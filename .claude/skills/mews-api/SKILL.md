---
name: mews-api
description: Reference for the two Mews APIs used in this project — the Connector API (trusted PMS-side, ClientToken+AccessToken) and the Distributor API (public booking-engine, ConfigurationId). Use whenever the user mentions Mews, the Cascadian, booking engine work, bills, reservations, availability, room categories, payments, or any HTTP call to api.mews-demo.com / api.mews.com. Covers auth shapes, the Connector vs Distributor decision, key endpoints, request/response field names, the Distributor Client-string allowlist, and the booking-engine deep-link URL spec.
---

# Mews API — working notes

## Two APIs, never confuse them

| | **Connector API** | **Distributor API** |
|---|---|---|
| Purpose | PMS-side: read/write everything | Public-facing booking engine |
| Trust | Trusted; **must never ship to a browser** | Anonymous, browser-safe |
| Auth | `ClientToken` + `AccessToken` + `Client` | `Client` only (string identifier) |
| Demo base URL | `https://api.mews-demo.com/api/connector/v1` | `https://api.mews-demo.com/api/distributor/v1` |
| Prod base URL | `https://api.mews.com/api/connector/v1` | `https://api.mews.com/api/distributor/v1` |
| Auth fields you pass | `ClientToken`, `AccessToken`, `Client` | `Client` (and an Id like `ConfigurationId` or `Ids`) |
| Swagger | `api.mews.com/swagger/connector/swagger.json` | `api.mews.com/swagger/distributor/swagger.json` |

**Rule of thumb:** if it's the operator (hotel staff) acting on a guest's data → Connector. If it's a guest browsing/booking on a public website → Distributor.

---

## Project credentials (Cascadian / demo environment)

All currently stored in [config.py](config.py) (Connector) and [booking-engine/js/config.js](booking-engine/js/config.js) (Distributor). Reuse those — don't hard-code in new files.

| Identifier | Value | Used for |
|---|---|---|
| `EnterpriseId` | `d73927b5-3500-43a6-9988-b409011e1672` | Connector requests scope to this property; Distributor passes it as `Ids[]` / `HotelId` |
| Distributor `ConfigurationId` | `602a440b-7c79-4b18-9b4e-b409011e18cc` | Distributor `/hotels/getAvailability`, deep-link `/distributor/{ConfigId}` |
| Image CDN | `https://cdn.mews-demo.com/Media/Image` | Final URL = `${ImageBaseUrl}/${ImageId}` |
| Hosted booking engine page | `https://app.mews-demo.com/distributor/602a440b-7c79-4b18-9b4e-b409011e18cc` | Deep-link target for Reserve buttons |

---

## Distributor API

### Critical quirk: `Client` string is allowlisted on demo

The demo Distributor only accepts certain `Client` values. Custom strings (e.g. `"Cascadian Booking Engine"`) get rejected with the misleading error:

```json
{"Message":"Cannot perform operation or session has expired."}
```

**Use `"My Client 1.0.0"` on demo.** On production you can use your own client identifier.

### Endpoint: `POST /configuration/get` — "decorate the site"

Returns hotel info + room categories + images. Cache once on page load.

Request:
```json
{
  "Client": "My Client 1.0.0",
  "Ids": ["d73927b5-3500-43a6-9988-b409011e1672"],   // ENTERPRISE id, not Distributor ConfigId
  "LanguageCode": "en-US",
  "FullAmounts": true
}
```

**Watch out:** `Ids[]` takes EnterpriseIds. The Distributor `ConfigurationId` is *returned inside* this response under `Configurations[].Id` — it's the input to the *next* call.

Response shape used:
```
Configurations[0].Enterprise.Name.en-US
Configurations[0].Enterprise.Categories[]
  └─ .Id, .Name, .Description, .ImageIds[],
     .NormalBedCount, .ExtraBedCount, .SpaceType
ImageBaseUrl                  // "https://cdn.mews-demo.com/Media/Image"
```

### Endpoint: `POST /hotels/getAvailability` — "price the search"

Request:
```json
{
  "Client": "My Client 1.0.0",
  "ConfigurationId": "602a440b-7c79-4b18-9b4e-b409011e18cc",
  "HotelId":         "d73927b5-3500-43a6-9988-b409011e1672",   // EnterpriseId AGAIN
  "StartUtc": "2026-05-20T00:00:00Z",
  "EndUtc":   "2026-05-22T00:00:00Z",
  "AdultCount": 2,
  "ChildCount": 0,
  "CurrencyCode": "USD",
  "LanguageCode": "en-US"
}
```

