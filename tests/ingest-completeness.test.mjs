import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeBbls } from "../scripts/ingest/lib.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("run-all exact BBL handoff wins over a second independent worklist", async () => {
  const rows = await storeBbls({
    __ingestedBbls: ["1008350041", "3009780018", "1008350041"],
    limit: "2"
  });
  assert.deepEqual(rows, ["1008350041", "3009780018"]);
});

test("strict document worklist is only the current verified MapPLUTO snapshot", () => {
  const src = read("scripts/ingest/lib.js");
  assert.match(src, /filters\.push\(`full_sync_id=eq\.\$\{syncId\}`\)/,
    "strict worklist must exclude stale parcels waiting for reconciliation");
  assert.match(src, /Strict document worklist mismatch/,
    "document phases must abort if their BBL universe differs from MapPLUTO");
  assert.match(src, /a\.__documentBbls = final/,
    "all downstream document workers reuse the exact same verified BBL list");
  assert.match(src, /const expected = Number\(a\.__mapPlutoMeta\?\.upserted\)/,
    "worklist count is checked against the MapPLUTO snapshot itself");
});

test("soqlAll pages to exhaustion and refuses a safety-ceiling truncation", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url) => {
      const u = new URL(String(url));
      const offset = Number(u.searchParams.get("$offset") || 0);
      const limit = Number(u.searchParams.get("$limit") || 0);
      calls.push({ offset, limit });
      const all = [{ id: 1 }, { id: 2 }, { id: 3 }];
      return new Response(JSON.stringify(all.slice(offset, offset + limit)), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const { soqlAll } = await import(`../server/adapters/socrata.js?complete-test=${Date.now()}`);
    const complete = await soqlAll("authority-unit-complete", { $order: "id ASC" }, {
      pageSize: 2, maxRows: 10, ttlMs: 0, retries: 0
    });
    assert.equal(complete.live, true);
    assert.equal(complete.complete, true);
    assert.deepEqual(complete.rows.map((x) => x.id), [1, 2, 3]);
    assert.deepEqual(calls.slice(0, 2), [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }]);

    calls.length = 0;
    const capped = await soqlAll("authority-unit-ceiling", { $order: "id ASC" }, {
      pageSize: 2, maxRows: 2, ttlMs: 0, retries: 0
    });
    assert.equal(capped.live, false);
    assert.equal(capped.complete, false);
    assert.deepEqual(capped.rows, [], "a safety fuse cannot return a partial authoritative set");
    assert.match(capped.error, /refusing partial data/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Socrata honors the production NYC Open Data token name", () => {
  const src = read("server/adapters/socrata.js");
  assert.match(src, /process\.env\.SOCRATA_APP_TOKEN \|\| process\.env\.NYC_OPEN_DATA_APP_TOKEN/);
  assert.match(src, /headers\["X-App-Token"\] = APP_TOKEN/);
  assert.match(read("render.yaml"), /key:\s*NYC_OPEN_DATA_APP_TOKEN/);
});

test("complete ingestion adapters have no UI-history ceilings and cross-check ACRIS Master", () => {
  const src = read("server/adapters/nyc-complete.js");
  for (const fn of [
    "completeAcrisByLot", "completeDobPermitsByLot", "completeDobNowByLot",
    "completeHpdViolationsByBbl", "completeEcbByLot", "completeTaxHistoryByBbl"
  ]) assert.match(src, new RegExp(`export async function ${fn}`));
  assert.match(src, /soqlAll/);
  assert.match(src, /permit_sequence__/);
  assert.match(src, /missingMasterIds/);
  assert.match(src, /acris_master_missing_/);
  assert.ok(!/\$limit:\s*(120|200|300|24)\b/.test(src), "certifying adapters must not inherit bounded UI depths");
});

test("MapPLUTO proves the source count, stable order and snapshot tagging", () => {
  const src = read("scripts/ingest/mappluto.js");
  assert.match(src, /returnCountOnly=true/);
  assert.match(src, /orderByFields=.*BBL ASC/);
  assert.match(src, /seenFeatures !== expected/);
  assert.match(src, /invalidBbls > 0 \|\| total !== seenFeatures/);
  assert.match(src, /mark_parcel_full_sync/);
  assert.match(src, /a\.__ingestedBbls/);
});

