// Regression pins for the five defects confirmed by the 2026-08-17 production
// functionality sweep (98 checks against the deployed service, each failure
// reproduced twice and root-caused in this repository before being fixed).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ---------------------------------------------------------------- defect 1
// /api/transit on a nonexistent BBL answered 503 live_source_unavailable —
// blaming whichever dataset most recently failed anywhere. First corrected to
// a 404, then corrected AGAIN on 2026-08-17 when the A/B diff measured the
// original site directly: it answers 200 with the empty shape
// {"nearest":null,"within":{"quarterMile":0,"halfMile":0}} for retired and
// garbage BBLs alike. The original is the arbiter; the pins now hold that.
test("transit answers the original's empty shape for a missing lot instead of blaming a data source", () => {
  for (const rel of ["server/routes-bundle.js", "server/routes-live.js"]) {
    const src = read(rel);
    const at = src.indexOf('"/api/transit"');
    assert.ok(at > 0, `${rel} defines /api/transit`);
    // Slice ends at the next route declaration so the absence assertion
    // examines the transit handler only, not its neighbours' legitimate 404s.
    const next = src.indexOf("router.get(", at + 1);
    const handler = src.slice(at, next > at ? next : at + 1800);
    assert.match(handler, /plutoByBbl/, `${rel}: the distinction is grounded in whether PLUTO itself answered`);
    assert.match(handler, /nearest: null, within: \{ quarterMile: 0, halfMile: 0 \}/,
      `${rel}: a PLUTO-absent lot gets the original's exact empty shape, 200`);
    assert.ok(!/status\(404\)/.test(handler), `${rel}: no 404 — the original never 404s a well-formed BBL`);
  }
});

// ---------------------------------------------------------------- defect 2
// /api/zap-live was a documented endpoint that answered Express's default HTML
// 404 for every BBL: liveZap() nulls fell past a guard set that did not list
// the path.
test("zap-live answers JSON in all three states and is guarded on outage", () => {
  const live = read("server/routes-live.js");
  const at = live.indexOf('"/api/zap-live"');
  assert.ok(at > 0);
  const handler = live.slice(at, at + 1200);
  assert.match(handler, /parcel_not_found/);
  assert.match(handler, /status\(404\)/);
  const guard = read("server/production-live-guard.js");
  assert.match(guard, /"\/api\/zap-live"/, "outage falls to the guard's honest 503 JSON, not an HTML 404");
});

