# Springer Pavilion — how this maps onto the Mews API

Event ticketing for in-house guests, charged to the room folio.
Live at [pavilion.html](pavilion.html).

---

## The short answer

The pavilion is a Mews **Additional service**. Each screening's ticket is a
**Product** on that service. Buying seats posts **`orders/add`** with
`LinkedReservationId`, which lands the charge on the guest's profile and the
folio for their stay.

```
POST /api/connector/v1/orders/add
{
  "ServiceId": "9e3c1cb6-db9a-408e-8011-b4b4018448d3",   ← Summer Movie Night
  "AccountId": "<reservation.AccountId>",                 ← whose profile pays
  "LinkedReservationId": "<reservation.Id>",              ← which stay it sits on
  "ConsumptionUtc": "2027-08-15T04:00:00Z",               ← the 9pm curtain, in UTC
  "Notes": "Springer Pavilion · Back to the Future · Seats B3, B4",
  "Options": { "DisableItemGrouping": true },             ← one folio line per seat
  "ProductOrders": [
    { "ProductId": "4becd3a5-2b12-4c10-8899-b4b4018b0bfb", "Count": 2 }
  ]
}
→ { "OrderId": "…" }
```

`AccountId` decides **whose** profile is charged. `LinkedReservationId` decides
**which stay** it's associated with — that's what puts it on the room folio, and
it's a prerequisite for allowances. Without it Mews infers the reservation and
the docs are explicit that the inference isn't guaranteed.

---

## The finding that shapes everything: the Distributor cannot see an Additional service

This was tested, not assumed, against the Cascadian demo enterprise on
2026-08-28:

| Call | Result |
|---|---|
| `distributor/configuration/get` | Returns **one** service, `Stay`, and its six products. The movie service is absent. |
| `distributor/services/getAvailability` with the movie `ServiceId` | `{"Message":"Invalid ServiceId."}` |
| `distributor/services/getPricing` with the movie `ServiceId` | `{"Message":"Invalid ServiceId."}` |
| `distributor/products/getPrices` with the ticket `ProductId` | `{"Message":"Invalid ProductIds."}` |
| `cdn.mews-demo.com/Media/Image/{ticket poster}` | `403 Forbidden` |

The Distributor surface only knows services bound to the booking-engine
configuration — i.e. `Stay`. An Additional service, its products, and its
artwork are all invisible to it, with no token-free workaround.

**So reading the catalogue is Connector-only**, which means it cannot happen in
the browser and has to go through a server. `server/springer-proxy.example.js`
is that server.

---

## Three layers

| Layer | Which API | Runs where |
|---|---|---|
| Event catalogue (service, ticket products, artwork) | **Connector** | Proxy — token required |
| Guest lookup + charging | **Connector** | Proxy — token required |
| Add-ons at checkout | **Distributor** | Browser — anonymous, safe |
| Seat inventory | **Neither** | Your app |

### Catalogue — three Connector calls

```
services/getAll  { ServiceIds: [SPRINGER_SERVICE_ID] }        → the venue
products/getAll  { ServiceIds: [SPRINGER_SERVICE_ID] }        → one product per screening
images/getUrls   { Images: [{ ImageId, Width, Height, ResizeMode }] }
```

`images/getUrls` is not optional. The bare CDN path 403s for a product that
isn't published to the Distributor, so the working URL has to come from Mews.

**Mews does not store the date.** A Product has a name, a price, and an image —
there is no date field anywhere on it or on the service. So the showtime lives
in `CASCADIAN_CONFIG.SPRINGER_SHOWTIMES`, keyed by ProductId, and reaches Mews
as `ConsumptionUtc` on `orders/add` at purchase time. Products with no showtime
configured are skipped rather than rendered undated.

### Guest lookup — two Connector calls

```
reservations/getAll/2023-06-06  { Numbers: ["1036"], States: ["Confirmed","Started"] }
  → .Id, .AccountId, .StartUtc, .EndUtc, .PersonCounts[]
customers/getAll                { CustomerIds: [AccountId] }   → .LastName
```

