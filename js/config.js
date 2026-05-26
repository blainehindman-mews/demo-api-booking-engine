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
};
