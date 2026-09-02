/* ============================================================
   Springer Pavilion — event ticketing on Mews
   ============================================================

   THREE LAYERS, three different answers to "which API?".

   1. CATALOGUE  — Distributor API, real, runs in this browser.
      POST /api/distributor/v1/configuration/get returns
      Enterprise.Products[] — the hotel's additional services with live
      names, images and per-currency prices. The event ticket is one of
      those products; the rest are offered as add-ons at checkout.

   2. GUEST + MONEY — Connector API, and it CANNOT run in this browser.
      Looking a guest up by confirmation number and posting a charge to
      their folio are trusted operations: they need ClientToken +
      AccessToken, which must never reach a client. They belong behind a
      server proxy (server/springer-proxy.example.js).
        POST /reservations/getAll/2023-06-06  { Numbers: ["30291"] }
        POST /customers/getAll                { CustomerIds: [AccountId] }
        POST /orders/add                      { ProductOrders, LinkedReservationId }
      With CASCADIAN_CONFIG.SPRINGER_CONNECTOR_PROXY_URL blank, the
      MockConnector below answers those three paths from
      data/springer-demo-reservations.json using the real response shapes.

   3. SEATS — not a Mews concept at all.
      A Mews Product has a price, not fifty numbered units, and Mews has
      no seat map. Seat inventory therefore lives in this app
      (data/springer-events.json + localStorage). The seat labels ride
      along to Mews in the order's `Notes`, so the folio line reads
      "Springer Pavilion · Casablanca · Seats A3, A4" and Mews stays
      the single source of truth for the charge.

   Every Mews call is logged to the browser console (and collected in
   window.springerApiLog()) — nothing about the API surfaces in the UI.
   ============================================================ */

