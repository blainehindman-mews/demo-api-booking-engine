#!/usr/bin/env node
/* ============================================================
   Springer Pavilion — Connector API proxy (example)
   ============================================================

   WHY THIS EXISTS
   The three Connector calls the pavilion needs — look up a reservation
   by number, resolve its profile, post an order to the folio — require a
   ClientToken and an AccessToken. Those are property-wide credentials: with
   them you can read every guest and charge every folio. They must never be
   served to a browser, and "obfuscated in the JS bundle" is not an answer.
   So the browser talks to this, and only this talks to Mews.

   Run (Node reads the env file itself — you never paste a token anywhere):

     cp .env.example .env      # then fill in the two tokens
     node --env-file=.env server/springer-proxy.example.js    # listens on :8787

   .env is gitignored; .env.example is committed and holds no values.
   Alternatively point at an env file you already keep elsewhere:
     node --env-file=../demo-api-terminal/.env server/springer-proxy.example.js
   or set them in your shell:
     export MEWS_CLIENT_TOKEN=...      # never commit these
     export MEWS_ACCESS_TOKEN=...
     node server/springer-proxy.example.js

   MEWS_ENTERPRISE_ID defaults to the Cascadian demo property.

   Then in js/config.js:
     SPRINGER_CONNECTOR_PROXY_URL: "http://localhost:8787"

   ------------------------------------------------------------
   ⚠  THIS IS A DEMO SHAPE, NOT A PRODUCTION SHAPE.
   ------------------------------------------------------------
   It is an allowlisted *passthrough*: the browser names the Connector path
   and supplies most of the body. That is fine on a laptop against the demo
   enterprise, and wrong on the public internet — anyone could walk the
   reservation numbers to harvest guest names, or post an order for zero
   seats at a price they chose.

   What you actually ship is two narrow endpoints that never let the client
   name a path or an amount:

     POST /springer/verify    { eventId, lastName, confirmationNumber }
       -> { ok, firstName, roomNumber, maxSeats }        // no ids leaked
       - rate-limit hard per IP; a confirmation number is a 5-digit secret
       - return the SAME generic failure for "no such booking" and "wrong
         surname" so the endpoint can't be used as an enumeration oracle
       - hold the reservationId in a signed, short-lived session cookie

     POST /springer/purchase  { seats: ["A3","A4"] }      // session-scoped
       -> { orderId, seats }
       - the server owns the seat store, re-checks the seats are still free,
         and takes them under a lock/transaction BEFORE calling orders/add
       - the server owns the price and the guest cap; the client sends neither
       - if orders/add fails, release the seats

   Keep the seat store server-side too. The localStorage store in
   js/springer.js is a demo affordance: it is per-browser, so two guests can
   "buy" the same seat. See SPRINGER-PAVILION.md.
   ============================================================ */

"use strict";

const http = require("http");

const PORT = Number(process.env.PORT || 8787);
const MEWS_BASE = process.env.MEWS_CONNECTOR_BASE || "https://api.mews-demo.com";
const CLIENT = process.env.MEWS_CLIENT || "Cascadian Springer 1.0.0";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:8000";

// Fail loudly at boot rather than on the first guest's lookup. We check for
// presence only — the values are never logged, echoed, or returned.
process.env.MEWS_ENTERPRISE_ID =
  process.env.MEWS_ENTERPRISE_ID || "d73927b5-3500-43a6-9988-b409011e1672";

for (const key of ["MEWS_CLIENT_TOKEN", "MEWS_ACCESS_TOKEN", "MEWS_ENTERPRISE_ID"]) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Exactly the paths this feature needs. Not a prefix match, not a regex.
//
// The first three read the event catalogue. They are Connector-only by
// necessity: the Distributor API flatly refuses an Additional service and its
// products — POST distributor/services/getAvailability with the movie's
// ServiceId returns {"Message":"Invalid ServiceId."}, and products/getPrices
// with the ticket returns {"Message":"Invalid ProductIds."}. The Distributor
// surface only knows about services bound to the booking-engine
// configuration, i.e. Stay. Verified 2026-08-28.
const ALLOWED_PATHS = new Set([
  "/api/connector/v1/services/getAll",
  "/api/connector/v1/products/getAll",
  "/api/connector/v1/images/getUrls",
  "/api/connector/v1/reservations/getAll/2023-06-06",
  "/api/connector/v1/customers/getAll",
  "/api/connector/v1/orders/add",
]);

// Endpoints that are chain- or token-scoped rather than enterprise-scoped:
// sending EnterpriseId to these is rejected or ignored.
const NO_ENTERPRISE_ID = new Set([
  "/api/connector/v1/customers/getAll",
  "/api/connector/v1/images/getUrls",
]);

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) { req.destroy(); reject(new Error("Body too large")); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { Message: "POST only" });

  const path = req.url.split("?")[0];
  if (!ALLOWED_PATHS.has(path)) {
    // Deliberately uninformative: don't confirm which paths exist.
    return send(res, 404, { Message: "Not found" });
  }

  let clientBody;
  try { clientBody = await readBody(req); }
  catch (err) { return send(res, 400, { Message: err.message }); }

  // Strip anything auth-shaped the client sent, then inject the real values.
  // Order matters: our fields must land last so they cannot be overridden.
  delete clientBody.ClientToken;
  delete clientBody.AccessToken;

  const body = Object.assign({}, clientBody, {
    ClientToken: process.env.MEWS_CLIENT_TOKEN,
    AccessToken: process.env.MEWS_ACCESS_TOKEN,
    Client: CLIENT,
    EnterpriseId: process.env.MEWS_ENTERPRISE_ID,
  });
  // Some endpoints take the plural form; orders/add takes the singular.
  if (path.includes("/reservations/getAll") ||
      path.endsWith("/services/getAll") ||
      path.endsWith("/products/getAll")) {
    delete body.EnterpriseId;
    body.EnterpriseIds = [process.env.MEWS_ENTERPRISE_ID];
  }
  if (NO_ENTERPRISE_ID.has(path)) {
    delete body.EnterpriseId;
    delete body.EnterpriseIds;
  }

  try {
    const upstream = await fetch(`${MEWS_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { Message: "Upstream returned non-JSON" }; }

    // Log the path and status, never the body — folios and guest profiles
    // do not belong in stdout.
    console.log(`${new Date().toISOString()}  ${path}  ${upstream.status}`);
    return send(res, upstream.status, json);
  } catch (err) {
    console.error(`${path} failed:`, err.message);
    return send(res, 502, { Message: "Upstream request failed" });
  }
});

server.listen(PORT, () => {
  console.log(`Springer Connector proxy on http://localhost:${PORT}`);
  console.log(`  upstream: ${MEWS_BASE}`);
  console.log(`  allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`  allowed paths:\n    ${[...ALLOWED_PATHS].join("\n    ")}`);
});