- `Numbers[]` is the guest-facing confirmation number, so it's one call.
- The seat cap is `sum(PersonCounts[].Count)` — a room booked for two claims two.
- The date check is done in app code rather than via the API's `CollidingUtc`
  filter, so the guest gets *"your stay doesn't cover that night"* instead of an
  indistinguishable *"not found"*.

### Add-ons — Distributor, and genuinely browser-safe

`configuration/get` returns `Enterprise.Products[]` — the six products on the
Stay service, with live prices and images. Those are the checkout add-ons, and
they need no token.

### Seats — not a Mews concept

A Product has a price, not thirty numbered units. There is no seat model in
Mews. Seat inventory lives in `data/springer-events.json` plus a `localStorage`
overlay; the labels ride to Mews in the order's `Notes` and in each
`ProductOrders[].ExternalIdentifier`, so the folio reads
`Springer Pavilion · Back to the Future · Seats B3, B4`.

**Seats are burned only after `orders/add` returns an `OrderId`.** Charge first,
then commit inventory.

Layout is 30 seats: rows A–C, each a block of 5, an aisle, and another block of
5. Change it in `data/springer-events.json` → `seatMap`.

---

## Running it

```bash
python3 -m http.server 8000                                          # the site
node --env-file=.env server/springer-proxy.example.js     # :8787
```

Node reads the env file itself, so no token is ever pasted or echoed. Without
the proxy the page falls back to the local catalogue and prints a banner saying
so.

### The two switches in `js/config.js`

| Flag | Effect when true |
|---|---|
| `SPRINGER_LIVE_GUEST_LOOKUP` | Surname + confirmation resolve against real reservations. Needs a real booking covering the show. |
| `SPRINGER_LIVE_CHARGE` | `orders/add` **actually writes** an order item to a real guest folio. |

The catalogue is always read live when the proxy is up — it's read-only.

Every call, live or simulated, is logged in the modal's **Mews API calls**
panel with the exact request and response bodies.

---

## `orders/add` vs `reservations/addProduct`

| | `reservations/addProduct` | `orders/add` |
|---|---|---|
| Models | A product attached to the *stay* | A product service order consumed at one instant |
| Timing | Spread per the product's `ChargingMode` | `ConsumptionUtc` — a single moment |
| Multiple products | One `ProductId` per call | `ProductOrders[]` + `Items[]` in one call |
| Free-text notes | No | `Notes` — where the seat labels go |

A 9pm screening on one night is a point-in-time consumption, and the ticket plus
its add-ons want to land as one order. `addProduct` is right for a stay add-on
like breakfast, not for an event ticket.

If a ticket Product doesn't exist in Mews yet, the documented rule is to post it
as a custom `Items[]` line instead. `js/springer.js` still does this when no
product resolves, and the API inspector says which form it used.

---

## The rejected alternative: seats as Mews resources

You could model each seat as a **Resource** under a bookable service and let
Mews own the inventory properly — real availability, real overbooking
protection. It's also thirty resources per venue, every ticket becomes a
reservation, and ops inherits thirty "rooms" in the rack. Not worth it at this
size, but it's the honest answer if you ever need Mews itself to arbitrate seat
availability.

---

## Known limits

- **Seat state is per-browser.** `localStorage` means two laptops can buy the
  same seat. Real inventory needs a server-side store with a lock taken before
  `orders/add` and released if it fails. Out of scope for a local PoC.
- **The confirmation number is the only secret.** Fine locally; a public
  deployment needs rate limiting and an identical failure message for
  "not found" and "wrong surname", or it's an enumeration oracle for guest names.
- **No cancellation path.** Refunding means `orderItems/cancel` plus releasing
  the seats. Not built — reverse a live charge in Commander.
- **The proxy is an allowlisted passthrough**, which is a laptop shape, not a
  production one. The file itself documents the production shape.
