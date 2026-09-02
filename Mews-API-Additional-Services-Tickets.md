# Mews API — Additional Services & Tickets

A reference skeleton for selling **timed, seat-or-unit-limited tickets** to
in-house guests and charging them to the room folio, using a Mews **Additional
service** and the **Products** on it.

Written to be lifted into another project. Nothing here is specific to one
property; the GUIDs are placeholders. Every API behaviour described was verified
against a live Mews demo enterprise, and the surprising ones are called out with
the exact error strings they produce.

---

## 1. What Mews models, and what it doesn't

This is the whole design in one table. Get this right and the rest follows.

| Thing | Does Mews own it? | Where it lives |
|---|---|---|
| The venue / experience | ✅ | An **Additional service** |
| The ticket (name, price, tax, artwork) | ✅ | A **Product** on that service |
| Who is charged | ✅ | Reservation → `AccountId` (customer profile) |
| The charge itself | ✅ | An **order** via `orders/add` |
| How many people are on the booking | ✅ | Reservation → `PersonCounts[]` |
| **The date/time of the event** | ❌ | **Your app.** A Product has no date field. |
| **Seat / unit inventory** | ❌ | **Your app.** A Product has a price, not N numbered units. |
| Seat labels on the folio | ~ | Passed through as order `Notes` / `ExternalIdentifier` |

The two ❌ rows are the ones people expect to find in Mews and don't. Plan for
them from the start rather than discovering them halfway through.

**Rule of thumb:** *Mews is the ledger. Your app is the calendar and the
seating chart.* The moment money moves, it moves through Mews; everything about
when and where the guest sits is yours.

---

## 2. Configuring it in Mews (Commander)

1. **Settings → Services → add a service**, type **Additional**. Name it for the
   venue or the event series (e.g. `Summer Movie Night`). Note the `ServiceId`.
2. **Add a Product** on that service — one product per *ticket type* per *event*.
   Set the price (gross/net and tax codes), and upload artwork. Note the `ProductId`.
3. Sensible product settings for a ticket:
   - `ChargingMode: Once` — one charge per unit, not per night.
   - `PostingMode: Once`
   - `AccountingCategoryId` — set it deliberately; it drives tax and reporting.
4. Record the `ServiceId` and each `ProductId` in your app's config.

**Modelling choice: one product per event, or one product per series?**
One product per event is usually right — each screening gets its own price,
artwork, and reporting line, and the order's `ConsumptionUtc` gives it the date.
A single reusable "Event Ticket" product works too, but you lose per-event
revenue reporting and the folio line becomes generic.

---

## 3. The finding that determines your architecture

**The Distributor API cannot see an Additional service.** Not "requires extra
config" — it refuses outright. Verified:

| Call | Result |
|---|---|
| `distributor/configuration/get` | Returns only the service the booking-engine configuration points at (`Stay`) and its products. The Additional service is absent. |
| `distributor/services/getAvailability` with its `ServiceId` | `{"Message":"Invalid ServiceId."}` |
| `distributor/services/getPricing` with its `ServiceId` | `{"Message":"Invalid ServiceId."}` |
| `distributor/products/getPrices` with its ticket `ProductId` | `{"Message":"Invalid ProductIds."}` |
| `cdn.<env>.mews.com/Media/Image/{its ImageId}` | `403 Forbidden` |

Those Distributor service endpoints *do* work anonymously — but only for the
service bound to the booking-engine configuration.

**Consequence: reading your ticket catalogue is Connector-only, so it cannot
happen in a browser.** The Connector API needs `ClientToken` + `AccessToken`,
which are property-wide — with them you can read every guest and charge every
folio. They must never ship to a client. You need a server between the two.

If your app is a static site, this is the single biggest architectural
implication of the whole feature. Budget for the proxy.

---

## 4. Architecture

