---
name: mews-api
description: Reference for the two Mews APIs — the Connector API (trusted PMS-side, ClientToken+AccessToken) and the Distributor API (public booking-engine, ConfigurationId). Use whenever the user mentions Mews, the Cascadian, booking engine work, bills, reservations, availability, room categories, payments, services, products, additional services, tickets, orders, charging to a folio, or any HTTP call to api.mews-demo.com / api.mews.com. Covers auth shapes, the Connector vs Distributor decision, per-endpoint enterprise scoping, date-range caps, key endpoints, request/response field names, the Distributor Client-string allowlist, what the Distributor cannot see, and the booking-engine deep-link URL spec.
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

Distributor identifiers are public and live in `js/config.js`. Reuse them; don't hard-code in new files.

**Connector tokens are not in this repo and must not be.** Supply them at runtime from an
env file the process reads itself — `node --env-file=<path>/.env server.js`, or a `config.py`
that loads it. Never `cat` an `.env`, never echo a token, never pass one through page JS.
To check one is present, test presence (`[ -n "$VAR" ]`) or let the consuming call fail.

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

### Hard limit: the Distributor only sees the booking-engine service

`configuration/get` is scoped to the service the Distributor configuration points at
(here `Stay`). Anything on another service is invisible, and there is no anonymous
workaround. Verified against the Cascadian demo on 2026-08-28 with a real Additional
service (`Summer Movie Night - Back to the Future`):

| Call | Result |
|---|---|
| `services/getAvailability` with that `ServiceId` | `{"Message":"Invalid ServiceId."}` |
| `services/getPricing` with that `ServiceId` | `{"Message":"Invalid ServiceId."}` |
| `products/getPrices` with its ticket `ProductId` | `{"Message":"Invalid ProductIds."}` |
| `cdn.mews-demo.com/Media/Image/{its ImageId}` | `403 Forbidden` |

`services/getAvailability` / `getPricing` *do* work anonymously for the Stay service if
you pass `EnterpriseId` + `ServiceId`. They just refuse anything else.

**So reading an Additional service, its products, or its artwork is Connector-only** —
`services/getAll`, `products/getAll`, `images/getUrls` — and therefore needs a server.
`images/getUrls` is required, not a nicety: the bare CDN path 403s for any product not
published to the Distributor.

