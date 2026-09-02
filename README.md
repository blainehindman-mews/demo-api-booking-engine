# The Cascadian — Booking Engine

**Live site:** https://blainehindman-mews.github.io/demo-api-booking-engine/

A custom hotel booking site for The Cascadian (Mews demo property), powered by the [Mews Distributor API](https://docs.mews.com/booking-engine).

Plain HTML / CSS / JS — no build step, no dependencies. Hosted on GitHub Pages.

## Folder Structure

```
demo-api-booking-engine/
├── index.html              Homepage with video hero + booking widget
├── rooms.html              Rooms & Suites
├── dining.html             Dining
├── experiences.html        Things to do
├── pavilion.html       Springer Pavilion — event ticketing
├── css/
│   ├── main.css            Layout, typography, sections
│   ├── booking.css         Booking widget + availability cards
│   └── springer.css        Pavilion page, seat map, API inspector
├── js/
│   ├── config.js           Distributor + Springer ids live here
│   ├── main.js             Nav, hero video carousel, date defaults
│   ├── booking.js          Mews Distributor API integration
│   ├── availability-calendar.js   Per-room month calendar
│   └── springer.js         Event ticketing: guest lookup, seats, charging
├── data/
│   ├── springer-events.json             Events + seeded seat inventory
│   └── springer-demo-reservations.json  Stand-in for Connector responses
├── server/
│   └── springer-proxy.example.js        Reference Connector proxy (not deployed)
├── assets/
│   ├── images/             Pavilion render
│   └── videos/             Six Pacific Northwest hero videos (Pexels)
├── download_videos.py      One-shot Pexels downloader
├── SPRINGER-PAVILION.md  How the ticketing maps onto the Mews API
└── API-docs.md             Links to Mews docs and Swagger
```

## Run locally

The site must be served over HTTP — browsers block `fetch` from `file://`. Any static server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Mews Distributor API

This repo uses the **Distributor API** — the public, anonymous booking-engine surface. No tokens required. All identifiers are browser-safe and live in [`js/config.js`](js/config.js).

The widget calls two endpoints:

- `POST /api/distributor/v1/configuration/get` — hotel info and room categories
- `POST /api/distributor/v1/hotels/getAvailability` — live pricing and availability

Reserve buttons deep-link to the Mews-hosted checkout page — Mews handles payment and reservation creation from there.

> **Note:** The Connector API (used in [demo-api-terminal](https://github.com/blainehindman-mews/demo-api-terminal)) is PMS-side and carries real credentials — it must never be exposed in browser JS. Distributor and Connector are separate APIs.

## Springer Pavilion

[`pavilion.html`](pavilion.html) — a 30-seat venue with a Ticketmaster-style
seat map. A guest enters their surname and confirmation number, gets one seat per
person on their reservation, and the ticket posts to their profile and room folio.

It spans both Mews APIs and shows you which is which as you go: open **Mews API
calls** at the bottom of the modal and every request and response is there, tagged
live or simulated.

- **Catalogue — Connector.** The venue is a Mews *Additional service*; each screening
  is a *Product* on it. `services/getAll` → `products/getAll` → `images/getUrls`.
  This cannot run in the browser: the Distributor API rejects an Additional service
  outright (`Invalid ServiceId.`) and 403s its artwork. Hence the proxy.
- **Guest lookup + charging — Connector.** `reservations/getAll/2023-06-06` →
  `customers/getAll`, then `orders/add` with `LinkedReservationId`.
- **Add-ons — Distributor.** `configuration/get` → `Enterprise.Products[]`, anonymous
  and browser-safe.
- **Seats — neither.** Mews has no seat model. Inventory lives in
  `data/springer-events.json` + `localStorage`, and is burned only once the charge
  succeeds. Mews does not store the showtime either — a Product has no date field —
  so that lives in `SPRINGER_SHOWTIMES` and reaches Mews as `ConsumptionUtc`.

### Running it

```bash
python3 -m http.server 8000                                                # the site
node --env-file=.env server/springer-proxy.example.js                      # :8787
```

Node reads the env file itself, so no token is pasted or echoed. Without the proxy
the page falls back to the local catalogue and says so in a banner.

Two switches in [`js/config.js`](js/config.js) control what touches the real property —
`SPRINGER_LIVE_GUEST_LOOKUP`, and `SPRINGER_LIVE_CHARGE`, which **writes a real order
item to a real guest folio**.

Full reasoning, the verified call shapes, and the known limits:
[`SPRINGER-PAVILION.md`](SPRINGER-PAVILION.md).

For the property-agnostic version — the pattern, the call reference, the flow
design and the gotcha checklist, written to be lifted into another project —
see [`Mews-API-Additional-Services-Tickets.md`](Mews-API-Additional-Services-Tickets.md).

## Re-downloading the hero videos

If `assets/videos/` is empty:

```bash
python3 download_videos.py
```

All six videos are pulled from Pexels (no API key needed) under the
Pexels license. Credits are baked into the homepage footer.

## Credits

Hero videos:
- Alex Moliski — Mt. Rainier trail, Puget Sound ferry
- Climate And Transit — Seattle skyline from ferry
- JeetsVids — Seattle sunrise / Space Needle
- Thomas K — Diablo Lake aerial
- Dean Diemert — Mt. Rainier