```
  Browser                    Your server                  Mews
  ────────────────────────────────────────────────────────────────────
  page JS ──────────────────► proxy ──────────────────────► Connector API
             (no tokens)        (injects ClientToken +        services/getAll
                                 AccessToken, allowlists       products/getAll
                                 paths, owns inventory)        images/getUrls
                                                               reservations/getAll
                                                               customers/getAll
                                                               orders/add

  page JS ──────────────────────────────────────────────► Distributor API
             (anonymous, safe)                              configuration/get
                                                            (upsell add-ons only)
```

| Layer | API | Runs where |
|---|---|---|
| Ticket catalogue | Connector | Server |
| Guest verification | Connector | Server |
| Charging | Connector | Server |
| Upsell add-ons | Distributor | Browser (anonymous) |
| Event dates, inventory | — | Your app |

---

## 5. Call reference

### 5.1 Catalogue — what's on sale

```jsonc
POST /api/connector/v1/services/getAll
{ "EnterpriseIds": ["<enterprise>"], "ServiceIds": ["<service>"], "Limitation": { "Count": 10 } }
→ { "Services": [ { "Id", "Names": {"en-US": "…"}, "IsActive",
                    "Data": { "Discriminator": "Additional" } } ] }

POST /api/connector/v1/products/getAll
{ "EnterpriseIds": ["<enterprise>"], "ServiceIds": ["<service>"], "Limitation": { "Count": 100 } }
→ { "Products": [ {
      "Id", "ServiceId", "IsActive",
      "Names": { "en-US": "Back to the Future - Main Ticket" },
      "Descriptions": {},
      "ChargingMode": "Once", "PostingMode": "Once",
      "Price": { "GrossValue": 10.89, "NetValue": 10.00, "Currency": "USD",
                 "TaxValues": [ { "Code": "US-WA-S", "Value": 0.65 } ] },
      "ImageIds": ["<image>"],
      "AccountingCategoryId": "<category>"
    } ] }
```

Filter to `IsActive: true`. `Names` is a language map — pick your locale with a
fallback; `Name` is the flattened convenience field.

### 5.2 Artwork — `images/getUrls` is mandatory, not optional

```jsonc
POST /api/connector/v1/images/getUrls
{ "Images": [ { "ImageId": "<image>", "Width": 1200, "Height": 800, "ResizeMode": "Fit" } ] }
→ { "ImageUrls": [ { "ImageId", "Url": "https://cdn…/Media/Image/<id>?Mode=Fit&Width=1200&Height=800" } ] }
```

Constructing `cdn.<env>.mews.com/Media/Image/{ImageId}` by hand **403s** for any
product not published to the Distributor. The signed URL has to come from Mews.
This endpoint is chain-scoped — do not send `EnterpriseId`.

### 5.3 Verifying the guest

Two calls. Do not try to do it in one.

```jsonc
POST /api/connector/v1/reservations/getAll/2023-06-06
{ "EnterpriseIds": ["<enterprise>"],
  "Numbers": ["1036"],                       // guest-facing confirmation number
  "States": ["Confirmed", "Started"],        // exclude cancelled/optional
  "Limitation": { "Count": 5 } }
→ { "Reservations": [ { "Id", "Number", "AccountId", "State",
                        "StartUtc", "EndUtc", "AssignedResourceName",
                        "PersonCounts": [ { "AgeCategoryId", "Count" } ] } ] }

POST /api/connector/v1/customers/getAll
{ "CustomerIds": ["<AccountId from above>"], "Limitation": { "Count": 1 } }
→ { "Customers": [ { "Id", "FirstName", "LastName", "Email" } ] }
```

Notes that matter:

- **`Numbers[]` is the confirmation number the guest actually has.** One call.
- **`customers/getAll` is chain-scoped** — sending `EnterpriseId` is wrong.
- **The purchase cap is `sum(PersonCounts[].Count)`.** A room booked for two
  claims two tickets. Age category ids resolve via `ageCategories/getAll`, or
  read them off a Distributor `configuration/get` response.
- **Compare surnames folded**: trim, `NFD` normalise, strip combining marks,
  lowercase. `Ökonkwo` must match `okonkwo`.