**Products have no date.** Name, price, image — that's it. Anything time-based about a
product (a screening's showtime, a slot) is your app's metadata, and reaches Mews as
`ConsumptionUtc` on `orders/add`.

Full pattern — Commander setup, every call, the flow design, the gotcha checklist —
in [Mews-API-Additional-Services-Tickets.md](../../../Mews-API-Additional-Services-Tickets.md).

### `Enterprise.Products[]` — the additional services, free with the config call

`/configuration/get` returns the property's products alongside the room categories.
Verified on the Cascadian demo enterprise — six products, with per-currency gross prices:

```
Configurations[0].Enterprise.Products[]
  └─ .Id, .Name, .Description, .ImageId, .CategoryId
     .IncludedByDefault, .AlwaysIncluded
     .Prices.USD.GrossValue          // and every other AcceptedCurrencyCode
```

This is the browser-safe way to render an add-on/upsell catalogue: no second call,
no token. Note `ImageId` here is singular (categories use `ImageIds[]`).

Also on the top level of the same response, worth knowing about:
`AgeCategories[]` (id → Adults/Teenagers/Children/Seniors — the ids that show up in
Connector `PersonCounts[]`) and `Services[]` (the demo enterprise publishes exactly
one, `Stay` = `ea8419fd-77e4-4d57-9d8f-b409011e185f`).

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

### Enterprise scoping varies by endpoint — get this wrong and you get a 400

There is no single rule. Each Connector endpoint wants one of three things:

| Form | Endpoints |
|---|---|
| Plural `EnterpriseIds: [...]` | `reservations/getAll/2023-06-06`, `services/getAll`, `products/getAll` |
| Singular `EnterpriseId` | `orders/add` |
| **Neither** — chain-scoped, rejects it | `customers/getAll`, `images/getUrls` |

If you're writing a proxy that injects scoping centrally, branch per path. Sending
`EnterpriseId` to a chain-scoped endpoint is an error, not a harmless extra field.

### Date-range filters are capped at 3 months + 1 day

`CollidingUtc`, `CreatedUtc`, `UpdatedUtc`, `ScheduledStartUtc` etc. all reject a wider
window:

```json
{"Message":"The interval must not exceed 3M1D."}
```

Verified: a 92-day window passes, 100 days fails. To sweep a year, walk it in ~88-day
chunks and de-duplicate by reservation `Id` — collisions overlap at the seams.

### `reservations/getAll` — use the dated variant

`POST /reservations/getAll/2023-06-06` is the current version and the one to write
against. The undated `/reservations/getAll` is the legacy shape. The dated one returns
`PersonCounts[]` and accepts `Numbers[]`, `ChannelNumbers[]`, `States[]`.

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
| `POST /reservations/getAll/2023-06-06` | Find a stay by guest-facing confirmation number (`Numbers[]`) | `js/springer.js` |
| `POST /services/getAll` | List services; `Data.Discriminator` = `Bookable` \| `Additional` | `js/springer.js` |
| `POST /products/getAll` | Products on a service — the only way to read a non-Stay catalogue | `js/springer.js` |
| `POST /images/getUrls` | Resolve usable image URLs (bare CDN paths 403) | `js/springer.js` |
| `POST /orders/add` | Post a product/custom item to a folio | `js/springer.js` |
| `POST /orderItems/cancel` | Reverse a posted order item | — |

### Reading a service catalogue (the non-Stay case)

```jsonc
services/getAll  { EnterpriseIds: [...], ServiceIds: [...] }
  → Services[] .Id .Names{lang} .IsActive
               .Data.Discriminator   // "Bookable" (has resources/time units)
                                     // "Additional" (products only, no availability)

products/getAll  { EnterpriseIds: [...], ServiceIds: [...] }
  → Products[] .Id .ServiceId .IsActive
               .Names{lang} / .Name          // map + flattened convenience field
               .Price.GrossValue .NetValue .Currency .TaxValues[]
               .ChargingMode .PostingMode    // "Once" for a one-shot ticket
               .ImageIds[]                   // PLURAL here; Distributor uses .ImageId
               .AccountingCategoryId
```

Filter `IsActive`. Note the `ImageIds[]` / `ImageId` plural-singular flip between the
Connector and Distributor representations of the same product — easy to miss.

### `images/getUrls` — required for anything not published to the Distributor

```jsonc
images/getUrls  { Images: [ { ImageId, Width: 1200, Height: 800, ResizeMode: "Fit" } ] }
  → ImageUrls[] { ImageId, Url }   // "https://cdn…/Media/Image/<id>?Mode=Fit&Width=…"
```

Hand-building `cdn.<env>.mews.com/Media/Image/{ImageId}` works **only** for products
published through the Distributor. For anything else it returns `403 Forbidden`; the
signed URL has to come from this endpoint. Chain-scoped — do not send `EnterpriseId`.

### Charging something to a guest's room

The pattern behind the Springer Pavilion feature (see `SPRINGER-PAVILION.md`):

```
reservations/getAll/2023-06-06  { Numbers: ["30291"], States: ["Confirmed","Started"] }
  → .Id, .AccountId, .StartUtc, .EndUtc, .PersonCounts[{AgeCategoryId, Count}]
customers/getAll                { CustomerIds: [AccountId] }   → .LastName
orders/add                      { ServiceId, AccountId, LinkedReservationId,
                                  ConsumptionUtc, Notes, ProductOrders[] }
  → { OrderId }
```

- `Numbers[]` is the **guest-facing** confirmation number, so the lookup is one call.
- `PersonCounts[]` is how many people are on the booking — the natural cap for
  "one ticket per guest". Sum the counts.
- **`orders/add` vs `reservations/addProduct`:** `addProduct` attaches a product to
  the *stay* and charges it per the product's `ChargingMode`. `orders/add` creates a
  product service order **consumed at a single instant** (`ConsumptionUtc`), takes
  several `ProductOrders[]` at once, and carries free-text `Notes`. Point-in-time
  things (an event ticket, a spa slot) want `orders/add`.
- **`LinkedReservationId` is not optional in practice.** It puts the charge on the
  room folio and it's a prerequisite for allowances. Omit it and Mews *guesses* the
  reservation, with no accuracy guarantee.
- Documented rule for the payload: product **exists** in Mews → `ProductOrders[]`;
  product **doesn't** exist in Mews → `Items[]` (name + `UnitAmount` + `UnitCount`).
- `Options: { DisableItemGrouping: true }` gives one folio line per unit.
- **`AccountId` vs `LinkedReservationId`:** `AccountId` decides *whose* profile/portfolio
  is charged; `LinkedReservationId` decides *which stay* it's associated with. You want
  both. `BillId` can force a specific bill, but rarely should.
- **`ConsumptionUtc` is UTC and the day rolls over.** A 21:00 event in
  `America/Los_Angeles` on 14 Aug is `2027-08-15T04:00:00Z`. Convert from the property's
  `IanaTimeZoneIdentifier`; storing both the local and UTC forms explicitly avoids a
  whole class of off-by-one.
- **Smoke-test a live write without writing anything:** POST `orders/add` with a
  fabricated `AccountId`. Mews answers `{"Message":"Invalid AccountId."}`, which proves
  the route, credentials, `ServiceId` and `ProductId` are all good while creating
  nothing. Validation hits the account before anything else.
- To reverse a posted item: `orderItems/cancel`.

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
5. Connector 400 on a `getAll`? — Check enterprise scoping (plural / singular / neither, table above) before anything else.
6. `"The interval must not exceed 3M1D."`? — A date filter window is wider than 3 months + 1 day. Chunk it.
7. `"Invalid ServiceId."` / `"Invalid ProductIds."` from a *Distributor* call? — You're asking it about a service it can't see. Only the booking-engine service exists to the Distributor; go Connector.
8. Product image 403s? — Use Connector `images/getUrls`; the bare CDN path only works for Distributor-published products.

See also: [reference_mews_distributor_deep_links.md](../../../../.claude/projects/-Users-blaine-hindman-Library-CloudStorage-OneDrive-Mews-Code-demo-api/memory/reference_mews_distributor_deep_links.md) in auto-memory.
