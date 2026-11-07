import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bblFromOppId, geometryTouches } from "../server/authority-release.js";
import { propensityFor } from "../server/area-buildings.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("pipeline opportunity ids preserve/derive the parcel BBL", () => {
  assert.equal(bblFromOppId("1008350041"), "1008350041");
  assert.equal(bblFromOppId("LIVE-1008350041"), "1008350041");
  assert.equal(bblFromOppId("parcel:3009780018:watch"), "3009780018");
  assert.equal(bblFromOppId("RELEASE-GATE-PROBE"), "");
});

test("MapPLUTO fallback assemblage requires polygon adjacency", () => {
  const a = { type: "Polygon", coordinates: [[[-74,40.7],[-73.99,40.7],[-73.99,40.71],[-74,40.71],[-74,40.7]]] };
  const b = { type: "Polygon", coordinates: [[[-73.99,40.7],[-73.98,40.7],[-73.98,40.71],[-73.99,40.71],[-73.99,40.7]]] };
  const c = { type: "Polygon", coordinates: [[[-73.97,40.7],[-73.96,40.7],[-73.96,40.71],[-73.97,40.71],[-73.97,40.7]]] };
  assert.equal(geometryTouches(a, b), true);
  assert.equal(geometryTouches(a, c), false);
});

test("operational truth, authority routes and truth layers precede compatibility bundle", () => {
  const src = read("server.js");
  const status = src.indexOf("app.use(productionStatus)");
  const authority = src.indexOf("app.use(authorityRelease)");
  const regulatory = src.indexOf("app.use(productionRegulatory)");
  const dossier = src.indexOf("app.use(productionDossier)");
  const distress = src.indexOf("app.use(productionDistressTax)");
  const bundle = src.indexOf("app.use(bundleRoutes)");
  assert.ok(status > 0 && status < authority && authority < bundle);
  assert.ok(regulatory > authority && regulatory < bundle);
  assert.ok(dossier > authority && dossier < bundle);
  assert.ok(distress > authority && distress < bundle);
});

test("production local SQLite accounts cannot create or carry owner authority", () => {
  const layer = read("server/authority-release.js");
  const auth = read("server/auth.js");
  assert.match(layer, /NODE_ENV === "production"[^\n]*req\.profile/);
  assert.match(layer, /local_auth_disabled/);
  assert.match(layer, /role:\s*"user"/);
  assert.match(auth, /LOCAL_FIRST_USER_OWNER === "1"/);
  assert.match(auth, /NODE_ENV !== "production"/);
  assert.ok(!/return count === 0 \? "owner" : "user"/.test(auth));
});

test("a durable-store failure that answers 503 occurs before any fallback disk write", () => {
  const src = read("server/durable-store.js");
  const save = src.slice(src.indexOf("async save(value)"));

  // The invariant, not one particular trigger: whatever decides to fail closed
  // must throw BEFORE writeDisk(), so a 503 can never be followed by a reload
  // that appears to show the card the API just rejected.
  //
  // The trigger was NODE_ENV === "production", and that was too broad in two
  // directions. A production deployment with NO durable storage configured is
  // not a failed durable write — disk is the intended backend there — and
  // throwing turned "no database attached" into "nothing can be saved". A
  // deployment with durable storage half-configured (SUPABASE_URL and a
  // publishable key but no APP_STATE_TOKEN) answered 503 to every save, so
  // setting two variables of three was worse than setting none. The condition
  // is now `durableConfigured() && everWorked`: a backend that has never
  // succeeded is a misconfiguration and degrades to disk with
  // durable:false/misconfigured:true, and because it does not answer 503 there
  // is no response-versus-reload contradiction to prevent. A backend that has
  // worked and then stops is a real outage and still throws, still before disk.
  const failClosed = save.indexOf("throw durableWriteError(name)");
  const localWrite = save.indexOf("writeDisk(value);", failClosed);
  assert.ok(failClosed >= 0, "a fail-closed branch exists");
  assert.ok(localWrite > failClosed,
    "the fallback disk write must come after the fail-closed throw, never before it");
  assert.match(save.slice(0, failClosed), /durableConfigured\(\) && everWorked/,
    "and it is gated on a backend that was configured AND has previously worked");
  assert.match(src, /was NOT written to ephemeral disk/);

  // No earlier writeDisk() may sneak in ahead of the throw on the failure path.
  // The successful-durable-write mirrors are legitimate and are wrapped in
  // try/catch after a durable row already succeeded, so they are excluded by
  // looking only at the tail of save() from the last durable attempt onward.
  const tail = save.slice(save.lastIndexOf("RPC write"), failClosed);
  assert.ok(!/^\s*writeDisk\(value\);/m.test(tail),
    "nothing writes to disk between the last durable attempt and the fail-closed throw");
});

