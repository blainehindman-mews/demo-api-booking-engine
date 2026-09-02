# Lovable Context

Hand-off notes for porting this project into Lovable. Read this first — the
architecture is shaped by one hard constraint, and if that constraint is missed
during the port, the result is a working demo that leaks credentials capable of
reading every guest record in the property.

---

## 0. The one thing that must survive the port

**Mews has two APIs, and only one of them may touch a browser.**

| | Distributor API | Connector API |
|---|---|---|
| Auth | a `Client` string + public ids | `ClientToken` + `AccessToken` |
| Scope | one booking-engine configuration | **the entire property, read and write** |
| Safe in frontend code? | **Yes** — anonymous by design | **Never** |

The Connector tokens are not scoped to an endpoint, a guest, or a date. Whoever
holds them can read every guest profile and post charges to any folio. They must
only ever be used from server-side code.

In this repo that server is `server/springer-proxy.example.js`. **In Lovable it
becomes an Edge Function.** That substitution is the whole port. Everything else
is ordinary React work.

> The trap specific to Lovable: Vite inlines every `VITE_`-prefixed variable
> into the client bundle at build time. `VITE_MEWS_ACCESS_TOKEN` is not a
> secret — it is a public string sitting in your JavaScript. See §5.

---

## 1. What the project is

A hotel marketing site (The Cascadian) with two live Mews integrations:

1. **Room booking** — browse room categories and availability, then deep-link to
   the Mews-hosted checkout. Distributor API only. Fully anonymous.
2. **Pavilion Movies event ticketing** — a guest identifies themselves with
   surname + confirmation number, picks seats from a 30-seat map, and the ticket
   is charged to their room folio. Connector API, therefore server-side.

Feature 2 is the interesting one and the reason this document exists.

---

## 2. How it works today

### File map

```
index.html  rooms.html  dining.html          Marketing pages. Static HTML.
experiences.html  pavilion.html

css/main.css                                 Design system: tokens, nav, buttons
css/booking.css                              Availability widget + calendar
css/springer.css                             Pavilion page + seat map

js/config.js                                 ALL configuration + public ids
js/booking.js                                Distributor calls + deep-link builder
js/availability-calendar.js                  Per-room month calendar
js/springer.js                               Ticketing: catalogue, verify, seats, charge
js/main.js                                   Nav scroll state, small page JS

server/springer-proxy.example.js             The Connector proxy. Node, no deps.
                                             ← becomes an Edge Function

data/springer-events.json                    Seat map shape, showtimes, staff holds
data/springer-demo-reservations.json         Offline fixture for guest lookup

.claude/skills/mews-api/SKILL.md             The Mews API skill (see §4)
Mews-API-Additional-Services-Tickets.md      Portable pattern reference
SPRINGER-PAVILION.md                         This property's ticketing architecture
```

### The three layers of the ticketing feature

| Layer | API | Where it runs | Why |
|---|---|---|---|
| Event catalogue | Connector | Server | The Distributor **cannot see** an Additional service |
| Guest verification | Connector | Server | Reads guest PII |
| Charging | Connector | Server | Writes money |
| Upsell add-ons | Distributor | Browser | Anonymous, safe |
| Seat inventory | *neither* | App | Mews has no seat model |

### The finding that forces the server

The event lives in Mews as an **Additional service** (`Pavilion Movies`) whose
**Products** are the tickets (`Back to the Future - Tickets`). The Distributor
API refuses to see any of it — verified, not assumed:

| Call | Result |
|---|---|
| `distributor/configuration/get` | returns only the `Stay` service |
| `distributor/services/getAvailability` | `{"Message":"Invalid ServiceId."}` |
| `distributor/products/getPrices` | `{"Message":"Invalid ProductIds."}` |
| bare image CDN path for the poster | `403 Forbidden` |

