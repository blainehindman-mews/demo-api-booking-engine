/* ============================================================
   The Cascadian — site-wide UI behaviors
   - Sticky/scrolled nav state
   - Hero video crossfade carousel
   - Date defaulting on the booking form
   ============================================================ */

(function () {
  "use strict";

  // ---------- Nav: switch to light bg after scroll past hero ----------
  const header = document.getElementById("site-header");
  if (header) {
    const onScroll = () => {
      header.classList.toggle("scrolled", window.scrollY > window.innerHeight - 120);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ---------- Hero video crossfade carousel ----------
  const stage = document.querySelector(".hero-video-stage");
  if (stage) {
    const videos = Array.from(stage.querySelectorAll(".hero-video"));
    const dots = Array.from(document.querySelectorAll(".hero-dots .dot"));
    const creditEl = document.getElementById("hero-credit");

    let current = 0;
    const SLIDE_MS = 9000;

    function showCredit(i) {
      if (!creditEl) return;
      const v = videos[i];
      creditEl.textContent = v && v.dataset.credit ? v.dataset.credit : "";
    }

    function activate(i) {
      videos.forEach((v, idx) => {
        const on = idx === i;
        v.classList.toggle("active", on);
        if (on) {
          try { v.currentTime = 0; v.play(); } catch (_) {}
        }
      });
      dots.forEach((d, idx) => d.classList.toggle("active", idx === i));
      showCredit(i);
      current = i;
    }

    showCredit(0);

    let timer = setInterval(() => activate((current + 1) % videos.length), SLIDE_MS);

    dots.forEach((d) => {
      d.addEventListener("click", () => {
        clearInterval(timer);
        activate(parseInt(d.dataset.i, 10));
        timer = setInterval(() => activate((current + 1) % videos.length), SLIDE_MS);
      });
    });

    // Pause carousel when the tab is hidden — saves CPU/network
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        clearInterval(timer);
      } else {
        timer = setInterval(() => activate((current + 1) % videos.length), SLIDE_MS);
      }
    });
  }

  // ---------- Booking form: sensible default dates ----------
  const arrival = document.getElementById("arrival");
  const departure = document.getElementById("departure");
  if (arrival && departure) {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    const dayAfter = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    arrival.value = fmt(tomorrow);
    departure.value = fmt(dayAfter);
    arrival.min = fmt(today);
    departure.min = fmt(tomorrow);

    arrival.addEventListener("change", () => {
      const a = new Date(arrival.value);
      const minDep = new Date(a.getTime() + 24 * 60 * 60 * 1000);
      departure.min = fmt(minDep);
      if (new Date(departure.value) <= a) departure.value = fmt(minDep);
    });
  }

  // ---------- Smooth scroll for in-page anchors ----------
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      if (id.length <= 1) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
})();
