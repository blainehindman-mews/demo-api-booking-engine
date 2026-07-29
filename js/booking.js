/* ============================================================
   Mews Distributor API integration — The Cascadian
   Swagger: https://api.mews.com/swagger/distributor/swagger.json

   Endpoint shapes verified against the live demo environment:

   POST /api/distributor/v1/configuration/get
     { Client, Ids:[EnterpriseId], LanguageCode, FullAmounts:true }
     → { Configurations:[{ Enterprise:{ Categories[], ... } }], ImageBaseUrl }

   POST /api/distributor/v1/hotels/getAvailability
     { Client, ConfigurationId, HotelId:EnterpriseId,
       StartUtc, EndUtc, AdultCount, ChildCount, LanguageCode, CurrencyCode }
     → { Rates[], RoomCategoryAvailabilities[
         { RoomCategoryId, AvailableRoomCount,
           RoomOccupancyAvailabilities[ { Pricing[{ RateId, Price{ ... } }] } ] }
       ] }

   Note: `Ids` on configuration/get takes EnterpriseIds, NOT the
   ConfigurationId — the ConfigurationId is returned *inside* the response
   and used on availability/reservation calls.
   ============================================================ */

(function () {
  "use strict";

  const cfg = window.CASCADIAN_CONFIG || {};
  const CONFIG_ID = cfg.DISTRIBUTOR_CONFIGURATION_ID;
  const ENTERPRISE_ID = cfg.ENTERPRISE_ID;
  const BASE = cfg.DISTRIBUTOR_BASE_URL;
  const CLIENT = cfg.CLIENT_NAME || "Cascadian 1.0";
  const LANG = cfg.LANGUAGE_CODE || "en-US";
  const CURRENCY = cfg.DEFAULT_CURRENCY || "USD";
  const IMAGE_BASE = cfg.IMAGE_BASE_URL || "https://cdn.mews-demo.com/Media/Image";
  const DIST_PAGE = cfg.DISTRIBUTOR_PAGE_URL || "";

  const hasConfig =
    CONFIG_ID && ENTERPRISE_ID &&
    !CONFIG_ID.startsWith("REPLACE_") &&
    !ENTERPRISE_ID.startsWith("REPLACE_");

  const form = document.getElementById("booking-form");
  const resultsEl = document.getElementById("availability-results");

  // ---------- module state: cached configuration ----------
  let categoryById = {};      // RoomCategoryId → { Name, Description, ImageIds, ... }
  let rateNameById = {};      // RateId → display name
  let enterpriseName = "The Cascadian";
  let configLoaded = false;

  // ---------- Distributor request helper ----------
  async function distributor(path, body) {
    const payload = Object.assign({ Client: CLIENT }, body);
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { Message: text }; }
    if (!res.ok || json.Message) {
      const msg = json.Message || `HTTP ${res.status}`;
      throw new Error(`${path}: ${msg}`);
    }
    return json;
  }

  // ---------- Deep-link URL to the Mews-hosted Distributor ----------
  // Mews reads these `mews*` query params on the Distributor page and uses
  // them to pre-fill the search form + jump straight to the chosen room.
  //
  // Documented params (verified on app.mews-demo.com):
  //   mewsStart        YYYY-MM-DD     arrival
  //   mewsEnd          YYYY-MM-DD     departure
  //   mewsAdultCount   int            adults
  //   mewsChildCount   int            children
  //   mewsRoom         uuid           pre-select a specific room category
  //   mewsRoute        string         set to "rates" to skip room-pick
  //                                   and land on the rate/occupancy step
  //                                   (required alongside mewsRoom — without
  //                                    it Mews ignores the room GUID)
  //
  // Resulting URL example:
  //   https://app.mews-demo.com/distributor/{CFG_ID}
  //     ?mewsStart=2026-06-01&mewsEnd=2026-06-04
  //     &mewsAdultCount=2&mewsChildCount=0
  //     &mewsRoom=1c9fcec5-...&mewsRoute=rates
  function distributorUrl({ start, end, adults, children, categoryId }) {
    if (!DIST_PAGE) return "#";
    const params = new URLSearchParams();
    if (start)            params.set("mewsStart", start);
    if (end)              params.set("mewsEnd", end);
    if (adults)           params.set("mewsAdultCount", adults);
    if (children != null) params.set("mewsChildCount", children);
    if (categoryId) {
      params.set("mewsRoom", categoryId);
      params.set("mewsRoute", "rates");
    }
    const sep = DIST_PAGE.includes("?") ? "&" : "?";
    return `${DIST_PAGE}${sep}${params.toString()}`;
  }

  // ---------- Helpers ----------
  function pickLang(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj[LANG] || obj["en-US"] || Object.values(obj)[0] || "";
  }

  function imageUrl(id) {
    return id ? `${IMAGE_BASE}/${id}` : "";
  }

  function nightsBetween(arrival, departure) {
    const ms = new Date(departure) - new Date(arrival);
    return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
  }

  function fmtMoney(value, currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || CURRENCY,
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      return `${currency || CURRENCY} ${Math.round(value)}`;
    }
  }

  // ---------- Load configuration on page load ----------
  async function loadConfiguration() {
    if (!hasConfig) return;
    try {
      const data = await distributor("/configuration/get", {
        Ids: [ENTERPRISE_ID],
        LanguageCode: LANG,
        FullAmounts: true,
      });
      const conf = (data.Configurations || [])[0] || {};
      const ent = conf.Enterprise || {};
      enterpriseName = pickLang(ent.Name) || enterpriseName;

      (ent.Categories || []).forEach((c) => { categoryById[c.Id] = c; });
      // Future use — actual rate names come from getAvailability anyway,
      // but cache enterprise-level rates so we can fall back.
      (ent.Rates || []).forEach((r) => { rateNameById[r.Id] = pickLang(r.Name); });

      configLoaded = true;
      console.info(`Distributor connected → ${enterpriseName}, ${Object.keys(categoryById).length} categories`);
    } catch (err) {
      console.warn("Distributor /configuration/get failed:", err.message);
    }
  }

  // ---------- Render cards ----------
  function bedLabel(cat) {
    const n = cat.NormalBedCount || 0;
    const x = cat.ExtraBedCount || 0;
    if (!n && !x) return null;
    const parts = [];
    if (n) parts.push(`${n} Bed${n > 1 ? "s" : ""}`);
    if (x) parts.push(`${x} Extra`);
    return parts.join(" + ");
  }

  function renderCard(opt) {
    return `
      <article class="av-card">
        <div class="av-img" style="background-image:url('${opt.image}')"></div>
        <div class="av-info">
          <h4>${opt.name}</h4>
          <p>${opt.description}</p>
          <div class="av-meta">
            ${opt.meta.map((m) => `<span>${m}</span>`).join("")}
          </div>
          ${opt.rateName ? `<p class="av-rate"><em>${opt.rateName}</em></p>` : ""}
        </div>
        <div class="av-price">
          <span class="price-val">${fmtMoney(opt.pricePerNight, opt.currency)}</span>
          <span class="price-unit">per night</span>
          <a href="${opt.reserveUrl}" target="_blank" rel="noopener" class="btn-primary">Reserve</a>
        </div>
      </article>
    `;
  }

  function renderResults(options, nights) {
    if (!options.length) {
      resultsEl.innerHTML = `
        <p class="av-status">No availability for the selected dates. Try adjusting your stay.</p>`;
      return;
    }
    resultsEl.innerHTML = `
      <p class="av-status">${enterpriseName} · ${options.length} option${options.length === 1 ? "" : "s"} · ${nights} night${nights === 1 ? "" : "s"}</p>
      <div class="av-grid">${options.map(renderCard).join("")}</div>
    `;
  }

  // ---------- Translate Distributor availability → card model ----------
  function normalize(availability, rateNameMap, search) {
    const out = [];
    (availability.RoomCategoryAvailabilities || []).forEach((rca) => {
      if ((rca.AvailableRoomCount || 0) <= 0) return;
      const cat = categoryById[rca.RoomCategoryId] || {};
      const occupancies = rca.RoomOccupancyAvailabilities || [];
      if (!occupancies.length) return;

      // Collect ALL pricings across occupancies; pick the cheapest per-night.
      let best = null;
      occupancies.forEach((occ) => {
        (occ.Pricing || []).forEach((p) => {
          const avg = p.Price && p.Price.AverageAmountPerNight && p.Price.AverageAmountPerNight[CURRENCY];
          const perNight = avg ? avg.GrossValue : null;
          if (perNight != null && (!best || perNight < best.perNight)) {
            best = { perNight, rateId: p.RateId, currency: (avg && avg.Currency) || CURRENCY };
          }
        });
      });
      if (!best) return;

      out.push({
        categoryId: rca.RoomCategoryId,
        name: pickLang(cat.Name) || "Room",
        description: (pickLang(cat.Description) || "").replace(/<[^>]+>/g, ""),
        image: imageUrl((cat.ImageIds || [])[0]) ||
               "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80",
        meta: [
          bedLabel(cat),
          cat.SpaceType,
          `${rca.AvailableRoomCount} available`,
        ].filter(Boolean),
        rateName: rateNameMap[best.rateId] || "",
        pricePerNight: Math.round(best.perNight),
        currency: best.currency,
        reserveUrl: distributorUrl({
          start: search.start,
          end: search.end,
          adults: search.adults,
          children: search.children,
          categoryId: rca.RoomCategoryId,
        }),
      });
    });
    // Stable, cheapest-first
    out.sort((a, b) => a.pricePerNight - b.pricePerNight);
    return out;
  }

  // ---------- Form submission ----------
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const arrival = document.getElementById("arrival").value;
      const departure = document.getElementById("departure").value;
      const adults = parseInt(document.getElementById("adults").value, 10);
      const children = parseInt(document.getElementById("children").value, 10);
      const nights = nightsBetween(arrival, departure);

      resultsEl.innerHTML = `<p class="av-status">Searching availability…</p>`;

      if (!hasConfig) {
        resultsEl.innerHTML = `
          <div class="av-error">
            <strong>Distributor not configured.</strong>
            Set DISTRIBUTOR_CONFIGURATION_ID and ENTERPRISE_ID in js/config.js.
          </div>`;
        return;
      }

      // Load configuration once if it wasn't preloaded
      if (!configLoaded) await loadConfiguration();

      try {
        const data = await distributor("/hotels/getAvailability", {
          ConfigurationId: CONFIG_ID,
          HotelId: ENTERPRISE_ID,
          StartUtc: `${arrival}T00:00:00Z`,
          EndUtc: `${departure}T00:00:00Z`,
          AdultCount: adults,
          ChildCount: children,
          LanguageCode: LANG,
          CurrencyCode: CURRENCY,
        });
        const rateMap = {};
        (data.Rates || []).forEach((r) => { rateMap[r.Id] = pickLang(r.Name); });

        const options = normalize(data, rateMap, {
          start: arrival,
          end: departure,
          adults,
          children,
        });
        renderResults(options, nights);
      } catch (err) {
        console.error(err);
        resultsEl.innerHTML = `
          <div class="av-error">
            <strong>Could not load availability.</strong>
            ${String(err.message || err)}
          </div>`;
      }
    });
  }

  // ---------- Kick off configuration preload ----------
  if (hasConfig) {
    loadConfiguration();
  }

  // ---------- Expose a small API so other modules (e.g. the per-room
  // availability calendar) can reuse the Distributor plumbing without
  // duplicating the request/auth boilerplate ----------
  window.cascadianDistributorUrl = distributorUrl;
  window.cascadianBooking = {
    distributor,
    distributorUrl,
    pickLang,
    imageUrl,
    config: {
      CONFIG_ID,
      ENTERPRISE_ID,
      LANG,
      CURRENCY,
      hasConfig,
    },
  };
})();