test("all document workers fail closed in strict mode and tag the same snapshot UUID", () => {
  for (const file of ["acris.js", "dob.js", "violations.js", "tax.js"]) {
    const src = read(`scripts/ingest/${file}`);
    assert.match(src, /strictComplete\(a\)/, `${file} must distinguish certifying mode`);
    assert.match(src, /complete citywide run aborted/, `${file} must abort certificate-bound source failure`);
    assert.match(src, /full_sync_id/, `${file} must tag rows in the full snapshot`);
  }
  assert.match(read("scripts/ingest/acris.js"), /completeAcrisByLot/);
  assert.match(read("scripts/ingest/dob.js"), /completeDobNowByLot/);
  assert.match(read("scripts/ingest/dob.js"), /completeDobPermitsByLot/);
  assert.match(read("scripts/ingest/violations.js"), /completeEcbByLot as ecbByLot/);
  assert.match(read("scripts/ingest/violations.js"), /completeHpdViolationsByBbl as hpdViolationsByBbl/);
  assert.match(read("scripts/ingest/tax.js"), /completeTaxHistoryByBbl/);
});

test("full refresh invalidates first, reconciles by UUID, then certifies", () => {
  const src = read("scripts/ingest/run-all.js");
  const mapAt = src.indexOf("await ingestMapPluto(a)");
  const reconcileAt = src.indexOf('rpc("reconcile_full_public_record_store"');
  const certifyAt = src.indexOf('rpc("mark_full_ingest_complete"');

  // The invariant is that the old certificate is dead before the first
  // warehouse write, so production falls back to live NYC data instead of
  // trusting a half-rewritten store. Invalidation used to be its own RPC; it
  // is now folded into begin_full_ingest, which does it in the SAME
  // transaction as lease acquisition — strictly stronger, because a refresh
  // can no longer invalidate the certificate and then fail to get the lease.
  // Accept either, and require that whichever runs happens before MapPLUTO.
  const invalidateAt = Math.max(
    src.indexOf('rpc("invalidate_full_ingest_certificate"'),
    src.indexOf('rpc("begin_full_ingest"')
  );
  assert.ok(invalidateAt > 0 && invalidateAt < mapAt,
    "old certificate must be invalid before the first data write");

  // And the folded-in version must really invalidate, not merely claim to in a
  // comment: assert it against the function body in the committed migration.
  const sql = read("supabase/migrations/202608150005_ingest_reconciliation.sql");
  const fn = sql.slice(sql.indexOf("function public.begin_full_ingest"));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /update public\.cre_ingest_certificate/,
    "begin_full_ingest must expire the standing certificate itself");
  assert.match(body, /expires_at\s*=\s*least\(expires_at,\s*now\(\)\)/,
    "and expiring it means moving expires_at to now, not merely annotating it");
  assert.ok(body.indexOf("cre_ingest_lock") < body.indexOf("cre_ingest_certificate"),
    "the lease is taken first, so a refusal to acquire cannot kill a valid certificate");
  assert.ok(reconcileAt > mapAt && reconcileAt < certifyAt, "reconciliation must finish before recertification");
  assert.match(src, /randomUUID\(\)/);
  assert.match(src, /p_full_sync_id:\s*a\.__fullSyncId/);
  assert.match(src, /fullSyncId:\s*a\.__fullSyncId/);
});

