// Fail-closed production database verification using read-only schema/status RPCs.
//
// IMPORTANT: the runtime no longer falls back to the project compiled into the
// frontend bundle. SUPABASE_URL is the one and only production database target.
// This verifier also requires a real server credential because several release
// checks are intentionally not callable by anon/authenticated roles.
import { adminCredential, supabaseHeaders } from "../server/supabase-credentials.js";

const configuredProject = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const project = configuredProject;
const key = adminCredential();
const validFullSyncId = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));

if (!project) {
  if (process.env.NODE_ENV === "production") {
    console.error("[schema-verify] FAIL: SUPABASE_URL is not set. A production deploy must name its Supabase project; there is no legacy default.");
    process.exit(1);
  }
  console.log("[schema-verify] no Supabase project configured in non-production — nothing to verify.");
  process.exit(0);
}
if (!key) {
  console.error(`[schema-verify] FAIL: ${project} is configured but no validated server credential is present.`);
  console.error("[schema-verify] Provide SUPABASE_SECRET_KEY=sb_secret_... or a legacy SUPABASE_SERVICE_ROLE_KEY JWT whose payload role is service_role. An anon/publishable key is not sufficient for release verification.");
  process.exit(1);
}

async function callRpc(name, body = {}) {
  let response;
  try {
    response = await fetch(`${project}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: supabaseHeaders({ apiKey: key, json: true }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    throw new Error(`${name}: could not reach ${project}: ${e.message}`);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`${name} unavailable (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
  try {
    const parsed = JSON.parse(text || "null");
    return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
  } catch {
    throw new Error(`${name} returned non-JSON: ${text.slice(0, 300)}`);
  }
}

// A committed DDL transaction can become visible in Postgres before PostgREST
// has refreshed its schema cache. Retry only the exact PGRST202 cache-miss that
// Render observed immediately after applying the buyer-intelligence migration.
// Every other HTTP, auth, network, or integrity error remains fail-closed.
const schemaCacheRetryDelaysMs = [500, 1000, 2000, 4000, 4000, 4000];

async function callRpcAfterSchemaCacheReload(name, body = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callRpc(name, body);
    } catch (e) {
      const schemaCacheMiss =
        /unavailable \(HTTP 404\):/.test(e.message) &&
        /"code":"PGRST202"/.test(e.message);
      if (!schemaCacheMiss || attempt >= schemaCacheRetryDelaysMs.length) throw e;
      const delayMs = schemaCacheRetryDelaysMs[attempt];
      console.log(
        `[schema-verify] ${name} is not visible in the PostgREST schema cache yet; retrying in ${delayMs}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

let schema;
try {
  schema = await callRpc("release_schema_check");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] Apply every file in supabase/migrations to this exact project before deploying.");
  process.exit(1);
}

if (!schema || schema.ok !== true) {
  console.error("[schema-verify] FAIL: the Supabase project is only partially migrated.");
  console.error(JSON.stringify(schema, null, 2));
  process.exit(1);
}

const falsePaths = [];
for (const [group, values] of Object.entries(schema)) {
  if (!values || typeof values !== "object" || Array.isArray(values)) continue;
  for (const [name, ok] of Object.entries(values)) if (ok === false) falsePaths.push(`${group}.${name}`);
}
if (falsePaths.length) {
  console.error(`[schema-verify] FAIL: required schema checks failed: ${falsePaths.join(", ")}`);
  process.exit(1);
}

// The self-delete hardening was added after release_schema_check was created.
// Require its own revision marker so a project carrying the older, unsafe
// cre_account_delete_tk function can never pass merely because the function name
// exists.
let accountDeleteSchema;
try {
  accountDeleteSchema = await callRpc("account_delete_schema_check");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] The authenticated self-only account deletion migration has not been applied or the configured credential is not privileged.");
  process.exit(1);
}
if (
  !accountDeleteSchema ||
  accountDeleteSchema.ok !== true ||
  accountDeleteSchema.revision !== "202608170003_self_only" ||
  accountDeleteSchema.anonExecute !== false ||
  accountDeleteSchema.authenticatedExecute !== true
) {
  console.error("[schema-verify] FAIL: account deletion is not on the authenticated self-only revision.");
  console.error(JSON.stringify(accountDeleteSchema, null, 2));
  process.exit(1);
}

// Owner mode is not merely a UI flag. The Investors book and owner-only usage
// policies evaluate cre_is_owner() while the request is running as
// `authenticated`. A missing EXECUTE grant makes those policies throw before
// they can authorize the owner. Prove the predicate ACL, workspace grants and
// the non-escalation role-column boundary together.
let ownerWorkspaceSchema;
try {
  ownerWorkspaceSchema = await callRpc("owner_workspace_schema_check");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] The owner-workspace ACL migration has not been applied.");
  process.exit(1);
}
if (
  !ownerWorkspaceSchema ||
  ownerWorkspaceSchema.ok !== true ||
  ownerWorkspaceSchema.revision !== "202608180004_owner_acl" ||
  ownerWorkspaceSchema.ownerPredicate?.authenticatedExecute !== true ||
  ownerWorkspaceSchema.ownerPredicate?.anonExecute !== false ||
  ownerWorkspaceSchema.profileRole?.authenticatedUpdate !== false
) {
  console.error("[schema-verify] FAIL: owner workspace authorization is not on the required least-privilege revision.");
  console.error(JSON.stringify(ownerWorkspaceSchema, null, 2));
  process.exit(1);
}

// The PostGIS runtime intentionally uses a publishable key for its seven public
// NYC-record read RPCs. Prove the complete ACL as one contract so a future
// hardening migration cannot leave only part of the warehouse readable.
let postgisReadSchema;
try {
  postgisReadSchema = await callRpc("postgis_public_read_schema_check");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] The complete PostGIS public-read ACL migration has not been applied.");
  process.exit(1);
}
if (
  !postgisReadSchema ||
  postgisReadSchema.ok !== true ||
  postgisReadSchema.revision !== "202608180005_postgis_public_read_acl" ||
  Object.values(postgisReadSchema.anonExecute || {}).some((v) => v !== true)
) {
  console.error("[schema-verify] FAIL: one or more PostGIS public-record read RPCs are unavailable to the publishable-key path.");
  console.error(JSON.stringify(postgisReadSchema, null, 2));
  process.exit(1);
}

// Migration 150005 must be independently present. This RPC is read-only; it
// proves the UUID reconciliation functions and full_sync_id columns exist.
let reconciliationSchema;
try {
  reconciliationSchema = await callRpc("ingest_reconciliation_schema_check");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] The full-ingest reconciliation migration has not been applied.");
  process.exit(1);
}
if (!reconciliationSchema || reconciliationSchema.ok !== true) {
  console.error("[schema-verify] FAIL: full-ingest reconciliation schema is incomplete.");
  console.error(JSON.stringify(reconciliationSchema, null, 2));
  process.exit(1);
}

// buyerDB is the historical transaction warehouse behind Lucia's owner-only
// buyer intelligence. Its deployment certificate proves the complete
// Manhattan buyer/property relationship and the canonical legal-suffix read
// identity without exposing contacts or mutating warehouse rows.
let buyerIntelligenceSchema;
try {
  buyerIntelligenceSchema = await callRpcAfterSchemaCacheReload("buyer_intelligence_schema_check");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] The canonical buyer-intelligence read migration has not been applied.");
  process.exit(1);
}
if (
  !buyerIntelligenceSchema ||
  buyerIntelligenceSchema.ok !== true ||
  buyerIntelligenceSchema.revision !== "202608190002_canonical_identity" ||
  buyerIntelligenceSchema.serviceRoleOnly !== true ||
  Number(buyerIntelligenceSchema.manhattanBuyerDeals) <= 0 ||
  Number(buyerIntelligenceSchema.missingPropertyAddresses) !== 0 ||
  Number(buyerIntelligenceSchema.canonicalRepeatBuyers) < Number(buyerIntelligenceSchema.rawRepeatBuyers)
) {
  console.error("[schema-verify] FAIL: Manhattan buyer intelligence is incomplete, unaddressed, or not canonicalized.");
  console.error(JSON.stringify(buyerIntelligenceSchema, null, 2));
  process.exit(1);
}

// Netlify uses the Supabase publishable key only as the PostgREST transport
// identity. Its ten mutating runtime RPCs must additionally validate the
// high-entropy shared secret. Prove that intentional exception as one complete
// least-privilege contract and keep the obsolete unprotected request RPC closed.
let netlifyRuntimeSchema;
try {
  netlifyRuntimeSchema = await callRpcAfterSchemaCacheReload("netlify_runtime_schema_check");
} catch (e) {
  console.error("[schema-verify] FAIL: " + e.message);
  console.error("[schema-verify] The protected Netlify scraper-runtime ACL migration has not been applied.");
  process.exit(1);
}
if (
  !netlifyRuntimeSchema ||
  netlifyRuntimeSchema.ok !== true ||
  netlifyRuntimeSchema.revision !== "202608190003_netlify_runtime_acl" ||
  netlifyRuntimeSchema.runtimeFunctions?.expected !== 10 ||
  netlifyRuntimeSchema.runtimeFunctions?.present !== 10 ||
  netlifyRuntimeSchema.runtimeFunctions?.securityDefinerAll !== true ||
  netlifyRuntimeSchema.runtimeFunctions?.fixedSearchPathAll !== true ||
  netlifyRuntimeSchema.runtimeFunctions?.secretGateAll !== true ||
  netlifyRuntimeSchema.runtimeFunctions?.anonExecuteAll !== true ||
  netlifyRuntimeSchema.runtimeFunctions?.authenticatedExecuteAny !== false ||
  netlifyRuntimeSchema.runtimeFunctions?.serviceRoleExecuteAll !== true ||
  netlifyRuntimeSchema.secretValidator?.anonExecute !== false ||
  netlifyRuntimeSchema.secretValidator?.authenticatedExecute !== false ||
  netlifyRuntimeSchema.legacyRequest?.anonExecute !== false ||
  netlifyRuntimeSchema.legacyRequest?.authenticatedExecute !== false ||
  netlifyRuntimeSchema.publicSchema?.publicCreate !== false ||
  netlifyRuntimeSchema.publicSchema?.anonCreate !== false ||
  netlifyRuntimeSchema.publicSchema?.authenticatedCreate !== false
) {
  console.error("[schema-verify] FAIL: the Netlify scraper runtime is incomplete or exceeds its shared-secret boundary.");
  console.error(JSON.stringify(netlifyRuntimeSchema, null, 2));
  process.exit(1);
}

// The status RPC exists only after the ingest-certificate migration. Calling it
// verifies that migration even when the warehouse is intentionally untrusted.
let ingest;
try {
  ingest = await callRpc("postgis_store_status");
} catch (e) {
  console.error(`[schema-verify] FAIL: ${e.message}`);
  console.error("[schema-verify] The PostGIS ingest-certificate migration has not been applied.");
  process.exit(1);
}

if (process.env.POSTGIS_TRUSTED === "1") {
  const fullSyncId = ingest?.scope?.fullSyncId;
  if (
    !ingest ||
    ingest.fresh !== true ||
    ingest.fullDocuments !== true ||
    ingest.scope?.reconciled !== true ||
    !validFullSyncId(fullSyncId)
  ) {
    console.error("[schema-verify] FAIL: POSTGIS_TRUSTED=1 but no fresh reconciled UUID-tagged complete citywide ingest certificate exists.");
    console.error(JSON.stringify(ingest, null, 2));
    console.error("[schema-verify] Run an unbounded citywide `npm run ingest` after all migrations, then redeploy.");
    process.exit(1);
  }
  console.log(`[schema-verify] PostGIS snapshot ${fullSyncId} is fresh through ${ingest.expiresAt}.`);
} else {
  console.log(`[schema-verify] PostGIS is not marked trusted; live NYC adapters remain authoritative. Warehouse certificate fresh=${ingest?.fresh === true}.`);
}

console.log(`[schema-verify] PASS: ${project} has the complete authority-release schema, canonical address-linked buyer intelligence, owner workspace ACL, PostGIS public-read ACL, self-delete hardening and reconciliation lifecycle.`);

