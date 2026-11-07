// The paid-usage meter must not require the service-role key. The kanban
// proved the pattern: SECURITY DEFINER RPCs callable with the publishable key
// that refuse without the registered app_state write token. 202608170001 gives
// the meter the same path; these tests pin both the SQL and the server wiring
// so "no service key" can never again silently mean "no spend panel".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("the token-gated usage RPCs validate the registered token before touching any row", () => {
  const sql = read("supabase/migrations/202608170001_usage_meter_token_rpc.sql");
  for (const fn of ["cre_usage_bump_tk", "cre_usage_read_tk", "cre_reserve_3d_session_tk"]) {
    const body = sql.slice(sql.indexOf(`function public.${fn}`));
    const gate = body.indexOf("app_state_token_ok(p_token)");
    assert.ok(gate > 0, `${fn} checks the token`);
    const firstWrite = Math.min(
      ...["insert into", "select", "from public.cre_"].map((s) => {
        const i = body.indexOf(s, body.indexOf("begin"));
        return i < 0 ? Infinity : i;
      })
    );
    assert.ok(gate < firstWrite, `${fn} checks the token before any table access`);
  }
});

test("the usage RPC grants follow the by-name revoke lesson from 202608150006", () => {
  const sql = read("supabase/migrations/202608170001_usage_meter_token_rpc.sql");
  for (const sig of [
    "cre_usage_bump_tk(text, bigint, text)",
    "cre_usage_read_tk(text, text)",
    "cre_reserve_3d_session_tk(bigint, text)"
  ]) {
    assert.ok(
      sql.indexOf(`revoke all on function public.${sig} from public, anon, authenticated`) >= 0,
      `${sig} revoked from public AND anon AND authenticated by name`
    );
    const revokeAt = sql.indexOf(`revoke all on function public.${sig}`);
    const grantAt = sql.indexOf(`grant execute on function public.${sig}`);
    assert.ok(revokeAt >= 0 && grantAt > revokeAt, `${sig} revoke precedes the deliberate grant`);
  }
});

test("the 3D quota keeps exactly one reservation implementation", () => {
  const sql = read("supabase/migrations/202608170001_usage_meter_token_rpc.sql");
  const wrapper = sql.slice(sql.indexOf("function public.cre_reserve_3d_session_tk"));
  assert.match(wrapper, /from public\.cre_reserve_3d_session\(p_cap\)/,
    "the token wrapper delegates to the atomic service-role function rather than duplicating its logic");
});

test("every meter path falls back to the token RPC when no service key exists", () => {
  const src = read("server/durable-cost.js");
  assert.match(src, /usageStoreConfigured = \(\) => !!adminKey\(\) \|\| !!tokenCreds\(\)/,
    "configured means either credential path");
  for (const [fn, rpc] of [
    ["incrementDurableUsage", "cre_usage_bump_tk"],
    ["readDurableUsage", "cre_usage_read_tk"],
    ["reserve3dSession", "cre_reserve_3d_session_tk"]
  ]) {
    const body = src.slice(src.indexOf(`export async function ${fn}`));
    assert.match(body.slice(0, 1400), new RegExp(rpc), `${fn} reaches ${rpc} on the token path`);
  }
  // The token itself must never be logged; it travels only inside the RPC body.
  assert.ok(!/console\.(log|error|warn)[^\n]*token/i.test(src), "no token logging");
});

test("the owner spend panel reports the store configured when either path exists", () => {
  const src = read("server/authority-release.js");
  assert.match(src, /usageStoreConfigured: usageStoreConfigured\(\)/,
    "maps-usage no longer equates 'configured' with 'service key present'");
});
