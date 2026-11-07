import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("distress authoritative owner mounts before bounded legacy handler", () => {
  const server = read("server.js");
  const complete = server.indexOf("app.use(productionDistressComplete)");
  const bounded = server.indexOf("app.use(productionDistressTax)");
  assert.ok(complete > 0 && bounded > complete);
});

test("complete distress evidence exhausts all five official source families", () => {
  const src = read("server/adapters/distress-complete.js");
  assert.match(src, /completeHpdViolationsByBbl/);
  assert.match(src, /soqlAll/);
  assert.match(src, /DOB Safety Violations/);
  assert.match(src, /DOB Violations \(BIS\)/);
  assert.match(src, /DOB ECB\/OATH Violations/);
  assert.match(src, /complete311ByBbl/);
  assert.match(src, /maxRows/);
});

// Re-pinned 2026-08-19. This asserted the capped transport lists
// (records: hpdRows.slice(0, 100) and the truncated flags) that /api/distress
// used to publish. It does not any more, because the original does not:
// measured across six BBLs its envelope is EXACTLY hpd, ecb and threeOneOne,
// each of them null rather than a zeroed object when it has nothing to report.
// What the test is really guarding — that the counts come off the COMPLETE
// arrays, not off a slice — is re-pinned on the counts themselves.
test("counts are computed from the complete arrays", () => {
  const src = read("server/production-distress-complete.js");
  assert.match(src, /openHpd\.length/);
  assert.match(src, /activeSafety\.length \+ activeLegacy\.length/);
  assert.match(src, /activeEcb\.length/);
  assert.match(src, /q311\.length/);
  assert.doesNotMatch(src, /records: hpdRows\.slice/,
    "the record lists the original never publishes must stay gone");
  // Nothing is sliced before it is counted: every count above reads the array
  // the adapter exhausted.
  const countsAt = src.indexOf("const factors");
  // lastIndexOf: the early non-parcel return is also a res.json.
  const publishAt = src.lastIndexOf("return res.json({");
  assert.ok(countsAt > 0 && publishAt > countsAt);
});

test("the published distress envelope is the original's three keys, nulled when empty", () => {
  const src = read("server/production-distress-complete.js");
  assert.match(src, /hpd: hpdRows\.length \? \{ open: openHpd\.length, total: hpdRows\.length, heatOpen: heatOpenHpd \} : null/);
  assert.match(src, /ecb: activeEcb\.length \? \{ unresolved: activeEcb\.length, balanceDue: Math\.round\(ecbBalance\) \} : null/);
  assert.match(src, /const TOP_CATEGORIES = 4;/,
    "1008350041 has 124 complaints over more than five types and the original publishes four");
});

test("any incomplete distress source returns unavailable rather than a clean zero", () => {
  const src = read("server/production-distress-complete.js");
  assert.match(src, /if \(!evidence\.live\)/);
  assert.match(src, /status\(503\)/);
  assert.match(src, /Missing or truncated sources are not treated as zero activity/);
});
