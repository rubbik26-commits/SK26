import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("full ACRIS timeline exhausts Legals, Parties, Master and References", () => {
  const src = read("server/adapters/acris-full.js");
  assert.match(src, /import \{ soqlAll, escSoql \}/);
  assert.match(src, /async function exhaust/);
  assert.match(src, /soqlAll\(dataset/);
  assert.ok(!/\$limit:\s*300\b/.test(src), "Legals must not silently stop at 300 associations");
  assert.ok(!/chunk\.length \* 30/.test(src), "Parties must not use the old derived hard limit");
  assert.ok(!/chunk\.length \* 20/.test(src), "References must not use the old derived hard limit");
});

test("authorityRelease owns maturity requests before the older production-maturity router", () => {
  const server = read("server.js");
  const authority = server.indexOf("app.use(authorityRelease)");
  const older = server.indexOf("app.use(productionMaturity)");
  assert.ok(authority > 0 && older > authority);
});

test("global and signed-in maturity paths require mortgage-specific ACRIS satisfaction linkage", () => {
  const src = read("server/authority-release.js");
  assert.match(src, /fullAcrisByLot/);
  assert.match(src, /acris\.referenceStatus !== "live"/);
  assert.match(src, /!d\.linkedSatisfactions\?\.length/);
  assert.match(src, /Only mortgages whose ACRIS cross-reference set was successfully retrieved/);
});

test("unavailable ACRIS References are omitted rather than guessed outstanding or satisfied", () => {
  const src = read("server/authority-release.js");
  assert.match(src, /unresolvedReferenceCount/);
  assert.match(src, /cross-reference set was successfully retrieved/);
});