(function () {
  "use strict";

  const cfg = window.CASCADIAN_CONFIG || {};
  const ENTERPRISE_ID = cfg.ENTERPRISE_ID;
  const CURRENCY = cfg.DEFAULT_CURRENCY || "USD";
  const LANG = cfg.LANGUAGE_CODE || "en-US";
  const IMAGE_BASE = cfg.IMAGE_BASE_URL || "https://cdn.mews-demo.com/Media/Image";
  const PROXY = (cfg.SPRINGER_CONNECTOR_PROXY_URL || "").replace(/\/$/, "");
  const TICKET_MATCH = new RegExp(cfg.SPRINGER_TICKET_NAME_MATCH || "ticket", "i");
  const SERVICE_ID = cfg.SPRINGER_SERVICE_ID || "";
  const LIVE_LOOKUP = !!cfg.SPRINGER_LIVE_GUEST_LOOKUP;
  const LIVE_CHARGE = !!cfg.SPRINGER_LIVE_CHARGE;

  // Which Connector paths are allowed to reach the real property. The
  // catalogue is read-only so it always goes live when the proxy is up; guest
  // data and money are opt-in per the flags above.
  const CATALOGUE_PATHS = new Set([
    "/api/connector/v1/services/getAll",
    "/api/connector/v1/products/getAll",
    "/api/connector/v1/images/getUrls",
  ]);
  function goesLive(path) {
    if (!PROXY) return false;
    if (CATALOGUE_PATHS.has(path)) return true;
    if (path === "/api/connector/v1/orders/add") return LIVE_CHARGE;
    return LIVE_LOOKUP;
  }
  const SHOWTIMES = cfg.SPRINGER_SHOWTIMES || {};
  const CONNECTOR_CLIENT = "Cascadian Springer 1.0.0";
  const STORE_KEY = "cascadian.springer.sold.v1";

  const listEl = document.getElementById("spr-events");
  const modal = document.getElementById("spr-modal");
  if (!listEl || !modal) return;

  // ---------- module state ----------
  let catalogue = null;      // data/springer-events.json
  let fixture = null;        // data/springer-demo-reservations.json (mock Connector store)
  let mewsProducts = [];     // live Distributor Enterprise.Products[]
  let ticketProduct = null;  // the one that looks like an event ticket, if published
  let apiLog = [];           // calls made during the current booking session
  let serviceName = "Pavilion Movies";  // overwritten by services/getAll

  let current = {            // per-modal-open booking state
    event: null,
    reservation: null,
    customer: null,
    maxSeats: 0,
    seats: [],
    addons: {},              // ProductId -> count
  };

  // ============================================================
  // Utilities
  // ============================================================

  function fold(s) {
    return String(s || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim().toLowerCase();
  }

  function money(v, currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency", currency: currency || CURRENCY,
      }).format(v);
    } catch { return `${currency || CURRENCY} ${v.toFixed(2)}`; }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function pickLang(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj[LANG] || obj["en-US"] || Object.values(obj)[0] || "";
  }

  // "2027-08-14T21:00" -> "Saturday, August 14, 2027 · 9:00 PM"
  function fmtEventDate(local) {
    const [d, t] = local.split("T");
    const [y, m, day] = d.split("-").map(Number);
    const [hh, mm] = t.split(":").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, day, hh, mm));
    const date = dt.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
    });
    const time = dt.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", timeZone: "UTC",
    });
    return `${date} · ${time}`;
  }

  function fmtShortDate(utc) {
    return new Date(utc).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ============================================================
  // Seat inventory — the part Mews does not model
  // ============================================================

  const inventory = {
    // localStorage overlay on top of the seeded soldSeats in the JSON file.
    read() {
      try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
      catch { return {}; }
    },
    write(state) {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
      catch (err) { console.warn("Seat inventory not persisted:", err.message); }
    },
    // Every seat that is spoken for: house holds, seeded sales, and whatever
    // was sold in this browser. Holds are keyed by Mews ProductId for live
    // events and by local event id for the fallback catalogue.
    soldFor(eventId) {
      const ev = catalogue.events.find((e) => e.id === eventId) || {};
      const sold = new Map();
      const holds = (catalogue.staffHolds || {});
      const held = [].concat(holds[ev.productId] || [], holds[ev.id] || []);
      held.forEach((s) => sold.set(s, { source: "staff", held: true }));
      (ev.soldSeats || []).forEach((s) => sold.set(s, { source: "seed" }));
      const mine = this.read()[eventId] || {};
      Object.entries(mine).forEach(([seat, rec]) => sold.set(seat, rec));
      return sold;
    },
    commit(eventId, seats, record) {
      const state = this.read();
      state[eventId] = state[eventId] || {};
      seats.forEach((seat) => { state[eventId][seat] = record; });
      this.write(state);
    },
    reset() {
      try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    },
  };

  function allSeats() {
    const { rows, blocks } = catalogue.seatMap;
    const out = [];
    rows.forEach((row) => {
      blocks.forEach((b) => {
        for (let n = b.from; n <= b.to; n++) out.push(`${row}${n}`);
      });
    });
    return out;
  }

  // ============================================================
  // API call log — what the modal's inspector renders
  // ============================================================

  // Kept for debugging only — every Mews request/response goes to the console,
  // nothing is rendered to the page. window.springerApiLog dumps the session.
  function logCall(entry) {
    const call = Object.assign({ at: new Date().toISOString() }, entry);
    apiLog.push(call);
    console.debug(
      `[mews ${call.api}${call.live ? "" : " · simulated"}] POST ${call.path}`,
      { request: call.request, response: call.response }
    );
  }
  window.springerApiLog = () => apiLog;

  // ============================================================
  // Connector API — proxied for real, mocked otherwise
  // ============================================================

  // The auth fields a real call carries. Never rendered with real values:
  // the proxy injects them server-side and this page never sees them.
  const AUTH_PLACEHOLDER = {
    ClientToken: "«injected server-side»",
    AccessToken: "«injected server-side»",
    Client: CONNECTOR_CLIENT,
  };

  async function connector(path, body, note) {
    const request = Object.assign({}, AUTH_PLACEHOLDER, body);
    let response;
    let live = false;

    if (goesLive(path)) {
      live = true;
      const res = await fetch(`${PROXY}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ Client: CONNECTOR_CLIENT }, body)),
      });
      response = await res.json().catch(() => ({ Message: `HTTP ${res.status}` }));
      if (!res.ok || response.Message) {
        logCall({ api: "Connector", path, request, response, note, live });
        throw new Error(response.Message || `HTTP ${res.status}`);
      }
    } else {
      await sleep(220); // make the request/response visible in the UI
      response = MockConnector(path, body);
    }

    logCall({ api: "Connector", path, request, response, note, live });
    return response;
  }

  // Answers the three Connector paths this feature needs, using the real
  // response shapes, from data/springer-demo-reservations.json.
  function MockConnector(path, body) {
    switch (path) {
      case "/api/connector/v1/reservations/getAll/2023-06-06": {
        const numbers = (body.Numbers || []).map(String);
        const states = body.States || null;
        const Reservations = fixture.Reservations.filter((r) =>
          numbers.includes(String(r.Number)) &&
          (!states || states.includes(r.State)));
        return { Reservations, Cursor: null };
      }
      case "/api/connector/v1/customers/getAll": {
        const ids = body.CustomerIds || [];
        const Customers = fixture.Customers.filter((c) => ids.includes(c.Id));
        return { Customers, Cursor: null };
      }
      case "/api/connector/v1/orders/add":
        return { OrderId: uuid() };
      default:
        throw new Error(`MockConnector: unhandled path ${path}`);
    }
  }

  // ============================================================
  // Distributor API — the real, browser-safe half
  // ============================================================

  async function loadMewsProducts() {
    const booking = window.cascadianBooking;
    if (!booking || !booking.config.hasConfig) return;
    const request = {
      Client: cfg.CLIENT_NAME,
      Ids: [ENTERPRISE_ID],
      LanguageCode: LANG,
      FullAmounts: true,
    };
    try {
      const data = await booking.distributor("/configuration/get", {
        Ids: [ENTERPRISE_ID], LanguageCode: LANG, FullAmounts: true,
      });
      const ent = ((data.Configurations || [])[0] || {}).Enterprise || {};
      mewsProducts = (ent.Products || []).map((p) => {
        const price = (p.Prices || {})[CURRENCY] || {};
        return {
          id: p.Id,
          name: pickLang(p.Name),
          description: (pickLang(p.Description) || "").replace(/<[^>]+>/g, ""),
          image: p.ImageId ? `${IMAGE_BASE}/${p.ImageId}` : "",
          price: price.GrossValue != null ? price.GrossValue : null,
          currency: price.Currency || CURRENCY,
        };
      }).filter((p) => p.price != null);

      // Prefer an explicitly configured ticket product; else sniff the catalogue.
      const configured = cfg.SPRINGER_TICKET_PRODUCT_ID;
      ticketProduct = configured
        ? mewsProducts.find((p) => p.id === configured) || null
        : mewsProducts.find((p) => TICKET_MATCH.test(p.name)) || null;

      logCall({
        api: "Distributor", path: "/api/distributor/v1/configuration/get",
        live: true, request,
        response: {
          "Configurations[0].Enterprise.Products": mewsProducts.map((p) => ({
            Id: p.Id || p.id, Name: p.name, [`Prices.${CURRENCY}.GrossValue`]: p.price,
          })),
          "…": "truncated — full response also carries Categories, Rates, AgeCategories",
        },
        note: ticketProduct
          ? `Ticket product resolved to "${ticketProduct.name}".`
          : "No ticket product published to the Distributor yet — the ticket will be posted as a Connector custom Item[] instead. Set SPRINGER_TICKET_PRODUCT_ID in js/config.js once it exists.",
      });
    } catch (err) {
      console.warn("Distributor /configuration/get failed:", err.message);
    }
  }

  // What one ticket costs, and how it will be posted to Mews.
  function ticketFor(event) {
    // An event sourced from the Mews service already carries its own product.
    if (event && event.productId) {
      return {
        productId: event.productId,
        name: event.title,
        price: event.ticketPriceFallback,
        currency: event.currency || CURRENCY,
        posting: "ProductOrders",
      };
    }
    if (ticketProduct) {
      return {
        productId: ticketProduct.id,
        name: ticketProduct.name,
        price: ticketProduct.price,
        currency: ticketProduct.currency,
        posting: "ProductOrders",
      };
    }
    return {
      productId: null,
      name: `${event.title} — Admission`,
      price: event.ticketPriceFallback,
      currency: catalogue.venue.currency || CURRENCY,
      posting: "Items",
    };
  }

  // ============================================================
  // Step 1 — verify the reservation on file
  // ============================================================

  async function verifyGuest(lastName, number, event) {
    // Real call. Note we filter on Numbers + States only and check the date
    // overlap ourselves: the API would also accept CollidingUtc, but doing the
    // overlap locally lets us tell "no such booking" apart from "your stay
    // doesn't cover this date", which is a much better error for the guest.
    const resData = await connector(
      "/api/connector/v1/reservations/getAll/2023-06-06",
      {
        EnterpriseIds: [ENTERPRISE_ID],
        Numbers: [String(number).trim()],
        States: ["Confirmed", "Started"],
        Limitation: { Count: 5 },
      },
      "Find the stay by confirmation number. Numbers[] is the guest-facing reservation number."
    );

    const reservation = (resData.Reservations || [])[0];
    if (!reservation) {
      return { ok: false, reason: "We couldn't find a confirmed booking with that number." };
    }

    const custData = await connector(
      "/api/connector/v1/customers/getAll",
      {
        ChainIds: null,
        CustomerIds: [reservation.AccountId],
        Limitation: { Count: 1 },
      },
      "Resolve the reservation's AccountId to a profile so the surname can be matched."
    );

    const customer = (custData.Customers || [])[0];
    if (!customer || fold(customer.LastName) !== fold(lastName)) {
      return { ok: false, reason: "That surname doesn't match the name on the booking." };
    }

    // Does the stay actually cover the performance?
    const showtime = new Date(event.startsAtUtc).getTime();
    const from = new Date(reservation.StartUtc).getTime();
    const to = new Date(reservation.EndUtc).getTime();
    if (showtime < from || showtime >= to) {
      return {
        ok: false,
        reason: `Booking #${reservation.Number} runs ${fmtShortDate(reservation.StartUtc)} – ${fmtShortDate(reservation.EndUtc)}, which doesn't cover this performance. Tickets are for in-house guests only.`,
      };
    }

    // The cap on tickets: the people already declared on the reservation.
    const maxSeats = (reservation.PersonCounts || [])
      .reduce((sum, pc) => sum + (pc.Count || 0), 0);
    if (maxSeats < 1) {
      return { ok: false, reason: "That booking has no guests recorded against it." };
    }

    return { ok: true, reservation, customer, maxSeats };
  }

  // ============================================================
  // Step 3 — post the charge to the room folio
  // ============================================================

  async function chargeToRoom() {
    const { event, reservation, seats } = current;

    // Never post an order that isn't backed by a verified reservation and at
    // least one seat. Steps are hidden, not removed, so these handlers stay
    // reachable from a step the guest isn't looking at.
    if (!event || !reservation) throw new Error("No verified booking for this order.");
    if (!seats.length) throw new Error("No seats selected.");
    if (seats.length > current.maxSeats) throw new Error("More seats than guests on the booking.");
    const ticket = ticketFor(event);
    // What the front desk reads on the folio: the service, the film,
    // when it plays, and which seats. serviceName comes from Mews itself
    // (services/getAll) so renaming it in Commander renames it here.
    const notes = [
      serviceName,
      event.title,
      fmtEventDate(event.startsAtLocal),
      `Seats ${seats.join(", ")}`,
    ].join(" · ");

    // orders/add creates a *product service order* consumed at one point in
    // time — exactly what a 9pm performance is — and LinkedReservationId ties
    // it to the stay so it lands on the room folio and plays nicely with
    // billing automation and allowances.
    const body = {
      EnterpriseId: ENTERPRISE_ID,
      ServiceId: SERVICE_ID || "«SPRINGER_SERVICE_ID — create the service in Commander»",
      AccountId: reservation.AccountId,
      LinkedReservationId: reservation.Id,
      ConsumptionUtc: event.startsAtUtc,
      Notes: notes,
      Options: { DisableItemGrouping: true }, // one folio line per seat
      ProductOrders: [],
      Items: [],
    };

    if (ticket.posting === "ProductOrders") {
      body.ProductOrders.push({
        ProductId: ticket.productId,
        Count: seats.length,
        ExternalIdentifier: `SPR-${event.id}-${seats.join("-")}`,
      });
    } else {
      // Documented Mews rule: product exists in Mews -> ProductOrders[];
      // product does not exist in Mews -> Items[].
      body.Items.push({
        Name: ticket.name,
        UnitCount: seats.length,
        UnitAmount: { Currency: ticket.currency, GrossValue: ticket.price },
        ExternalIdentifier: `SPR-${event.id}-${seats.join("-")}`,
      });
    }

    Object.entries(current.addons).forEach(([productId, count]) => {
      if (count > 0) body.ProductOrders.push({ ProductId: productId, Count: count });
    });

    if (!body.ProductOrders.length) delete body.ProductOrders;
    if (!body.Items.length) delete body.Items;

    const res = await connector(
      "/api/connector/v1/orders/add", body,
      ticket.posting === "ProductOrders"
        ? "Post the ticket (and any add-ons) to the guest's folio as a product service order."
        : "No ticket Product exists in Mews yet, so the ticket goes on as a custom Item[]; the add-ons are real published products and go on as ProductOrders[]."
    );
    return { orderId: res.OrderId, notes, ticket };
  }

  // ============================================================
  // Rendering — event list
  // ============================================================

  function seatSummary(eventId) {
    const sold = inventory.soldFor(eventId).size;
    const total = allSeats().length;
    return { sold, total, left: total - sold };
  }

  function renderEvents() {
    listEl.innerHTML = catalogue.events.map((ev) => {
      const { left, total } = seatSummary(ev.id);
      const soldOut = left === 0;
      return `
        <article class="spr-event${soldOut ? " is-soldout" : ""}">
          <div class="spr-event-img" style="background-image:url('${esc(ev.image)}')">
            <span class="spr-event-kind">${esc(ev.kind)}</span>
          </div>
          <div class="spr-event-body">
            <p class="spr-event-when">${esc(fmtEventDate(ev.startsAtLocal))}</p>
            <h3>${esc(ev.title)}</h3>
            <p class="spr-event-desc">${esc(ev.description)}</p>
            <p class="spr-event-meta">
              <span>${ev.runtimeMinutes} min</span>
              <span>${money(ticketFor(ev).price, ticketFor(ev).currency)} per seat</span>
              <span class="${left <= 10 ? "spr-scarce" : ""}">${left} of ${total} seats left</span>
            </p>
          </div>
          <div class="spr-event-cta">
            <button type="button" class="btn-primary${soldOut ? " is-disabled" : ""}"
                    data-spr-event="${esc(ev.id)}" ${soldOut ? "disabled" : ""}>
              ${soldOut ? "Sold Out" : "Select Seats"}
            </button>
            <button type="button" class="spr-preview-link" data-spr-preview="${esc(ev.id)}">
              Preview seats
            </button>
          </div>
        </article>`;
    }).join("");

    listEl.querySelectorAll("[data-spr-event]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(btn.getAttribute("data-spr-event")));
    });
    listEl.querySelectorAll("[data-spr-preview]").forEach((btn) => {
      btn.addEventListener("click", () => openModal(btn.getAttribute("data-spr-preview"), "preview"));
    });
  }

  // ============================================================
  // Rendering — seat map
  // ============================================================

  // Shared by the interactive picker and the read-only preview.
  function paintSeatMap(grid, eventId, { interactive }) {
    const sold = inventory.soldFor(eventId);
    const { rows, blocks } = catalogue.seatMap;

    grid.innerHTML = rows.map((row) => `
      <div class="spr-row">
        <span class="spr-row-label">${row}</span>
        ${blocks.map((b, i) => {
          let html = `<div class="spr-block">`;
          for (let n = b.from; n <= b.to; n++) {
            const id = `${row}${n}`;
            const rec = sold.get(id);
            const isHeld = !!(rec && rec.held);
            const isSold = !!rec && !isHeld;
            const isSel = interactive && current.seats.includes(id);
            const cls = isHeld ? "is-held" : isSold ? "is-sold" : isSel ? "is-selected" : "is-open";
            const label = isHeld ? ", staff reserved" : isSold ? ", taken" : ", available";
            html += `<button type="button" class="spr-seat ${cls}" data-seat="${id}"
                       ${rec || !interactive ? "disabled" : ""}
                       aria-pressed="${isSel}"
                       aria-label="Seat ${id}${label}">${n}</button>`;
          }
          html += `</div>`;
          return i < blocks.length - 1 ? html + `<span class="spr-aisle" aria-hidden="true"></span>` : html;
        }).join("")}
        <span class="spr-row-label">${row}</span>
      </div>`).join("");

    if (interactive) {
      grid.querySelectorAll("[data-seat]").forEach((btn) => {
        btn.addEventListener("click", () => toggleSeat(btn.getAttribute("data-seat")));
      });
    }
  }

  function renderSeatMap() {
    paintSeatMap(document.getElementById("spr-seatgrid"), current.event.id, { interactive: true });
    updateSeatFooter();
  }

  // Read-only: what's still free, without asking who you are.
  function renderPreview() {
    const ev = current.event;
    paintSeatMap(document.getElementById("spr-preview-grid"), ev.id, { interactive: false });
    const { left, total } = seatSummary(ev.id);
    const ticket = ticketFor(ev);
    document.getElementById("spr-preview-count").innerHTML =
      `<strong>${left}</strong> of ${total} seats still open · ${money(ticket.price, ticket.currency)} per seat`;
  }

  function toggleSeat(id) {
    // Belt and braces: the button is disabled, but never let a held or sold
    // seat enter the selection — it would reach orders/add.
    if (inventory.soldFor(current.event.id).has(id) && !current.seats.includes(id)) return;
    const at = current.seats.indexOf(id);
    if (at > -1) {
      current.seats.splice(at, 1);
      setSeatHint("");
    } else if (current.seats.length >= current.maxSeats) {
      setSeatHint(
        `Booking #${current.reservation.Number} is for ${current.maxSeats} guest${current.maxSeats === 1 ? "" : "s"}, so you can hold ${current.maxSeats} seat${current.maxSeats === 1 ? "" : "s"}. Release one to choose another.`,
        true
      );
      return;
    } else {
      current.seats.push(id);
      setSeatHint("");
    }
    current.seats.sort();
    renderSeatMap();
  }

  function setSeatHint(msg, isWarning) {
    const el = document.getElementById("spr-seat-hint");
    el.textContent = msg;
    el.classList.toggle("is-warning", !!isWarning);
  }

  function updateSeatFooter() {
    const { seats, maxSeats, event } = current;
    const ticket = ticketFor(event);
    const countEl = document.getElementById("spr-seat-count");
    const nextBtn = document.getElementById("spr-to-review");

    countEl.innerHTML = seats.length
      ? `<strong>${seats.join(", ")}</strong> · ${seats.length} of ${maxSeats} · ${money(seats.length * ticket.price, ticket.currency)}`
      : `Choose up to ${maxSeats} seat${maxSeats === 1 ? "" : "s"}.`;

    nextBtn.disabled = seats.length === 0;
  }

  // ============================================================
  // Rendering — review step (add-ons + total)
  // ============================================================

  function renderReview() {
    const { event, reservation, customer, seats } = current;
    const errEl = document.getElementById("spr-charge-error");
    if (errEl) { errEl.hidden = true; errEl.textContent = ""; }
    const ticket = ticketFor(event);

    document.getElementById("spr-review-summary").innerHTML = `
      <dl class="spr-review-dl">
        <div><dt>Performance</dt><dd>${esc(event.title)}</dd></div>
        <div><dt>When</dt><dd>${esc(fmtEventDate(event.startsAtLocal))}</dd></div>
        <div><dt>Seats</dt><dd><strong>${esc(seats.join(", "))}</strong></dd></div>
        <div><dt>Billing to</dt><dd>${esc(customer.FirstName)} ${esc(customer.LastName)} · Room ${esc(reservation.AssignedResourceName)} · Booking #${esc(reservation.Number)}</dd></div>
      </dl>`;

    // "Additional services" — the hotel's real Mews products, unrestricted.
    const addonList = mewsProducts.filter((p) => !ticketProduct || p.id !== ticketProduct.id);
    const addonsEl = document.getElementById("spr-addons");
    if (!addonList.length) {
      addonsEl.innerHTML = `<p class="spr-muted">No additional services published to the Distributor for this property.</p>`;
    } else {
      addonsEl.innerHTML = addonList.map((p) => {
        const n = current.addons[p.id] || 0;
        return `
          <div class="spr-addon${n ? " is-on" : ""}">
            ${p.image ? `<div class="spr-addon-img" style="background-image:url('${esc(p.image)}')"></div>` : `<div class="spr-addon-img spr-addon-img-blank"></div>`}
            <div class="spr-addon-info">
              <h5>${esc(p.name)}</h5>
              <p>${esc(p.description)}</p>
            </div>
            <div class="spr-addon-buy">
              <span class="spr-addon-price">${money(p.price, p.currency)}</span>
              <div class="spr-stepper">
                <button type="button" data-addon-minus="${esc(p.id)}" aria-label="One fewer ${esc(p.name)}" ${n ? "" : "disabled"}>&minus;</button>
                <span data-addon-count="${esc(p.id)}">${n}</span>
                <button type="button" data-addon-plus="${esc(p.id)}" aria-label="One more ${esc(p.name)}">+</button>
              </div>
            </div>
          </div>`;
      }).join("");

      addonsEl.querySelectorAll("[data-addon-plus]").forEach((b) =>
        b.addEventListener("click", () => bumpAddon(b.getAttribute("data-addon-plus"), 1)));
      addonsEl.querySelectorAll("[data-addon-minus]").forEach((b) =>
        b.addEventListener("click", () => bumpAddon(b.getAttribute("data-addon-minus"), -1)));
    }

    renderTotals(ticket);
  }

  function bumpAddon(id, delta) {
    // No cap on add-ons — only the seats are limited by the guest count.
    const n = Math.max(0, (current.addons[id] || 0) + delta);
    current.addons[id] = n;
    renderReview();
  }

  function renderTotals(ticket) {
    const lines = [{
      label: `${ticket.name} × ${current.seats.length}`,
      amount: ticket.price * current.seats.length,
      currency: ticket.currency,
    }];
    Object.entries(current.addons).forEach(([id, n]) => {
      if (!n) return;
      const p = mewsProducts.find((x) => x.id === id);
      if (p) lines.push({ label: `${p.name} × ${n}`, amount: p.price * n, currency: p.currency });
    });
    const total = lines.reduce((s, l) => s + l.amount, 0);

    document.getElementById("spr-totals").innerHTML = `
      ${lines.map((l) => `
        <div class="spr-total-line">
          <span>${esc(l.label)}</span><span>${money(l.amount, l.currency)}</span>
        </div>`).join("")}
      <div class="spr-total-line spr-total-grand">
        <span>Charged to room</span><span>${money(total, ticket.currency)}</span>
      </div>`;
  }

  // ============================================================
  // Modal plumbing
  // ============================================================

  function showStep(name) {
    modal.querySelectorAll("[data-step]").forEach((el) => {
      el.hidden = el.getAttribute("data-step") !== name;
    });
    const panel = modal.querySelector(".spr-modal-panel");
    if (panel) panel.scrollTop = 0;
  }

  function openModal(eventId, startAt) {
    current = {
      event: catalogue.events.find((e) => e.id === eventId),
      reservation: null, customer: null, maxSeats: 0, seats: [], addons: {},
    };
    document.getElementById("spr-modal-title").textContent = current.event.title;
    document.getElementById("spr-modal-when").textContent = fmtEventDate(current.event.startsAtLocal);
    document.getElementById("spr-verify-form").reset();
    setVerifyError("");
    if (startAt === "preview") { renderPreview(); showStep("preview"); }
    else showStep("verify");

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("spr-modal-open");
    if (startAt !== "preview") {
      setTimeout(() => document.getElementById("spr-lastname").focus(), 50);
    }
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("spr-modal-open");
  }

  function setVerifyError(msg) {
    const el = document.getElementById("spr-verify-error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  // ============================================================
  // Wiring
  // ============================================================

  function wire() {
    // --- step 1: verify
    document.getElementById("spr-verify-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("spr-verify-btn");
      const lastName = document.getElementById("spr-lastname").value.trim();
      const number = document.getElementById("spr-confirmation").value.trim();
      if (!lastName || !number) return;

      setVerifyError("");
      btn.disabled = true;
      btn.textContent = "Checking…";
      try {
        const result = await verifyGuest(lastName, number, current.event);
        if (!result.ok) { setVerifyError(result.reason); return; }

        current.reservation = result.reservation;
        current.customer = result.customer;
        current.maxSeats = result.maxSeats;

        const { left } = seatSummary(current.event.id);
        current.maxSeats = Math.min(current.maxSeats, left);

        document.getElementById("spr-seat-welcome").innerHTML =
          `Welcome back, ${esc(result.customer.FirstName)}. Booking <strong>#${esc(result.reservation.Number)}</strong> · Room ${esc(result.reservation.AssignedResourceName)} · ${result.maxSeats} guest${result.maxSeats === 1 ? "" : "s"} on file, so <strong>${current.maxSeats} seat${current.maxSeats === 1 ? "" : "s"}</strong> to claim.`;

        setSeatHint("");
        renderSeatMap();
        showStep("seats");
      } catch (err) {
        setVerifyError(`Lookup failed: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Find My Booking";
      }
    });

    // --- preview -> verify
    document.getElementById("spr-preview-claim").addEventListener("click", () => {
      showStep("verify");
      setTimeout(() => document.getElementById("spr-lastname").focus(), 50);
    });

    // --- step 2 -> 3
    document.getElementById("spr-to-review").addEventListener("click", () => {
      if (!current.reservation || !current.seats.length) return;
      renderReview();
      showStep("review");
    });
    document.getElementById("spr-back-to-seats").addEventListener("click", () => {
      renderSeatMap();
      showStep("seats");
    });

    // --- step 3: charge
    document.getElementById("spr-charge").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Posting to folio…";
      try {
        const { orderId, ticket } = await chargeToRoom();

        // The charge succeeded, so — and only now — the seats stop being sold.
        inventory.commit(current.event.id, current.seats, {
          orderId,
          reservationNumber: current.reservation.Number,
          guest: current.customer.LastName,
          soldAtUtc: new Date().toISOString(),
        });

        const addonTotal = Object.entries(current.addons).reduce((s, [id, n]) => {
          const p = mewsProducts.find((x) => x.id === id);
          return s + (p ? p.price * n : 0);
        }, 0);
        const total = ticket.price * current.seats.length + addonTotal;

        document.getElementById("spr-done-body").innerHTML = `
          <p class="spr-done-seats">${esc(current.seats.join(" · "))}</p>
          <dl class="spr-review-dl">
            <div><dt>Performance</dt><dd>${esc(current.event.title)}</dd></div>
            <div><dt>When</dt><dd>${esc(fmtEventDate(current.event.startsAtLocal))}</dd></div>
            <div><dt>Charged to</dt><dd>Room ${esc(current.reservation.AssignedResourceName)} · Booking #${esc(current.reservation.Number)}</dd></div>
            <div><dt>Total</dt><dd>${money(total, ticket.currency)}</dd></div>
            <div><dt>Mews OrderId</dt><dd><code>${esc(orderId)}</code></dd></div>
          </dl>
          <p class="spr-muted">Those seats are now off the map for everyone else. No ticket to print — the door team looks you up by room number.</p>`;

        renderEvents();
        showStep("done");
      } catch (err) {
        const el = document.getElementById("spr-charge-error");
        el.textContent = `Could not post the charge: ${err.message}`;
        el.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = "Charge to My Room";
      }
    });

    document.getElementById("spr-done-close").addEventListener("click", closeModal);

    // --- close
    modal.querySelectorAll("[data-spr-close]").forEach((el) =>
      el.addEventListener("click", closeModal));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("is-open")) closeModal();
    });

    // --- demo reset
    const reset = document.getElementById("spr-reset");
    if (reset) {
      reset.addEventListener("click", () => {
        inventory.reset();
        renderEvents();
        reset.textContent = "Inventory reset";
        setTimeout(() => { reset.textContent = "Reset demo inventory"; }, 1800);
      });
    }
  }

  // ============================================================
  // The event catalogue, straight out of the Mews Additional service
  // ============================================================
  //
  // One Product on the service = one screening. Mews owns the name, the price
  // and the artwork; it does NOT own the date — a Product has no date field —
  // so the showtime comes from CASCADIAN_CONFIG.SPRINGER_SHOWTIMES, keyed by
  // ProductId. Products with no showtime configured are skipped rather than
  // shown undated.
  async function loadCatalogueFromMews() {
    if (!PROXY || !SERVICE_ID) return null;

    const svcRes = await connector(
      "/api/connector/v1/services/getAll",
      { ServiceIds: [SERVICE_ID], Limitation: { Count: 10 } },
      "Read the pavilion's Additional service. The Distributor API cannot see this — it only knows services bound to the booking engine."
    );
    const service = (svcRes.Services || [])[0];
    if (!service) throw new Error(`Service ${SERVICE_ID} not found`);

    const prodRes = await connector(
      "/api/connector/v1/products/getAll",
      { ServiceIds: [SERVICE_ID], Limitation: { Count: 100 } },
      "Every Product on that service is one screening's ticket."
    );
    const products = (prodRes.Products || []).filter((p) => p.IsActive);

    // Ask Mews for real, signed image URLs — the bare CDN path 403s for
    // anything not published to the Distributor.
    const imageIds = products.flatMap((p) => p.ImageIds || []);
    const imageById = {};
    if (imageIds.length) {
      try {
        const imgRes = await connector(
          "/api/connector/v1/images/getUrls",
          { Images: imageIds.map((ImageId) => ({ ImageId, Width: 1200, Height: 800, ResizeMode: "Fit" })) },
          "Resolve product artwork. cdn.mews-demo.com/Media/Image/{id} returns 403 for unpublished products, so the URL has to come from Mews."
        );
        (imgRes.ImageUrls || []).forEach((i) => { imageById[i.ImageId] = i.Url; });
      } catch (err) {
        console.warn("images/getUrls failed, falling back to stills:", err.message);
      }
    }

    const events = [];
    const undated = [];
    products.forEach((p) => {
      const when = SHOWTIMES[p.Id];
      if (!when) { undated.push(pickLang(p.Names) || p.Name); return; }
      const price = p.Price || {};
      events.push({
        id: `mews-${p.Id}`,
        productId: p.Id,
        // Products are named for the till ("Back to the Future - Tickets"),
        // but the card should show the film. Strip a trailing ticket-type
        // suffix; leave anything else alone.
        title: (pickLang(p.Names) || p.Name || "Screening")
          .replace(/\s*[-–—]\s*(main\s+|general\s+)?(tickets?|admissions?|reserved\s+seats?|seats?)\s*$/i, "")
          .trim(),
        kind: when.kind || pickLang(service.Names) || "Event",
        startsAtLocal: when.startsAtLocal,
        startsAtUtc: when.startsAtUtc,
        runtimeMinutes: when.runtimeMinutes || null,
        image: imageById[(p.ImageIds || [])[0]] || when.image || "",
        description: (pickLang(p.Descriptions) || p.Description || when.description || "").replace(/<[^>]+>/g, ""),
        ticketPriceFallback: price.GrossValue != null ? price.GrossValue : 0,
        currency: price.Currency || CURRENCY,
        soldSeats: [],
        fromMews: true,
      });
    });

    if (undated.length) {
      console.warn(`No showtime configured for: ${undated.join(", ")} — add them to SPRINGER_SHOWTIMES in js/config.js.`);
    }
    return { serviceName: pickLang(service.Names) || service.Name, events };
  }

  // ============================================================
  // Boot
  // ============================================================

  async function boot() {
    try {
      const [events, reservations] = await Promise.all([
        fetch("data/springer-events.json").then((r) => r.json()),
        fetch("data/springer-demo-reservations.json").then((r) => r.json()),
      ]);
      catalogue = events;
      fixture = reservations;
    } catch (err) {
      listEl.innerHTML = `
        <div class="av-error">
          <strong>Could not load the event catalogue.</strong>
          ${esc(err.message)} — the JSON files need to be served over HTTP.
          Run <code>python -m http.server 8000</code> from the repo root.
        </div>`;
      return;
    }

    wire();

    // The real catalogue lives in Mews, behind the Connector proxy. The local
    // JSON is the fallback for when the proxy isn't running.
    listEl.innerHTML = `<p class="av-status">Loading the season from Mews…</p>`;
    let sourced = false;
    try {
      const live = await loadCatalogueFromMews();
      if (live && live.events.length) {
        catalogue.events = live.events;
        sourced = true;
        serviceName = live.serviceName || serviceName;
        console.info(`Springer catalogue from Mews: ${serviceName} — ${live.events.length} screening(s)`);
      }
    } catch (err) {
      console.warn("Mews catalogue unavailable, using data/springer-events.json:", err.message);
    }

    if (!sourced && PROXY) {
      console.warn(`Springer: Connector proxy at ${PROXY} isn't answering — showing the local catalogue from data/springer-events.json.`);
    }

    renderEvents();
    if (!sourced) await loadMewsProducts();
    renderEvents();
  }

  boot();
})();
