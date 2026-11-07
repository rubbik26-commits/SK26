import test from "node:test";
import assert from "node:assert/strict";

const fakeJwt = (role) => [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ role, exp: 4102444800 })).toString("base64url"),
  "signature"
].join(".");

function headersOf(init) {
  const h = new Headers(init?.headers || {});
  return Object.fromEntries(h.entries());
}

test("trusted PostGIS rejects stale anon precedence, ignores a database-URI API override, and transports sb_secret_ as an API key", async () => {
  const keys = [
    "NODE_ENV", "POSTGIS_TRUSTED", "POSTGIS_ENABLED", "POSTGIS_SUPABASE_URL",
    "POSTGIS_SUPABASE_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const nativeFetch = globalThis.fetch;
  const nativeWarn = console.warn;

  process.env.NODE_ENV = "production";
  process.env.POSTGIS_TRUSTED = "1";
  process.env.POSTGIS_ENABLED = "1";
  // This is the exact class of configuration error this deployment had: a
  // PostgreSQL pooler URI pasted into the variable used by fetch(). The adapter
  // must not append /rest/v1 to it or expose its embedded password in logs.
  process.env.POSTGIS_SUPABASE_URL = "postgresql://postgres.project:password@pooler.supabase.com:6543/postgres";
  delete process.env.POSTGIS_SUPABASE_KEY;
  process.env.SUPABASE_URL = "https://example-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = fakeJwt("anon");
  process.env.SUPABASE_SECRET_KEY = "sb_secret_server_key";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_public_key";
  delete process.env.SUPABASE_ANON_KEY;

  const calls = [];
  const warnings = [];
  console.warn = (...parts) => warnings.push(parts.join(" "));
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: headersOf(init), body: String(init.body || "") });
    if (String(url).endsWith("/rest/v1/rpc/postgis_store_status")) {
      return new Response(JSON.stringify({
        fresh: true,
        fullDocuments: true,
        scope: {
          reconciled: true,
          fullSyncId: "11111111-1111-4111-8111-111111111111"
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/rest/v1/rpc/lot_at")) {
      return new Response(JSON.stringify({ bbl: "1000000001", address: "TEST LOT" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    // Cache-bust because other tests may import the adapter with different env.
    const mod = await import(`../server/adapters/postgis.js?credentials-test=${Date.now()}`);
    const row = await mod.pgLotAt(40.7, -73.9);

    assert.equal(row?.bbl, "1000000001");
    assert.equal(calls.length, 2, "trusted production lookup first proves certificate freshness, then performs lot_at");
    assert.equal(calls[0].url, "https://example-project.supabase.co/rest/v1/rpc/postgis_store_status");
    assert.equal(calls[1].url, "https://example-project.supabase.co/rest/v1/rpc/lot_at");
    assert.equal(warnings.length, 1, "invalid override is reported exactly once");
    assert.match(warnings[0], /not an HTTP\(S\) Supabase API URL/);
    assert.doesNotMatch(warnings[0], /password|postgresql:\/\//i, "the rejected connection URI is never logged");

    for (const call of calls) {
      assert.equal(call.headers.apikey, "sb_secret_server_key",
        "the valid modern server secret wins behind a stale anon SERVICE_ROLE_KEY value");
      assert.equal(call.headers.authorization, undefined,
        "an sb_secret_ key is never serialized as Authorization: Bearer");
      assert.equal(call.headers["content-type"], "application/json");
    }
  } finally {
    globalThis.fetch = nativeFetch;
    console.warn = nativeWarn;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
