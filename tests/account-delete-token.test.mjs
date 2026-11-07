// Account deletion must not require the service-role key. 202608170002 gives
// it the same publishable-key-plus-registered-token path as the kanban and the
// usage meter; these tests pin the SQL and the serving handler so "no service
// key" can never again mean "deletion answers 501 on a working deployment".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("the deletion RPC validates the registered token before touching auth.users", () => {
  const sql = read("supabase/migrations/202608170002_account_delete_token_rpc.sql");
  const body = sql.slice(sql.indexOf("function public.cre_account_delete_tk"));
  const gate = body.indexOf("app_state_token_ok(p_token)");
  const del = body.indexOf("delete from auth.users");
  assert.ok(gate > 0, "token check present");
  assert.ok(del > 0, "delete present");
  assert.ok(gate < del, "token is checked before the delete runs");
  assert.match(body, /where id = p_user_id/, "exactly one user, addressed by id — never a broader predicate");
});

test("the deletion RPC grants follow the by-name revoke lesson from 202608150006", () => {
  const sql = read("supabase/migrations/202608170002_account_delete_token_rpc.sql");
  const sig = "cre_account_delete_tk(uuid, text)";
  assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon, authenticated`),
    "revoked from public AND anon AND authenticated by name");
  const revokeAt = sql.indexOf(`revoke all on function public.${sig}`);
  const grantAt = sql.indexOf(`grant execute on function public.${sig}`);
  assert.ok(revokeAt >= 0 && grantAt > revokeAt, "revoke precedes the deliberate grant");
});

test("the serving handler verifies the caller's JWT before any deletion path", () => {
  const src = read("server/routes-bundle.js");
  const handler = src.slice(src.indexOf('router.post("/api/account-delete"'));
  const jwtCheck = handler.indexOf("/auth/v1/user");
  const serviceCheck = handler.indexOf("SUPABASE_SERVICE_ROLE_KEY");
  const tokenPath = handler.indexOf("cre_account_delete_tk");
  assert.ok(jwtCheck > 0 && serviceCheck > 0 && tokenPath > 0);
  assert.ok(jwtCheck < serviceCheck, "identity is established before either credential path is chosen");
  assert.ok(serviceCheck < tokenPath, "the token RPC is the no-service-key fallback, not a bypass");
});

test("501 remains only for a deployment with neither credential path", () => {
  const src = read("server/routes-bundle.js");
  const handler = src.slice(src.indexOf('router.post("/api/account-delete"'), src.indexOf('router.get("/api/area-buildings"'));
  const fallback = handler.slice(handler.indexOf("if (!service)"));
  assert.match(fallback, /appStatePublishableKey\(\)/);
  assert.match(fallback, /appStateToken\(\)/);
  const fiveOhOne = fallback.indexOf("501");
  const rpcCall = fallback.indexOf("cre_account_delete_tk");
  assert.ok(fiveOhOne > 0 && rpcCall > fiveOhOne,
    "the 501 answers only when the token creds are also absent; otherwise the RPC runs");
  // The registered token travels only inside the RPC body — never into a log.
  assert.ok(!/console\.(log|error|warn)[^\n]*(rpcToken|p_token)/i.test(handler), "no token logging");
});
