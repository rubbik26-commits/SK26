// Territory / Area Detail pinned to the original's published implementation.
//
// The original returns a `sources` array on every /api/territory response in
// which each entry carries the verbatim Socrata URL that produced it. Read
// through the site gate on 2026-08-18, that is the endpoint itself, and
// server/production-territory.js is a transcription of it. These tests pin the
// transcription; docs/release/VERIFICATION.md carries the measured counts.
//
// What this replaced: an implementation that downloaded every lot in the ZIP and
// computed the census in JavaScript, counting one universe (`bldgclass IS NOT
// NULL`) while paging another (the same rows minus every lot MapPLUTO has no
// centroid for) and then requiring the smaller to reach the larger's size. ZIP
// 10001 has 11 such lots, so office / hotels / condo / misc all answered
// HTTP 503 pluto_territory_pagination_incomplete where the original answers 200.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("territory owner is mounted before the older live-extra implementation", () => {
  const src = read("server.js");
  const owner = src.indexOf("app.use(productionTerritory)");
  const older = src.indexOf("app.use(productionLiveExtra)");
  assert.ok(owner > 0 && older > owner);
});

test("the census is a Socrata count, not a client-side tally of downloaded lots", () => {
  const src = read("server/production-territory.js");
  // The header comment names the old failure mode so the history stays legible,
  // so the absence assertions run against code with line comments stripped.
  const code = src.replace(/^\s*\/\/[^\n]*$/gm, "");
  assert.match(src, /\$select:\s*"count\(1\) as n"/, "total lots is count(1)");
  assert.match(src, /count\(1\) as n, sum\(\$\{m\.unitField\}\) as u/, "the qualifying census counts and sums in SQL");
  assert.ok(!/MAX_LOTS/.test(code), "no 6,000-lot cap — the original analyses ZIP 11234's 19,382 lots in full");
  assert.ok(!/pagination_incomplete/.test(code), "and no pagination-completeness gate to fail on a ZIP with no surplus");
  assert.ok(!/liveAreaBuildings/.test(code), "the lot-by-lot download path is gone");
});

test("every lens carries the predicate the original publishes for it", () => {
  const src = read("server/production-territory.js");
  const expect = [
    ["multifamily", /where:\s*"unitsres >= 20"/],
    ["condo", /condo:[\s\S]{0,80}where:\s*cls\("R"\)/],
    ["office", /office:[\s\S]{0,80}where:\s*cls\("O"\)/],
    ["hotels", /hotels:[\s\S]{0,80}where:\s*cls\("H"\)/],
    ["development", /where:\s*"lotarea > 1500 and builtfar < 1\.5 and \(residfar >= 3 or commfar >= 4\)"/],
    ["misc", /misc:[\s\S]{0,80}where:\s*NOT_TRACKED_CLASSES/]
  ];
  for (const [lens, re] of expect) assert.match(src, re, `${lens} predicate`);
  // The sales half is per-lens too: category prefixes and a price floor.
  assert.match(src, /salesCategories:\s*\["07", "08", "14"\]/, "multifamily sale categories");
  assert.match(src, /salesCategories:\s*\["06", "31"\]/, "development sale categories");
  assert.match(src, /salesMinPrice:\s*1000000/, "office and hotels use the higher price floor");
  assert.match(src, /salesSf:\s*"land_square_feet"/, "development prices on land area");
});

test("owner rollups drop MapPLUTO's no-owner placeholders", () => {
  const src = read("server/production-territory.js");
  assert.match(src, /UNAVAILABLE OWNER\|NAME NOT ON FILE/,
    "both placeholders — 'UNAVAILABLE OWNER' holds 83 lots in 11216 and would top every list");
  assert.match(src, /PLACEHOLDER_OWNER\.test/, "and the filter is actually applied to the grouped rows");
});

test("rolling-sales square footage is parsed through its thousands separators", () => {
  const src = read("server/production-territory.js");
  assert.match(src, /replace\(\/,\/g, ""\)/, "commas are stripped before parseFloat");
  assert.match(src, /const sf = sqft\(x\[m\.salesSf\]\)/, "and the sales projector uses it");
});