test("publishable-key app-state bootstrap is explicit, never first-caller-wins at runtime", () => {
  const src = read("server/durable-store.js");
  const probeAt = src.indexOf('rpc("app_state_get"');
  const bootstrapAt = src.indexOf('rpc("app_state_bootstrap"');
  assert.ok(probeAt > 0 && bootstrapAt > probeAt, "existing token is probed before bootstrap is attempted");
  assert.match(src, /APP_STATE_BOOTSTRAP !== "1"/);
  assert.match(src, /explicit operator bootstrap required/);
  const render = read("render.yaml");
  assert.match(render, /- key: APP_STATE_BOOTSTRAP/);
});

test("usage reporting reads the real cre_usage_daily column names", () => {
  const src = read("server/durable-cost.js");
  assert.match(src, /select=category,count,usage_date/);
  assert.match(src, /usage_date=gte/);
  assert.match(src, /Number\(row\.count\)/);
  assert.ok(!/select=category,amount,day/.test(src));
});

test("expired Socrata cache is diagnostic only and never returned as live rows", () => {
  const src = read("server/adapters/socrata.js");
  // Slice the stale-cache branch only, ending at the close of the function it
  // sits in. The window used to run all the way to resolveDataset, ~3,700
  // characters that swallow an entire pagination helper whose `live: true`
  // returns are legitimate successful fetches — so the "never live" assertion
  // was reading unrelated code and failing on correct behaviour.
  const from = src.indexOf("const stale = readFileCache");
  assert.ok(from > 0, "the stale-cache branch exists");
  const end = src.indexOf("\n}", from);
  const stale = src.slice(from, end);

  assert.match(stale, /live:\s*false/, "an expired cache is never a live answer");
  assert.match(stale, /rows:\s*\[\]/, "and contributes no rows to the caller");
  assert.match(stale, /staleRows/, "the expired payload is exposed separately, for diagnosis only");
  assert.ok(!/live:\s*true/.test(stale),
    "nothing in the stale branch may claim liveness");
  // The expired payload must reach the caller under a DIFFERENT key than the
  // live one — that is the substitution the whole rule exists to prevent. So
  // every `rows:` in this branch (the stale return and the no-cache return
  // alike) has to be the empty array; only `staleRows:` may carry content.
  const rowsValues = [...stale.matchAll(/(?<!stale)\brows:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  assert.ok(rowsValues.length >= 1, "the branch returns a rows key at all");
  assert.deepEqual([...new Set(rowsValues)], ["[]"],
    `every rows value in the stale branch must be empty; found ${rowsValues.join(" | ")}`);
});

test("PostGIS requires operator trust AND an unexpired complete-ingest certificate", () => {
  const src = read("server/adapters/postgis.js");
  assert.match(src, /POSTGIS_TRUSTED !== "1"/);
  assert.match(src, /postgis_store_status/);
  assert.match(src, /raw\.fresh === true && raw\.fullDocuments === true/);
  assert.match(src, /if \(!status\.fresh\) return null/);
  assert.match(src, /resolution_hit:\s*row\.hit/);
});

test("ingestion defaults traverse the complete selected universe", () => {
  const lib = read("scripts/ingest/lib.js");
  const map = read("scripts/ingest/mappluto.js");

  // What matters is the DEFAULT, not the shape of the expression that computes
  // it: with no explicit --limit the worker must traverse everything, so the
  // default cap is Infinity and no silent 150/5000 ceiling may reappear. The
  // lib.js expression was refactored into requestedCap(), which the previous
  // literal pattern could not see even though the behaviour was unchanged.
  assert.ok(!/\|\|\s*150\b/.test(lib), "no silent 150-row default may return");
  assert.match(lib, /Number\.isFinite\([^)]*\)[^;]*\?[^;]*:\s*Infinity/,
    "an absent or invalid --limit must fall back to Infinity, not to a number");
  assert.ok(!/\|\|\s*5000\b/.test(map), "no silent 5000-row default may return");
  assert.match(map, /Number\.isFinite\([^)]*\)[^;]*\?[^;]*:\s*Infinity/,
    "the MapPLUTO worker's default hard limit is Infinity too");
});

