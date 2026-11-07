import test from "node:test";
import assert from "node:assert/strict";
import {
  adminCredential,
  normalizeSupabaseApiUrl,
  serviceCredential,
  supabaseHeaders
} from "../server/supabase-credentials.js";

const fakeJwt = (role) => [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ role, exp: 4102444800 })).toString("base64url"),
  "signature"
].join(".");

test("admin credential rejects anon/publishable keys and accepts server credentials", () => {
  const anon = fakeJwt("anon");
  const service = fakeJwt("service_role");
  assert.equal(serviceCredential(anon), "");
  assert.equal(serviceCredential("sb_publishable_public_key"), "");
  assert.equal(serviceCredential(service), service);
  assert.equal(serviceCredential("sb_secret_server_key"), "sb_secret_server_key");
});

test("valid secret key wins behind a stale anon value in SERVICE_ROLE_KEY", () => {
  const secret = "sb_secret_server_key";
  const selected = adminCredential({
    SUPABASE_SERVICE_ROLE_KEY: fakeJwt("anon"),
    SUPABASE_SECRET_KEY: secret
  });
  assert.equal(selected, secret);
});

test("Supabase API URL validator accepts HTTP(S), strips quotes/trailing slash, and rejects database URIs", () => {
  assert.equal(
    normalizeSupabaseApiUrl("https://example-project.supabase.co/"),
    "https://example-project.supabase.co"
  );
  assert.equal(
    normalizeSupabaseApiUrl('"https://example-project.supabase.co/"'),
    "https://example-project.supabase.co"
  );
  assert.equal(
    normalizeSupabaseApiUrl("postgresql://postgres.example:password@pooler.supabase.com:5432/postgres"),
    ""
  );
  assert.equal(normalizeSupabaseApiUrl("not a url"), "");
});

test("modern secret key is transported as apikey, not a fake JWT bearer", () => {
  const secret = "sb_secret_server_key";
  const headers = supabaseHeaders({ apiKey: "sb_publishable_public_key", bearerToken: secret, json: true });
  assert.equal(headers.apikey, secret);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers["content-type"], "application/json");
});

test("account-delete style modern admin key stays out of Authorization", () => {
  const secret = "sb_secret_server_key";
  const headers = supabaseHeaders({ apiKey: secret });
  assert.equal(headers.apikey, secret);
  assert.equal(headers.authorization, undefined);
});

test("account-delete style legacy service-role key is also sent as a bearer JWT", () => {
  const service = fakeJwt("service_role");
  const headers = supabaseHeaders({ apiKey: service });
  assert.equal(headers.apikey, service);
  assert.equal(headers.authorization, `Bearer ${service}`);
});

test("user JWT stays a bearer token paired with the publishable API key", () => {
  const user = fakeJwt("authenticated");
  const headers = supabaseHeaders({ apiKey: "sb_publishable_public_key", bearerToken: user });
  assert.equal(headers.apikey, "sb_publishable_public_key");
  assert.equal(headers.authorization, `Bearer ${user}`);
});
