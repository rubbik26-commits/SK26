// Regressions for defects reported against the running code.
//
// Each test below corresponds to one numbered finding and fails if that defect
// returns. They are grouped here rather than scattered so the list stays
// checkable against the report it came from.
//
//   node --test tests/reported-defects.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ---------------------------------------------------------------------- #1
// Owner authentication was shadowed on /api/pinecone-status and
// /api/airtable-xref: routes-bundle is mounted ahead of production-api, its
// isOwner() read req.user?.role (never set — attachUser writes req.profile.role)
// and it had no way to resolve a Supabase bearer at all. A signed-in Supabase
// owner was therefore treated as anonymous by the endpoint the frontend uses as
// its app-wide owner switch.
test("#1 owner identity is resolved before the first router that authorizes", () => {
  const serverJs = read("server.js");
  const attachAt = serverJs.indexOf("app.use(attachUser)");
  const identityAt = serverJs.indexOf("productionIdentity(req)");
  const bundleAt = serverJs.indexOf("app.use(bundleRoutes)");
  assert.ok(attachAt >= 0 && identityAt >= 0 && bundleAt >= 0, "all three mount points exist");
  assert.ok(identityAt < bundleAt,
    "the Supabase bearer must be resolved BEFORE bundleRoutes, which owns /api/pinecone-status");

  const bundle = read("server/routes-bundle.js");
  const isOwnerLine = bundle.slice(bundle.indexOf("const isOwner ="), bundle.indexOf("const isOwner =") + 400);
  assert.match(isOwnerLine, /req\.profile\?\.role/, "the self-hosted role lives on req.profile.role");
  assert.match(isOwnerLine, /req\.productionUser\?\.role/, "the Supabase role must be honoured too");
});

test("#1 both owner-gated bundle endpoints go through the shared check", () => {
  const bundle = read("server/routes-bundle.js");
  for (const route of ["/api/pinecone-status", "/api/airtable-xref"]) {
    const at = bundle.indexOf(`"${route}"`);
    assert.ok(at > 0, `${route} is defined in routes-bundle`);
    const body = bundle.slice(at, at + 700);
    assert.match(body, /isOwner\(req\)/, `${route} must decide ownership through isOwner()`);
  }
});

// ---------------------------------------------------------------------- #3
// app_state_bootstrap accepted the first sufficiently long token while the auth
// table was empty, with a count(*) and an insert and nothing serialising them.
test("#3 the bootstrap race is closed three ways in the committed migration", () => {
  const sql = read("supabase/migrations/202608150001_app_state_publishable_key_rpc.sql");
  assert.match(sql, /create unique index if not exists app_state_auth_singleton\s+on public\.app_state_auth \(\(true\)\)/i,
    "a unique index on a constant expression makes a second token row impossible");
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('app_state_bootstrap'\)\)/i,
    "the check-then-insert is serialised across sessions");
  assert.match(sql, /app_state_bootstrap_window/,
    "registration is closed by default and opened only for a bounded window");
  assert.match(sql, /revoke all on function public\.app_state_open_bootstrap/i,
    "opening that window is operator-only — never granted to anon");
  // The lock has to be taken before the count, or it serialises nothing.
  const fn = sql.slice(sql.lastIndexOf("create or replace function public.app_state_bootstrap"));
  const lockAt = fn.indexOf("pg_advisory_xact_lock");
  const countAt = fn.indexOf("select count(*)");
  assert.ok(lockAt > 0 && countAt > 0 && lockAt < countAt,
    "the advisory lock must be taken BEFORE the count, not after it");
});

// ---------------------------------------------------------------------- #4
// durableStore.save() wrote to disk and returned {backend:"disk"} when every
// durable path failed, so callers answered {ok:true} for a save that would not
// survive a redeploy.
test("#4 a configured-but-failing backend throws instead of reporting success", () => {
  const store = read("server/durable-store.js");
  assert.match(store, /durable_write_failed/, "the failure has a code callers can branch on");
  assert.match(store, /export function durableConfigured/,
    "there is an explicit distinction between disk-by-design and disk-by-failure");
  assert.match(store, /will not survive a redeploy/, "and the message says what actually happened");
  // ...but only after the backend has actually worked once. Throwing on a
  // backend that was never reachable turns a half-configured deployment into a
  // dead one, which the release gate caught: two of three environment variables
  // set produced 503 on every save.
  assert.match(store, /durableConfigured\(\) && everWorked/,
    "an outage throws; a misconfiguration must degrade, not refuse every save");
  assert.match(store, /MISCONFIGURED/, "and a misconfiguration is loud in the log");
  assert.match(store, /misconfigured: true/, "and visible on the response");
});

test("#4 the routes turn that into a visible 503, not a success", () => {
  const bundle = read("server/routes-bundle.js");
  assert.match(bundle, /durable_write_failed/, "wrap() recognises the failure");
  assert.match(bundle, /error:\s*"not_saved"/, "and answers with an explicit not-saved error");
  const wrap = bundle.slice(bundle.indexOf("const wrap ="), bundle.indexOf("const wrap =") + 900);
  assert.match(wrap, /status\(503\)/, "reported as 503 rather than a generic 500");
  // Every save site must report where the write landed.
  const saves = [...bundle.matchAll(/await (pipelineStore|investorsStore)\.save\(/g)];
  assert.ok(saves.length >= 3, `expected the three save sites, found ${saves.length}`);
  assert.ok(!/await (pipelineStore|investorsStore)\.save\([^)]*\);\s*\n\s*return \{ ok: true \};/.test(bundle),
    "no save site may return a bare {ok:true} without reporting durability");
});

// ---------------------------------------------------------------------- #5
// render.yaml runs apply-migrations.mjs, which exited 0 whenever
// SUPABASE_DB_URL/DATABASE_URL were unset — and the blueprint declared neither,
// so it ALWAYS skipped and the deploy went green with no schema.
test("#5 the blueprint declares the database credentials the migration step needs", () => {
  const yaml = read("render.yaml");
  for (const key of ["SUPABASE_DB_URL", "DATABASE_URL"]) {
    assert.match(yaml, new RegExp(`- key: ${key}`), `${key} must be declared in the blueprint`);
  }
});

test("#5 the migration step verifies the schema instead of skipping silently", () => {
  const mig = read("scripts/apply-migrations.mjs");
  assert.match(mig, /FAILING THE DEPLOY/, "a configured project with a missing schema fails the build");
  assert.match(mig, /app_state_get/, "it probes for an object the running app actually calls");
  assert.match(mig, /res\.status === 404/, "a 404 from PostgREST is what proves the function is absent");
});

// The three branches, run for real: nothing configured, configured+present,
// configured+absent. A gate that has never failed has not been verified.
const runMigrate = (env, script = "scripts/apply-migrations.mjs") => new Promise((resolve) => {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SUPABASE_") && k !== "DATABASE_URL")), ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let out = "";
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { out += b; });
  child.on("close", (code) => resolve({ code, out }));
});