test("reconciliation migration is service-role-only and snapshot-scoped", () => {
  const sql = read("supabase/migrations/202608150005_ingest_reconciliation.sql");
  for (const table of ["parcels", "acris_docs", "dob_filings", "tax_bills", "ntas"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table}\\s+add column if not exists full_sync_id uuid`, "i"));
  }
  assert.match(sql, /invalidate_full_ingest_certificate/);
  assert.match(sql, /reconcile_full_public_record_store\(\s*p_full_sync_id uuid/);
  assert.match(sql, /full_sync_id is distinct from p_full_sync_id/g);
  assert.match(sql, /grant execute on function public\.reconcile_full_public_record_store\(uuid\) to service_role/i);
  assert.ok(!/grant execute on function public\.reconcile_full_public_record_store\(uuid\) to anon/i.test(sql));
  assert.match(sql, /ingest_reconciliation_schema_check/);
});

// A Supabase project ships ALTER DEFAULT PRIVILEGES granting EXECUTE on every
// new function in `public` to anon and authenticated. `revoke ... from public`
// drops only the PUBLIC pseudo-role's grant, so a migration that revokes from
// public and grants to service_role LOOKS service-role-only and is not.
// Verified against the live project: ingest_parcels, begin_full_ingest and
// reconcile_full_public_record_store — SECURITY DEFINER writers that bypass RLS
// by design — all answered TRUE to has_function_privilege('anon', ...).
//
// This is a whole-migration-set check, not a check of one file, because the
// defect is a thing left undone: any future migration that adds a
// service-role-only function inherits the same default grant.
test("every service-role-only function is revoked from anon by name, not only from public", () => {
  const dir = path.join(root, "supabase", "migrations");
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");

  // Normalizing whitespace lets one signature match across files that format
  // the same argument list differently.
  const squash = (s) => s.replace(/\s+/g, "");

  const serviceRoleOnly = new Set();
  for (const m of sql.matchAll(/grant\s+execute\s+on\s+function\s+(public\.[a-z0-9_]+\s*\([^)]*\))\s+to\s+([^;]+);/gi)) {
    const roles = m[2].toLowerCase();
    if (/\banon\b/.test(roles)) continue;
    serviceRoleOnly.add(squash(m[1].toLowerCase()));
  }

  const revokedFromAnon = new Set();
  for (const m of sql.matchAll(/revoke\s+(?:all|execute)\s+on\s+function\s+(public\.[a-z0-9_]+\s*\([^)]*\))\s+from\s+([^;]+);/gi)) {
    if (!/\banon\b/.test(m[2].toLowerCase())) continue;
    revokedFromAnon.add(squash(m[1].toLowerCase()));
  }

  const unguarded = [...serviceRoleOnly].filter((fn) => !revokedFromAnon.has(fn));
  assert.deepEqual(unguarded, [],
    `these functions are granted to service_role but never revoked from anon, so Supabase's default grant still applies:\n  ${unguarded.join("\n  ")}`);

  // The check above is only meaningful if it found the writers it is about.
  for (const fn of ["public.ingest_parcels(jsonb)", "public.begin_full_ingest(uuid)", "public.reconcile_full_public_record_store(uuid)"]) {
    assert.ok(serviceRoleOnly.has(squash(fn)), `${fn} must be classified service-role-only`);
  }
});

test("the deploy gate fails closed if the anon lockdown ever regresses", () => {
  const sql = read("supabase/migrations/202608150006_ingest_revoke_anon_default_grants.sql");

  // Positively phrased, because verify-production-schema.mjs fails the deploy on
  // any FALSE inside a nested object of release_schema_check's result.
  assert.match(sql, /'anon_locked_out_of_ingest_parcels',\s*not coalesce\(has_function_privilege\('anon'/);
  assert.match(sql, /'anon_locked_out_of_reconcile',\s*not coalesce\(has_function_privilege\('anon'/);
  assert.match(sql, /'anon_locked_out_of_begin_full_ingest',\s*not coalesce\(has_function_privilege\('anon'/);

  // A revoke that overshoots would blank the map and the dossier instead of
  // failing loudly, so the public read surface is asserted reachable too.
  assert.match(sql, /'anon_can_read_lot_at',\s*coalesce\(has_function_privilege\('anon'/);
  assert.match(sql, /'anon_can_read_parcels_opportunities',\s*coalesce\(has_function_privilege\('anon'/);

  // And the grant result has to reach the top-level `ok`, not just the detail
  // block — the verifier checks both, but `ok` is what a human reads.
  assert.match(sql, /acris_pk_ok and\s*\n\s*grants_ok,/);

  // to_regprocedure returns NULL for an absent function and has_function_privilege
  // raises on NULL. Absence must read as "not locked down", never as a crash in
  // the RPC the deploy gate depends on.
  //
  // Counted against the SQL with line comments stripped: this file's header
  // quotes has_function_privilege in prose while explaining the defect, and a
  // count that included the explanation would fail for the wrong reason.
  const code = sql.replace(/^[^\n]*?--[^\n]*$/gm, "");
  const probes = (code.match(/has_function_privilege\(/g) || []).length;
  const guarded = (code.match(/coalesce\(has_function_privilege\(/g) || []).length;
  assert.ok(probes >= 16, `expected the full privilege matrix, found ${probes} probes`);
  assert.equal(guarded, probes, "no privilege probe may be left un-coalesced");
});

test("runtime and deploy verifier reject legacy non-reconciled certificates", () => {
  const adapter = read("server/adapters/postgis.js");
  assert.match(adapter, /raw\?\.scope\?\.reconciled === true/);
  assert.match(adapter, /validFullSyncId/);
  assert.match(adapter, /raw\.fresh === true && raw\.fullDocuments === true && validSnapshot/);

  const verifier = read("scripts/verify-production-schema.mjs");
  // The legacy fallback was removed (owner directive 2026-08-18): the verifier
  // targets the explicit SUPABASE_URL and fails a production deploy without it.
  assert.doesNotMatch(verifier, /LEGACY_SUPABASE_URL/);
  assert.match(verifier, /SUPABASE_URL is not set/);
  assert.match(verifier, /ingest_reconciliation_schema_check/);
  assert.match(verifier, /ingest\.scope\?\.reconciled !== true/);
  assert.match(verifier, /validFullSyncId\(fullSyncId\)/);
});

test("migration runner cannot target generic or mismatched production databases", () => {
  const migrate = read("scripts/apply-migrations.mjs");
  const verify = read("scripts/verify-production-schema.mjs");
  assert.match(migrate, /const supabaseDbUrl = String\(process\.env\.SUPABASE_DB_URL \|\| ""\)/);
  assert.ok(!/process\.env\.SUPABASE_DB_URL \|\| process\.env\.DATABASE_URL/.test(migrate));
  assert.match(migrate, /dbRef !== effectiveRef/);
  assert.match(migrate, /No migration was executed/);
  // No legacy fallback in either script (owner directive 2026-08-18).
  assert.doesNotMatch(migrate, /LEGACY_SUPABASE_URL/);
  assert.match(verify, /const project = configuredProject;/);
  assert.match(migrate, /FAILING THE DEPLOY/);
});

test("server never normalizes a legacy Supabase fallback into the environment", () => {
  // This pin used to REQUIRE the legacy normalization; the owner's directive
  // (2026-08-18) reversed it: SUPABASE_URL is the only database identity, an
  // unset value stays unset, and production logs a loud misconfiguration
  // banner while the deploy gate fails builds outright.
  const src = read("server.js");
  assert.doesNotMatch(src, /LEGACY_SUPABASE_URL/);
  assert.doesNotMatch(src, /process\.env\.SUPABASE_URL\s*=\s*/);
  assert.match(src, /PRODUCTION MISCONFIGURATION/);
});

test("all finish-line ingestion and deployment JavaScript parses", () => {
  for (const rel of [
    "server.js",
    "server/adapters/socrata.js",
    "server/adapters/nyc-complete.js",
    "server/adapters/postgis.js",
    "scripts/apply-migrations.mjs",
    "scripts/verify-production-schema.mjs",
    "scripts/ingest/lib.js",
    "scripts/ingest/mappluto.js",
    "scripts/ingest/nta.js",
    "scripts/ingest/acris.js",
    "scripts/ingest/dob.js",
    "scripts/ingest/violations.js",
    "scripts/ingest/tax.js",
    "scripts/ingest/run-all.js"
  ]) {
    execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
  }
});
