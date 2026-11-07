import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("complete building-footprint owner mounts before capped legacy handlers", () => {
  const server = read("server.js");
  const complete = server.indexOf("app.use(productionBuildingFootprints)");
  const liveExtra = server.indexOf("app.use(productionLiveExtra)");
  const parity = server.indexOf("app.use(parityRoutes)");
  assert.ok(complete > 0 && complete < liveExtra && complete < parity);
});

test("building footprint adapter exhausts BUILDING rather than using a single capped request", () => {
  const src = read("server/adapters/building-footprints-complete.js");
  assert.match(src, /soqlAll\(BUILDING_DATASET/);
  assert.match(src, /pageSize:\s*2000/);
  assert.match(src, /complete !== true/);
});

// Measured on https://nycremarketintel.com 2026-08-18, gated with the site
// password. This test pinned an envelope that was never the original's:
//   original /api/bldg-tiles/16/19298/24633 -> keys [type,tile,count,features]
//     all 244 features' property keys: exactly {bbl,h,yr,bin}
//   original /api/footprints?lat=40.7549&lng=-73.9840 -> keys [lat,lng,features]
//     all feature keys: exactly {bbl,bin,geom}
// The old assertion required `{ features, provenance, source, fetchedAt }` on
// /api/footprints — four keys the original does not publish and one it does
// not (lat/lng). It is re-pinned to the measured shapes.
test("footprint success shapes match the original's measured envelopes", () => {
  const src = read("server/production-building-footprints.js");
  assert.match(src, /type: "FeatureCollection"/);
  assert.match(src, /tile: \{ z, x, y \}/);
  assert.match(src, /return res\.json\(\{ lat, lng, features \}\)/,
    "/api/footprints publishes {lat,lng,features} — no provenance/source/fetchedAt");
  assert.match(src, /\{ bbl: f\.properties\.bbl, bin: f\.properties\.bin, geom: f\.geometry \}/,
    "each footprint publishes exactly bbl, bin and geom");
  assert.match(src, /buildingFootprintFeature/,
    "the existing projector defines feature properties/geometry so completeness does not change the payload contract");
});

test("bldg-tile features carry exactly the original's four properties", () => {
  const src = read("server/production-building-footprints.js");
  // The original publishes no provenance/source/fetchedAt on the tile envelope
  // and no heightRoofFt/provenance/source on a feature.
  const tileHandler = src.slice(src.indexOf('router.get("/api/bldg-tiles'), src.indexOf('router.get("/api/footprints'));
  // The 503 branch keeps provenance: "unavailable" — that is the honest
  // unavailable shape, not a success payload. Only the 200 envelope is pinned.
  const success = tileHandler.slice(tileHandler.indexOf('return res.json({\n    type: "FeatureCollection"'));
  assert.ok(success.length > 0, "success envelope found");
  for (const key of ["provenance:", "source:", "fetchedAt:", "heightRoofFt"]) {
    assert.ok(!success.includes(key), `bldg-tiles must not publish ${key}`);
  }
  assert.match(tileHandler, /bbl: f\.properties\.bbl/);
  assert.match(tileHandler, /h: f\.properties\.h/);
  assert.match(tileHandler, /yr: f\.properties\.yr/);
  assert.match(tileHandler, /bin: f\.properties\.bin/);
});

test("the tile grid has the original's zoom floor and coordinate precision", () => {
  const src = read("server/production-building-footprints.js");
  // z13 -> {"type":"FeatureCollection","features":[],"note":"zoom in"}; z14 -> 5026 features.
  assert.match(src, /const MIN_ZOOM = 14/);
  assert.match(src, /note: "zoom in"/);
  // Original tile 16/19298/24633 feature 0 publishes [-73.992886,40.741978]
  // where 5zhs-2jue holds [-73.992886045488,40.741978470648].
  assert.match(src, /const TILE_COORD_DP = 6/);
});

test("absent height or construction year stays null rather than becoming a measured zero", () => {
  const src = read("server/adapters/mappluto.js");
  // The original publishes yr:null for bins 1015492, 1016254 and 1084663 in
  // tile 16/19298/24633. n(null) is 0 because Number(null) is finite, so the
  // raw column value has to be tested before conversion.
  assert.match(src, /rawYr == null \? null : n\(rawYr\)/);
  assert.match(src, /rawRoofFt == null \? null : n\(rawRoofFt\)/);
  // h is metres to one decimal with no floor: the original publishes h:0 for
  // bin 1084663, whose height_roof is 0.
  assert.match(src, /Math\.round\(roofFt \* 0\.3048 \* 10\) \/ 10/);
  assert.ok(!/Math\.max\(1, Math\.round\(roofFt/.test(src), "no minimum-height clamp");
  // bbl is base_bbl: it matches the original on 244/244 features of that tile,
  // mappluto_bbl on only 199/244.
  assert.match(src, /firstValue\(row, "base_bbl", "mappluto_bbl"/);
});

test("an over-ceiling or incomplete BUILDING pull returns unavailable rather than a clipped FeatureCollection", () => {
  const src = read("server/production-building-footprints.js");
  assert.match(src, /r\.complete !== true/);
  assert.match(src, /status\(503\)/);
  assert.match(src, /building_footprints_incomplete/);
});
