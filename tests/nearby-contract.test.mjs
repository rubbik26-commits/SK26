// /api/nearby, pinned to what https://nycremarketintel.com serves.
//
// Measured 2026-08-18 across ten probe points (Midtown, Staten Island, FiDi,
// Bed-Stuy, South Bronx, East Village, Crown Heights, Astoria, Bay Ridge,
// Jamaica), gated with the site password. Before the change this pins, the
// rebuild answered `{buildings}` alone — no lat, no lng, no coverage, no owner
// on any building — computed distanceFt with a flat-earth approximation that
// was wrong by up to 25 ft, and ranked a 120-row page of a Bed-Stuy box that
// holds 500 lots, so its "nearest" lot was 154 ft from the point where the
// original's was 75 ft and 20 of its 24 lots were not the original's.
//
// These are source assertions, not network assertions: the suite must stay
// hermetic. The live A/B that produced the numbers is in the commit message.
//
//   node --test tests/nearby-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("the serving /api/nearby is the one in routes-bundle", () => {
  // Mount order decides. bundleRoutes is the first mount that declares
  // /api/nearby; routes-live.js and routes.js also declare it and are shadowed.
  const server = read("server.js");
  const bundle = server.indexOf("app.use(bundleRoutes)");
  assert.ok(bundle > 0);
  for (const later of ["app.use(liveRoutes)", "app.use(routes)"]) {
    assert.ok(server.indexOf(later) > bundle, `${later} must mount after bundleRoutes`);
  }
});

test("the envelope carries lat, lng, buildings and coverage", () => {
  const src = read("server/routes-bundle.js");
  const handler = src.slice(src.indexOf('router.get("/api/nearby"'));
  assert.match(handler, /lat, lng, buildings: rows/);
  // The original's line, verbatim, with its own count interpolated. It says
  // "1 nearest tax lots" for a single result.
  assert.match(handler, /coverage: `\$\{rows\.length\} nearest tax lots from PLUTO within ~190m of your location\.`/);
});

test("the candidate pool is exhausted, not capped, and refuses to rank a truncated page", () => {
  const nyc = read("server/adapters/nyc.js");
  assert.match(nyc, /export async function plutoBboxAll/);
  assert.match(nyc, /soqlAll\(DS\.pluto/);
  // :id, not bbl: it decides how equal-distance ties break, and the original
  // lists BBL 5000160103 before 5000160041 at Bay Ridge (both 364 ft).
  assert.match(nyc, /\$order: ":id ASC"/);
  const live = read("server/live.js");
  const fn = live.slice(live.indexOf("export async function liveNearby"));
  assert.match(fn, /plutoBboxAll\(/);
  assert.match(fn, /r\.complete !== true\) return null/);
  assert.ok(!/plutoBbox\(lat - d/.test(fn), "the capped plutoBbox must not be used to rank");
});

test("the exhausting bbox keeps lots PLUTO carries no building class for", () => {
  const nyc = read("server/adapters/nyc.js");
  const fn = nyc.slice(nyc.indexOf("export async function plutoBboxAll"), nyc.indexOf("plutoTopByBorough"));
  // The original returns BBL 1005310016 — a row with nothing but bbl,
  // latitude and longitude — 154 ft from (40.7282,-73.9942).
  const where = fn.slice(fn.indexOf("const where ="), fn.indexOf("\n", fn.indexOf("const where =")));
  assert.ok(where.length > 0, "where clause found");
  assert.ok(!where.includes("REAL_LOT"), "no bldgclass IS NOT NULL filter on the ranked pool");
});

test("distance is the haversine whose radius reproduces the original", () => {
  const util = read("server/util.js");
  // Solved from 216 published distanceFt values: the feasible radius window is
  // 20,902,400.85 .. 20,902,647.03 ft and 3958.8 mi = 20,902,464 ft sits in it.
  assert.match(util, /const R = 3958\.8 \* 5280/);
  const live = read("server/live.js");
  // Scoped to liveNearby. liveTransit still uses the 364000/288200
  // equirectangular constants; that is a separate endpoint whose contract has
  // not been measured against the original, so it is left alone here.
  const fn = live.slice(live.indexOf("function nearbyLot"), live.indexOf("export async function liveMarket"));
  assert.match(fn, /haversineFt\(lat, lng, bLat, bLng\)/);
  assert.ok(!/364000|288200/.test(fn),
    "the flat-earth approximation must be gone from the nearby path");
});

test("an absent PLUTO column is omitted, a zero is published", () => {
  const live = read("server/live.js");
  const fn = live.slice(live.indexOf("function nearbyLot"), live.indexOf("export async function liveNearby"));
  // Measured: lot 1005310016 publishes {bbl,address,distanceFt,lat,lng,bearing}
  // with no bldgClass/units/yearBuilt/owner, while lot 3018150007 publishes
  // "units":0 because its unitstotal IS 0.
  assert.match(fn, /row\.bldgclass == null \? undefined : row\.bldgclass/);
  assert.match(fn, /row\.ownername == null \? undefined : row\.ownername/);
  assert.match(fn, /row\.yearbuilt == null \? undefined :/);
  assert.match(fn, /hasUnits \? \(nearbyNum\(row\.unitstotal\) \|\| nearbyNum\(row\.unitsres\) \|\| 0\) : undefined/);
  // A lot with no address publishes an em dash, not an empty string.
  assert.match(fn, /row\.address === "" \? "—" : row\.address/);
});

test("the building key order is the original's", () => {
  const live = read("server/live.js");
  const fn = live.slice(live.indexOf("function nearbyLot"), live.indexOf("export async function liveNearby"));
  const order = ["bbl:", "address:", "bldgClass:", "units:", "yearBuilt:", "distanceFt:", "lat:", "lng:", "owner:", "bearing:"];
  let at = -1;
  for (const key of order) {
    const i = fn.indexOf(key, at + 1);
    assert.ok(i > at, `${key} must follow the previous key — JSON key order is the original's`);
    at = i;
  }
});
