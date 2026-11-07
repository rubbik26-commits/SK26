// Render-migration release gate (static + unit checks; the live-server side
// lives in api-parity.test.mjs). Locks the hermetic asset pipeline, the
// version-controlled deployment blueprint, the safe dossier contracts and the
// PostGIS geospatial layer.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const JS_SHA = "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8";
const CSS_SHA = "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b";

test("committed chunk set reconstructs the exact immutable bundle (no network)", async () => {
  const { reconstructAsset } = await import("../scripts/reconstruct-frontend.js");
  assert.equal(sha256(reconstructAsset("index-BbnE3o5g.js")), JS_SHA);
  assert.equal(sha256(reconstructAsset("index-shmfCHKD.css")), CSS_SHA);
  const parts = readdirSync(path.join(root, "server", "data", "production-frontend"));
  assert.ok(parts.filter((f) => f.startsWith("index-BbnE3o5g.js.part-")).length >= 20, "complete JS chunk set is committed");
  assert.ok(parts.filter((f) => f.startsWith("index-shmfCHKD.css.part-")).length >= 1, "CSS chunk set is committed");
});

test("vendored public assets byte-match the pinned production hashes", () => {
  assert.equal(sha256(readFileSync(path.join(root, "public", "assets", "index-BbnE3o5g.js"))), JS_SHA);
  assert.equal(sha256(readFileSync(path.join(root, "public", "assets", "index-shmfCHKD.css"))), CSS_SHA);
});

