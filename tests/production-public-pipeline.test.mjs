import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// Re-pinned 2026-08-19. These asserted an EXHAUSTIVE traversal
// (completeDobNowPipelineByZips) and a straight slice of its rows. The original
// does neither: its own published sources[] entry is a SINGLE w9ak-ipjd call
// with $limit=600, and ZIP 10314 comes back at exactly 600 rows whose counts
// sum to 600 — the cap is real, and paging past it produced different counts.
// What these tests are really guarding — DOF Rolling Sales staying out of a DOB
// feature, an unavailable source failing loudly, and counts and sites coming
// off the same row set — is re-pinned below on the code that decides it.
test("public pipeline is sourced only from DOB NOW evidence", () => {
  const route = read("server/production-public-pipeline.js");
  assert.match(route, /soql\(DOB_NOW, params\)/, "one call, the one the original publishes");
  assert.match(route, /const ROW_LIMIT = 600;/);
  assert.ok(!/rollingSales|liveMarket/.test(route), "DOF Rolling Sales is unrelated to the public DOB pipeline");
  assert.match(route, /if \(!r\.live\) return res\.status\(503\)/,
    "a source that did not answer is an outage, never an empty pipeline");
});

// The exhausting adapter is kept — nothing was deleted — and still pins its own
// paging contract for the callers that use it. The public pipeline route no
// longer does, because the original does not.
test("DOB pipeline adapter exhausts the source instead of capping units or sites before analytics", () => {
  const src = read("server/adapters/dob-now-pipeline-complete.js");
  assert.match(src, /soqlAll\(DS\.dobNow/);
  assert.match(src, /pageSize:\s*5000/);
  assert.match(src, /maxRows:\s*200000/);
  assert.match(src, /filing_date DESC,job_filing_number ASC/);
});

test("pipeline counts and display sites are derived from the same row set", () => {
  const src = read("server/production-public-pipeline.js");
  assert.match(src, /const rows = r\.rows \|\| \[\]/);
  assert.match(src, /for \(const x of rows\)/);
  // Sites come off the SAME rows, deduplicated on bbl + kind and capped at 60.
  // Solved against the original: ZIP 10001's 114 rows reduce to exactly its 45
  // sites and 11216's first 60 of 117 are exactly its 60, in the same order.
  assert.match(src, /const key = `\$\{site\.bbl\}\|\$\{site\.kind\}`/);
  assert.match(src, /if \(sites\.length >= SITE_LIMIT\) break/);
});

test("the pipeline classifies a filing on an EXACT job_type, and reports absent figures as absent", () => {
  const src = read("server/production-public-pipeline.js");
  // /new building/i also matched ZIP 11216's 30 rows of "ALT-CO - New Building
  // with Existing Elements to Remain": 267 new buildings against the original's
  // 237, and 60 foundations against its 90.
  assert.match(src, /if \(x\.job_type === "New Building"\) return "New Building";/);
  // The prose above mentions the old regex, so this asserts on its USE.
  assert.doesNotMatch(src, /\/new building\/i\.test\(/);
  // A demolition filing carries no unit count; publishing 0 claims it proposes
  // none, which is a different fact.
  assert.match(src, /proposedUnits: x\.proposed_dwelling_units == null \? null :/);
});

test("public ?zips= owner mounts before CRM compatibility routes while bare pipeline falls through", () => {
  const server = read("server.js");
  const publicAt = server.indexOf("app.use(productionPublicPipeline)");
  const authorityAt = server.indexOf("app.use(authorityRelease)");
  const bundleAt = server.indexOf("app.use(bundleRoutes)");
  assert.ok(publicAt > 0 && publicAt < authorityAt && publicAt < bundleAt);

  const route = read("server/production-public-pipeline.js");
  assert.match(route, /if \(req\.query\.zips === undefined\) return next\(\)/,
    "bare /api/pipeline must remain the user workspace contract");
});
