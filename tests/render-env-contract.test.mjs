import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (/\.(?:js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

function envNames(file) {
  const text = readFileSync(file, "utf8");
  const out = new Set();
  const direct = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  const bracket = /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g;
  for (const re of [direct, bracket]) {
    for (const match of text.matchAll(re)) out.add(match[1]);
  }
  return out;
}

function declaredRenderKeys() {
  const text = readFileSync(path.join(root, "render.yaml"), "utf8");
  return new Set([...text.matchAll(/^\s*- key:\s*([A-Z][A-Z0-9_]*)\s*$/gm)].map((m) => m[1]));
}

// These are deliberately NOT user-supplied deployment variables:
// - Render owns PORT/RENDER_*.
// - APP_DATA_DIR is a local/persistent-disk override; production intentionally
//   persists through Supabase/Postgres instead of a Render disk.
// - ALLOW_DEMO_FALLBACK must stay absent/false in production.
// - SOCRATA_DOMAIN is a test fault-injection override; production uses the
//   authoritative NYC endpoints hard-coded by the adapters.
const INTENTIONAL_UNDECLARED = new Set([
  "PORT",
  "RENDER",
  "RENDER_EXTERNAL_HOSTNAME",
  "RENDER_EXTERNAL_URL",
  "RENDER_SERVICE_ID",
  "RENDER_INSTANCE_ID",
  "APP_DATA_DIR",
  "ALLOW_DEMO_FALLBACK",
  "SOCRATA_DOMAIN"
]);

const productionFiles = [
  path.join(root, "server.js"),
  ...filesUnder(path.join(root, "server")),
  path.join(root, "scripts", "apply-migrations.mjs"),
  path.join(root, "scripts", "verify-production-schema.mjs"),
  path.join(root, "scripts", "buyerdb-refresh-dispatch.mjs")
];

// Include the ingest workers: they are part of the Owner warehouse contract
// even though PostGIS is intentionally not trusted until a certified full sync.
const ingestDir = path.join(root, "scripts", "ingest");
try { productionFiles.push(...filesUnder(ingestDir)); } catch { /* no ingest dir */ }

test("every literal production environment variable is declared by the Render blueprint or intentionally platform/internal", () => {
  const usedBy = new Map();
  for (const file of productionFiles) {
    for (const key of envNames(file)) {
      if (!usedBy.has(key)) usedBy.set(key, []);
      usedBy.get(key).push(path.relative(root, file));
    }
  }
  const declared = declaredRenderKeys();
  const missing = [...usedBy.keys()]
    .filter((key) => !declared.has(key) && !INTENTIONAL_UNDECLARED.has(key))
    .sort()
    .map((key) => `${key} <- ${usedBy.get(key).join(", ")}`);
  assert.deepEqual(missing, [], `production env variables missing from render.yaml:\n${missing.join("\n")}`);
});

test("the exact Owner external integration variables are all represented explicitly", () => {
  const declared = declaredRenderKeys();
  const required = [
    "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_KEY", "GOOGLE_3D_KEY", "GOOGLE_3D_DAILY_CAP",
    "GOOGLE_CSE_KEY", "GOOGLE_CSE_CX",
    "MAPBOX_ACCESS_TOKEN", "MAPBOX_TOKEN",
    "SERPER_API_KEY", "PINECONE_API_KEY", "PINECONE_INDEX_HOST",
    "AIRTABLE_PAT", "AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "AIRTABLE_SELLERS_TABLE",
    "AIRTABLE_BUYERS_TABLE", "AIRTABLE_MATCH_FIELDS",
    "CENSUS_API_KEY", "FRED_API_KEY", "NYC_OPEN_DATA_APP_TOKEN", "SOCRATA_APP_TOKEN",
    "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_DB_URL", "DATABASE_URL",
    "APP_STATE_TOKEN", "OWNER_EMAIL", "SITE_PASSWORD", "OWNER_PASSWORD"
  ];
  assert.deepEqual(required.filter((key) => !declared.has(key)), [],
    "one or more Owner integration variables are absent from render.yaml");
});
