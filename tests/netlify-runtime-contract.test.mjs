import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190003_netlify_runtime_acl.sql", import.meta.url),
  "utf8"
);
const verifier = readFileSync(new URL("../scripts/verify-production-schema.mjs", import.meta.url), "utf8");

test("runtime ACL migration changes privileges and certificates only", () => {
  assert.doesNotMatch(migration, /\b(insert|update|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i);
  assert.match(migration, /No sbi_\* table row is inserted, updated, merged, or deleted/i);
  assert.match(migration, /create or replace function public\.netlify_runtime_schema_check\(\)/);
});

test("all ten Netlify RPCs remain shared-secret gated", () => {
  const declarations = migration.match(/public\.sbi_runtime_(?:request_run|active_run|update_run|rolling_targets|rolling_apply|phase2_targets|phase2_apply|sync|broker_contacts|log_ai)\(/g) || [];
  assert.ok(declarations.length >= 30);
  assert.match(migration, /position\('public\.sbi_runtime_secret_ok' in pg_get_functiondef/);
  assert.match(migration, /v_expected = 10/);
  assert.match(migration, /'secretGateAll', v_secret_gate/);
});

test("publishable-key transport grants anon only and closes direct bypasses", () => {
  assert.match(migration, /from public, anon, authenticated;[\s\S]*to anon, service_role;/);
  assert.match(migration, /revoke all on function public\.sbi_runtime_secret_ok\(text\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.api_request_scrape\(text,text,jsonb\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /has_schema_privilege\('anon', 'public', 'CREATE'\)/);
});

test("production verifier fails closed on the complete Netlify runtime certificate", () => {
  assert.match(verifier, /callRpcAfterSchemaCacheReload\("netlify_runtime_schema_check"\)/);
  assert.match(verifier, /revision !== "202608190003_netlify_runtime_acl"/);
  assert.match(verifier, /runtimeFunctions\?\.anonExecuteAll !== true/);
  assert.match(verifier, /runtimeFunctions\?\.authenticatedExecuteAny !== false/);
  assert.match(verifier, /legacyRequest\?\.anonExecute !== false/);
  assert.match(verifier, /publicSchema\?\.anonCreate !== false/);
});