test("the ZAP project-bbl mapping uses the verified dataset id, catalog only as fallback", () => {
  const src = read("server/adapters/nyc.js");
  assert.match(src, /const ZAP_BBL_MAP = "2iga-a6mk"/);
  const fn = src.slice(src.indexOf("export async function zapByLot"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(body.indexOf("soql(ZAP_BBL_MAP") < body.indexOf("resolveDataset"),
    "the pinned id is tried before the catalog text search that was failing in production");
});

// ---------------------------------------------------------------- defect 3
// The LL84 adapter fell through to three invalid column names whenever a
// building simply had no disclosure, generating guaranteed HTTP 400s that the
// staleness registry then displayed inside unrelated 503 envelopes.
test("LL84 stops probing column candidates once a live column answers empty", () => {
  const src = read("server/adapters/ll84-current.js");
  const loop = src.slice(src.indexOf("for(const field of candidates)"));
  const emptyReturn = loop.indexOf("r.live&&!(r.rows?.length)");
  const rowsReturn = loop.indexOf("r.live&&r.rows?.length");
  assert.ok(emptyReturn > 0, "a live-but-empty response is a terminal answer");
  assert.ok(emptyReturn < rowsReturn, "and it is checked before the rows branch so no further candidates run");
});

// ---------------------------------------------------------------- defect 4
// REVERSED, then the reversal itself corrected on 2026-08-18. The history is
// kept in full because both earlier readings were recorded as settled.
//
// 2026-08-17, first reading: the packaged 160-feature NTA file (one Manhattan
// NTA) was called "empty where data must exist" and a live citywide 2020
// upgrade (9nt8-h7nd, 262 features) shipped.
//
// 2026-08-17, second reading: the browser lot-grid checks (P15.4/5/12/14) went
// red, the failure was bisected to the "Midtown South-Flatiron-Union Square"
// polygon, and the original was queried with NO bbox — which returns its
// citywide answer, the same 160 features as the packaged file. Conclusion
// recorded: the packaged file IS the contract and the live feed crashes the
// bundle. The upgrade was reverted and server/production-nta.js unmounted.
//
// 2026-08-18, measured properly: the original was driven one bbox at a time
// instead of once with none.
//
//   bbox                                     original            live DCP layer
//   -74.00,40.74,-73.97,40.76 (midtown)      200 ·   7 features    8
//   -74.03,40.70,-73.90,40.88 (Manhattan)    200 ·  87 (38 MN)     89 (38 MN)
//   -74.05,40.65,-73.85,40.85 (MN+BK)        200 · 143 (36 MN)    143 (36 MN)
//   -74.10,40.55,-73.70,40.90 (4 boroughs)   200 · 160 (12 MN)    251 (38 MN)
//   -74.26,40.49,-73.68,40.92 (citywide)     200 · 160 ( 1 MN)    262 (38 MN)
//   (no bbox)                                400
//
// The original serves the CURRENT DCP layer and caps the answer at 160. Its
// citywide answer is the truncated tail of that cap — which is exactly what the
// packaged file is a capture of. It also serves "Midtown South-Flatiron-Union
// Square" itself, geometry byte-identical to 9nt8-h7nd's, to this same bundle.
//
// And the bundle renders it. Driven through the browser on 2026-08-18, zooming
// with the map's own control instead of five timed double-clicks:
//   original          → "Lot grid active", 334 lots, canvas 32115/32115, 41 tiles
//   this deployment   → "Lot grid active", 250 lots, canvas 32115/32115, 50 tiles
// Driven with the five double-clicks the suite used, the ORIGINAL fails the
// same four checks. The instrument was measuring how fast the map absorbs
// pointer input, not the grid. tests/browser/maps-geospatial.cjs now zooms
// deterministically and carries that evidence.
//
// So the pinned behavior is: current DCP layer, per bbox, capped at 160.
test("nta-polys serves the current DCP layer per bbox, capped where the original caps it", () => {
  const src = read("server/production-nta.js");
  assert.match(src, /ntasInBbox/, "the current DCP layer is the source");
  assert.match(src, /ORIGINAL_FEATURE_CAP\s*=\s*160/, "capped at the 160 features the original caps at");
  assert.match(src, /slice\(0,\s*ORIGINAL_FEATURE_CAP\)/, "and the cap is actually applied to the response");
  assert.match(src, /postgisConfigured\(\)/, "PostGIS store still answers first when configured");

  // The route has to be reachable. It was correct and simply not mounted, and
  // production-live-guard.js answers /api/nta-polys 503 for anything that gets
  // past every intended owner — so an unmounted router is a total outage, not a
  // fallback. Mounting order is what makes the difference, so assert it.
  const server = read("server.js");
  assert.match(server, /import productionNta from "\.\/server\/production-nta\.js"/, "the router is imported");
  const mountAt = server.indexOf("app.use(productionNta)");
  const guardAt = server.indexOf("app.use(productionLiveGuard)");
  assert.ok(mountAt > 0, "the router is mounted");
  assert.ok(guardAt > 0 && mountAt < guardAt, "and mounted ahead of the live guard, or every request 503s");
});

test("the packaged NTA file is kept, and is what it was measured to be", () => {
  // Retained as the capture of the original's citywide answer that it is — the
  // demo/offline path in server/routes.js still reads it. It is no longer
  // described as the dataset the original draws from, because it is not.
  const raw = JSON.parse(read("server/data/nta-polys.json"));
  const rows = Array.isArray(raw) ? raw : raw.features;
  assert.equal(rows.length, 160, "160 features — the original's CITYWIDE answer, captured");
  const manhattan = rows.filter((f) => f.boro === "Manhattan");
  assert.equal(manhattan.length, 1, "one Manhattan NTA, because the cap truncates before the rest");
  assert.equal(manhattan[0].name, "Financial District-Battery Park City");
});

// ---------------------------------------------------------------- defect 5
// SITE_PASSWORD and OWNER_PASSWORD are set to the same value on the deployed
// service, silently granting every member the owner role. The resolution is a
// config change only the operator can make; the code's job is to say so.
test("status reports gate owner-distinctness without ever exposing a password", () => {
  const src = read("server/production-status.js");
  assert.match(src, /ownerDistinct/);
  assert.match(src, /every member is granted the owner role/i);
  const gateBlock = src.slice(src.indexOf("gate: (() => {"), src.indexOf("subsystems:"));
  assert.ok(gateBlock.length > 0, "gate block present before subsystems");
  assert.match(gateBlock, /memberConfigured: !!site/);
  assert.match(gateBlock, /ownerConfigured: !!owner/);
  assert.ok(!/\$\{site\}|\$\{owner\}|site,\s|owner,\s/.test(gateBlock.replace(/site !== owner|!!site|!!owner|site = |owner = /g, "")),
    "the block only compares and boolean-tests the values; it never emits them");
});

// ------------------------------------------------- 2026-08-17 A/B diff gaps
// Found by the full-surface original-vs-rebuild differ (67 identical probes to
// both live sites): the original accepts ?zip= where this served 400, and the
// original answers ?zips= for ANY ZIP with that ZIP's own scored lots where
// this filtered a fixed universe down to [].
test("area-buildings accepts the singular zip param the original accepts", () => {
  const src = read("server/area-buildings.js");
  assert.match(src, /query\.zips \?\? query\.zip \?\?/, "?zips= wins, ?zip= accepted");
});

// CORRECTED 2026-08-18. The 08-17 fix made the live per-ZIP pull a fallback for
// when intersecting the citywide universe with the ZIP came out exactly empty.
// That fired for 11216 (0 rows) and stayed silent for 10001 (2 rows), so
// ?zips=10001 answered 2 where the original answers 150 — measured on both
// sites the same minute. The original's ZIP answers are not subsets of its
// citywide answer at all (its 11216 list holds Bed-Stuy lots that appear
// nowhere in the bare list), so the pull is unconditional now.
test("a ZIP request is answered from that ZIP's own record, not by filtering the universe", () => {
  const src = read("server/routes-bundle.js");
  const at = src.indexOf('router.get("/api/opportunities"');
  const handler = src.slice(at, src.indexOf('router.get("/api/pipeline"', at));
  assert.match(handler, /plutoByZips\(zipList/, "a live per-ZIP pull");
  assert.match(handler, /plutoRowsToParcels/, "through the identical scoring pipeline");
  assert.ok(!/if \(!list\.length\) \{[\s\S]{0,200}plutoByZips/.test(handler),
    "and it is not gated on the universe intersection being empty");
  assert.match(handler, /universeForZip/, "universe rows for the ZIP are merged on top, not discarded");
});

// ?assetClass= compared against the display `category`, which no value it is
// ever called with can equal. Measured 2026-08-18: the original answers 150
// rows for ?zips=11216&assetClass=multifamily and 29 for
// ?zips=10001&assetClass=development where this answered [] for both. Every
// returned BBL was looked up in PLUTO: the parameter selects on the building
// class letter (C/D, R, O, H, V), and a value outside those five is ignored
// rather than matching nothing.
test("?assetClass= selects on the building class, not on the display category", () => {
  const opps = read("server/opps-live.js");
  assert.match(opps, /export function assetClassOf/, "the class mapping is one exported function");
  assert.match(opps, /export const ASSET_CLASS_SOQL/, "with the matching SoQL predicate per class");
  for (const [cls, letter] of [["multifamily", "C"], ["condo", "R"], ["office", "O"], ["hotels", "H"], ["development", "V"]]) {
    assert.ok(new RegExp(`"${letter}%'`).test(opps) || new RegExp(`'${letter}%'`).test(opps),
      `${cls} is selected by building class ${letter}`);
  }
  // routes-bundle still post-filters on the mapped class. The serving handler
  // (production-opportunities.js, mounted first) now selects in the query
  // instead — measured: the original's lens sets are reproduced exactly by a
  // per-lens SoQL predicate, so there is nothing left to post-filter.
  {
    const src = read("server/routes-bundle.js");
    const at = src.indexOf('router.get("/api/opportunities"');
    const handler = src.slice(at, at + 4000);
    assert.ok(!/category === assetClass/.test(handler), "routes-bundle no longer filters on the display category");
    assert.match(handler, /p\.assetClass === (wantClass|assetClass)/, "routes-bundle filters on the building-class mapping");
  }
  {
    const src = read("server/production-opportunities.js");
    assert.ok(!/category === assetClass/.test(src), "the serving handler never filters on the display category");
    assert.match(src, /const CLASS_PRED = \{/, "it selects on the building class in the query");
    for (const [cls, pred] of [["multifamily", "C%"], ["condo", "R%"], ["office", "O%"], ["hotels", "H%"], ["development", "V%"]]) {
      assert.ok(src.includes(`'${pred}'`), `${cls} selects on building class ${pred}`);
    }
    // Development is V% only: including Z% adds 3 lots the original does not serve.
    assert.ok(!/development: "\(bldgclass like 'V%' or bldgclass like 'Z%'\)"/.test(src));
  }
});