So the catalogue read is Connector-only, and there is no anonymous workaround.
Product artwork additionally requires `images/getUrls` — a hand-built CDN URL
403s for anything not published to the Distributor.

### Two things Mews does not model

- **Dates.** A Product has a name, a price, and an image. No date field. The
  showtime lives in `SPRINGER_SHOWTIMES` in `js/config.js`, keyed by ProductId,
  and reaches Mews as `ConsumptionUtc` on the order.
- **Seat inventory.** A Product has a price, not 30 numbered units. The seat
  grid, sold seats, and staff holds live in `data/springer-events.json` plus a
  `localStorage` overlay.

*Mews is the ledger. The app is the calendar and the seating chart.*

### The purchase flow, end to end

```
1. Page load    → Edge Function → services/getAll, products/getAll, images/getUrls
                                  = the event catalogue
2. Preview      → read-only seat map. No identification required.
3. Verify       → Edge Function → reservations/getAll/2023-06-06 { Numbers: ["1036"] }
                                → customers/getAll { CustomerIds: [AccountId] }
                  Checks: surname matches (diacritic-folded), and the stay
                  brackets the showtime. Seat cap = sum(PersonCounts[].Count).
4. Pick seats   → capped at the guest count. Sold + held seats disabled.
5. Review       → ticket + optional Distributor add-ons (uncapped).
6. Charge       → Edge Function → orders/add {
                     ServiceId, AccountId, LinkedReservationId,
                     ConsumptionUtc, Notes, ProductOrders[] }
                  → { OrderId }
7. Commit       → ONLY after OrderId comes back, burn the seats.
```

Step 7 ordering is not stylistic. Charge first, then consume inventory — a
failed charge that already took the seat is far worse than a double-click.

---

## 3. Rules the port must not break

1. **No Connector token in frontend code.** Not in `.env`, not in a `VITE_` var,
   not fetched from an endpoint the browser can call.
2. **Commit inventory only after `orders/add` returns an `OrderId`.**
3. **`LinkedReservationId` is required** on `orders/add`, or the charge doesn't
   reliably attach to the stay and allowances won't apply.
4. **Enterprise scoping differs per endpoint** and a wrong guess is a 400:

   | Form | Endpoints |
   |---|---|
   | plural `EnterpriseIds` | `reservations/getAll/2023-06-06`, `services/getAll`, `products/getAll` |
   | singular `EnterpriseId` | `orders/add` |
   | **neither** (chain-scoped, rejects it) | `customers/getAll`, `images/getUrls` |
5. **Date-range filters cap at 3 months + 1 day** — `{"Message":"The interval must not exceed 3M1D."}`
6. **`ConsumptionUtc` is UTC and the day rolls over.** 21:00 on 14 Aug in
   `America/Los_Angeles` is `2027-08-15T04:00:00Z`.
7. **Keep read-live and write-live as separate switches.** Reading the catalogue
   is harmless; charging is not.

---

## 4. The skills we mapped

### `.claude/skills/mews-api/SKILL.md` — the working reference

Built up by hitting the API and recording what actually happened. It carries the
things no amount of reading the docs would have given us:

- Connector vs Distributor decision table and auth shapes
- **The Distributor `Client` string is allowlisted on demo.** A custom string
  fails with the misleading `"Cannot perform operation or session has expired."`
  Use `"My Client 1.0.0"`.
- The Distributor's blindness to Additional services, with exact error strings
- Per-endpoint enterprise scoping (the table in §3)
- The 3M1D date-range cap
- `orders/add` vs `reservations/addProduct`, and when each is right
- `images/getUrls` being mandatory rather than a nicety
- The booking-engine deep-link spec — `mewsRoom` does nothing without
  `mewsRoute=rates`
- A safe way to smoke-test a live write: POST `orders/add` with a fabricated
  `AccountId`, get `"Invalid AccountId."`, and know the whole route works
  without creating anything

### `Mews-API-Additional-Services-Tickets.md` — the portable pattern

