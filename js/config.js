// Mews Distributor configuration for The Cascadian Hotel.
//
// The Distributor API is anonymous: no token, no AccessToken. The request
// is identified by the EnterpriseId (passed as Ids/HotelId) and scoped to
// the published booking-engine instance via DISTRIBUTOR_CONFIGURATION_ID.
//
// IMPORTANT: these are NOT the Connector API ClientToken / AccessToken
// used in the Python scripts. Distributor is a separate, browser-safe API.
window.CASCADIAN_CONFIG = {
  // From Mews Commander → Integrations → Distributor → Configuration ID.
  // Used as `ConfigurationId` on /hotels/getAvailability + /reservationGroups/create.
  DISTRIBUTOR_CONFIGURATION_ID: "602a440b-7c79-4b18-9b4e-b409011e18cc",

  // The Cascadian Hotel enterprise id. Used as:
  //   - `Ids: [ENTERPRISE_ID]`  on /configuration/get
  //   - `HotelId: ENTERPRISE_ID` on /hotels/getAvailability
  ENTERPRISE_ID: "d73927b5-3500-43a6-9988-b409011e1672",

  DISTRIBUTOR_BASE_URL: "https://api.mews-demo.com/api/distributor/v1",

  // IMPORTANT on demo: the Mews demo Distributor allowlists specific Client
  // strings. Custom values like "Cascadian Booking Engine" are rejected with
  // "Cannot perform operation or session has expired." Stick to the standard
  // demo client string. Production uses your own client identifier.
  CLIENT_NAME: "My Client 1.0.0",

  LANGUAGE_CODE: "en-US",
  DEFAULT_CURRENCY: "USD",

  // Image CDN. Image URLs are `${IMAGE_BASE_URL}/${imageId}`.
  IMAGE_BASE_URL: "https://cdn.mews-demo.com/Media/Image",

  // Mews-hosted Distributor booking engine URL. Reserve buttons deep-link
  // here with query params (mewsStart / mewsEnd / mewsAdultCount /
  // mewsChildCount / mewsRoomCategoryId) that pre-fill dates, occupancy,
  // and the chosen category. Mews handles checkout + payment from there.
  // Production swap: https://app.mews.com/distributor/{ConfigurationId}
  DISTRIBUTOR_PAGE_URL: "https://app.mews-demo.com/distributor/602a440b-7c79-4b18-9b4e-b409011e18cc",

  // ---- Springer Pavilion (event ticketing) -------------------------
  // The pavilion is a Mews **Additional service**; each screening's ticket
  // is a **Product** on it. Real ids from the Cascadian demo enterprise:
  //
  //   Service  "Pavilion Movies"              (type: Additional)
  //   Product  "Back to the Future - Tickets"  $10.89 gross
  //
  // IMPORTANT: neither is reachable from the browser. The Distributor API only
  // knows about services bound to the booking-engine configuration (i.e. Stay)
  // and rejects these outright — services/getAvailability answers
  // {"Message":"Invalid ServiceId."} and products/getPrices answers
  // {"Message":"Invalid ProductIds."}. Reading them is Connector-only, so the
  // catalogue arrives through SPRINGER_CONNECTOR_PROXY_URL below.
  SPRINGER_SERVICE_ID: "fea4735d-7238-427f-bcf5-b4b7011f78ce",
  SPRINGER_TICKET_PRODUCT_ID: "ff471e6c-ddfb-44f5-8da7-b4b701201e97",

  // Fallback only, used when no proxy is configured: scan the Distributor
  // product catalogue for a name matching this before falling back to the
  // per-event price in data/springer-events.json.
  SPRINGER_TICKET_NAME_MATCH: "ticket|amphitheat|springer|admission",

  // Connector calls CANNOT run in the browser (ClientToken + AccessToken must
  // stay server-side). This points at the local proxy, which injects the
  // tokens — see server/springer-proxy.example.js. Start it with:
  //   cp .env.example .env    # fill in the two Connector tokens
  //   node --env-file=.env server/springer-proxy.example.js
  // Blank => js/springer.js falls back to its built-in mock Connector and the
  // local event catalogue in data/springer-events.json.
  SPRINGER_CONNECTOR_PROXY_URL: "http://localhost:8787",

  // --- What actually talks to your live Mews property -------------------
  // The catalogue (services/products/images) is always read live when the
  // proxy is up — it's read-only and it's the whole point. These two control
  // the parts that touch guest data and money.
  //
  // Live lookup: resolve the surname + confirmation number against real
  // reservations on the property. Requires a real booking covering the night
  // of the screening — for the 14 Aug 2027 show that means a stay whose
  // StartUtc/EndUtc bracket 2027-08-15T04:00:00Z (i.e. arriving 14 Aug,
  // departing 15 Aug or later). Set false to fall back to the local fixture
  // in data/springer-demo-reservations.json.
  SPRINGER_LIVE_GUEST_LOOKUP: true,

  // Live charge: actually POST orders/add. This WRITES a real order item to a
  // real guest folio on the demo property. To reverse one, cancel it in
  // Commander or call Connector orderItems/cancel with the returned ids.
  // Set false to build the request, show it in the API inspector, and answer
  // it locally without touching Mews.
  SPRINGER_LIVE_CHARGE: true,

  // A Mews Product carries a name, price and image — but NO date. So the
  // showtime for each screening lives here in the app, keyed by ProductId,
  // and reaches Mews as `ConsumptionUtc` on orders/add at purchase time.
  // (Local time at the property, America/Los_Angeles.)
  SPRINGER_SHOWTIMES: {
    "ff471e6c-ddfb-44f5-8da7-b4b701201e97": {
      startsAtLocal: "2027-08-14T21:00",
      startsAtUtc:   "2027-08-15T04:00:00Z",
      runtimeMinutes: 116,
      kind: "Open-Air Cinema",
      description:
        "Marty McFly and the DeLorean, projected onto the pavilion's stone " +
        "back-wall as the light goes off Puget Sound. Blankets and a cedar-smoke " +
        "fire pit provided; the bar stays open through the credits.",
      image: "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1600&q=80",
    },
  },
};