test("only an unbounded full run can certify the PostGIS warehouse", () => {
  const run = read("scripts/ingest/run-all.js");
  assert.match(run, /const scoped = Boolean/);
  assert.match(run, /if \(!scoped\)/);
  assert.match(run, /mark_full_ingest_complete/);
  assert.match(run, /NOT certifying the warehouse as citywide authoritative/);
  const sql = read("supabase/migrations/202608150004_postgis_ingest_certificate.sql");
  assert.match(sql, /expires_at > now\(\) and c\.full_documents/);
  assert.match(sql, /interval '36 hours'/);
  assert.match(sql, /creates NO certificate row/i);
});

test("authority migration makes assemblage a connected ST_Touches cluster", () => {
  const sql = read("supabase/migrations/202608150003_finishline_authority_release.sql");
  assert.match(sql, /with recursive subject/i);
  assert.match(sql, /st_touches\(p\.geom, current_lot\.geom\)/i);
  const cluster = sql.slice(sql.indexOf("create or replace function public.assemblage_at"), sql.indexOf("-- ---------------------------------------------------------- schema release RPC"));
  assert.ok(!/or \(p\.borough = s\.borough and p\.block = s\.block\)/i.test(cluster));
  assert.match(sql, /grant update\(bbl\) on public\.cre_pipeline to authenticated/i);
});

test("deploy verifies complete schema and requires a fresh warehouse when trusted", () => {
  const sql = read("supabase/migrations/202608150003_finishline_authority_release.sql");
  const verifier = read("scripts/verify-production-schema.mjs");
  const render = read("render.yaml");
  for (const name of ["cre_pipeline", "cre_investors", "cre_usage_daily", "parcels", "acris_docs", "dob_filings", "tax_bills", "ntas"]) assert.match(sql, new RegExp(name));
  assert.match(sql, /acris_document_bbl_pk/);
  assert.match(verifier, /release_schema_check/);
  assert.match(verifier, /schema\.ok !== true/);
  assert.match(verifier, /postgis_store_status/);
  assert.match(verifier, /POSTGIS_TRUSTED === "1"/);
  assert.match(verifier, /fullDocuments !== true/);
  assert.match(render, /verify-production-schema\.mjs/);
});

test("similar-properties consumes Pinecone's matches envelope and falls back to public records", () => {
  const src = read("server/authority-release.js");
  const start = src.indexOf('router.get("/api/similar"');
  const body = src.slice(start, src.indexOf("// ----------------------------------------------------------- Area Buildings", start));
  assert.match(body, /Array\.isArray\(result\?\.matches\)/);
  assert.match(body, /result\.matches/);
  assert.match(body, /public-record-similarity/);
  assert.match(body, /plutoByZips/);
});

test("unknown permits do not earn the no-permit propensity signal", () => {
  const base = { owner: "JOHN DOE", yearBuilt: 1920, unitsRes: 2, maxFar: 0, lotArea: 0 };
  const unknown = propensityFor(base, undefined).propensity;
  const zero = propensityFor(base, 0).propensity;
  assert.equal(zero - unknown, 6, "only verified zero permit activity receives the six-point signal");
});

test("shared Area Buildings fails on either PLUTO half and exposes permit-source failure", () => {
  const src = read("server/area-buildings.js");
  assert.match(src, /if \(!countRes\.live \|\| !pageRes\.live\)/);
  assert.match(src, /pluto_partial_failure/);
  assert.match(src, /Number\.isFinite\(permitCount\) && permitCount === 0/);
  assert.match(src, /permitHistory:\s*"unavailable"/);
});

test("propensity validation fails on unavailable permits or Rolling Sales", () => {
  const src = read("server/authority-release.js");
  const start = src.indexOf('router.get("/api/propensity-validation"');
  const body = src.slice(start, src.indexOf("// --------------------------------------------------------------- maturity wall", start));
  assert.match(body, /dob_permits_unavailable/);
  assert.match(body, /if \(!salesRes\.live\)/);
  assert.match(body, /rolling_sales_unavailable/);
  const shared = read("server/area-buildings.js");
  assert.match(shared, /if \(!baseRes\.live \|\| !salesRes\.live\)/);
  assert.match(shared, /permitCountsFor\(baseBuildings\)/);
});

