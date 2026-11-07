import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { declarations } from "../scripts/route-audit.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundle = readFileSync(path.join(root, "public/assets/index-BbnE3o5g.js"), "utf8");

// The exact production bundle is the frontend authority. Extract every literal
// same-origin /api path family it can issue instead of maintaining a second,
// hand-written list that can drift from the artifact we actually ship.
function bundleApiFamilies() {
  const out = new Set();
  const re = /(["'`])(\/api\/[A-Za-z0-9_./:-]+)/g;
  for (const match of bundle.matchAll(re)) out.add(match[2]);
  return out;
}

function declaredPaths() {
  return [...declarations().keys()].map((key) => key.replace(/^[A-Z]+\s+/, ""));
}

function coveredByServer(family, declared) {
  if (family.endsWith("/")) return declared.some((pathname) => pathname.startsWith(family));
  return declared.includes(family);
}

function declarationSitesForFamily(family) {
  const sites = [];
  for (const [key, handlers] of declarations()) {
    const pathname = key.replace(/^[A-Z]+\s+/, "");
    const matches = family.endsWith("/") ? pathname.startsWith(family) : pathname === family;
    if (matches) sites.push(...handlers.map((h) => ({ ...h, key })));
  }
  return sites;
}

test("every application API family referenced by the exact bundle is declared by the server", () => {
  const families = bundleApiFamilies();
  // Guard the extractor itself. If minification changes and this suddenly finds
  // only a handful of strings, the test must fail rather than declare coverage.
  assert.ok(families.size >= 40, `expected at least 40 bundle API families, found ${families.size}`);

  // supabase-js builds /api/broadcast as part of its Realtime transport URL. It
  // is not a same-origin application endpoint and must not be implemented by
  // this Express service.
  families.delete("/api/broadcast");

  const declared = declaredPaths();
  const missing = [...families].filter((family) => !coveredByServer(family, declared)).sort();
  assert.deepEqual(missing, [], `bundle API families with no server declaration: ${missing.join(", ")}`);
});

test("every exact bundle data family has a production implementation, not only the seeded demo router", () => {
  const families = bundleApiFamilies();
  families.delete("/api/broadcast");

  // The five mbtile paths are provider proxies, not property-record handlers.
  // Their intended implementation lives in routes.js and is independently
  // pinned to Mapbox/CARTO in owner-map-provider.test.mjs. Every other exact
  // bundle family must have at least one implementation outside routes.js so a
  // declared demo fallback can never be mistaken for completed Owner parity.
  const providerProxy = (family) => family === "/api/mbtile/" || family.startsWith("/api/mbtile/");
  const missingProductionOwner = [];

  for (const family of [...families].sort()) {
    if (providerProxy(family)) continue;
    const sites = declarationSitesForFamily(family);
    if (!sites.some((site) => site.file !== "server/routes.js")) {
      missingProductionOwner.push(`${family} -> ${sites.map((s) => s.file).join(", ") || "no declaration"}`);
    }
  }

  assert.deepEqual(missingProductionOwner, [],
    `exact bundle families implemented only by the seeded demo router: ${missingProductionOwner.join("; ")}`);
});

test("the Owner product's private integration routes exist with the methods the bundle uses", () => {
  const declared = declarations();
  const required = [
    "GET /api/pinecone-status",
    "GET /api/investors",
    "POST /api/investors",
    "GET /api/airtable-xref",
    "GET /api/maps-usage",
    "GET /api/3d-session"
  ];
  for (const key of required) {
    assert.ok(declared.has(key), `${key} is required by the Owner bundle but is not declared`);
  }
});