The property-agnostic version: Commander setup, every call with request and
response shapes, the data you must own, the UX flow and why it's shaped that
way, a 15-item gotcha checklist, and the production hardening notes. **This is
the file to feed a fresh project.**

### `SPRINGER-PAVILION.md` — this implementation

Concrete architecture for this property, the verified findings table, and the
known limits.

### Carrying skills into Lovable

Lovable does not run Claude Code skills. Two options, and the second is better:

- **Paste as context.** Drop `Mews-API-Additional-Services-Tickets.md` into the
  chat when you start. It's written to be lifted.
- **Commit them into the repo.** Keep `Mews-API-Additional-Services-Tickets.md`
  and this file at the project root. Lovable reads repo files, and a `README.md`
  that points at both gives every future prompt the same grounding. Anything
  that stays in `.claude/` will be ignored by Lovable — so if the skill content
  matters to you, mirror it to the root.

---

## 5. Environment variables — the part to get right

### Why Vite makes this dangerous

Lovable builds on Vite. Vite exposes **only** variables prefixed `VITE_` to
frontend code, and it does so by **substituting the literal value into the
bundle at build time**. Anyone can read it with View Source.

That prefix is therefore not an access control. It is a *publication* marker:

```
VITE_ANYTHING  →  public. Assume it is printed on a billboard.
no prefix      →  invisible to the frontend. Only Edge Functions see it.
```

### Which value goes where

**Frontend `.env` — public, safe, commit `.env.example`:**

| Variable | Value | Why it's safe |
|---|---|---|
| `VITE_MEWS_DISTRIBUTOR_BASE` | `https://api.mews-demo.com/api/distributor/v1` | public endpoint |
| `VITE_MEWS_ENTERPRISE_ID` | `d73927b5-3500-43a6-9988-b409011e1672` | public identifier |
| `VITE_MEWS_CONFIGURATION_ID` | `602a440b-7c79-4b18-9b4e-b409011e18cc` | public identifier |
| `VITE_MEWS_CLIENT_NAME` | `My Client 1.0.0` | allowlisted demo string |
| `VITE_MEWS_DISTRIBUTOR_PAGE` | `https://app.mews-demo.com/distributor/<cfg>` | public URL |
| `VITE_MEWS_IMAGE_BASE` | `https://cdn.mews-demo.com/Media/Image` | public CDN |
| `VITE_PAVILION_SERVICE_ID` | `fea4735d-7238-427f-bcf5-b4b7011f78ce` | an id, not a credential |
| `VITE_PAVILION_TICKET_PRODUCT_ID` | `ff471e6c-ddfb-44f5-8da7-b4b701201e97` | an id, not a credential |
| `VITE_PAVILION_LIVE_CHARGE` | `false` | see §7 |

These are already public in this repo by design — `js/config.js` is served to
every visitor today and says so in its own comments.

**Edge Function secrets — never `VITE_`, never in `.env`, never committed:**

| Secret | Notes |
|---|---|
| `MEWS_CLIENT_TOKEN` | property-wide |
| `MEWS_ACCESS_TOKEN` | property-wide |
| `MEWS_CONNECTOR_BASE` | `https://api.mews-demo.com` — not secret, but keep it server-side so the client never names a Connector host |
| `MEWS_CLIENT` | e.g. `Cascadian Pavilion 1.0.0` |
| `MEWS_ENTERPRISE_ID` | duplicated server-side so the client can't spoof the property |

Set these in Lovable's secrets manager (or the Supabase dashboard under Edge
Functions → Secrets). They are read with `Deno.env.get("MEWS_CLIENT_TOKEN")`.
**They never appear in any `.env` file in the repo.**

### Where these values are read today — the exact sites

Four files, and only one of them ever touches a secret.