- **Check the event falls inside the stay yourself**, in app code:
  `reservation.StartUtc <= eventUtc < reservation.EndUtc`. The API offers a
  `CollidingUtc` filter, but doing it locally lets you distinguish *"no such
  booking"* from *"your stay doesn't cover that night"* — a much better error,
  and the difference between a guest retyping and a guest giving up.

### 5.4 Charging — `orders/add`

```jsonc
POST /api/connector/v1/orders/add
{
  "EnterpriseId": "<enterprise>",
  "ServiceId": "<the Additional service>",
  "AccountId": "<reservation.AccountId>",         // WHOSE profile is charged
  "LinkedReservationId": "<reservation.Id>",      // WHICH stay it sits on
  "ConsumptionUtc": "2027-08-15T04:00:00Z",       // the event, in UTC
  "Notes": "Springer Pavilion · Back to the Future · Seats B3, B4",
  "Options": { "DisableItemGrouping": true },     // one folio line per unit
  "ProductOrders": [
    { "ProductId": "<ticket>", "Count": 2, "ExternalIdentifier": "EVT-…-B3-B4" }
  ]
}
→ { "OrderId": "…" }
```

- **`AccountId` vs `LinkedReservationId`.** `AccountId` decides whose profile
  and portfolio is charged. `LinkedReservationId` associates the order with the
  stay — it's what puts the line on the room folio, and it is a **prerequisite
  for allowances**. Omit it and Mews guesses the reservation; the docs state
  plainly that the guess isn't guaranteed.
- **`ConsumptionUtc` is where your event date finally reaches Mews.** Convert
  from the property's local time using its `IanaTimeZoneIdentifier`. A 9pm show
  in `America/Los_Angeles` on 14 Aug is `2027-08-15T04:00:00Z` — note the day
  rolls over, which is an easy off-by-one.
- **`Notes` is where seat labels go.** It's the only free-text field on the
  order, and it's what makes the folio legible to the front desk.
- **`ProductOrders[]` vs `Items[]`** — the documented rule: product exists in
  Mews → `ProductOrders[]`; product does *not* exist → `Items[]` with a `Name`,
  `UnitCount`, and `UnitAmount`. Supporting both means the feature works before
  anyone has created the product, and upgrades cleanly afterwards.
- Multiple products in one order: push the ticket and any add-ons into the same
  `ProductOrders[]` so they land as one order on one bill.

### 5.5 Why `orders/add` and not `reservations/addProduct`

| | `reservations/addProduct` | `orders/add` |
|---|---|---|
| Models | A product attached to the *stay* | A product service order consumed at one instant |
| Timing | Spread per the product's `ChargingMode` | `ConsumptionUtc` — a single moment |
| Multiple products | One `ProductId` per call | `ProductOrders[]` + `Items[]` together |
| Free-text notes | No | `Notes` |

A timed event is a point-in-time consumption. `addProduct` is the right call for
a stay add-on like breakfast, not for a ticket.

### 5.6 Upsell add-ons — the one part that is browser-safe

```jsonc
POST /api/distributor/v1/configuration/get
{ "Client": "<allowlisted client string>", "Ids": ["<enterprise>"],
  "LanguageCode": "en-US", "FullAmounts": true }
→ Configurations[0].Enterprise.Products[]   // id, name, description, ImageId,
                                            // Prices.<CUR>.GrossValue
   ImageBaseUrl                             // these images DO resolve publicly
   AgeCategories[]                          // maps PersonCounts AgeCategoryIds
```

These are the products on the booking-engine service. Anonymous, no token, safe
in page JS — good for "add a bottle of champagne to your evening" at checkout.
Their images work off `ImageBaseUrl/{ImageId}` because they *are* published.

---

## 6. The data your app has to own

Two files, roughly.

**Event definitions** — the showtime Mews won't store, keyed by ProductId:

```jsonc
{
  "seatMap": { "rows": ["A","B","C"], "blocks": [ {"from":1,"to":5}, {"from":6,"to":10} ] },
  "showtimes": {
    "<ProductId>": {
      "startsAtLocal": "2027-08-14T21:00",     // for display
      "startsAtUtc":   "2027-08-15T04:00:00Z", // for ConsumptionUtc
      "runtimeMinutes": 116
    }
  }
}
```

Store **both** the local and UTC forms explicitly rather than converting in the
browser — it removes a whole class of timezone bug, and the UTC value is exactly
what the API wants. A product with no showtime entry should be *skipped*, not
rendered undated.

**Inventory** — which units are gone:

```jsonc
{ "<eventId>": { "B3": { "orderId": "…", "reservationNumber": "1036",
                         "soldAtUtc": "…" } } }
```

**Commit inventory only after `orders/add` returns an `OrderId`.** Charge first,
then burn the seat. Never the reverse — a failed charge that already consumed
inventory is much worse than a double-click.

For anything beyond a local prototype this store belongs on the server, behind a
lock taken *before* `orders/add` and released if it fails. Browser-local storage
means two devices can sell the same seat.

---

## 7. The UX flow, and why it's shaped this way

Four steps in one modal, hidden/shown rather than routed. This sequencing did
the most work:

```
  [card] Select Seats ─────────────► ① Verify ─► ② Pick ─► ③ Review ─► ④ Done
  [card] Preview seats ─► ⓪ Preview ──┘
```

**⓪ Preview (optional, no identification).** A read-only map showing what's
still free, reachable from a small secondary link under the primary button.
People want to know whether it's worth the effort *before* being asked who they
are. It's the same renderer as step ②, called with `interactive: false`, so the
two can never disagree. "Claim Seats" hands straight to ①.

**① Verify before anything else.** Surname + confirmation number. Gating first
means every later step can assume a known guest, a known cap, and a known
folio — no re-validation, no half-filled carts belonging to nobody. Three
distinct failures, each with its own message: *not found* / *surname mismatch* /
*stay doesn't cover this date*. That third one is the one guests actually hit.

**② Pick, with the cap made visible.** Show the entitlement in words before
they start — "2 guests on file, so 2 seats to claim" — and when they exceed it,
explain rather than silently ignoring the click: *"Booking #1036 is for 2
guests… release one to choose another."* Sold units are `disabled`, not just
styled.

**③ Review, then charge.** Restate seats, guest, room, and total. This is where
the Distributor upsell products appear — unrestricted quantity, since only the
seats are capped by occupancy. One button, one order.

**④ Confirmation** with the seat labels and the returned `OrderId`.

Three implementation notes worth carrying over:

- **Steps are hidden, not unmounted — so guard every handler.** A hidden
  button's click handler still fires. The charge path must independently assert
  "verified reservation exists", "at least one seat", "seats ≤ cap" rather than
  trusting that the user could only have got there legitimately. This was a real
  bug: charging from a step the user wasn't looking at produced a completed
  state and an order with zero seats.
- **Never use `alert()` for API errors.** It blocks, it can't be styled, and it
  breaks headless testing. Inline error slots per step.
- **Scope DOM queries when two grids coexist.** Preview and picker both carry
  `[data-seat]`; an unscoped `querySelector` silently hits the disabled one.

---

## 8. Config surface worth copying

```js
SERVICE_ID:            "<additional service>",
TICKET_PRODUCT_ID:     "<ticket product>",   // or resolve per event
CONNECTOR_PROXY_URL:   "http://localhost:8787",  // blank => run mocked
SHOWTIMES:             { "<ProductId>": { startsAtLocal, startsAtUtc, … } },

LIVE_GUEST_LOOKUP:     false,   // real reservations vs local fixture
LIVE_CHARGE:           false,   // ⚠ true WRITES to a real folio
```

Separating **read-live** from **write-live** is the single most useful thing in
this list. The catalogue can always be read live — it's harmless. Guest lookup
and charging are opt-in, independently, so you can demo the whole flow against
real products and real guests without posting anything, then flip one flag when
you actually mean it.

