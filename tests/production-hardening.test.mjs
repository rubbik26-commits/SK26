import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const NEW_MODULES = [
  "scripts/vendor-production-frontend.js",
  "scripts/reconstruct-frontend.js",
  "scripts/make-frontend-chunks.js",
  "public/js/production-auth-bridge.js",
  "server/supabase-env.js",
  "server/adapters/postgis.js",
  "server/production-frontend.js",
  "server/production-api.js",
  "server/production-private.js",
  "server/production-live-guard.js",
  "server/production-live-extra.js",
  "server/production-imagery.js",
  "server/production-regulatory.js",
  "server/production-analytics.js",
  "server/production-distress-tax.js",
  "server/durable-cost.js",
  "server/security.js",
  "server/adapters/mappluto.js",
  "server/adapters/dof-benefits.js",
  "server/adapters/dob-sustainability.js"
];

test("production hardening modules are syntactically valid ESM/JS", () => {
  for (const file of NEW_MODULES) {
    execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" });
  }
});

test("exact production frontend remains checksum pinned to the supplied ZIP", () => {
  const bridge = read("server/production-frontend.js");
  assert.match(bridge, /4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8/);
  assert.match(bridge, /d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b/);
  assert.match(bridge, /Checksum mismatch/);
  const vendor = read("scripts/vendor-production-frontend.js");
  assert.match(vendor, /server["',\s]+data["',\s]+production-frontend|production-frontend/);
  assert.match(vendor, /brotliDecompressSync/);
  assert.match(vendor, /checksum/i);
  // The served shell is the ZIP index plus one same-origin script: the auth
  // bridge that propagates the Supabase session to owner-only API calls. The
  // untouched ZIP index remains committed at site/index.html for reference.
  const index = read("public/index.html");
  assert.match(index, /production-auth-bridge\.js/);
  assert.match(index, /assets\/index-BbnE3o5g\.js/);
  assert.match(index, /assets\/index-shmfCHKD\.css/);
  assert.match(index, /<div id="root"><\/div>/);
});

test("production public-record requests cannot silently become demo facts", () => {
  const guard = read("server/production-live-guard.js");
  for (const route of [
    "/api/address", "/api/asset-history", "/api/area-buildings", "/api/contacts",
    "/api/distress", "/api/tax-history", "/api/liensale", "/api/transit",
    "/api/cliffs", "/api/demographics", "/api/market-report", "/api/maturity-wall"
  ]) assert.ok(guard.includes(`\"${route}\"`) || guard.includes(`"${route}"`), `${route} must be guarded`);
  assert.match(guard, /live_source_unavailable/);
  assert.match(guard, /No synthetic fallback was used/);
});

test("production dossier distress contract includes factual HPD heat/hot-water count", () => {
  const distress = read("server/production-distress-tax.js");
  assert.match(distress, /heatOpenHpd/);
  assert.match(distress, /novdescription/);
  assert.match(distress, /heatOpen:\s*heatOpenHpd/);
  assert.match(distress, /\/heat\|hot water\/i/);
});

test("Supabase migration enforces per-user RLS and durable paid-resource quotas", () => {
  const sql = read("supabase/migrations/202608130001_exact_production_workspace.sql");
  for (const table of ["cre_profiles","cre_watchlist","cre_pipeline","cre_canvass","cre_investors","cre_usage_daily","cre_quota_daily"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(sql, /user_id = auth\.uid\(\)/i);
  assert.match(sql, /cre_reserve_3d_session/i);
  assert.match(sql, /used < hard_cap/i);
  assert.match(sql, /grant execute on function public\.cre_reserve_3d_session\(bigint\) to service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.cre_reserve_3d_session\(bigint\) to authenticated/i);
});

// Re-pinned 2026-08-19. This asserted the `official` block (with its
// applicableLimitMetricTonsCo2e:null / estimatedPenalty:null fields) that
// /api/cliffs used to publish. It does not any more, because the original does
// not: measured across fifteen BBLs, its envelope is EXACTLY three keys —
// j51, ll97, ll33 — and its ll97 block is exactly
//   ghg, gfa, type, capTons, overTons, penalty2030, status, reportYear.
// The rebuild now matches all fifteen byte-for-byte. What the test was really
// guarding — that no LL97 position is asserted without a published emissions
// figure behind it — is re-pinned below on the code that still decides it.
test("production regulatory path asserts no LL97 position without a published disclosure", () => {
  const regulatory = read("server/production-regulatory.js");
  const contract = read("server/cliffs-contract.js");
  // The route publishes only the measured three keys.
  assert.match(regulatory, /j51: j51 \?\? null,/);
  // Re-pinned 2026-08-19 (round 3): the projection is now gated on LL97's own
  // 25,000 sf coverage floor, measured on BBL 1015850014 — LL84 self-reports
  // 5,025 sf, the original answers ll97:null, and the rebuild was publishing a
  // $22,434 penalty for a building the law does not cover.
  assert.match(regulatory, /ll97: covered \? cliffsLl97\(uiLl97\) : null,/);
  assert.match(regulatory, /const LL97_COVERAGE_SF = 25000;/);
  assert.match(regulatory, /reportedGfa >= LL97_COVERAGE_SF/);
  assert.match(regulatory, /ll33: ll33Published\.live \? ll33Published\.grade : null/);
  assert.doesNotMatch(regulatory, /applicableLimitMetricTonsCo2e/,
    "the `official` block the original never publishes must stay gone");
  // ll97FromDisclosure returns null when the disclosure carries no usable
  // emissions figure, so a cap can never be asserted without one.
  assert.match(contract, /if \(!Number\.isFinite\(ghg\)\) return null;/);
  // And the cap is the per-property-type limit, not one invented constant.
  assert.match(contract, /ll97IntensityForType\(propertyType\)/);
});

test("the LL97 2030 cap uses the measured per-property-type intensity", () => {
  // Solved 2026-08-19 by dividing the original's published capTons by its
  // published gfa across 232 probes / 78 property types.
  return import("../server/cliffs-contract.js").then(({ ll97IntensityForType, LL97_2030_INTENSITY }) => {
    assert.equal(LL97_2030_INTENSITY, 0.00453);
    assert.equal(ll97IntensityForType("Office"), 0.00453);
    assert.equal(ll97IntensityForType("Multifamily Housing"), 0.00407);
    assert.equal(ll97IntensityForType("K-12 School"), 0.00344);
    assert.equal(ll97IntensityForType("Hotel"), 0.00526);
    assert.equal(ll97IntensityForType("Non-Refrigerated Warehouse"), 0.00110);
    assert.equal(ll97IntensityForType("Retail Store"), 0.00400);
    assert.equal(ll97IntensityForType("Hospital (General Medical & Surgical)"), 0.01083);
    // Anything unmeasured falls back to the default rather than to zero.
    assert.equal(ll97IntensityForType("Some Type Nobody Measured"), 0.00453);
    assert.equal(ll97IntensityForType(null), 0.00453);
    // Empire State Building, measured: gfa 2852257 -> capTons 12921.
    assert.equal(Math.round(2852257 * ll97IntensityForType("Office")), 12921);
    // 3009810111, measured: gfa 135600 -> capTons 466 (was 614 on the flat rate).
    assert.equal(Math.round(135600 * ll97IntensityForType("K-12 School")), 466);
  });
});

test("exact-client private APIs derive owner access from authenticated Supabase profile", () => {
  const api = read("server/production-api.js");
  assert.match(api, /\/auth\/v1\/user/);
  assert.match(api, /cre_profiles\?select=display_name,role/);
  assert.match(api, /\["owner",\s*"admin"\]/);
  assert.match(api, /requireOwner/);
  assert.doesNotMatch(api, /OWNER_MODE\s*!==/);
  const authBridge = read("public/js/production-auth-bridge.js");
  assert.match(authBridge, /Authorization|authorization/);
  assert.match(authBridge, /Bearer/);
});

test("3D sessions fail closed when durable quota storage is unavailable", () => {
  const quota = read("server/durable-cost.js");
  assert.match(quota, /durable_quota_unavailable/);
  assert.match(quota, /cre_reserve_3d_session/);
  assert.match(quota, /key:\s*null/);
});

test("production analytics measure the backtest lift and label its limits", () => {
  const analytics = read("server/production-analytics.js");
  // The lift is computed from recorded DOF sales matched against live
  // propensity scores — a real measurement, served under both the
  // propensity-validation and analytics/backtest paths from one function.
  assert.match(analytics, /router\.get\("\/api\/analytics\/backtest"/);
  assert.match(analytics, /rollingSalesByZips/);
  assert.match(analytics, /liveAreaBuildings/);
  assert.match(analytics, /soldHitPct \/ baseHitPct/);
  // Its limitation is disclosed rather than hidden: current PLUTO is not an
  // archive, so the response says so instead of implying point-in-time rigor.
  assert.match(analytics, /pointInTime: false/);
  assert.match(analytics, /archived point-in-time snapshot/);
  // A source that returns nothing still yields null — never a fabricated lift.
  assert.match(analytics, /lift: null/);
  assert.match(analytics, /rather than an invented one/);
  assert.match(analytics, /ACS 5-year 2024/);
  assert.match(analytics, /public-record-similarity/);
});
