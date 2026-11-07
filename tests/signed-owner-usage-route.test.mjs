// Runtime regression for the signed-in owner spend meter. This is deliberately
// a real-stack compatibility test: it boots server.js with the response probe,
// supplies a tiny fake Supabase Auth/Data API, enters through the real site gate,
// and proves an explicitly bearer-authenticated owner sees the same Source
// Registry field meanings as the gate-only Owner route.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_PORT = 5228;
const SUPA_PORT = 5528;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const SUPA = `http://127.0.0.1:${SUPA_PORT}`;

const ownerToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "00000000-0000-4000-8000-000000000001", role: "authenticated", exp: 4102444800 })).toString("base64url"),
  "signature"
].join(".");

function fakeSupabase() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, SUPA);
    res.setHeader("content-type", "application/json");

    if (req.method === "GET" && url.pathname === "/auth/v1/user") {
      res.end(JSON.stringify({
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@example.test",
        user_metadata: { display_name: "Owner Test" }
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/rest/v1/cre_profiles") {
      res.end(JSON.stringify([{ display_name: "Owner Test", role: "owner" }]));
      return;
    }

    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/cre_usage_read_tk") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body || "{}");
      assert.ok(parsed.p_token, "durable usage RPC must carry the registered/derived app-state token");
      res.end(JSON.stringify({
        rows: [
          { category: "streetview", count: 7 },
          { category: "staticmap", count: 3 },
          { category: "photorealistic3d", count: 2 }
        ]
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SUPA_PORT, "127.0.0.1", () => resolve(server));
  });
}

function appServer() {
  return new Promise((resolve, reject) => {
    const probeLines = [];
    const child = spawn(process.execPath, ["--import", "./scripts/route-probe.mjs", "server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        NODE_ENV: "test",
        APP_VARIANT: "user",
        SITE_PASSWORD: "signed-owner-member",
        OWNER_PASSWORD: "signed-owner-gate-owner",
        OWNER_EMAIL: "",
        SUPABASE_URL: SUPA,
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_runtime_test",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        SUPABASE_SECRET_KEY: "",
        SUPABASE_DB_URL: "",
        DATABASE_URL: "",
        APP_STATE_TOKEN: "",
        GOOGLE_MAPS_KEY: "",
        GOOGLE_MAPS_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", reject);
    child.stdout.on("data", (b) => {
      for (const line of String(b).split("\n")) if (line.startsWith("[PROBE]")) probeLines.push(line);
    });
    (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`${BASE}/healthz`);
          if (r.ok) return resolve({ child, probeLines });
        } catch { /* booting */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      try { child.kill(); } catch { /* already down */ }
      reject(new Error("application server did not start"));
    })();
  });
}

function responder(lines, route) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[PROBE\] \w+ (\S+) \d+ <= (\S+)/);
    if (m && m[1] === route) return m[2].split(":")[0];
  }
  return null;
}

async function siteCookie() {
  const r = await fetch(`${BASE}/__gate`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "signed-owner-member" }).toString()
  });
  assert.equal(r.status, 303, "member site password must pass the real gate");
  const raw = r.headers.get("set-cookie") || "";
  const pair = raw.split(";")[0];
  assert.match(pair, /(?:ndi_gate|site_access)=/, "gate must return an access cookie");
  return pair;
}

test("explicit signed-in owner maps usage keeps Source Registry semantics", async (t) => {
  const supabase = await fakeSupabase();
  t.after(() => new Promise((resolve) => supabase.close(resolve)));

  const { child, probeLines } = await appServer();
  t.after(() => { try { child.kill(); } catch { /* already down */ } });

  const cookie = await siteCookie();
  const r = await fetch(`${BASE}/api/maps-usage`, {
    headers: {
      cookie,
      authorization: `Bearer ${ownerToken}`
    }
  });
  const body = await r.json();

  assert.equal(r.status, 200);
  assert.equal(body.configured, true,
    "configured tracks the durable usage meter, which the fake Supabase RPC makes live");
  assert.equal(body.mapsConfigured, false,
    "Google imagery credential state is separate and intentionally absent in this test");
  assert.equal(body.durable, true);
  assert.equal(body.source, "cre_usage_daily");
  assert.equal(body.streetview, 7);
  assert.equal(body.staticmap, 3);
  assert.equal(body.photorealistic3d, 2);
  assert.equal(body.freeStreetview, 5000);
  assert.equal(body.freeStatic, 10000);
  assert.equal(responder(probeLines, "/api/maps-usage"), "server/production-api.js",
    "an explicitly bearer-authenticated compatibility request must resolve in production-api.js");
});