| File | Reads | Notes |
|---|---|---|
| **`.env`** | — | **Exists locally. Gitignored. Will NOT arrive with the push.** Mode 600. Holds the two real tokens. |
| **`.env.example`** | — | Committed. Same keys, values blank. This is what you'll see in the repo. |
| **`server/springer-proxy.example.js`** | `process.env.MEWS_*` | **The only file that reads a secret.** L67–75 config, L156–157 token injection, L166 enterprise scoping. |
| **`js/config.js`** | nothing — values are literals | Public ids, served to every visitor. No secret has ever been here. |
| **`js/springer.js`** | `window.CASCADIAN_CONFIG` | Reads the public config object. Calls the proxy by URL; never sees a token. |

The single place the tokens enter a Mews request —
`server/springer-proxy.example.js` around L150–160:

```js
// Strip anything auth-shaped the client sent, then inject the real values.
// Order matters: our fields must land last so they cannot be overridden.
delete clientBody.ClientToken;
delete clientBody.AccessToken;

const body = Object.assign({}, clientBody, {
  ClientToken: process.env.MEWS_CLIENT_TOKEN,   // ← secret enters here
  AccessToken: process.env.MEWS_ACCESS_TOKEN,   // ← and here
  Client: CLIENT,
  EnterpriseId: process.env.MEWS_ENTERPRISE_ID,
});
```

**Port that block verbatim into the Edge Function.** Swap `process.env.X` for
`Deno.env.get("X")` and change nothing else — the strip-then-inject ordering is
the security property, not a style choice. A caller must not be able to
override the tokens by sending their own.

### The manual step nobody can automate

`.env` is gitignored, so **the tokens do not travel with the GitHub push.** That
is deliberate and correct. Someone has to move them by hand, once:

1. Open the local `.env` in this project (not `.env.example`).
2. Copy the values of `MEWS_CLIENT_TOKEN` and `MEWS_ACCESS_TOKEN`.
3. In Lovable: **Settings → Secrets** (or Supabase → Edge Functions → Secrets),
   add them under the *same names*, no `VITE_` prefix.
4. Add `MEWS_CLIENT`, `MEWS_CONNECTOR_BASE`, `MEWS_ENTERPRISE_ID` there too —
   not secret, but keeping them server-side stops the client naming a Connector
   host or spoofing the property.
5. Redeploy the function. Verify with the fabricated-`AccountId` test in §4
   before enabling charging.

If the secrets are missing, the function should **fail loudly at startup**, the
way the current proxy does — it exits non-zero rather than serving traffic with
no credentials:

```js
for (const key of ["MEWS_CLIENT_TOKEN", "MEWS_ACCESS_TOKEN", "MEWS_ENTERPRISE_ID"]) {
  if (!Deno.env.get(key)) throw new Error(`Missing required secret: ${key}`);
}
```

Silent degradation is worse than a hard failure here. A function that starts
without tokens produces confusing 401s from Mews much later, at the point of
sale.

### A safety note for whoever holds the repo

The tokens now sit in the working tree. `.gitignore` is the only thing between
them and a public repo, and it has been verified with `git add --dry-run .env`,
which refuses the file. Do not defeat it with `git add -f`. If a token ever does
reach a commit, rotating it in Commander is the only real remedy — deleting the
file in a later commit does not remove it from history.

### `.env.example` to commit

