import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marketAreaForNta, NTA_DATASET } from "../server/adapters/nta.js";
import { guardedPath } from "../server/production-live-guard.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("current DCP NTA authority is available for server-side containment", () => {
  assert.equal(NTA_DATASET, "9nt8-h7nd");
  const nta = read("server/adapters/nta.js");
  assert.match(nta, /features\.length < 250/);
  assert.match(nta, /geometryContains/);
});

// CORRECTED 2026-08-18. This asserted that the current DCP NTA layer must NOT
// reach the map, on the 2026-08-17 reading that the compiled bundle crashes its
// map-control stack on the "Midtown South-Flatiron-Union Square" polygon. Both
// halves of that reading were measured wrong:
//
//   * The original serves that exact polygon, geometry byte-identical to
//     9nt8-h7nd's, to this same bundle, for any bbox that contains it. It serves
//     the current layer for every viewport and caps the answer at 160 features;
//     its no-bbox answer (the one the 08-17 check read) is that cap's tail,
//     which is what the packaged 160-feature file is a capture of.
//   * The bundle renders it. The lot-grid checks that went red were zooming with
//     five timed double-clicks, and driven that way the ORIGINAL fails the same
//     four checks. Zoomed with the map's own control, both draw the grid.
//
// Leaving the router unmounted was not a safe fallback either: the live guard
// answers /api/nta-polys 503 for anything that reaches it, so production served
// no overlay at all. See server/production-nta.js for the full measurement.
test("the current DCP NTA overlay is mounted, ahead of the live guard", () => {
  const server = read("server.js");
  assert.ok(server.includes("app.use(productionNta)"), "the overlay router is mounted");
  const mountAt = server.indexOf("app.use(productionNta)");
  const guardAt = server.indexOf("app.use(productionLiveGuard)");
  assert.ok(guardAt > 0 && mountAt < guardAt,
    "ahead of productionLiveGuard, which otherwise answers /api/nta-polys 503 for every request");
  const nta = read("server/production-nta.js");
  assert.match(nta, /ORIGINAL_FEATURE_CAP\s*=\s*160/,
    "capped where the original caps, so the bundle is never handed more than the original hands it");
});

// Re-pinned 2026-08-19 to the measured selection. This used to require ntaAt,
// plutoTopByBorough and the ten-slice partial-pull guard. Measured against the
// original, none of those is its rule: it selects one PLUTO query per lens and
// ECHOES ?neighborhood= into every item rather than deriving geography (proven
// by ?neighborhood=Chelsea / Hudson Yards returning the same 150 BBLs in the
// same order with only that string changed). Deriving the neighbourhood from
// the NTA layer and then filtering on it is why the same BBL came back as
// "Chelsea / Hudson Yards" where the original says "FiDi / Lower Manhattan".
test("production opportunities never import the authored seed universe", () => {
  const src = read("server/production-opportunities.js");
  assert.ok(!/seed-parcels/.test(src));
  assert.ok(!/curatedAsParcels/.test(src));
  assert.match(src, /plutoRowsToParcels/,
    "the parcel/scoring projection stays shared with the other consumers");
  // The measured selection: one PLUTO query, government owners removed,
  // assesstot DESC, first 150.
  assert.match(src, /soql\(DS\.pluto/);
  assert.match(src, /GOV_RE/, "the government-owner denylist is the measured filter");
  assert.match(src, /\$order: "assesstot DESC"/);
  assert.match(src, /RESULT_LIMIT = 150/);
  assert.match(src, /CITYWIDE_LOT_FLOOR = 225793/, "the measured citywide lot floor");
  assert.match(src, /MULTIFAMILY_LOT_FLOOR = 2101/, "multifamily is the one lens with a floor");
  // A source that cannot answer is unavailable, never a short list.
  assert.match(src, /status\(503\)/);
});

test("official NTA names deterministically map into the immutable frontend market taxonomy", () => {
  assert.equal(marketAreaForNta("Financial District-Battery Park City", "Manhattan"), "FiDi / Lower Manhattan");
  assert.equal(marketAreaForNta("Chelsea-Hudson Yards", "Manhattan"), "Chelsea / Hudson Yards");
  assert.equal(marketAreaForNta("Midtown South-Flatiron-Union Square", "Manhattan"), "Flatiron / NoMad");
  assert.equal(marketAreaForNta("East Midtown-Turtle Bay", "Manhattan"), "Midtown East");
  assert.equal(marketAreaForNta("Upper East Side-Yorkville", "Manhattan"), "Upper East Side (below 96)");
  assert.equal(marketAreaForNta("Carroll Gardens-Cobble Hill-Gowanus-Red Hook", "Brooklyn"), "Gowanus / Park Slope");
  assert.equal(marketAreaForNta("Downtown Brooklyn-DUMBO-Boerum Hill", "Brooklyn"), "Downtown Brooklyn / Fort Greene");
  assert.equal(marketAreaForNta("Bedford-Stuyvesant (West)", "Brooklyn"), "Bushwick / Bed-Stuy");
  assert.equal(marketAreaForNta("Long Island City-Hunters Point", "Queens"), "LIC / Hunters Point");
  assert.equal(marketAreaForNta("Queensbridge-Ravenswood-Dutch Kills", "Queens"), "Astoria / Dutch Kills");
  assert.equal(marketAreaForNta("Woodside", "Queens"), "Sunnyside / Woodside");
  assert.equal(marketAreaForNta("Jamaica Hills-Briarwood", "Queens"), "Jamaica / Queens");
  assert.equal(marketAreaForNta("Inwood", "Manhattan"), null);
});

test("live opportunity owner mounts before the compatibility bundle", () => {
  const src = read("server.js");
  const opps = src.indexOf("app.use(productionOpportunities)");
  const bundle = src.indexOf("app.use(bundleRoutes)");
  assert.ok(opps > 0 && opps < bundle);
});

test("authoritative geospatial and market paths cannot reach the deterministic city model", () => {
  for (const p of [
    "/api/opportunities", "/api/nta-polys", "/api/lot-at", "/api/zip-at",
    "/api/footprints", "/api/assemblage", "/api/territory", "/api/area-detail",
    "/api/market-index", "/api/pipeline", "/api/similar",
    "/api/lot-tiles/17/1/2", "/api/bldg-tiles/17/1/2"
  ]) assert.equal(guardedPath(p), true, `${p} must never fall through to the deterministic city model in production`);
});