test("#5 with nothing configured the step exits 0", async () => {
  // NODE_ENV is pinned, not inherited. "Nothing configured" is a local/dev
  // build and skips cleanly; under NODE_ENV=production the same omission
  // fails the deploy outright (no legacy fallback exists — see the production
  // case below). Inheriting NODE_ENV made this assertion depend on the shell
  // it happened to run in.
  const r = await runMigrate({ NODE_ENV: "development" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no database configured/i);
});

// The production counterpart of the case above, which is the one that actually
// protects a deploy: with no SUPABASE_URL set, production has NO database
// identity — the legacy fallback was removed (owner directive 2026-08-18) —
// so the migration step fails the deploy naming the missing variable instead
// of probing a project the deployment's owner does not control.
test("#5 in production an omitted SUPABASE_URL fails the deploy outright", async () => {
  const r = await runMigrate({ NODE_ENV: "production" });
  assert.notEqual(r.code, 0,
    "a production deploy must not pass without a named Supabase project");
  assert.match(r.out, /FAILING THE DEPLOY/,
    "and it must say so, rather than skipping quietly");
  assert.match(r.out, /SUPABASE_URL is not set/,
    "naming the missing configuration");
});

test("#5 with a project configured but the schema absent the step FAILS", async () => {
  // Point the probe at a function that cannot exist, which is exactly what an
  // un-migrated project looks like from outside.
  const { writeFileSync, unlinkSync } = await import("node:fs");
  const tmp = path.join(root, "scripts", ".apply-migrations.negative.mjs");
  writeFileSync(tmp, read("scripts/apply-migrations.mjs").replace("/rest/v1/rpc/app_state_get", "/rest/v1/rpc/__absent__"));
  try {
    const r = await runMigrate({
      SUPABASE_URL: "https://hvsvxjdwfbsqaqlmuwlt.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_probe_only_not_a_secret"
    }, tmp);
    assert.notEqual(r.code, 0, `the deploy must fail when the schema is missing:\n${r.out}`);
    assert.match(r.out, /FAILING THE DEPLOY/);
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------------- #2
// Street View incremented the durable counter BEFORE proxyImage() checked its
// 24-hour cache, so a cached image billed as a Google request; and the owner's
// usage panel read a local JSON file that nothing increments any more.
test("#2 a cached Street View image does not increment the paid meter", () => {
  const src = read("server/production-imagery.js");
  const sv = src.slice(src.indexOf('router.get("/api/streetview"'));
  const cacheAt = sv.indexOf("cachedImage(");
  const meterAt = sv.indexOf("incrementDurableUsage(");
  assert.ok(cacheAt > 0 && meterAt > 0, "both the cache check and the meter are present");
  assert.ok(cacheAt < meterAt,
    "the cache must be checked BEFORE metering — a cache hit makes no Google request and costs nothing");
});

test("#2 the owner usage panel reads the counter that chargeable calls increment", () => {
  const cost = read("server/durable-cost.js");
  assert.match(cost, /export async function readDurableUsage/,
    "there is a way to READ cre_usage_daily, not only to increment it");
  const bundle = read("server/routes-bundle.js");
  const usage = bundle.slice(bundle.indexOf('router.get("/api/maps-usage"'), bundle.indexOf('router.get("/api/maps-usage"') + 1600);
  assert.match(usage, /readDurableUsage/, "the panel asks the durable store first");
  assert.match(usage, /source:\s*"cre_usage_daily"/, "and names the source it used");
  assert.match(usage, /durable:\s*false/, "the local-file fallback is labelled as not durable");
});

// --------------------------------------------------------------------- #13
// One liveBuilding() probe was PLUTO-only and its single boolean was assigned
// to pluto, acris and socrata alike, so an ACRIS outage still reported healthy.
test("#13 ACRIS health is probed independently of PLUTO", () => {
  const src = read("server/routes-live.js");
  const start = src.indexOf('router.get("/api/status"');
  const status = src.slice(start, src.indexOf('router.get("/api/address"', start));
  assert.match(status, /acrisByLot\(/, "ACRIS is probed with its own call");
  assert.match(status, /acris:\s*acrisOk/, "and the reported value comes from that probe");
  assert.ok(!/pluto:\s*!!probe,\s*acris:\s*!!probe/.test(status),
    "acris must not simply mirror the PLUTO probe");
});

// --------------------------------------------------------------------- #15
test("#15 an inferred J-51 term is labelled an estimate", async () => {
  const { safeJ51 } = await import("../server/cliffs-contract.js");
  const inferred = safeJ51({ live: true, taxYear: 2026, j51: { active: true, periodStart: 2010 } }, 2026);
  assert.equal(inferred.valueType, "estimated");
  assert.equal(inferred.endYearEstimated, true);
  assert.equal(inferred.statusEstimated, true);
  assert.match(inferred.basis, /verify against the filed benefit schedule/i);

  const published = safeJ51({ live: true, j51: { active: true, periodStart: 2010, periodEnd: 2024 } }, 2026);
  assert.equal(published.valueType, "published fact");
  assert.equal(published.endYearEstimated, false);
});

// --------------------------------------------------------------------- #16
test("#16 the Source Registry no longer calls live owner names demo placeholders", () => {
  const src = read("server/sources.js");
  assert.ok(!/demo placeholders/i.test(src),
    "production ownership comes from live PLUTO; calling it a demo placeholder is a stale disclaimer");
  assert.match(src, /live PLUTO ownername/i, "and it names where owner data actually comes from");
  // Assert the claim, tolerating the qualifier. The registry says an owner of
  // record "is not, by itself, a resolved beneficial-ownership graph"; a regex
  // demanding those words be contiguous failed on the more careful wording.
  assert.match(src, /is not[^.]*resolved beneficial-ownership graph/i,
    "while still stating the real limitation, which is that an LLC of record is not a beneficial owner");
});

// A revoke that only names anon does nothing: Postgres grants EXECUTE on a new
// function to PUBLIC by default and anon inherits it. This was caught by
// querying has_function_privilege on the live project, which answered TRUE
// after the anon-only revoke — the operator-only window was open to everyone.
test("#3 privileged bootstrap functions are revoked from PUBLIC, not just anon", () => {
  const sql = read("supabase/migrations/202608150001_app_state_publishable_key_rpc.sql");
  for (const fn of ["public.app_state_open_bootstrap(int, text)", "public.app_state_token_ok(text)"]) {
    assert.ok(
      sql.includes(`revoke all on function ${fn} from public;`),
      `${fn} must be revoked from PUBLIC — revoking from anon alone leaves the default grant in place`
    );
  }
});

// --------------------------------------------------------------------- #10
// Every live parcel in all five boroughs was labelled "FiDi / Lower Manhattan",
// and the neighborhood filter carried an explicit `|| p.id.startsWith("LIVE-")`
// bypass that let every live parcel through regardless of what was requested —
// which hid the wrong labels by making the filter do nothing.
test("#10 neighborhoods are resolved from coordinates, not hard-coded", async () => {
  const { neighborhoodFor } = await import("../server/opps-live.js");
  // A Manhattan lot near the Garment District anchor.
  assert.equal(await neighborhoodFor(40.7522, -73.9876, "1008140001"), "Garment District / Midtown South");
  // Gowanus.
  assert.equal(await neighborhoodFor(40.6778, -73.9907, "3009780018"), "Gowanus / Park Slope");
  // Staten Island is nowhere near any curated anchor: it must take its borough
  // name, not the nearest Manhattan neighborhood.
  assert.equal(await neighborhoodFor(40.5795, -74.1502, "5000010001"), "Staten Island");
  // A Bronx lot likewise.
  assert.equal(await neighborhoodFor(40.8448, -73.8648, "2028830001"), "Bronx");
});

test("#10 the neighborhood filter has no LIVE-* bypass", () => {
  const bundle = read("server/routes-bundle.js");
  assert.ok(!/p\.neighborhood === neighborhood \|\| p\.id\.startsWith\("LIVE-"\)/.test(bundle),
    "the bypass made the filter a no-op for every live parcel");
  assert.match(bundle, /if \(neighborhood\) list = list\.filter\(\(p\) => p\.neighborhood === neighborhood\);/,
    "the filter must actually filter");
});

// ---------------------------------------------------------------------- #7
// The PostGIS tax-history route held only PG_ADOPTED_RATES[2026] and answers
// ahead of the DOF implementation, so a PostGIS deployment got taxRate:null and
// estTax:null on every other year.
test("#7 the PostGIS tax path uses the published rate table and carries forward", () => {
  const bundle = read("server/routes-bundle.js");
  const at = bundle.indexOf("const PG_ADOPTED_RATES");
  const route = bundle.slice(at, at + 3000);
  assert.match(route, /taxRatesByClass\(\)/, "it reads the City's published rates, not a one-year constant");
  assert.match(route, /publishedRates\[year\]\?\.\[key\]/, "published rates take precedence");
  assert.match(route, /estTaxValueType: adopted != null \? "derived calculation" : carried != null \? "estimated"/,
    "a carried-forward rate is labelled an estimate, matching the DOF path");
});

// --------------------------------------------------------------------- #12
// /api/lot-at answered "which lot centroid is nearest" while the UI asks "which
// lot did I click on". Those differ on long lots and near shared lot lines.
test("#12 lot containment is computed correctly, holes included", async () => {
  const { geometryContains } = await import("../server/adapters/mappluto.js");
  const donut = { type: "Polygon", coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
  ] };
  assert.equal(geometryContains(donut, 1, 1), true, "inside the outer ring");
  assert.equal(geometryContains(donut, 5, 5), false, "inside a hole is outside the lot");
  assert.equal(geometryContains(donut, 20, 20), false, "outside entirely");
  const multi = { type: "MultiPolygon", coordinates: [
    [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]]
  ] };
  assert.equal(geometryContains(multi, 5.5, 5.5), true, "the second polygon of a MultiPolygon counts");
  assert.equal(geometryContains(null, 0, 0), false);
});

// Re-pinned 2026-08-19. This test used to require the nearest-centroid
// fallback and its resolvedBy labels. Measured against the original on nine
// cases, that fallback is not the contract: where no lot polygon contains the
// point the original answers 200 {"found":false}, while the rebuild returned a
// full record for a DIFFERENT lot —
//   40.678180,-73.944160  original {"found":false}  rebuild 63-key lot
//   40.764560,-73.973000  original {"found":false}  rebuild 63-key lot
//   40.687000,-73.944000  original {"found":false}  rebuild 63-key lot
// so a click on a street opened a neighbour's dossier. The containment query
// itself was right and stays pinned.
test("#12 lot-at asks the containment question and never answers with a different lot", () => {
  const bundle = read("server/routes-bundle.js");
  const at = bundle.indexOf('router.get("/api/lot-at"');
  const route = bundle.slice(at, bundle.indexOf('router.get("/api/nta-polys"', at));
  assert.match(route, /intersects\(the_geom, "POINT\(/,
    "within_box requires containment IN the box and excluded every lot larger than it");
  assert.match(route, /return \{ found: false \}/,
    "no containing polygon means no lot at this point, exactly as the original answers");
  const code = route.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/nearest-centroid/.test(code) && !/resolvedBy/.test(code),
    "the nearest-lot guess and its label are not part of the original's contract");
  // A source that cannot answer is unavailable, not an absent lot.
  assert.match(route, /lot_at_source_unavailable/);
});

// The original's exact hit envelope: 23 keys, in this order, and nothing else.
// Measured 2026-08-19 at 40.748440,-73.985664 and 40.752000,-73.977000.
test("#12b lot-at publishes the original's 23-key envelope", () => {
  const bundle = read("server/routes-bundle.js");
  const fn = bundle.slice(bundle.indexOf("function lotAtContract("), bundle.indexOf('router.get("/api/lot-at"'));
  const order = ["bbl:", "address:", "owner:", "bldgClass:", "landUse:", "zoning:", "units:",
    "unitsRes:", "lotArea:", "bldgArea:", "floors:", "yearBuilt:", "assessedTotal:", "builtFar:",
    "maxResidFar:", "maxCommFar:", "maxFacilFar:", "numBldgs:", "histDist:", "landmark:",
    "eDesig:", "splitZone:", "ltdHeight:"];
  let at = -1;
  for (const key of order) {
    const i = fn.indexOf(key, at + 1);
    assert.ok(i > at, `${key} must follow the previous key — JSON key order is the original's`);
    at = i;
  }
  // Grand Central (BBL 1012800001) has no recorded floors or year: the original
  // publishes null for both while keeping bldgArea 0, builtFar 0, numBldgs 1.
  assert.match(fn, /floors: LOT_AT_UNKNOWN\(b\.numFloors\)/);
  assert.match(fn, /yearBuilt: LOT_AT_UNKNOWN\(b\.yearBuilt\)/);
  // A lot with no building must not report one: plutoRowToBuilding coerces a
  // recorded 0 to 1 for its other consumers, so numBldgs is read from the row.
  assert.match(fn, /raw\?\.numbldgs == null \? b\.numBldgs :/);
});

// ---------------------------------------------------------------------- #6
// acris_docs used document_id as its sole primary key while storing one bbl,
// and the ingestion worker loops BBL by BBL upserting on document_id — so a
// deed covering an assemblage kept only the last lot written.
test("#6 acris_docs is keyed on (document_id, bbl)", () => {
  const base = read("supabase/migrations/202608130003_postgis_geospatial.sql");
  const ddl = base.slice(base.indexOf("create table if not exists public.acris_docs"),
    base.indexOf("create index if not exists acris_docs_bbl_idx"));
  assert.ok(!/document_id text primary key/.test(ddl),
    "a single-column key cannot hold a document that touches more than one lot");
  assert.match(ddl, /primary key \(document_id, bbl\)/, "the key must match ACRIS's own grain");

  const fix = read("supabase/migrations/202608150002_acris_docs_multi_lot_key.sql");
  assert.match(fix, /to_regclass\('public\.acris_docs'\)/,
    "guarded so it is a no-op on a project without the PostGIS layer");
  assert.match(fix, /primary key \(document_id, bbl\)/);
});

test("#6 both ingestion paths upsert on the composite key", () => {
  assert.match(read("scripts/ingest/acris.js"), /upsert\("acris_docs", rows, "document_id,bbl"\)/);
  assert.match(read("scripts/db-setup.js"), /on conflict \(document_id,bbl\)/);
});

// --------------------------------------------------------------------- #11
test("#11 territory analytics page the whole territory and label any sampling", () => {
  const src = read("server/production-live-extra.js");
  assert.match(src, /TERRITORY_MAX_LOTS/, "there is an explicit cap rather than an unstated 1000");
  assert.ok(!/liveAreaBuildings\(zips,\{page:0,pageSize:1000,sort:"score"\}\)/.test(src),
    "the single 1000-row pull is gone");
  assert.match(src, /sampled:snap\.area\.sampled===true/, "the response says whether it sampled");
  assert.match(src, /coveragePct:snap\.area\.coverage/, "and what fraction it covered");
});

test("#11 area-detail honours the mode it accepts", () => {
  const src = read("server/production-live-extra.js");
  const at = src.indexOf('router.get("/api/area-detail"');
  const route = src.slice(at, at + 2200);
  assert.match(route, /if\(kind==="sales"\)/);
  assert.match(route, /const inMode=/, "sales must be filtered by the requested asset class");
  assert.match(route, /mode==="office"\)return c==="O"/, "using the same class-family rule as /api/territory");
});

// --------------------------------------------------------------------- #14
test("#14 the cross-field formula actually searches address and BBL", async () => {
  const { crossFieldFormula, matchFields } = await import("../server/adapters/airtable.js");
  const terms = ["EMPIRE STATE BUILDING", "338 5 AVENUE", "1008350041"];
  const formula = crossFieldFormula(terms, matchFields());

  // The defect was entirely in which fields the formula covered, so it is a
  // pure function of terms x fields and needs no Airtable base to verify.
  const clauses = (formula.match(/IF\(/g) || []).length;
  assert.equal(clauses, terms.length * matchFields().length,
    `every term must be searched against every field — got ${clauses}`);
  assert.ok(clauses > terms.length,
    "the old fallback produced exactly one clause per term, all against {Name}");

  assert.match(formula, /\{Address\}/, "a record matching only on Address must be findable");
  assert.match(formula, /\{BBL\}/, "and one matching only on BBL");
  assert.match(formula, /IF\(\{Address\}, SEARCH\(LOWER\("338 5 avenue"\)/,
    "the address term is searched against the Address field specifically");
  assert.match(formula, /IF\(\{BBL\}, SEARCH\(LOWER\("1008350041"\)/);

  // A field the table does not have must contribute 0, not error: Airtable
  // rejects the whole formula on an unknown field name, which would take the
  // entire query down instead of skipping one column.
  assert.ok(formula.split("IF({").length - 1 === clauses,
    "every clause is guarded with IF({field}, ...)");
  assert.equal(crossFieldFormula([], matchFields()), "FALSE()", "no terms matches nothing");
});

test("#14 the Airtable fallback searches address and BBL, not only Name", () => {
  const src = read("server/adapters/airtable.js");
  assert.match(src, /AIRTABLE_MATCH_FIELDS/, "candidate fields are configurable per base");
  assert.match(src, /Address/, "address is searched");
  assert.match(src, /BBL/, "BBL is searched");
  assert.ok(!/fallbackFormula\("Name"\)\), error: null \};\n      \} catch \(e2\)/.test(src),
    "Name-only must not be the first fallback");
  assert.match(src, /matchedFields/, "the response reports which fields were actually searched");
  assert.match(src, /degraded/, "and says so when it had to narrow to Name only");
});

// --------------------------------------------------------------------- #18
test("#18 db:setup stops on a migration failure instead of continuing", () => {
  const src = read("scripts/db-setup.js");
  assert.match(src, /migrationFailures\.push/, "failures are collected");
  assert.match(src, /throw new Error\(`migration \$\{file\} failed/, "and abort the run");
  assert.match(src, /already exists/i, "an idempotent re-run is still tolerated");
  assert.match(src, /Coverage loaded: ZIP/, "the summary states what was actually loaded");
  assert.match(src, /not the whole city/i, "so a four-ZIP slice is never read as citywide");
});

// --------------------------------------------------------------------- #19
// The CI workflow this item pinned was removed at the owner's direction on
// 2026-08-17 — GitHub Actions was never part of the mandate. The deployed
// verification it orchestrated runs directly instead:
// `node scripts/run-browser-tests.mjs <deployment-url>`.

// ---------------------------------------------------------------------- #8
// The Development/Land stock rule was not recovered. That is still true — what
// changed is that the null now states what was ruled out, so nobody re-runs the
// same searches and nobody mistakes it for an oversight.
test("#8 development stock stays null and says why", () => {
  const src = read("server/market-report.js");
  assert.ok(!/development:\s*"\(/.test(src), "no predicate was invented to hit three numbers");
  assert.match(src, /EXHAUSTIVE subset search over all 24 building-class letters/,
    "the class-letter family is recorded as exhaustively ruled out");
  assert.match(src, /EXHAUSTIVE subset search over all 12 land-use codes/,
    "so is the land-use family");
  const reason = src.slice(src.indexOf("const STOCK_UNAVAILABLE"), src.indexOf("const ROWS"));
  assert.match(reason, /11216=363, 10002=132, 10451=438/, "the API states the targets it could not reproduce");
  // Check the CODE, not the comment: the block carries a long note explaining
  // what was ruled out, and that note necessarily contains the word.
  const predicateBlock = src.slice(src.indexOf("const STOCK_PREDICATE"), src.indexOf("// Why a class reports no stock"));
  const withoutComments = predicateBlock.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\bdevelopment\s*:/.test(withoutComments),
    "development must not acquire a stock predicate without the rule being known");
});

// ---------------------------------------------------------------------- #9
// productionOpportunityScore is a least-squares fit of the original's scorer,
// not the recovered rule. It may match sampled parcels and cannot guarantee an
// identical score for one that was not sampled.
test("#9 the opportunity score is labelled a modeled estimate", async () => {
  const { plutoRowsToParcels } = await import("../server/opps-live.js");
  const [p] = plutoRowsToParcels([{
    bbl: "1008350041.00000000", address: "338 5 AVENUE", landuse: "05",
    lotarea: "91351", bldgarea: "2812739", builtfar: "30.79", residfar: "0",
    commfar: "15", yearbuilt: "1931", numfloors: "102", unitsres: "0",
    latitude: "40.7484514", longitude: "-73.9857117", zipcode: "10001", ownername: "X"
  }]);
  assert.ok(p, "a parcel was produced");
  assert.equal(typeof p.opportunityScore, "number");
  assert.equal(p.scoreValueType, "modeled estimate",
    "the score must never be presented as the original's figure or a recorded fact");
  assert.match(p.scoreBasis, /least-squares fit/i, "and the method is stated");
  assert.match(p.scoreBasis, /not the recovered rule/i, "including its limitation");
  // The thesis STRING no longer carries the qualifier, because the original's
  // does not. Measured on its bare feed, verbatim:
  //   "Modeled development score 30. Confirm ownership intent, debt and any
  //    active filings in the dossier."
  // The estimate labelling survives where it can be read without diverging from
  // the specification: scoreValueType and scoreBasis stay on the parcel for
  // every internal consumer, and the score is still called "Modeled" in the
  // sentence the user sees. /api/opportunities projects the original's exact
  // 33-key item, so neither field is published there.
  assert.match(p.thesis, /^Modeled development score \d+\./,
    "the sentence still says the score is modeled, exactly as the original words it");
  assert.ok(!/modeled estimate, not a recorded figure/i.test(p.thesis),
    "the parenthetical is not in the specification");
});

// --------------------------------------------------------------------- #17
// public/index.html injects scripts absent from the untouched export, and one
// of them (mobile-parity.js) is behavioural. The injections are allowed; an
// UNDECLARED injection is not.
test("#17 every shell injection is declared, and the pristine shell is servable", () => {
  const served = read("public/index.html");
  const original = read("site/index.html");
  const doc = read("docs/SHELL-DIVERGENCE.md");

  const assets = (html) => new Set(
    [...html.matchAll(/(?:src|href)="(\/(?:js|css)\/[^"]+)"/g)].map((m) => m[1])
  );
  const injected = [...assets(served)].filter((a) => !assets(original).has(a));
  assert.ok(injected.length > 0, "there are injections — this test exists to bound them");

  // Classification matters, not substring presence: a file mentioned only in a
  // "removed" section is NOT documented as served — that loophole let the doc
  // deny serving skyline-brand.css while index.html loaded it.
  const removedAt = doc.search(/^## Removed divergences$/m);
  const activeDoc = removedAt >= 0 ? doc.slice(0, removedAt) : doc;
  const removedDoc = removedAt >= 0 ? doc.slice(removedAt) : "";
  for (const a of injected) {
    const name = a.replace(/^\//, "");
    assert.ok(activeDoc.includes(name),
      `${a} is injected into the served shell but not documented (outside any "removed" section) in docs/SHELL-DIVERGENCE.md`);
  }
  for (const m of removedDoc.matchAll(/`(?:\/)?((?:js|css)\/[^`]+)`/g)) {
    assert.ok(!injected.includes(`/${m[1]}`),
      `docs/SHELL-DIVERGENCE.md claims ${m[1]} was removed, but the served shell injects it`);
  }

  // The behavioural one must be named as behavioural, not filed under cosmetic.
  const behavioural = doc.slice(doc.indexOf("## Behavioural"), doc.indexOf("## Functional"));
  assert.match(behavioural, /mobile-parity\.js/,
    "mobile-parity.js changes what the app does and must be declared behavioural");
  // Match the claim, not one exact phrasing — the doc says "deliberate
  // functional divergence", and requiring the two words to be adjacent failed
  // on wording that states the point more precisely than the regex did.
  assert.match(behavioural, /deliberate\s+\w*\s*divergence/i,
    "and the conflict with behaviour-for-behaviour parity must be stated, not glossed");
  assert.match(behavioural, /Delete this file and the\s+original .* returns|stated production requirement/i,
    "including why it is kept despite that conflict");

  assert.match(read("server.js"), /__original-shell/,
    "the untouched export must be servable so the divergence can be diffed");
});

// ===================================================================== //
// Second report, items #1-#31. Numbered R#n to keep them distinct from
// the first report's #1-#19 above.
// ===================================================================== //

// -------------------------------------------------------------------- R#1
// roleForNewUser() granted "owner" to whoever registered first when cre_users
// was empty. On Render the SQLite file lives on ephemeral disk, so the table is
// empty again after every cold start: any visitor who signed up first became
// owner, with no OWNER_PASSWORD and no OWNER_EMAIL allowlist involved.
test("R#1 production never grants owner from an empty user table", async () => {
  const src = read("server/auth.js");
  const fn = src.slice(src.indexOf("function roleForNewUser"), src.indexOf("function roleForNewUser") + 700);
  assert.match(fn, /OWNER_EMAIL/, "an explicit allowlist remains the only production path to owner");

  // The count may only be consulted behind BOTH a non-production guard and an
  // explicit opt-in. Reaching it on any other path re-opens the escalation.
  const countAt = fn.indexOf("count(*)");
  if (countAt >= 0) {
    const guard = fn.slice(0, countAt);
    assert.match(guard, /NODE_ENV !== "production"/,
      "the row count must be unreachable in production");
    assert.match(guard, /LOCAL_FIRST_USER_OWNER === "1"/,
      "and must additionally require an explicit local opt-in, not merely 'not production'");
  }
  // Whatever the environment, the default when no rule matches is a plain user.
  assert.match(fn, /return "user";?\s*\n?\}/,
    "the function must fall through to 'user', never to 'owner'");

  const { default: authRouter } = await import("../server/auth.js").catch(() => ({ default: null }));
  assert.ok(authRouter !== undefined, "the module still loads after the change");
});

// -------------------------------------------------------------------- R#2
// A mortgage with an empty linkedSatisfactions array was treated as
// outstanding. Empty also means "the Cross References source did not answer",
// so a source outage published discharged loans as live debt.
test("R#2 unresolved satisfaction linkage excludes a parcel instead of assuming debt", () => {
  const src = read("server/production-private.js");
  const idx = src.indexOf('router.get("/api/maturity-wall"');
  const body = src.slice(idx, src.indexOf("return res.json", idx) + 3000);
  assert.match(body, /referenceStatus !== "live"/,
    "the linkage source's own status must gate the empty-array inference");
  assert.match(body, /unresolvedSatisfaction/,
    "and excluded parcels must be reported, not silently dropped");

  // Order has to be checked against the executing statements. The comment
  // explaining this fix quotes `!d.linkedSatisfactions?.length` verbatim, so a
  // raw indexOf finds the prose above the guard and reports the wrong order.
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const statusAt = code.indexOf('if (acris.referenceStatus !== "live")');
  const inferAt = code.indexOf("!d.linkedSatisfactions?.length");
  assert.ok(statusAt >= 0, "the status guard is a statement, not only a comment");
  assert.ok(inferAt >= 0, "the empty-array inference is still what selects outstanding debt");
  assert.ok(statusAt < inferAt,
    "the status check must run before the empty-array inference, not after it");
});

// -------------------------------------------------------------------- R#3
// liveMaturityWall() filtered ACRIS down to kind === "mortgage" before calling
// estimateDebtMaturity(). The estimator's satisfaction detection reads the
// SATISFACTION / RELEASE documents out of the array it is given — they had
// already been removed, so the check could never fire and a discharged loan was
// published as debt past maturity.
test("R#3 the estimator receives the satisfaction documents it was written to detect", async () => {
  const src = read("server/live.js");
  const fn = src.slice(src.indexOf("export async function liveMaturityWall"),
    src.indexOf("export { acsByZip as liveDemographics"));

  assert.ok(!/filter\(\(m\) => m\.kind === "mortgage"\)/.test(fn),
    "pre-filtering to mortgages discards the discharge evidence the estimator needs");
  assert.match(fn, /"satisfaction"/,
    "satisfactions must reach estimateDebtMaturity()");
  assert.match(fn, /"agreement"/,
    "and CEMA/consolidation agreements, which restate the debt and reset its date");
  assert.match(fn, /est\.satisfied/, "the wall must act on the result, not just compute it");
  assert.match(fn, /satisfiedExcluded/, "and disclose what it excluded");

  // Behavioural proof, against the estimator itself.
  const { estimateDebtMaturity, computeDistressFromRecord } = await import("../server/scoring.js");

  // ACRIS orders newest-first, which is how acrisByLot hands the docs over.
  const withDischarge = {
    loans: [
      { date: "2019-06-04", amount: 0, docType: "SATISFACTION OF MORTGAGE", lender: "—" },
      { date: "2011-03-22", amount: 4200000, docType: "MORTGAGE", lender: "SIGNATURE BANK" }
    ]
  };
  const est = estimateDebtMaturity(withDischarge, 2026);
  assert.equal(est.satisfied, true, "a 2019 discharge of a 2011 loan is on record");
  assert.equal(est.satisfactionDate, "2019-06-04");
  assert.equal(est.amount, 4200000, "the mortgage, not the discharge, is still the primary document");
  assert.equal(est.date, "2011-03-22");
  assert.match(est.note, /may already be repaid/);

  // The exact array the old caller would have produced: same parcel, discharge
  // stripped. It reports the loan as live debt — this is the defect, reproduced.
  const preFiltered = { loans: withDischarge.loans.filter((l) => !/SATISF/.test(l.docType)) };
  const blind = estimateDebtMaturity(preFiltered, 2026);
  assert.equal(blind.satisfied, false, "with the discharge removed the estimator cannot see it");
  assert.equal(blind.status, "past", "and publishes a repaid loan as past maturity");
  assert.equal(blind.satisfactionsSeen, 0,
    "satisfactionsSeen separates 'no discharge on record' from 'none supplied'");

  // Distress must not score a repaid loan as refinance pressure.
  const scored = computeDistressFromRecord(withDischarge, 2026);
  assert.ok(!scored.reasons.some((r) => /maturity/i.test(r.label)),
    "a discharged loan is not maturity pressure");
  const scoredBlind = computeDistressFromRecord(preFiltered, 2026);
  assert.ok(scoredBlind.reasons.some((r) => /past estimated maturity/i.test(r.label)),
    "whereas the pre-filtered record scored 30 points off a loan that was already repaid");
  assert.ok(scoredBlind.distressScore > scored.distressScore);

  // The widened fallback must never name a discharge as the outstanding loan.
  const onlyDischarge = estimateDebtMaturity({
    loans: [{ date: "2019-06-04", amount: 0, docType: "SATISFACTION OF MORTGAGE", lender: "—" }]
  }, 2026);
  assert.equal(onlyDischarge, null,
    "a record containing only a discharge has no outstanding loan to report");
});

// ------------------------------------------------------------------- R#26
// `npm test` named nine suites explicitly and had drifted: the three files
// carrying the regression coverage for reported defects — this one,
// original-contract and acris-multi-lot — were not among them, so the tests
// written to prove those fixes never ran in CI or before a push. An explicit
// list silently excludes every file added after it was written, which is the
// failure mode itself, so the script is a glob and this test guards the glob.
test("R#26 npm test runs every unit suite in tests/, with no file left out", () => {
  const pkg = JSON.parse(read("package.json"));
  const script = pkg.scripts.test;

  const onDisk = readdirSync(path.join(root, "tests"))
    .filter((f) => f.endsWith(".test.mjs")).sort();
  assert.ok(onDisk.length >= 11, `expected the full unit suite, found ${onDisk.length}`);

  // Either a glob that necessarily covers them all, or a list that names each.
  const isGlob = /tests\/\*\.test\.mjs/.test(script);
  if (!isGlob) {
    for (const f of onDisk) {
      assert.ok(script.includes(f),
        `${f} exists but npm test does not run it — an explicit list has drifted again; use tests/*.test.mjs`);
    }
  }

  // The three that were actually missing, named so a regression is unambiguous.
  for (const f of ["reported-defects.test.mjs", "original-contract.test.mjs", "acris-multi-lot.test.mjs"]) {
    assert.ok(onDisk.includes(f), `${f} is missing from tests/`);
    assert.ok(isGlob || script.includes(f), `${f} is not covered by npm test`);
  }

  // The standalone harnesses are network-driven or mutate the working tree and
  // are deliberately NOT part of `npm test`; they must stay out of the glob.
  for (const f of ["original-parity-diff.mjs", "release-gate-negatives.mjs"]) {
    assert.ok(!f.endsWith(".test.mjs"),
      `${f} would be swept into npm test by the glob — it is a standalone harness and must keep its non-.test name`);
  }
});

// ------------------------------------------------------------------- R#13
// The deploy verifier probed ONE object, public.app_state_get, and passed the
// deploy if it existed. That is exactly the state the user's own Supabase
// project was found in: the app_state migration applied, the cre_* workspace
// migration never applied. The gate went green, the kanban wrote to app_state
// successfully, and /api/pipeline, /api/maturity-wall and the owner spend panel
// all failed against tables that did not exist.
//
// Driven against a stub that answers exactly as PostgREST does — PGRST202 for a
// missing RPC, PGRST205 for a missing relation — so the detection is exercised
// rather than asserted from the source.
test("R#13 the deploy verifier probes every object the runtime needs, not just one", async () => {
  const src = read("scripts/apply-migrations.mjs");
  for (const obj of ["app_state_get", "app_state_put", "cre_pipeline", "cre_watchlist",
    "cre_investors", "cre_usage_daily", "cre_quota_daily", "cre_profiles"]) {
    assert.ok(src.includes(obj), `${obj} must be in the verifier's required set`);
  }

  const http = await import("node:http");
  // The partial schema that shipped: the app_state RPCs exist, the workspace
  // tables do not.
  const PRESENT = new Set(["/rest/v1/rpc/app_state_get", "/rest/v1/rpc/app_state_put", "/rest/v1/cre_pipeline"]);
  const server = http.createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (PRESENT.has(p)) { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: p.startsWith("/rest/v1/rpc/") ? "PGRST202" : "PGRST205", message: "not found" }));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  try {
    const r = await runMigrate({
      NODE_ENV: "production",
      SUPABASE_URL: `http://localhost:${port}`,
      SUPABASE_PUBLISHABLE_KEY: "stub"
    });
    assert.notEqual(r.code, 0, "a partially applied schema must fail the deploy");
    assert.match(r.out, /FAILING THE DEPLOY/);
    // Every absent object is named, with why it matters.
    for (const missing of ["cre_watchlist", "cre_investors", "cre_usage_daily",
      "cre_quota_daily", "cre_profiles"]) {
      assert.match(r.out, new RegExp(missing), `${missing} must be reported as missing`);
    }
    // And nothing present is falsely reported.
    assert.ok(!/- public\.cre_pipeline\b/.test(r.out), "a table that exists must not be listed as missing");
    assert.ok(!/- public\.app_state_get\b/.test(r.out), "a function that exists must not be listed as missing");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// All objects present must pass, or the gate would block every deploy.
test("R#13 a fully applied schema passes the verifier", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await runMigrate({
      NODE_ENV: "production",
      SUPABASE_URL: `http://localhost:${port}`,
      SUPABASE_PUBLISHABLE_KEY: "stub"
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /reachable and the bootstrap schema exists/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ------------------------------------------------------------------- R#19
// The Socrata adapter has always returned stale/staleAgeMs/staleRows when a
// fetch failed but an expired cache existed. Nothing in the application read
// them — zero references outside server/adapters. Because every caller branches
// on `.live`, no expired row was ever served as current, so the data-integrity
// rule held; what was lost is that a user got an identical bare "source
// unavailable" whether the dataset broke ten minutes ago or last month, and
// whether one dataset or all of them were down.
test("R#19 a failed source is recorded, surfaced, and cleared when it recovers", async () => {
  const { soql, staleSources, clearStale } = await import("../server/adapters/socrata.js");
  const DATASET = "erm2-nwe9";
  clearStale(DATASET);

  // TEST-NET-3 is reserved and unroutable, so this fails deterministically
  // rather than depending on a real outage.
  await soql(DATASET, { $limit: 1 }, { timeoutMs: 2000, retries: 0, domain: "https://203.0.113.1" });

  const degraded = staleSources();
  const entry = degraded.find((s) => s.datasetId === DATASET);
  assert.ok(entry, "a failed fetch must be recorded against its dataset");
  assert.ok(entry.error, "with the reason attached");
  assert.ok(Object.prototype.hasOwnProperty.call(entry, "lastKnownAgeMs"),
    "and how old the last good copy is — null when none has ever been held");
  assert.equal(typeof entry.hasCachedCopy, "boolean");

  // Recovery must clear it on its own; a status surface that reports an ended
  // outage forever is its own defect.
  clearStale(DATASET);
  assert.ok(!staleSources().some((s) => s.datasetId === DATASET),
    "a dataset that answers again is no longer degraded");
});

test("R#19 the live guard reports which sources are degraded, without serving cached rows", () => {
  const guard = read("server/production-live-guard.js");
  assert.match(guard, /staleSources/, "the guard reads the registry");
  assert.match(guard, /degradedSources/, "and names the failed datasets on its 503");
  assert.match(guard, /lastKnownAgeMs/, "including how stale the last good copy is");
  assert.match(guard, /No cached rows are served/,
    "while stating plainly that this is diagnostic, not data");
  // The refusal must stay a refusal.
  assert.match(guard, /status\(503\)/);
  assert.ok(!/staleRows/.test(guard),
    "the guard must never reach for the expired rows themselves");
});

// ------------------------------------------------------------------- R#6b
// The same defect class as #6, found by sweeping for it rather than waiting for
// it to be reported: a response's rows defaulted with `?? []` while nothing
// tested that response's `.live`. Six sites; the consequential one was HPD.
//
// `hpdViolations: (hpdR.rows ?? []).filter(open).length` published 0 whenever
// the HPD dataset was unreachable, and computeDistressFromRecord() reads that
// exact field — so a building with a hundred open violations scored as clean
// during an outage, and the dossier printed "0 open violations" about a real
// address. Zero is a claim about the property; null is not.
test("R#6b an unreachable violations source yields null, never a zero count", async () => {
  const src = read("server/live.js");
  const fn = src.slice(src.indexOf("export async function liveAssetHistory"),
    src.indexOf("export async function liveCompetitiveSet"));

  assert.match(fn, /hpdLive/, "liveness of the HPD pull is established explicitly");
  assert.ok(!/const hpdOpen = \(hpdR\.rows \?\? \[\]\)/.test(fn),
    "the count must not be taken unconditionally from a possibly-failed response");
  assert.match(fn, /hpdLive\s*$|hpdLive\s*\n?\s*\?/m,
    "and the count is only computed when the source answered");
  assert.match(fn, /status: "unavailable"/,
    "an outage is labelled on the payload so it is distinguishable from a clean record");

  // The scorer must not turn the unknown into distress evidence either.
  const { computeDistressFromRecord } = await import("../server/scoring.js");
  const unknown = computeDistressFromRecord({ signals: { hpdViolations: null }, loans: [] }, 2026);
  const clean = computeDistressFromRecord({ signals: { hpdViolations: 0 }, loans: [] }, 2026);
  const heavy = computeDistressFromRecord({ signals: { hpdViolations: 80 }, loans: [] }, 2026);
  assert.equal(unknown.distressScore, clean.distressScore,
    "an unknown violation count must score exactly like no evidence, not like a clean building with evidence");
  assert.ok(!unknown.reasons.some((r) => /violation/i.test(r.label)),
    "and must contribute no violation-based reason");
  assert.ok(heavy.distressScore > clean.distressScore,
    "while a real count still scores");
});

test("R#6b DOB NOW and the tax roll do not publish an outage as an empty record", () => {
  const src = read("server/live.js");
  const fn = src.slice(src.indexOf("export async function liveAssetHistory"),
    src.indexOf("export async function liveCompetitiveSet"));
  assert.match(fn, /dobNowR\?\.live === false \? null/,
    "an empty filing list from an outage reads as 'no work filed', which is a claim about the building");
  assert.match(fn, /const taxLive = tax\?\.live !== false/,
    "and a missing assessment must be distinguishable from an unreachable assessment roll");
});

// ------------------------------------------------------------------- R#11
// "A first-boot misconfiguration still accepts disposable saves."
//
// Two behaviours have to hold together, and they are easy to get backwards.
// The STORE must degrade rather than refuse — throwing on a backend that was
// never reachable is what made two-of-three environment variables worse than
// none, and killed the kanban outright. The ROUTE must refuse rather than
// report success — a save that will not survive the next redeploy is exactly
// the failure this project exists to fix, and reporting it as saved is worse
// than refusing it.
//
// So: store degrades loudly (durable:false, misconfigured:true, a warning), and
// the API answers 503 with a reason. Driven against a real server rather than
// asserted from the source.
test("R#11 a half-configured production deployment refuses the save instead of losing it", async (t) => {
  const { spawn: sp } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const PORT = 5219;
  const B = `http://localhost:${PORT}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "r11-"));

  const child = sp(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      // Every other Supabase selector is stripped first. "Configured and
      // deliberately unusable" only holds if the unusable key is the ONLY way
      // in: a real SUPABASE_SECRET_KEY or APP_STATE_TOKEN inherited from the
      // host shell hands the server a working write path, the save succeeds,
      // and the assertion below reads that success as a lost write. Same
      // reasoning as the helper at the top of this file, which already filters
      // SUPABASE_* for exactly this reason.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) =>
        !k.startsWith("SUPABASE_") && k !== "DATABASE_URL" && k !== "APP_STATE_TOKEN")),
      PORT: String(PORT),
      APP_DATA_DIR: dir,
      NODE_ENV: "production",
      // Configured, and deliberately unusable: the exact shape of a deployment
      // with SUPABASE_URL and a key set but no working write path.
      SUPABASE_URL: "https://hvsvxjdwfbsqaqlmuwlt.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "not-a-real-key-probe",
      SITE_PASSWORD: "r11-site",
      OWNER_PASSWORD: "r11-owner",
      SOCRATA_DOMAIN: "203.0.113.1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  t.after(() => {
    try { child.kill(); } catch { /* already down */ }
    rmSync(dir, { recursive: true, force: true });
  });

  let up = false;
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${B}/healthz`); up = true; break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  assert.ok(up, "the server started");

  const gate = await fetch(`${B}/__gate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=r11-owner",
    redirect: "manual"
  });
  const cookie = (gate.headers.getSetCookie?.() ?? [String(gate.headers.get("set-cookie"))])
    .map((c) => c.split(";")[0]).join("; ");

  const res = await fetch(`${B}/api/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ oppId: "LIVE-1008350041", stage: "Watchlist" })
  });
  assert.equal(res.status, 503, "a save that cannot be made durable must not answer 2xx");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.durable, false, "and must never claim durability it does not have");
  assert.equal(body.error, "durable_storage_required");
  assert.match(body.message, /no ephemeral save is reported as successful/i,
    "with a message the user can act on, not a generic failure");
  assert.match(body.message, /durable production store is unavailable/i,
    "naming the actual cause");
});

// ------------------------------------------------------------------- R#ECB
// Found by the dossier browser suite (P16.10), which compares the app's ECB
// count against the ECB dataset for five control parcels and failed on four.
// Two independent defects in server/adapters/dob-violations.js, capable of
// making the SAME field read 0 or 94 for the same building.
//
// 1. Block and lot were filtered unpadded. ECB (6bgk-3dad) and legacy BIS
//    violations (3h2n-5cm9) store them zero-padded as text, so the query
//    matched nothing: BBL 1003720009 returns 0 rows unpadded and 2 padded,
//    3009020001 returns 0 and 3. Every ECB summons on every parcel was
//    invisible, and the dossier published ecbViolations: 0 for buildings with
//    open ones.
// 2. The active/resolved predicate tested for "resolved" WITH a trailing d.
//    ecb_violation_status is exactly ACTIVE / RESOLVE / Unknown — verified by
//    grouping the live dataset — so "RESOLVE" never matched and every resolved
//    summons counted as open. With the padding fixed but this still wrong, BBL
//    1008350041 reported 94 open summonses where the record has 0.
test("R#ECB the DOB violation filter matches both block/lot spellings", () => {
  const src = read("server/adapters/dob-violations.js");
  assert.match(src, /eitherForm/,
    "the filter must accept both the padded and unpadded spelling");
  assert.ok(!/const lotWhere=`block='\$\{p\.block\}' AND lot='\$\{p\.lot\}'`/.test(src),
    "the unpadded-only filter is the defect and must not return");
  assert.match(src, /p\.block5/, "the padded block is part of the predicate");
  assert.match(src, /p\.lot4/, "and the padded lot");
});

test("R#ECB a resolved ECB summons is not counted as open", async () => {
  const src = read("server/adapters/dob-violations.js");
  assert.match(src, /const ecbActive =/,
    "ECB needs its own predicate — its vocabulary is not the shared one");
  assert.match(src, /!\/resolv\/i/,
    "matching must not require the trailing 'd' that RESOLVE does not have");
  assert.match(src, /active:ecbActive\(r\.ecb_violation_status\)/,
    "and the ECB rows must actually use it");

  // The predicate itself, against the dataset's real three values.
  const mod = await import("../server/adapters/dob-violations.js");
  assert.ok(typeof mod.dobViolationsByLot === "function", "the adapter still loads");
  const rule = (v) => !/resolv/i.test(String(v ?? ""));
  assert.equal(rule("RESOLVE"), false, "RESOLVE is not open");
  assert.equal(rule("ACTIVE"), true, "ACTIVE is open");
  assert.equal(rule("Unknown"), true,
    "an unreadable status is not evidence a summons was satisfied, so it stays surfaced");
  // The predicate that shipped, shown failing on the value that mattered.
  const shipped = (v) => !/closed|dismissed|resolved|cured|inactive|disposed/i.test(String(v ?? ""));
  assert.equal(shipped("RESOLVE"), true,
    "this is the defect reproduced: the old rule called a RESOLVE'd summons open");
});

// ----------------------------------------------------------------- R#gate
// Every Playwright context must sign in through the gate before it asserts
// anything about the application.
//
// Six of the eight suites once ran against an ungated server and passed for
// that reason; the shared helper in tests/browser/lib/gate.cjs was written to
// close that. It reopened anyway: a context added to maps-geospatial.cjs later
// skipped signIn(), so /live rendered the password wall and P15.17 reported
// "no Start Live Details control" — a working feature failing because the test
// was never signed in. A convention that has to be remembered at each new call
// site is not a fix, so it is checked here.
test("R#gate every browser context signs in through the gate", () => {
  const suites = readdirSync(path.join(root, "tests/browser"))
    .filter((f) => f.endsWith(".cjs"));
  assert.ok(suites.length >= 8, `expected the browser suites, found ${suites.length}`);

  const offenders = [];
  for (const f of suites) {
    const src = read(path.join("tests/browser", f));
    const contexts = (src.match(/browser\.newContext\(/g) ?? []).length;
    if (!contexts) continue;
    // Two equivalent ways to authenticate a context: the shared helper, or a
    // direct gate POST on the context's own request object. production-verify
    // uses the second (ctx.request.post(`${BASE}/__gate`, ...)), which is a
    // real sign-in, so counting only signIn() calls flagged it falsely.
    const signIns = (src.match(/signIn\(/g) ?? []).length;
    const directGatePosts = (src.match(/\.request\.post\(`\$\{BASE\}\/__gate`/g) ?? []).length;
    const authed = signIns + directGatePosts;
    if (authed < contexts) {
      offenders.push(`${f}: ${contexts} context(s), ${authed} authenticated (${signIns} signIn, ${directGatePosts} direct gate POST)`);
    }
  }
  assert.deepEqual(offenders, [],
    `a browser context that never signs in tests the login wall, not the app:\n  ${offenders.join("\n  ")}`);
});

// ---------------------------------------------------------------- R#payload
// Exposed by fixing the ECB filter: with real records finally loading,
// /api/distress for 60 Wall Street was 104KB, ~89KB of it 264 DOB safety
// records. hpd and threeOneOne already capped their record lists at 100; dob
// and ecb shipped every row the query returned, up to 500 each.
//
// The counts are the product; the record lists are supporting detail. Bounding
// the lists must not change a single displayed number, and a truncated list
// must never be mistakable for a complete one.
test("R#payload distress record lists are bounded and say so, without changing any count", () => {
  const src = read("server/production-distress-tax.js");

  for (const [section, field] of [["dob", "safety"], ["dob", "legacy"], ["ecb", "records"]]) {
    assert.ok(new RegExp(`${field}:\\s*\\w+\\.slice\\(0,\\s*100\\)`).test(src),
      `${section}.${field} must be capped like hpd.records and threeOneOne.records already are`);
  }
  // The pre-existing caps must not have been disturbed.
  assert.match(src, /records:hpdRows\.slice\(0,100\)/);
  assert.match(src, /records:q311\.slice\(0,100\)/);

  // Truncation has to be self-describing.
  for (const key of ["total", "showing", "truncated"]) {
    assert.ok(src.includes(`${key}:`), `each capped section reports \`${key}\``);
  }

  // And the counts must still be computed from the FULL sets, not the slices.
  assert.match(src, /active:activeSafety\.length\+activeLegacy\.length/,
    "the DOB active count comes from the full arrays");
  assert.match(src, /total:safety\.length\+legacy\.length/,
    "as does the total");
  assert.match(src, /unresolved:activeEcb\.length/,
    "and the ECB unresolved count");
  assert.ok(!/activeEcb=ecb\.slice/.test(src) && !/activeSafety=safety\.slice/.test(src),
    "no count may be derived from a truncated list");
});

// ---------------------------------------------------------------- R#balance
// "Balance due" has to mean what is still owed.
//
// It summed EVERY ECB record, resolved ones included. BBL 1008350041 has 94
// summonses, all RESOLVE, six carrying a negative balance_due (credits on
// closed cases) — so the app published "Balance due: -$3,060" for a building
// that owes nothing. The same figure feeds distressFactors.ecbBalance, where
// Math.floor(-3060/10000)*3 is -3: credits on resolved cases were quietly
// LOWERING the distress score of buildings with clean ECB records. Verified
// after the fix: that parcel reports $0 due and its score rises 18 -> 21, and
// BBL 1000400003 reports $1,000 actually outstanding against $11,000 across
// all records.
test("R#balance ECB balance due counts unresolved summonses only", () => {
  const src = read("server/production-distress-tax.js");

  assert.match(src, /const ecbBalance=activeEcb\.reduce/,
    "the headline balance must be summed over UNRESOLVED summonses");
  assert.match(src, /Math\.max\(0,x\.balanceDue\|\|0\)/,
    "and a credit on an individual record cannot make the amount owed go negative");
  assert.ok(!/const ecbBalance=ecb\.reduce/.test(src),
    "summing every record is the defect and must not return");

  // The full sum is kept, not dropped, so the reconciliation stays available.
  assert.match(src, /balanceDueAllRecords/,
    "the all-records figure remains published under its own name");
  assert.match(src, /balanceBasis/,
    "with the basis stated, so the two numbers cannot be confused");

  // Ordering: activeEcb has to exist before the balance is computed from it.
  const activeAt = src.indexOf("activeEcb=ecb.filter");
  const balanceAt = src.indexOf("const ecbBalance=activeEcb.reduce");
  assert.ok(activeAt > 0 && balanceAt > activeAt,
    "activeEcb must be defined before the balance that sums it");
});

// ------------------------------------------------------------------ R#lotat
// Same defect as the assemblage 404, in a second route, found because NYC Open
// Data went down mid-session and /api/lot-at answered
// 404 {"error":"no_parcel_found","provenance":"live"} for the Empire State
// Building's own coordinates.
//
// The handler does check `.live` — but MapPLUTO's ArcGIS layer returns
// live:true with an EMPTY feature set, so the liveness check passes and the
// empty result becomes "there is no parcel at this point", which is a statement
// about the location rather than about the source. A point in the river
// genuinely has no lot and must still 404; the difference is whether anything
// authoritative was actually consulted.
test("R#lotat an empty MapPLUTO result is confirmed against DOF before claiming no parcel", () => {
  const src = read("server/production-live-extra.js");
  const at = src.indexOf('router.get("/api/lot-at"');
  assert.ok(at > 0, "the route exists");
  const body = src.slice(at, src.indexOf("router.", at + 10));

  assert.match(body, /TAX_LOT_POLYGONS/,
    "an empty MapPLUTO result must be checked against the DOF Digital Tax Map");
  assert.match(body, /intersects\(the_geom/,
    "using point-in-polygon, which is the operator that answers 'what lot is here'");

  // The three outcomes must be distinguishable.
  assert.match(body, /lot_sources_unavailable/,
    "DOF unreachable => unknown, not 'no parcel'");
  assert.match(body, /lot_geometry_unavailable/,
    "DOF holds a lot but MapPLUTO has no feature => the detail is unavailable, not absent");
  assert.match(body, /no_parcel_found/,
    "and a live, successful DOF query returning nothing is still an honest 404");

  // Ordering: the 404 may only be reached after the DOF check.
  const dofAt = body.indexOf("TAX_LOT_POLYGONS");
  const notFoundAt = body.lastIndexOf("no_parcel_found");
  assert.ok(dofAt > 0 && notFoundAt > dofAt,
    "the no-parcel answer must come after the confirming query, not before it");
});

// ------------------------------------------------------------------- R#env
// A configuration key the owner sets and the code never reads is invisible:
// the feature simply does not work, with nothing anywhere saying why. That is
// the "I set the key and it still doesn't work" failure.
//
// The real instance: render.yaml declared GOOGLE_MAPS_API_KEY while six modules
// — including production-imagery.js, the one that actually fetches Street View
// and static maps — read GOOGLE_MAPS_KEY, with no alias between them. A
// deployment that set the declared name got /api/status reporting maps as
// configured while imagery read an empty string.
test("R#env every Google Maps read accepts both spellings of the key", () => {
  const files = ["authority-release", "parity-routes", "production-api", "production-imagery",
    "production-status", "routes-bundle", "routes-live", "routes"];
  for (const f of files) {
    const src = read(`server/${f}.js`);
    const reads = [...src.matchAll(/process\.env\.GOOGLE_MAPS_(?:API_)?KEY/g)];
    if (!reads.length) continue;
    // Every read must sit next to the other spelling.
    const bare = [...src.matchAll(/process\.env\.(GOOGLE_MAPS_(?:API_)?KEY)(?!\s*\|\|\s*process\.env\.GOOGLE_MAPS)/g)]
      .filter((m) => {
        // Allow it when it is the SECOND half of an alias pair.
        const before = src.slice(Math.max(0, m.index - 60), m.index);
        return !/process\.env\.GOOGLE_MAPS_(?:API_)?KEY\s*\|\|\s*$/.test(before);
      });
    assert.deepEqual(bare.map((m) => m[1]), [],
      `server/${f}.js reads a Google Maps key without accepting the other spelling — an owner who sets the other name gets a silently disabled feature`);
  }
});

test("R#env the blueprint declares both spellings, and every alias the code accepts", () => {
  const yaml = read("render.yaml");
  for (const key of [
    "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_KEY",
    "NYC_OPEN_DATA_APP_TOKEN", "SOCRATA_APP_TOKEN",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_ANON_KEY",
    "AIRTABLE_SELLERS_TABLE", "AIRTABLE_BUYERS_TABLE", "AIRTABLE_MATCH_FIELDS"
  ]) {
    assert.ok(new RegExp(`- key: ${key}\\b`).test(yaml),
      `${key} is read by the code but not declared in render.yaml, so the owner has no way to know it exists`);
  }
});

test("R#env /api/maps-usage means the same thing by `configured` in every branch", () => {
  const src = read("server/authority-release.js");
  const at = src.indexOf('router.get("/api/maps-usage"');
  const body = src.slice(at, src.indexOf("router.", at + 10));
  // Scan the executing code only — the comment explaining this fix quotes
  // "configured: false", which a raw scan reads as a second meaning.
  const code = body.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const configured = [...code.matchAll(/^\s*configured:\s*([^,\n]+)/gm)].map((m) => m[1].trim());
  assert.ok(configured.length >= 2, "both the success and the failure branch report `configured`");
  for (const c of configured) {
    assert.match(c, /GOOGLE_MAPS/,
      `\`configured\` must always mean the maps key; found "${c}" — reporting the usage store under the same field made one deployment read configured:false with a working key`);
  }
  assert.match(body, /usageStoreConfigured/,
    "the usage store's own state keeps a distinct field");
});