test("area-detail answers the original's five-key envelope and its 250-row cap", () => {
  const src = read("server/production-territory.js");
  const at = src.indexOf('router.get("/api/area-detail"');
  const body = src.slice(at);
  assert.match(body, /kind,\s*\n\s*mode,/, "kind and mode are top-level keys");
  assert.match(src, /DETAIL_LIMIT = 250/);
  assert.match(body, /owner_required/, "the owner drill-down refuses without its subject, as the original does");
  assert.match(body, /qualifying \$\{m\.detailLabel\} in ZIP \$\{zipLabel\} \(showing up to \$\{DETAIL_LIMIT\}\)/,
    "the coverage sentence is the original's");
});

test("one development score serves every surface, and it is the recovered rule", () => {
  // The original answers ONE score per lot: /api/area-buildings, /api/address,
  // /api/territory and /api/opportunities all agree. This codebase had two
  // scorers and disagreed with itself.
  //
  // Re-pinned 2026-08-19: this asserted the LEAST-SQUARES FIT (31.294 + 64.78 *
  // env …). The rule itself was recovered and the fit is gone. Verified against
  // 2,000 lots the original scores on its own /api/area-buildings across ten
  // ZIPs: the fit reproduced 280 of them, the rule reproduces 2,000 of 2,000
  // exactly (MAE 0.0000, max error 0). Live A/B afterwards: 947 scored rows
  // across area-buildings x3, address, opportunities x3 and territory — every
  // one exact.
  const live = read("server/live.js");
  assert.match(live, /export function devScoreFromReal/);
  assert.doesNotMatch(live, /31\.294 \+ 64\.78 \* env/, "the fit is superseded by the recovered rule");
  // The four capped components, summed and rounded once.
  assert.match(live, /\(unusedFar > 1 && share > 0\.5\) \? 60 \* share : 45 \* share/,
    "both envelope gates are STRICT — 27 lots at share exactly 0.5 and 363 at unusedFar exactly 1.0 take the 45-band");
  assert.match(live, /20 \* clamp01\(log10p1\(scoreNum\(b\?\.lotArea \?\? b\?\.lotSf\)\) \/ LOT_REF\)/);
  assert.match(live, /10 \* clamp01\(log10p1\(scoreNum\(b\?\.assessTotal\)\) \/ ASSESS_REF\)/);
  assert.match(live, /const LOT_SATURATION_SF = 20000;/);
  assert.match(live, /const ASSESS_SATURATION = 50000000;/);
  assert.match(live, /const AGE_UNKNOWN_SHARE = 0\.6;/);
  assert.match(live, /Math\.round\(envelope \+ size \+ assess \+ 10 \* ageShare\)/);
  assert.match(live, /devScoreHeuristicSuperseded/, "the earlier heuristic is retained, not deleted");
  const opps = read("server/opps-live.js");
  assert.match(opps, /function productionOpportunityScore\(p\) \{\s*\n?\s*return devScoreFromReal\(p\);/,
    "opportunities delegates rather than carrying a second copy");
  // The assessed-value term needs an input the opportunity parcel did not carry:
  // without it every opportunity came out exactly ten low (30 -> 20, 96 -> 86).
  assert.match(opps, /assessTotal: num\(r\.assesstot\)/);
  const terr = read("server/production-territory.js");
  assert.match(terr, /score: devScoreFromReal\(b\)/, "territory rows use the same one");
  const area = read("server/area-buildings.js");
  assert.match(area, /export function developmentScore\(b\) \{\s*\n?\s*return devScoreFromReal\(b\);/,
    "area-buildings no longer carries a second scorer");
});

test("maxFar counts facilfar", () => {
  // The original publishes maxFar 4.8 for BBL 3012200047 and 3012080001 — lots
  // whose residfar is 2.43, commfar 0 and facilfar 4.8 — with unusedFar
  // 0.5699999999999994 and 2.01, which are 4.8 minus builtfar. Dropping
  // facilfar understated the envelope on every community-facility lot, and once
  // the recovered score read maxFar it understated the score too: those two
  // came out 34 and 30 against the original's 39 and 49.
  const nyc = read("server/adapters/nyc.js");
  assert.match(nyc, /Math\.max\(num\(r\.residfar\), num\(r\.commfar\), num\(r\.facilfar\)\)/);
});