test("asset pipeline has no network fallback and fails fast", () => {
  const frontend = read("server/production-frontend.js");
  assert.match(frontend, /ensureExactAssets/);
  assert.doesNotMatch(frontend, /nycremarketintel\.com/, "runtime never contacts the legacy origin");
  assert.doesNotMatch(frontend, /fetch\(/, "runtime asset loading is local-only");
  const vendor = read("scripts/vendor-production-frontend.js");
  assert.doesNotMatch(vendor, /fetch\(/, "build vendoring is local-only");
  assert.match(vendor, /process\.exit\(1\)/, "missing assets fail the build");
  assert.match(read("server.js"), /ensureExactAssets\(\)/, "startup verifies assets before listening");
  const workflow = read(".github/workflows/vendor-exact-frontend.yml");
  assert.match(workflow, /server\/data\/production-frontend\/\*\*/, "workflow watches the chunk folder");
  assert.match(workflow, /reconstruct-frontend\.js/);
  assert.doesNotMatch(workflow, /curl/, "workflow reconstructs hermetically");
});

test("render.yaml pins the deployment: commands, health check, env contract", () => {
  const blueprint = read("render.yaml");
  // Render must use the committed lockfile, execute the complete unit gate, then
  // rebuild the immutable frontend and verify/migrate the production schema.
  // npm install here would allow dependency resolution to drift from CI/local.
  assert.match(blueprint, /buildCommand:\s*npm ci --include=dev && npm test && node scripts\/reconstruct-frontend\.js/);
  assert.match(blueprint, /startCommand:\s*node server\.js/);
  // A fresh deployment must provision its own schema rather than depending on
  // someone having run db:setup by hand. WHERE it runs matters and this test had
  // it wrong: preDeployCommand is a paid-plan feature, and this service is on
  // `plan: free`, so the step was declared and never executed — which is why the
  // production Supabase project still has only the original cre_* tables and
  // none of this repository's migrations. Chaining it into buildCommand is the
  // form that actually runs on free, so either placement is accepted and at
  // least one must be present.
  assert.ok(
    /buildCommand:[^\n]*apply-migrations\.mjs/.test(blueprint) ||
    /preDeployCommand:\s*node scripts\/apply-migrations\.mjs/.test(blueprint),
    "apply-migrations.mjs must run on deploy — chained into buildCommand (works on free) or as preDeployCommand (paid plans only)"
  );
  assert.match(blueprint, /healthCheckPath:\s*\/healthz/);
  for (const key of [
    "NODE_ENV", "SITE_PASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OWNER_EMAIL",
    "GOOGLE_MAPS_API_KEY", "AIRTABLE_API_KEY", "AIRTABLE_BASE_ID", "SERPER_API_KEY"
  ]) assert.match(blueprint, new RegExp(`key:\\s*${key}\\b`), `render.yaml must declare ${key}`);
});

test("index.html loads supabase-env then the auth bridge before the immutable bundle", () => {
  const html = read("public/index.html");
  const env = html.indexOf("/js/supabase-env.js");
  const bridge = html.indexOf("/js/production-auth-bridge.js");
  const bundle = html.indexOf("assets/index-BbnE3o5g.js");
  assert.ok(env >= 0 && bridge >= 0 && bundle >= 0);
  assert.ok(env < bridge && bridge < bundle, "supabase-env → auth bridge → compiled bundle, in that order");
  const bridgeSrc = read("public/js/production-auth-bridge.js");
  assert.match(bridgeSrc, /__SUPABASE_ENV__/);
  assert.match(bridgeSrc, /qrcpeskqkoyacnmjuxni/, "bridge still identifies legacy traffic so it can repoint it");
  const envRoute = read("server/supabase-env.js");
  assert.match(envRoute, /SUPABASE_URL/);
  assert.match(envRoute, /SUPABASE_PUBLISHABLE_KEY/);
});

test("no server module or deploy script falls back to the legacy Supabase project", () => {
  // supabase-env.js is the single allowed holder of the legacy identifiers —
  // it serves them under explicit legacy* fields so the bridge can IDENTIFY
  // legacy-bound traffic. Every other module treats SUPABASE_URL as the one
  // and only database identity (owner directive 2026-08-18).
  for (const f of readdirSync(path.join(root, "server")).filter((x) => x.endsWith(".js"))) {
    if (f === "supabase-env.js") continue;
    assert.ok(!read(`server/${f}`).includes("qrcpeskqkoyacnmjuxni"),
      `server/${f} must not reference the legacy project`);
  }
  for (const f of ["scripts/apply-migrations.mjs", "scripts/verify-production-schema.mjs", "server.js"]) {
    const src = read(f);
    assert.ok(!src.includes("LEGACY_SUPABASE_URL") && !src.includes("qrcpeskqkoyacnmjuxni"),
      `${f} must not use the legacy fallback`);
  }
  assert.doesNotMatch(read("server/supabase-env.js"), /process\.env\.SUPABASE_URL\s*\|\|\s*LEGACY_SUPABASE_URL/,
    "the served env endpoint must not default url to the legacy project");
});

test("gate accepts Basic auth and the site_access cookie; bypasses only assets + liveness probes", () => {
  const gate = read("server/gate.js");
  assert.match(gate, /site_access/);
  assert.match(gate, /Basic/);
  assert.match(gate, /startsWith\("\/assets\/"\)/);
  assert.match(gate, /401/);
  // Both probe paths stay open: render.yaml health-checks /healthz, but a
  // dashboard-configured service may still point at /api/status, and a 401
  // there fails every deploy.
  assert.match(gate, /HEALTH_PATHS\s*=\s*new Set\(\["\/healthz",\s*"\/api\/status"\]\)/);
  assert.match(read("render.yaml"), /healthCheckPath:\s*\/healthz/);
});

test("cliffs normalizers emit safe Number primitives for every LL97/J-51 metric", async () => {
  const { safeJ51, safeLl97 } = await import("../server/routes-bundle.js");

  // A published benefit period is a recorded fact and must say so.
  const j51 = safeJ51({ live: true, taxYear: 2026, j51: { active: true, startDate: "06/15/2005", periodStart: 2005, periodEnd: 2019 } }, 2026);
  assert.equal(j51.exYears, 14);
  assert.equal(j51.initYear, 2005);
  assert.equal(j51.endYear, 2019);
  assert.equal(j51.status, "expired");
  assert.equal(j51.valueType, "published fact");
  assert.equal(j51.endYearEstimated, false, "DOF published the end year — nothing was inferred");

  // With no published end, the 14-year term is SUBSTITUTED, and endYear/status
  // are conclusions drawn from it. They used to be returned unlabelled, so an
  // inferred expiry read exactly like a filed one.
  const j51Sparse = safeJ51({ live: true, taxYear: 2026, j51: { active: true } }, 2026);
  for (const k of ["exYears", "initYear", "endYear"]) assert.ok(Number.isFinite(j51Sparse[k]), `${k} is a Number even with no source detail`);
  assert.ok(["active", "expiring", "expired"].includes(j51Sparse.status));
  assert.equal(j51Sparse.valueType, "estimated", "an inferred term must be labelled an estimate");
  assert.equal(j51Sparse.endYearEstimated, true);
  assert.equal(j51Sparse.statusEstimated, true, "status is derived from the inferred end year, so it is inferred too");
  assert.match(j51Sparse.basis, /14-year alteration term/, "and the methodology is stated, not just flagged");
  assert.equal(safeJ51({ live: true, j51: { active: false } }), null, "no J-51 benefit → null (the UI hides the row)");
  assert.equal(safeJ51(null), null);

  const ll97 = safeLl97({ type: null, ghg: "16678", capTons: undefined, overTons: null, penalty2030: "junk", reportYear: "2024" });
  for (const k of ["ghg", "capTons", "penalty2030", "overTons"]) {
    assert.equal(typeof ll97[k], "number");
    assert.ok(Number.isFinite(ll97[k]), `${k} survives .toLocaleString()`);
    ll97[k].toLocaleString();
  }
  assert.equal(typeof ll97.type, "string");
  assert.ok(["exposed", "compliant"].includes(ll97.status));
  assert.equal(safeLl97(null), null, "no LL84 disclosure → null (the UI hides the row)");
  const exposed = safeLl97({ ghg: 1000, capTons: 400 });
  assert.equal(exposed.status, "exposed");
  assert.equal(exposed.overTons, 600);
  assert.equal(exposed.penalty2030, 600 * 268);
});

test("PostGIS layer: migration uses ST_Contains / ST_MakeEnvelope / ST_Touches with RLS", () => {
  const sql = read("supabase/migrations/202608130003_postgis_geospatial.sql");
  assert.match(sql, /create extension if not exists postgis/i);
  assert.match(sql, /st_contains/i);
  assert.match(sql, /st_makeenvelope/i);
  assert.match(sql, /st_touches/i);
  assert.match(sql, /geometry\(MultiPolygon, 4326\)/);
  for (const table of ["parcels", "acris_docs", "dob_filings", "tax_bills", "ntas"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table}\\s+enable row level security`, "i"), `${table} has RLS`);
  }
  assert.match(sql, /grant execute on function public\.ingest_parcels\(jsonb\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.ingest_parcels\(jsonb\) to anon/i, "ingest is service-role only");

  const adapter = read("server/adapters/postgis.js");
  for (const fn of ["lot_at", "nta_polys", "assemblage_at", "parcels_opportunities", "tax_history_at", "parcel_contacts"]) {
    assert.match(adapter, new RegExp(`"${fn}"`), `adapter calls ${fn}`);
  }
  const bundle = read("server/routes-bundle.js");
  assert.match(bundle, /postgisConfigured/);
  for (const route of ["/api/lot-at", "/api/nta-polys", "/api/assemblage", "/api/opportunities", "/api/tax-history", "/api/contacts"]) {
    assert.match(bundle, new RegExp(`"${route.replace(/\//g, "\\/")}"`), `${route} wired in the contract layer`);
  }
});

test("ingestion workers are present and syntactically valid", () => {
  for (const file of ["lib.js", "mappluto.js", "nta.js", "acris.js", "dob.js", "tax.js", "run-all.js"]) {
    execFileSync(process.execPath, ["--check", path.join(root, "scripts", "ingest", file)], { stdio: "pipe" });
  }
});

test("the files the migration brief named own their contracts", () => {
  // /api/cliffs — the regulatory router is the file named in the brief and is
  // the fallback behind the bundle contract router; both must emit the same
  // UI-exact keys, so both normalize through cliffs-contract.js.
  const contract = read("server/cliffs-contract.js");
  for (const key of ["exYears", "initYear", "endYear", "status"]) assert.match(contract, new RegExp(key));
  for (const key of ["type", "ghg", "capTons", "penalty2030", "overTons", "reportYear"]) assert.match(contract, new RegExp(key));
  const regulatory = read("server/production-regulatory.js");
  assert.match(regulatory, /from "\.\/cliffs-contract\.js"/, "production-regulatory.js uses the shared normalizer");
  assert.match(regulatory, /ll97FromDisclosure/);
  assert.match(regulatory, /safeJ51/);
  // A missing column must not read as a real zero and mask the column that
  // holds the value — the bug that blanked LL97 and mis-graded LL33.
  assert.match(regulatory, /if \(s === ""\) return null;/);

  // /api/maturity-wall — named file, and the loan keys the brief specified.
  const maturity = read("server/production-maturity.js");
  assert.match(maturity, /router\.get\("\/api\/maturity-wall"/);
  for (const key of ["amount", "rate", "payoffBalance"]) {
    assert.match(maturity, new RegExp(`\\b${key}[,:]`), `loan rows expose ${key}`);
  }
  assert.match(maturity, /configured: true/);
  assert.match(read("server.js"), /productionMaturity/, "the maturity router is mounted");

  // /api/analytics/backtest — named endpoint, non-null lift, single source of
  // truth shared with /api/propensity-validation.
  const analytics = read("server/production-analytics.js");
  assert.match(analytics, /router\.get\("\/api\/analytics\/backtest"/);
  assert.match(analytics, /router\.get\("\/api\/propensity-validation"/);
  assert.match(analytics, /propensityLift/);
  assert.doesNotMatch(analytics, /lift:\s*null,\s*\n?\s*pointInTime:false/, "the hardcoded null lift is gone");

  // Neither route may also live in the bundle router, or the two can disagree.
  const bundle = read("server/routes-bundle.js");
  assert.doesNotMatch(bundle, /router\.get\("\/api\/maturity-wall"/);
  assert.doesNotMatch(bundle, /router\.get\("\/api\/propensity-validation"/);
});

test("ingestion covers DOB violations, not just permits and filings", () => {
  execFileSync(process.execPath, ["--check", path.join(root, "scripts", "ingest", "violations.js")], { stdio: "pipe" });
  const violations = read("scripts/ingest/violations.js");
  assert.match(violations, /ecbByLot/);
  assert.match(violations, /hpdViolationsByBbl/);
  assert.match(violations, /dob_violations/);
  // The schema allows the source; the runner must actually populate it.
  assert.match(read("supabase/migrations/202608130003_postgis_geospatial.sql"), /'dob_violations'/);
  assert.match(read("scripts/ingest/run-all.js"), /ingestViolations/);
  assert.match(read("package.json"), /"ingest:violations"/);
});

test("no optional subsystem can take the deployment down at boot", () => {
  const db = read("server/db.js");
  // node:sqlite ships unflagged only from Node 22.13 — 22.12 still requires
  // --experimental-sqlite — and it needs a writable data dir. A top-level
  // `import { DatabaseSync } from "node:sqlite"` therefore throws at import time
  // on a host below that floor — before any route is mounted and before a health
  // check can be answered — which fails the whole deploy over a legacy local
  // account store.
  assert.doesNotMatch(db, /^import\s+\{[^}]*DatabaseSync[^}]*\}\s+from\s+"node:sqlite"/m,
    "node:sqlite must not be imported at module top level");
  assert.match(db, /getBuiltinModule/, "the runtime is probed rather than assumed");
  assert.match(db, /export const sqliteAvailable/);
  assert.match(db, /unavailableStore/, "a same-shape stand-in keeps callers working");
  // The pin still belongs in the blueprint — the guard is the safety net, not
  // a reason to run an unsupported runtime. This asserted 22.12.0, which is
  // BELOW the floor: node:sqlite is flagged there and pdfjs-dist declares
  // engines ">=22.13.0 || >=24". CI ran on 22.12.0 for that reason, the account
  // store never opened, and /api/auth/signup answered 500 on every run. The
  // assertion now enforces the floor rather than a specific stale patch.
  const pinned = read("render.yaml").match(/key: NODE_VERSION[\s\S]{0,60}?value:\s*([\d.]+)/)?.[1];
  assert.ok(pinned, "render.yaml pins NODE_VERSION");
  const [maj, min] = pinned.split(".").map(Number);
  assert.ok(maj > 22 || (maj === 22 && min >= 13),
    `NODE_VERSION ${pinned} is below the 22.13 floor for unflagged node:sqlite and pdfjs-dist`);
  // (The CI workflow that previously mirrored this floor was removed at the
  // owner's direction on 2026-08-17.)
  // The blueprint must name the service that actually exists, or Render
  // creates a second one instead of deploying this one.
  assert.match(read("render.yaml"), /name: lucia\b/);
});

test("db:setup builds and verifies the store in one command", () => {
  execFileSync(process.execPath, ["--check", path.join(root, "scripts", "db-setup.js")], { stdio: "pipe" });
  const setup = read("scripts/db-setup.js");
  // Applies the schema, loads records, and proves the spatial contract.
  assert.match(setup, /ingest_parcels/);
  assert.match(setup, /ingest_ntas/);
  assert.match(setup, /public\.lot_at/);
  assert.match(setup, /public\.nta_polys/);
  assert.match(setup, /public\.assemblage_at/);
  // Workspace migrations reference auth.users and must be skipped on plain Postgres.
  assert.match(setup, /table_schema='auth' and table_name='users'/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["db:setup"], "node scripts/db-setup.js");
  // `pg` used to be asserted as ops-only, on the reasoning that the web service
  // never touched Postgres at runtime. That stopped being true when
  // server/durable-store.js started keeping the deployment-wide kanban board and
  // investor pool in Postgres — the fix for state vanishing on every deploy. It
  // is now a runtime dependency, and the assertion is inverted to say so: a
  // production install that omits devDependencies must still be able to reach
  // the durable store, or the site silently falls back to an ephemeral disk and
  // the original bug returns.
  assert.ok(pkg.dependencies?.pg, "pg must be a runtime dependency — durable-store.js imports it to serve requests");
  assert.ok(!pkg.devDependencies?.pg, "pg must not also be a devDependency");
});
