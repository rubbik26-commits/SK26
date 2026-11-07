import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("Owner Similar Properties is owned before the legacy compatibility fallback", () => {
  const server = read("server.js");
  const owner = server.indexOf("app.use(productionOwnerSourceRegistry)");
  const authority = server.indexOf("app.use(authorityRelease)");
  const bundle = server.indexOf("app.use(bundleRoutes)");
  assert.ok(owner > 0 && owner < authority && authority < bundle,
    "the Owner integration router must resolve /api/similar before any heuristic compatibility route");
});

test("configured Pinecone failures are explicit and never replaced by heuristic matches", () => {
  const src = read("server/production-owner-source-registry.js");
  const start = src.indexOf('router.get("/api/similar"');
  assert.ok(start > 0, "Owner router defines /api/similar");
  const body = src.slice(start);

  assert.match(body, /pineconeConfigured\(\)/);
  assert.match(body, /upsertParcel\(subject\)/);
  assert.match(body, /searchSimilar\(subject, \{ topK: 8 \}\)/);
  assert.match(body, /pinecone_upsert_failed/);
  assert.match(body, /pinecone_search_failed/);
  assert.match(body, /status\(502\)/,
    "a configured Pinecone integration failure must be an HTTP failure, not a successful substituted result");
  assert.doesNotMatch(body, /public-record-similarity/);
  assert.doesNotMatch(body, /plutoByZips/);
});

test("unconfigured and unknown-lot states remain the original empty envelopes", () => {
  const src = read("server/production-owner-source-registry.js");
  const start = src.indexOf('router.get("/api/similar"');
  const body = src.slice(start);
  assert.match(body, /configured: false, matches: \[\]/,
    "unconfigured Pinecone must preserve the UI's not-connected state");
  assert.match(body, /if \(!pluto\.rows\?\.length\)[\s\S]*configured: true, matches: \[\]/,
    "a valid-format retired/unknown BBL remains a normal empty result when Pinecone is configured");
  assert.match(body, /pluto_unavailable/,
    "a PLUTO outage must not be confused with an unknown parcel");
});
