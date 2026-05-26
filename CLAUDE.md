# Claude Context — Mews Booking Engine

## Repo layout

```
demo-api-booking-engine/
├── .claude/skills/mews-api/SKILL.md   ← Mews API skill (Connector + Distributor reference)
├── index.html                         ← Homepage / hero
├── rooms.html                         ← Room category listing
├── dining.html                        ← Dining page
├── experiences.html                   ← Experiences page
├── css/
│   ├── main.css                       ← Global styles
│   └── booking.css                    ← Availability widget styles
├── js/
│   ├── config.js                      ← Distributor IDs (public, browser-safe)
│   ├── booking.js                     ← Distributor API calls + deep-link builder
│   └── main.js                        ← Page-level JS
├── assets/
│   ├── images/
│   └── videos/                        ← Hero MP4s (large — gitignored if needed)
├── download_videos.py                 ← Helper to fetch video assets
├── API-docs.md                        ← Links to Mews docs and Swagger
└── README.md
```

## Secrets

There are **no secrets** in this repo. The Distributor API is anonymous and browser-safe.
All identifiers (`ConfigurationId`, `EnterpriseId`) are public by design and live in `js/config.js`.

## The Mews API skill

`.claude/skills/mews-api/SKILL.md` is the authoritative reference. Load it before any Mews API work.
This project only uses the **Distributor API** — never the Connector API.

## Distributor API — key facts

- Base URL: `https://api.mews-demo.com/api/distributor/v1`
- No token required — identified by `Client` string + `ConfigurationId`
- **Demo quirk:** the `Client` string must be `"My Client 1.0.0"` on demo (custom strings are rejected)
- Deep-links to Mews-hosted checkout: `mewsRoom` only works when paired with `mewsRoute=rates`

## Running locally

```bash
python -m http.server 8000
# then open http://localhost:8000
```