test("both maturity-wall modes require live ACRIS satisfaction references", () => {
  const src = read("server/authority-release.js");
  assert.match(src, /acris\.referenceStatus !== "live"/);
  assert.match(src, /!d\.linkedSatisfactions\?\.length/);
  assert.match(src, /Only mortgages whose ACRIS cross-reference set was successfully retrieved/);
  assert.match(src, /cleanBbl\(r\.bbl\) \|\| bblFromOppId\(r\.opp_id\)/);
});

test("operational status reports actual PostGIS certificate freshness", () => {
  const src = read("server/production-status.js");
  assert.match(src, /postgisStoreStatus/);
  assert.match(src, /postgis:\s*pg\.fresh === true/);
  assert.match(src, /survivesRedeploy/);
  assert.match(src, /Generated\/demo property facts are not substituted/);
});

test("DOB Safety Violations are scoped by borough as well as block/lot", () => {
  const src = read("server/adapters/dob-violations.js");
  assert.match(src, /const safetyWhere=/);
  assert.match(src, /borough=/);
  assert.match(src, /AND \$\{lotWhere\}/);
});

// The shell carries the OWNER's identity, not the name compiled into the
// purchased bundle. A previous change stripped it on the reasoning that the
// pinned bundle's own product name is the "original" one to preserve; that is
// backwards. The bundle's BYTES are what must not change — the site's name,
// colours and typeface belong to the business running it.
//
// This regressed silently for two days because the shell is the one file that
// can restyle the app without touching the pinned assets, so nothing that
// checks the bundle hashes would notice.
test("served shell carries the Skyline brand identity", () => {
  const html = read("public/index.html");
  assert.match(html, /<html[^>]*class="[^"]*\bskyline\b/, "the brand layer is gated on this class; without it the CSS loads and does nothing");
  assert.match(html, /\/css\/skyline-brand\.css/, "brand stylesheet must be linked");
  assert.match(html, /\/js\/skyline-name\.js/, "company name overlay must be loaded");
  assert.match(html, /<title>Skyline Properties — Manhattan’s Off-Market Investment Sales Authority<\/title>/);
  assert.match(html, /name="theme-color" content="#0B1B2B"/, "brand navy, not the bundle's default");
  assert.match(html, /name="apple-mobile-web-app-title" content="Skyline Properties"/);
});

// Satoshi / Inter / JetBrains Mono are loaded from remote stylesheets. The `?`
// that starts each query string was once written as `%3F`, which makes the URL
// a path that 404s — the page still renders, silently, in a fallback typeface.
// Assert the separator is literal so a broken font link fails here instead of
// in front of a client.
test("web font stylesheet URLs are not query-encoded into 404s", () => {
  const html = read("public/index.html");
  assert.match(html, /api\.fontshare\.com\/v2\/css\?f\[\]=satoshi/, "Satoshi URL must use a literal ?");
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Inter/, "Inter/JetBrains Mono URL must use a literal ?");
  assert.ok(!/%3F/i.test(html), "no %3F may appear in the shell — it breaks every stylesheet URL it touches");
});

// Independent of branding: the purchased bundle is immutable and the shell must
// keep pointing at exactly those bytes.
test("served shell still pins the immutable compiled bundle", () => {
  const html = read("public/index.html");
  assert.match(html, /index-BbnE3o5g\.js/);
  assert.match(html, /index-shmfCHKD\.css/);
});

test("deployed verifier handles bare pipeline arrays and deletes its probe", () => {
  const src = read("tests/browser/production-verify.cjs");
  assert.match(src, /const pipelineRows = \(json\) => Array\.isArray\(json\)/);
  assert.match(src, /method:\s*"DELETE"/);
  assert.match(src, /probe .* deleted durably/);
  assert.ok(!/json\?\.rows \?\? \[\]/.test(src));
});

// The GitHub Actions workflow this test previously read was removed at the
// owner's direction on 2026-08-17 (CI was never part of the mandate). The
// runner-side guarantees stand on their own and stay pinned.
test("the browser runner demands real owner credentials for external targets", () => {
  const runner = read("scripts/run-browser-tests.mjs");
  assert.match(runner, /if \(!external\)/);
  assert.match(runner, /OWNER_PASSWORD must be supplied when testing an external deployment/);
});
