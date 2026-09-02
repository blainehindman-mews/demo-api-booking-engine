# Claude Context — Mews Booking Engine

## Repo layout

```
demo-api-booking-engine/
├── .claude/skills/mews-api/SKILL.md   ← Mews API skill (Connector + Distributor reference)
├── index.html                         ← Homepage / hero
├── rooms.html                         ← Room category listing
├── dining.html                        ← Dining page
├── experiences.html                   ← Experiences page
├── pavilion.html                  ← Springer Pavilion event ticketing
├── css/
│   ├── main.css                       ← Global styles
│   ├── booking.css                    ← Availability widget styles
│   └── springer.css                   ← Pavilion + seat map
├── js/
│   ├── config.js                      ← Distributor IDs (public, browser-safe)
│   ├── booking.js                     ← Distributor API calls + deep-link builder
│   ├── availability-calendar.js       ← Per-room month calendar
│   ├── springer.js                    ← Ticketing: lookup, seats, charging
│   └── main.js                        ← Page-level JS
├── data/                              ← Event catalogue + Connector fixtures
├── server/                            ← Reference Connector proxy (not deployed)
├── SPRINGER-PAVILION.md           ← Ticketing architecture, this property
├── Mews-API-Additional-Services-Tickets.md  ← Portable reference: the pattern in general
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

**The browser still never holds a Connector token.** Most of the site is Distributor-only.
The Springer Pavilion feature does use the Connector API — it has to, because the
Distributor cannot see an Additional service — but every such call goes through
`server/springer-proxy.example.js`, which injects the tokens server-side. Never move a
Connector call into page JS.

If you touch that feature, read `SPRINGER-PAVILION.md` first.

## Springer Pavilion — two running processes

```bash
python3 -m http.server 8000                                                # the site
node --env-file=.env server/springer-proxy.example.js                      # :8787
```

`js/config.js` has two switches that decide what touches the real property:
`SPRINGER_LIVE_GUEST_LOOKUP` and `SPRINGER_LIVE_CHARGE` (the latter **writes** a real
order item to a real folio). The catalogue is always read live when the proxy is up.

## Distributor API — key facts

- Base URL: `https://api.mews-demo.com/api/distributor/v1`
- No token required — identified by `Client` string + `ConfigurationId`
- **Demo quirk:** the `Client` string must be `"My Client 1.0.0"` on demo (custom strings are rejected)
- Deep-links to Mews-hosted checkout: `mewsRoom` only works when paired with `mewsRoute=rates`
- **It only knows the `Stay` service.** An Additional service, its products and its images
  are invisible: `services/getAvailability` answers `Invalid ServiceId.`, `products/getPrices`
  answers `Invalid ProductIds.`, and the image CDN 403s. Those reads are Connector-only.

## Running locally

```bash
python -m http.server 8000
# then open http://localhost:8000
```