Response shape used:
```
Rates[]                                            // rate plans
  └─ .Id, .Name.en-US

RoomCategoryAvailabilities[]                       // what's bookable
  ├─ .RoomCategoryId                               // joins back to Categories[]
  ├─ .AvailableRoomCount
  └─ .RoomOccupancyAvailabilities[].Pricing[]
       ├─ .RateId                                  // joins to Rates[]
       └─ .Price.AverageAmountPerNight.USD.GrossValue
       └─ .Price.Total.USD.GrossValue
```

Per-night "from $X" = `min(Pricing[].Price.AverageAmountPerNight.USD.GrossValue)` across all rates for that category.

### Endpoint: `POST /reservationGroups/create` — booking

Not currently used in this project — we deep-link to the Mews-hosted Distributor instead (next section). Use this endpoint only if you're building a fully custom checkout flow.

---

## Booking-engine deep link (hand off to Mews for checkout)

When the user clicks Reserve on a custom-built availability card, redirect them to the Mews-hosted Distributor page with query params that pre-fill state. **Mews owns checkout, payment capture, and reservation creation from this point.** No API call needed for the booking itself.

```
GET https://app.mews-demo.com/distributor/{ConfigurationId}
  ?mewsStart=YYYY-MM-DD
  &mewsEnd=YYYY-MM-DD
  &mewsAdultCount=N
  &mewsChildCount=N
  &mewsRoom={RoomCategoryId}    // same UUID returned by /configuration/get
  &mewsRoute=rates               // REQUIRED to skip room-pick; without it mewsRoom is ignored
```

| Param | Type | What it does |
|---|---|---|
| `mewsStart` | `YYYY-MM-DD` | Pre-fills arrival |
| `mewsEnd` | `YYYY-MM-DD` | Pre-fills departure |
| `mewsAdultCount` | int | Pre-fills adults |
| `mewsChildCount` | int | Pre-fills children |
| `mewsRoom` | uuid | Pre-selects a room category |
| `mewsRoute` | `"rates"` | **Required when using `mewsRoom`** — skips room-pick, lands on rate step |
| `mewsVoucherCode` | string | Apply a voucher |

**The non-obvious bit:** `mewsRoom` alone does nothing. Both `mewsRoom` and `mewsRoute=rates` must be set together. Found out the hard way on 2026-05-13.

---

## Connector API (PMS-side)

### Auth

Every request body includes:
```json
{
  "ClientToken": "...",
  "AccessToken": "...",
  "Client": "Python Cascadian API 1.0.0",
  ... other params
}
```

Helper in [config.py](config.py): `call_connector(path, body)` auto-merges these tokens.

### Endpoints we use here

| Endpoint | Purpose | Lives in |
|---|---|---|
| `POST /bills/getAll` | Fetch bills for a customer/date range | `get_bills.py` |
| `POST /bills/close` | Close an open bill (`Type: Receipt` or `Invoice`) | `close_bill.py` |
| `POST /bills/delete` | Delete an empty bill | `delete_bill.py` |
| `POST /payments/addExternal` | Wire transfer / cash / complimentary payment | `process_payment.py` |
| `POST /payments/getAll` | List payments on bills | `get_bills.py` |
| `POST /orderItems/getAll` | List charges on bills | `get_bills.py` |
| `POST /reservations/getAll` | List reservations (filter by state, date range) | `check_paid.py` |
| `POST /customers/getAll` | Resolve names from CustomerIds | `get_bills.py` |
| `POST /accountingCategories/getAll` | Look up wire-transfer category for `payments/addExternal` | `process_payment.py` |

### Amount field convention

Payments use `Amount.GrossValue` (number), not `Amount.Value`. Example:
```json
"Amount": { "Currency": "USD", "GrossValue": 479.04 }
```

Negative `GrossValue` = refund (hotel owes guest). Positive = charge (guest owes hotel).

### Things that are immutable

- **Credit notes** (`CorrectionType: "CreditNote"`) — never touch, never delete
- **Closed bills** (`State: "Closed"`) — never touch, never reissue
- Never call `bills/reissue` — it auto-generates credit notes and makes ledgers messier

### Pagination

Most "getAll" endpoints take `Limitation: { Count: 1000 }`. For very large result sets, paginate via `Cursor` / `Count`.

---

## When in doubt

1. Connector vs Distributor? — Who is the actor: hotel staff (Connector) or guest in a browser (Distributor)?
2. Distributor call returns `"Cannot perform operation or session has expired."`? — Almost always the `Client` string is wrong on demo. Try `"My Client 1.0.0"`.
3. Deep-link doesn't open the right room? — Did you set BOTH `mewsRoom` AND `mewsRoute=rates`?
4. Want to fetch full schemas? — `curl https://api.mews.com/swagger/distributor/swagger.json` or `.../connector/swagger.json`.

See also: [reference_mews_distributor_deep_links.md](../../../../.claude/projects/-Users-blaine-hindman-Library-CloudStorage-OneDrive-Mews-Code-demo-api/memory/reference_mews_distributor_deep_links.md) in auto-memory.
