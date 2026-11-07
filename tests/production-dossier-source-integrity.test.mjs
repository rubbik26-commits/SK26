import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("Dossier source preflight owns asset-history/contacts before exact handler", () => {
  const server = read("server.js");
  const guard = server.indexOf("app.use(productionDossierSourceGuard)");
  const dossier = server.indexOf("app.use(productionDossier)");
  assert.ok(guard > 0 && dossier > guard);
});

test("PLUTO outage is not treated as a retired/merged BBL", () => {
  const src = read("server/production-dossier-source-guard.js");
  assert.match(src, /const pluto = await plutoByBbl/);
  assert.match(src, /if \(!pluto\.live\) return unavailable/);
  assert.match(src, /if \(!pluto\.rows\?\.length\) return next\(\)/,
    "a live zero-row PLUTO result must still preserve measured ACRIS-only retired-BBL behavior");
});

test("active parcel asset history requires every source that can otherwise appear as an empty panel", () => {
  const src = read("server/production-dossier-source-guard.js");
  for (const name of [
    "DOF Rolling Sales (parcel history)", "DOB Permit Issuance", "DOB NOW filings",
    "HPD Violations", "DOF Assessment Roll", "PLUTO peer set", "DOF Rolling Sales (comps)"
  ]) assert.ok(src.includes(name), `${name} must be preflighted`);
  assert.match(src, /missing\.length/);
  assert.match(src, /status\(503\)/);
});

test("contacts require both non-ACRIS public contact sources before exact handler runs", () => {
  const src = read("server/production-dossier-source-guard.js");
  const at = src.indexOf('router.get("/api/contacts"');
  const body = src.slice(at);
  assert.match(body, /dobPermitsByLot/);
  assert.match(body, /hpdContactsByBbl/);
  assert.match(body, /const missing = \[/,
    "contact preflight must collect unavailable evidence families before the exact handler runs");
  assert.match(body, /!permits\?\.live/);
  assert.match(body, /!hpd\?\.live/);
  assert.match(body, /if \(missing\.length\) return unavailable\(res, "contacts", missing\)/,
    "missing contact sources must fail explicitly instead of appearing as factual empty arrays");
});
