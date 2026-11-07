import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("database account-delete RPC requires auth.uid to equal p_user_id", () => {
  const sql = read("supabase/migrations/202608170003_account_delete_self_only.sql");
  assert.match(sql, /v_uid := auth\.uid\(\)/);
  assert.match(sql, /p_user_id <> v_uid/);
  assert.match(sql, /self deletion only/);
  assert.match(sql, /revoke all on function public\.cre_account_delete_tk\(uuid, text\) from public, anon, authenticated, service_role/);
  assert.match(sql, /grant execute on function public\.cre_account_delete_tk\(uuid, text\) to authenticated/);
});

test("server sends the caller JWT to the token-gated self-delete RPC", () => {
  const src = read("server/production-account-delete.js");
  assert.match(src, /req\.productionUser/);
  assert.match(src, /supabaseHeaders\s*\(\s*\{[^}]*apiKey:\s*key[^}]*bearerToken:\s*user\.token[^}]*json:\s*true[^}]*\}\s*\)/s,
    "the token-gated self-delete RPC must use the caller JWT as its bearer token");
  assert.match(src, /p_user_id: user\.id/);
  assert.ok(!/bearerToken:\s*key/.test(src),
    "publishable/anon bearer would make auth.uid() null and would also weaken the database identity boundary");
});