```bash
# --- Frontend, PUBLIC. Vite inlines these into the bundle. ---
VITE_MEWS_DISTRIBUTOR_BASE=https://api.mews-demo.com/api/distributor/v1
VITE_MEWS_ENTERPRISE_ID=d73927b5-3500-43a6-9988-b409011e1672
VITE_MEWS_CONFIGURATION_ID=602a440b-7c79-4b18-9b4e-b409011e18cc
VITE_MEWS_CLIENT_NAME=My Client 1.0.0
VITE_MEWS_IMAGE_BASE=https://cdn.mews-demo.com/Media/Image
VITE_PAVILION_SERVICE_ID=fea4735d-7238-427f-bcf5-b4b7011f78ce
VITE_PAVILION_TICKET_PRODUCT_ID=ff471e6c-ddfb-44f5-8da7-b4b701201e97
VITE_PAVILION_LIVE_CHARGE=false

# --- Connector tokens are NOT here and must never be. ---
# They are Edge Function secrets, set in the Lovable/Supabase UI and
# read with Deno.env.get(). Never VITE_-prefixed.
#
#   MEWS_CLIENT_TOKEN      <- property-wide, 64 chars
#   MEWS_ACCESS_TOKEN      <- property-wide, 64 chars
#   MEWS_CLIENT            e.g. "Cascadian Pavilion 1.0.0"
#   MEWS_CONNECTOR_BASE    https://api.mews-demo.com
#   MEWS_ENTERPRISE_ID     d73927b5-3500-43a6-9988-b409011e1672
```

The repo already ships a working `.env.example` in exactly this spirit for the
current Node proxy — read it before writing the Vite one; the comments explain
which half is public and why.

Also add to `.gitignore`:

```
.env
.env.*
!.env.example
```

### A rule of thumb for review

> If you can find the string in the built bundle, it is public.
> `grep -r "$(grep MEWS_ACCESS .env | cut -d= -f2)" dist/` must return nothing.
> If it returns anything, stop and rotate the token.

---

## 6. Mapping this project onto Lovable

| Today | In Lovable |
|---|---|
| 5 static HTML pages | React Router routes; layout component for nav + footer |
| `css/main.css` design tokens | Tailwind theme extension — the palette below |
| `css/springer.css` seat map | A `SeatMap` component; CSS grid is fine as-is |
| `js/config.js` | `src/lib/config.ts`, reading `import.meta.env.VITE_*` |
| `js/booking.js` | `useDistributor()` hook — calls Mews directly, no token |
| `js/springer.js` | `usePavilion()` hook + `PavilionModal` component |
| `server/springer-proxy.example.js` | **Edge Function `mews-connector`** |
| `data/springer-events.json` | Keep as JSON, or a `showtimes` table |
| seat inventory in `localStorage` | **Supabase table** — see below |
| `data/springer-demo-reservations.json` | Keep for the offline fixture path |

### Design tokens to carry over

```js
// tailwind.config.ts → theme.extend.colors
bg: "#faf8f4", ink: "#1e1e1e", inkSoft: "#3a3a3a",
muted: "#6b6b6b", line: "#d8d2c8",
gold: "#a0855b", goldDark: "#7a6442", dark: "#14171a",
// fonts: "Cormorant Garamond" (serif display), "Inter" (sans)
```

### The Edge Function

Port `server/springer-proxy.example.js` almost literally — it's dependency-free
Node HTTP and the logic maps straight onto Deno. Keep all four behaviours:

1. **Allowlist exact paths.** A `Set` of full strings. Not a prefix, not a regex.
   ```
   /api/connector/v1/services/getAll
   /api/connector/v1/products/getAll
   /api/connector/v1/images/getUrls
   /api/connector/v1/reservations/getAll/2023-06-06
   /api/connector/v1/customers/getAll
   /api/connector/v1/orders/add
   ```
2. **Strip client-supplied `ClientToken`/`AccessToken`, then inject yours last**
   so they cannot be overridden by the caller.
3. **Branch enterprise scoping per path** (the §3 table). `customers/getAll` and
   `images/getUrls` must not receive `EnterpriseId`.
4. **Log path and status only.** Never bodies — they carry guest PII and folio data.

Call it from React with `supabase.functions.invoke("mews-connector", { body })`.

### Seat inventory deserves a real table

`localStorage` was right for a laptop demo and is wrong the moment two people
load the page — both can buy seat B3. With Supabase available, do it properly:

```sql
create table pavilion_seats (
  event_id    text not null,       -- Mews ProductId
  seat        text not null,       -- "B3"
  state       text not null,       -- 'sold' | 'held'
  order_id    text,                -- Mews OrderId, null for staff holds
  reservation_number text,
  created_at  timestamptz default now(),
  primary key (event_id, seat)
);
```

The insert is the lock: `(event_id, seat)` is the primary key, so a second buyer
gets a uniqueness violation instead of a double sale. Take the row **before**
calling `orders/add`, and delete it if the charge fails.

Seed the six staff holds currently in `data/springer-events.json`:
`A10, B9, C1, C2, C5, C10` with `state = 'held'`.

Enable RLS: public `select` (everyone sees the map), **no** public `insert` or
`update` — only the Edge Function writes, using the service role key.

---

## 7. Two switches worth keeping

The current build separates *reading live* from *writing live*, and it is the
single most useful thing in the config:

- `SPRINGER_LIVE_GUEST_LOOKUP` — resolve surname + confirmation against real
  reservations, versus the local fixture.
- `SPRINGER_LIVE_CHARGE` — **actually POST `orders/add`**, writing a real order
  item to a real guest folio.

Reading the catalogue is always live; it's harmless and it's the point. Keep
both switches in the port, default `VITE_PAVILION_LIVE_CHARGE=false`, and let
the Edge Function refuse to charge unless its own server-side flag agrees — a
client-side boolean is a UI affordance, not a safety mechanism.

**Both are currently `true` in this repo.** A completed purchase writes to a
real folio on the Mews demo property. Reverse one in Commander or with
`orderItems/cancel`.

---

## 8. Suggested porting order

1. Scaffold the pages and layout. No Mews. Get the design system right.
2. Wire the **Distributor** features — rooms, availability, deep-links. These
   need no backend, so they prove the frontend end to end.
3. Create the Edge Function with the allowlist and secrets. Test the catalogue
   read first: `services/getAll` → `products/getAll` → `images/getUrls`.
4. Build the seat map against the JSON, then move inventory to Supabase.
5. Add verification. Keep the fixture path for when there's no matching booking.
6. Charging **last**, with the live flag off. Smoke-test with a fabricated
   `AccountId` and confirm `"Invalid AccountId."` before ever flipping it on.

---

## 9. A first prompt for Lovable

> Build a luxury hotel site in React + Tailwind: home, rooms, dining,
> experiences, and a Pavilion events page. Serif display type (Cormorant
> Garamond) with Inter for UI, warm off-white `#faf8f4`, ink `#1e1e1e`, muted
> gold accent `#a0855b`, generous whitespace.
>
> The Pavilion page lists film screenings and sells seats to in-house guests.
> Clicking an event opens a modal: (1) optional read-only seat preview,
> (2) verify by surname + confirmation number, (3) a 30-seat map — rows A–C,
> two blocks of five with a centre aisle — capped at the number of guests on
> the booking, (4) review with optional add-ons, (5) charge to the room.
>
> All Mews Connector calls must go through a Supabase Edge Function that holds
> `MEWS_CLIENT_TOKEN` and `MEWS_ACCESS_TOKEN` as secrets. Never put those in
> frontend code or any `VITE_` variable. Distributor API calls can run in the
> browser — they are anonymous.
>
> Read `Mews-API-Additional-Services-Tickets.md` in the repo for the exact
> endpoints, request shapes and gotchas before writing the integration.

---

## 10. Reference

- `Mews-API-Additional-Services-Tickets.md` — the portable pattern. Start here.
- `SPRINGER-PAVILION.md` — this property's architecture and verified findings.
- `server/springer-proxy.example.js` — the proxy to port, heavily commented.
- `.claude/skills/mews-api/SKILL.md` — the full API reference.
- `API-docs.md` — links to Mews docs and Swagger.

Swagger, when you need a shape this document doesn't have:

```bash
curl https://api.mews.com/swagger/connector/swagger.json
curl https://api.mews.com/swagger/distributor/swagger.json
```
