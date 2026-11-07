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

test("ingest falls back from a database URI override and uses the validated server secret", async () => {
  const keys = [
    "POSTGIS_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const nativeFetch = globalThis.fetch;
  const nativeWarn = console.warn;

  process.env.POSTGIS_SUPABASE_URL = "postgresql://postgres.project:db-password@pooler.supabase.com:5432/postgres";
  process.env.SUPABASE_URL = "https://example-project.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = fakeJwt("anon");
  process.env.SUPABASE_SECRET_KEY = "sb_secret_server_key";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_public_key";
  delete process.env.SUPABASE_ANON_KEY;

  const calls = [];
  const warnings = [];
  console.warn = (...parts) => warnings.push(parts.join(" "));
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: headersOf(init) });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const mod = await import(`../scripts/ingest/lib.js?credentials-test=${Date.now()}`);
    assert.equal(mod.SUPABASE_URL, "https://example-project.supabase.co");
    assert.equal(mod.SERVICE_KEY, "sb_secret_server_key");

    const out = await mod.rpc("probe", {});
    assert.deepEqual(out, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example-project.supabase.co/rest/v1/rpc/probe");
    assert.equal(calls[0].headers.apikey, "sb_secret_server_key");
    assert.equal(calls[0].headers.authorization, undefined,
      "modern secret keys are API keys and are not serialized as fake JWT Bearer tokens");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not an HTTP\(S\) Supabase API URL/);
    assert.doesNotMatch(warnings[0], /db-password|postgresql:\/\//i,
      "the rejected database connection string is never logged");
  } finally {
    globalThis.fetch = nativeFetch;
    console.warn = nativeWarn;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
