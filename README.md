# The Cascadian — Booking Engine

A custom hotel booking site for The Cascadian (Mews demo property), powered by the [Mews Distributor API](https://docs.mews.com/booking-engine).

Plain HTML / CSS / JS — no build step, no dependencies.

## Folder Structure

```
demo-api-booking-engine/
├── index.html              Homepage with video hero + booking widget
├── rooms.html              Rooms & Suites
├── dining.html             Dining
├── experiences.html        Things to do
├── css/
│   ├── main.css            Layout, typography, sections
│   └── booking.css         Booking widget + availability cards
├── js/
│   ├── config.js           DistributorConfigurationId lives here
│   ├── main.js             Nav, hero video carousel, date defaults
│   └── booking.js          Mews Distributor API integration
├── assets/
│   └── videos/             Six Pacific Northwest hero videos (Pexels)
├── download_videos.py      One-shot Pexels downloader
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

> **Note:** The Connector API (used in [demo-api-terminal](https://github.com/)) is PMS-side and carries real credentials — it must never be exposed in browser JS. Distributor and Connector are separate APIs.

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