Keep a mock that answers the same Connector paths with the same response shapes
from a fixture file. Swapping mock for real then becomes a config change instead
of a rewrite, and the feature stays demoable with the proxy switched off.

### Testing a live charge without writing

Send `orders/add` through the proxy with a deliberately fabricated `AccountId`.
Mews answers `{"Message":"Invalid AccountId."}` — which proves the route, the
credentials, the `ServiceId` and the `ProductId` are all accepted, while
creating nothing. A genuinely safe end-to-end smoke test of the write path.

---

## 9. The proxy

Minimum viable, and each point matters:

- **Allowlist exact paths.** A set of full path strings — not a prefix match,
  not a regex, and never an open passthrough.
- **Strip client-supplied `ClientToken`/`AccessToken`, then inject yours**, with
  your fields applied *last* so they can't be overridden.
- **Normalise enterprise scoping per endpoint.** `orders/add` takes singular
  `EnterpriseId`; `reservations/getAll`, `services/getAll`, `products/getAll`
  take plural `EnterpriseIds`; `customers/getAll` and `images/getUrls` take
  neither (chain-scoped) and will reject it.
- **Load credentials from the environment, never from a file you read yourself.**
  `node --env-file=.env server.js` keeps the values out of your shell history,
  your logs, and your terminal.
- **Log path and status only.** Never bodies — they contain guest profiles and
  folio data.

**An allowlisted passthrough is a prototype shape.** In production the client
should never name a Connector path or an amount. Expose two narrow endpoints
instead:

```
POST /events/verify    { eventId, lastName, confirmationNumber }
  → { ok, firstName, roomNumber, maxSeats }        // no ids leaked to the client
  - hold reservationId in a signed, short-lived session
  - rate-limit hard; return an IDENTICAL failure for "no such booking" and
    "wrong surname", or you've built an enumeration oracle for guest names

POST /events/purchase  { seats: [...] }             // session-scoped
  → { orderId, seats }
  - the server owns the price, the cap and the seat store
  - take the seats under a lock BEFORE orders/add; release them if it fails
```

---

## 10. Gotcha checklist

- [ ] Distributor **cannot** see an Additional service — `Invalid ServiceId.`
- [ ] Product images **403** on the bare CDN path — use `images/getUrls`
- [ ] Products have **no date** — you own the calendar; it reaches Mews as `ConsumptionUtc`
- [ ] Products have **no inventory** — you own the seat map
- [ ] `ConsumptionUtc` is UTC — an evening event often rolls to the next day
- [ ] `customers/getAll` / `images/getUrls` are chain-scoped — no `EnterpriseId`
- [ ] `reservations/getAll` uses `Numbers[]` for the guest-facing number
- [ ] Filter `States` to `Confirmed` + `Started` so cancelled bookings can't buy
- [ ] Cap from `sum(PersonCounts[].Count)`
- [ ] Fold diacritics and case when matching surnames
- [ ] `LinkedReservationId` or allowances silently won't apply
- [ ] Commit inventory only *after* `OrderId` comes back
- [ ] Guard hidden-step handlers — they still fire
- [ ] `CollidingUtc` windows are capped; page long date ranges in chunks
- [ ] Distributor `Client` string is allowlisted on demo — use a standard one

---

## 11. Not covered here

- **Cancellation / refunds.** `orderItems/cancel` plus releasing the seats.
- **Payment capture.** This flow charges to folio; it settles at checkout. Taking
  a card up front is a different flow entirely.
- **Non-guests.** Everything here keys off an existing reservation. Selling to
  the public means creating a customer profile and an account to charge.
- **Overbooking protection inside Mews.** If you truly need Mews to arbitrate
  availability, model each unit as a **Resource** under a bookable service —
  real inventory, at the cost of every ticket becoming a reservation and your
  ops team inheriting N "rooms" in the rack. Rarely worth it below a few hundred
  units.
