/* ============================================================
   Per-room availability calendar — The Cascadian
   "View availability" opens a month calendar scoped to ONE
   RoomCategoryId. The Distributor API has no calendar endpoint,
   so this issues one /hotels/getAvailability call per night
   (small parallel batches) and caches each month once fetched.
   Picking a valid arrival/departure hands off to the Mews-hosted
   checkout via the existing mewsRoom + mewsRoute=rates deep link.
   ============================================================ */
(function () {
  "use strict";

  const booking = window.cascadianBooking;
  const modal = document.getElementById("cal-modal");
  if (!booking || !modal) return; // booking.js didn't load, or no modal on this page

  const ADULTS = 2;
  const CHILDREN = 0;
  const CONCURRENCY = 5; // parallel per-night requests — keep polite to the demo API

  const titleEl = document.getElementById("cal-modal-title");
  const monthLabelEl = document.getElementById("cal-month-label");
  const gridEl = document.getElementById("cal-grid");
  const loadingEl = document.getElementById("cal-loading");
  const prevBtn = document.getElementById("cal-prev");
  const nextBtn = document.getElementById("cal-next");
  const selectionEl = document.getElementById("cal-selection");
  const continueBtn = document.getElementById("cal-continue");

  let categoryId = null;
  let viewYear, viewMonth; // viewMonth is 0-indexed, both in UTC
  let checkin = null;      // "YYYY-MM-DD" or null
  let checkout = null;
  const monthData = new Map(); // "YYYY-MM" -> Promise<Map<dateStr, nightInfo>>

  // ---------- date helpers (all UTC-based to dodge local-TZ drift) ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function dateStr(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
  function monthKey(y, m) { return `${y}-${pad(m + 1)}`; }
  function monthKeyOf(dStr) { return dStr.slice(0, 7); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); }
  function addDays(dStr, n) {
    const [y, m, d] = dStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dateStr(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  }
  function fmtDisplay(dStr) {
    const [y, m, d] = dStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      month: "short", day: "numeric", timeZone: "UTC",
    });
  }
  const TODAY = (() => {
    const now = new Date();
    return dateStr(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  })();

  const REQUEST_TIMEOUT_MS = 8000;
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ---------- fetch one night's availability for this category ----------
  async function fetchNight(dStr) {
    try {
      const data = await withTimeout(booking.distributor("/hotels/getAvailability", {
        ConfigurationId: booking.config.CONFIG_ID,
        HotelId: booking.config.ENTERPRISE_ID,
        StartUtc: `${dStr}T00:00:00Z`,
        EndUtc: `${addDays(dStr, 1)}T00:00:00Z`,
        AdultCount: ADULTS,
        ChildCount: CHILDREN,
        LanguageCode: booking.config.LANG,
        CurrencyCode: booking.config.CURRENCY,
      }), REQUEST_TIMEOUT_MS);
      const rca = (data.RoomCategoryAvailabilities || [])
        .find((r) => r.RoomCategoryId === categoryId);
      if (!rca || (rca.AvailableRoomCount || 0) <= 0) return { available: false };

      let best = null;
      (rca.RoomOccupancyAvailabilities || []).forEach((occ) => {
        (occ.Pricing || []).forEach((p) => {
          const avg = p.Price && p.Price.AverageAmountPerNight &&
            p.Price.AverageAmountPerNight[booking.config.CURRENCY];
          const perNight = avg ? avg.GrossValue : null;
          if (perNight != null && (!best || perNight < best.perNight)) {
            best = { perNight };
          }
        });
      });
      return { available: true, price: best ? Math.round(best.perNight) : null };
    } catch (err) {
      console.warn(`Availability check failed for ${dStr}:`, err.message);
      return { available: null }; // unknown — request failed, don't claim either way
    }
  }

  // ---------- fetch (and cache) a whole month, small parallel batches ----------
  function getMonthNights(y, m) {
    const key = monthKey(y, m);
    if (!monthData.has(key)) monthData.set(key, buildMonthNights(y, m));
    return monthData.get(key);
  }

  async function buildMonthNights(y, m) {
    const nights = new Map();
    const total = daysInMonth(y, m);
    const dates = [];
    for (let d = 1; d <= total; d++) {
      const dStr = dateStr(y, m, d);
      if (dStr < TODAY) nights.set(dStr, { available: false, past: true });
      else dates.push(dStr);
    }

    let idx = 0;
    async function worker() {
      while (idx < dates.length) {
        const my = idx++;
        nights.set(dates[my], await fetchNight(dates[my]));
      }
    }
    const workerCount = Math.min(CONCURRENCY, dates.length) || 1;
    await Promise.all(Array.from({ length: workerCount }, worker));
    return nights;
  }

  // ---------- render ----------
  function renderGrid(nights, y, m) {
    gridEl.innerHTML = "";
    const firstWeekday = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const total = daysInMonth(y, m);

    for (let i = 0; i < firstWeekday; i++) {
      const blank = document.createElement("span");
      blank.className = "cal-day cal-day-blank";
      gridEl.appendChild(blank);
    }

    for (let d = 1; d <= total; d++) {
      const dStr = dateStr(y, m, d);
      const info = nights.get(dStr) || { available: null };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day";

      if (info.past) {
        btn.classList.add("cal-day-past");
        btn.disabled = true;
      } else if (info.available === false) {
        btn.classList.add("cal-day-unavailable");
        btn.disabled = true;
      } else if (info.available == null) {
        btn.classList.add("cal-day-unknown");
        btn.disabled = true;
      } else {
        btn.classList.add("cal-day-available");
        btn.addEventListener("click", () => onDayClick(dStr));
      }

      if (dStr === checkin || dStr === checkout) btn.classList.add("cal-day-selected");
      if (checkin && checkout && dStr > checkin && dStr < checkout) btn.classList.add("cal-day-in-range");

      const num = document.createElement("span");
      num.className = "cal-day-num";
      num.textContent = String(d);
      btn.appendChild(num);

      if (info.available && info.price != null) {
        const price = document.createElement("span");
        price.className = "cal-day-price";
        price.textContent = `$${info.price}`;
        btn.appendChild(price);
      }

      gridEl.appendChild(btn);
    }
  }

  function showLoading(on) {
    loadingEl.hidden = !on;
    gridEl.classList.toggle("is-loading", on);
  }

  function isCurrentOrPastMonth(y, m) {
    const now = new Date();
    return (y < now.getUTCFullYear()) || (y === now.getUTCFullYear() && m <= now.getUTCMonth());
  }

  async function showMonth(y, m) {
    viewYear = y;
    viewMonth = m;
    monthLabelEl.textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", {
      month: "long", year: "numeric", timeZone: "UTC",
    });
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    showLoading(true);

    let nights;
    try {
      nights = await getMonthNights(y, m);
    } catch (err) {
      // A month promise is cached, so a rejection here would otherwise
      // wedge every future view of this month too — drop the bad cache entry.
      monthData.delete(monthKey(y, m));
      console.error(`Failed to load availability for ${monthKey(y, m)}:`, err);
      if (y !== viewYear || m !== viewMonth) return;
      showLoading(false);
      prevBtn.disabled = isCurrentOrPastMonth(y, m);
      nextBtn.disabled = false;
      gridEl.innerHTML = `<p class="cal-error">Could not load availability. Try again.</p>`;
      return;
    }

    // If the user navigated again before this resolved, drop the stale render.
    if (y !== viewYear || m !== viewMonth) return;

    showLoading(false);
    prevBtn.disabled = isCurrentOrPastMonth(y, m);
    nextBtn.disabled = false;
    renderGrid(nights, y, m);
  }

  // ---------- selection state ----------
  function nightsAvailable(fromStr, toStr) {
    let d = fromStr;
    while (d < toStr) {
      const nights = monthData.get(monthKeyOf(d));
      // Not resolved / not fetched yet — caller is responsible for awaiting first.
      const info = nights && typeof nights.get === "function" ? nights.get(d) : undefined;
      if (!info || info.available !== true) return false;
      d = addDays(d, 1);
    }
    return true;
  }

  async function onDayClick(dStr) {
    if (!checkin || checkout) {
      checkin = dStr;
      checkout = null;
    } else if (dStr <= checkin) {
      checkin = dStr;
      checkout = null;
    } else {
      // Ensure every month spanned by the tentative range has resolved data
      // before trusting nightsAvailable() — a range can cross into a month
      // the user hasn't navigated to yet.
      const monthsNeeded = new Set();
      let d = checkin;
      while (d < dStr) { monthsNeeded.add(monthKeyOf(d)); d = addDays(d, 1); }

      showLoading(true);
      for (const mk of monthsNeeded) {
        const [yy, mm] = mk.split("-").map(Number);
        monthData.set(mk, await getMonthNights(yy, mm - 1));
      }
      showLoading(false);

      if (nightsAvailable(checkin, dStr)) {
        checkout = dStr;
      } else {
        selectionEl.textContent = "Some nights in that range aren't available — pick another date.";
        checkin = dStr;
        checkout = null;
      }
    }
    updateSelectionUI();
    const nights = await getMonthNights(viewYear, viewMonth);
    renderGrid(nights, viewYear, viewMonth);
  }

  function updateSelectionUI() {
    if (checkin && checkout) {
      const nights = Math.round((new Date(`${checkout}T00:00:00Z`) - new Date(`${checkin}T00:00:00Z`)) / 86400000);
      selectionEl.textContent = `${fmtDisplay(checkin)} – ${fmtDisplay(checkout)} · ${nights} night${nights === 1 ? "" : "s"}`;
      continueBtn.classList.remove("is-disabled");
      continueBtn.setAttribute("aria-disabled", "false");
      continueBtn.href = booking.distributorUrl({
        start: checkin, end: checkout, adults: ADULTS, children: CHILDREN, categoryId,
      });
    } else if (checkin) {
      selectionEl.textContent = `${fmtDisplay(checkin)} selected — choose your departure date.`;
      continueBtn.classList.add("is-disabled");
      continueBtn.setAttribute("aria-disabled", "true");
      continueBtn.removeAttribute("href");
    } else {
      selectionEl.textContent = "Select your arrival date.";
      continueBtn.classList.add("is-disabled");
      continueBtn.setAttribute("aria-disabled", "true");
      continueBtn.removeAttribute("href");
    }
  }

  continueBtn.addEventListener("click", (e) => {
    if (continueBtn.classList.contains("is-disabled")) e.preventDefault();
  });

  // ---------- open / close ----------
  function openModal(id, name) {
    categoryId = id;
    checkin = null;
    checkout = null;
    titleEl.textContent = name;
    updateSelectionUI();
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("cal-modal-open");
    const now = new Date();
    showMonth(now.getUTCFullYear(), now.getUTCMonth());
  }

  function closeModal() {
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("cal-modal-open");
  }

  modal.querySelectorAll("[data-cal-close]").forEach((el) => el.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("is-open")) closeModal();
  });

  prevBtn.addEventListener("click", () => {
    let y = viewYear, m = viewMonth - 1;
    if (m < 0) { m = 11; y -= 1; }
    showMonth(y, m);
  });
  nextBtn.addEventListener("click", () => {
    let y = viewYear, m = viewMonth + 1;
    if (m > 11) { m = 0; y += 1; }
    showMonth(y, m);
  });

  // ---------- wire up "View availability" links ----------
  document.querySelectorAll("[data-mews-room]").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (!booking.config.hasConfig) {
        window.alert("Distributor is not configured — see js/config.js.");
        return;
      }
      const id = link.getAttribute("data-mews-room");
      const name = link.getAttribute("data-room-name") || "Room";
      openModal(id, name);
    });
  });
})();
