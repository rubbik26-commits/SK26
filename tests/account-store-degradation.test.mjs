// What the deployment does when the local account store cannot open.
//
// This is the failure CI actually hit. The workflow and render.yaml pinned Node
// 22.12.0; node:sqlite is only unflagged from 22.13 (22.12 still requires
// --experimental-sqlite), so db.js's openLocalStore() failed, db.js degraded to
// its stand-in — correctly, by design, rather than crashing at import — and then
// nothing turned the stand-in's write error into a response. /api/auth/signup
// answered a 500 HTML error page and the api-parity suite failed on every run.
//
// The version pin is fixed, but a pin is a preference and this is the safety
// net: the store can also be missing because the data directory is read-only, or
// because someone runs the service on an older runtime. So the degradation is
// tested directly, with DISABLE_LOCAL_SQLITE=1 standing in for "the store did
// not open" — the same branch, reached deterministically.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5213;
const B = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(path.join(os.tmpdir(), "acct-store-"));

let child;

function start() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        APP_DATA_DIR: dataDir,
        DISABLE_LOCAL_SQLITE: "1",
        // Pinned, not inherited.
        //
        // These assertions describe the SELF-HOSTED regime, where the local
        // account routes are mounted and must degrade honestly when the store
        // will not open. server.js does not mount authRoutes at all under
        // NODE_ENV=production — a deliberate decision, since the compiled
        // frontend authenticates through Supabase and never requests any
        // /api/auth path (verified: zero references in the bundle). Inheriting
        // NODE_ENV from the shell therefore made this suite assert the wrong
        // regime and fail with 410/404 wherever the variable happened to be
        // set. The production regime is covered by its own test below.
        NODE_ENV: "development",
        // The site gate is pinned OFF for the same reason NODE_ENV is pinned:
        // these assertions read the account routes' own status codes (503 for
        // an unavailable store, 200 for /api/auth/me). With SITE_PASSWORD
        // inherited from the shell, siteGate() answers every one of them 401
        // before the route runs, and the suite reports a broken account store
        // on a server whose account store is fine. The gate has its own tests.
        SITE_PASSWORD: "",
        OWNER_PASSWORD: "",
        // Keep the boot off the network: this test is about the account store.
        SOCRATA_DOMAIN: "203.0.113.1",
        SOCRATA_CACHE_DIR: path.join(dataDir, "cache")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", reject);
    (async () => {
      for (let i = 0; i < 120; i++) {
        try { await fetch(`${B}/healthz`); return resolve(); } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      reject(new Error("server did not start"));
    })();
  });
}

test("the deployment serves with no local account store", async (t) => {
  await start();
  t.after(() => {
    try { child?.kill(); } catch { /* already down */ }
    rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test("it starts and answers its health check at all", async () => {
    // The whole point of db.js's guard: a missing account store must not take
    // the process down before a single route is mounted.
    const res = await fetch(`${B}/healthz`);
    assert.equal(res.status, 200);
  });

  await t.test("signup refuses honestly instead of returning a 500 page", async () => {
    const res = await fetch(`${B}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `probe${Date.now()}@example.com`, password: "longenough1" })
    });
    assert.equal(res.status, 503, "an unavailable subsystem is 503, not 500");
    assert.match(res.headers.get("content-type") || "", /application\/json/,
      "the client gets JSON it can act on, not an HTML error page");
    const body = await res.json();
    assert.equal(body.error, "account_store_unavailable");
    assert.match(body.message, /Supabase/, "and it names where accounts do work");
  });

  await t.test("login and the magic-link routes refuse the same way", async () => {
    for (const [route, payload] of [
      ["/api/auth/login", { email: "x@example.com", password: "longenough1" }],
      ["/api/auth/magic", { email: "x@example.com" }]
    ]) {
      const res = await fetch(`${B}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 503, `${route} refuses honestly`);
      assert.equal((await res.json()).error, "account_store_unavailable");
    }
  });

  await t.test("me and logout still answer, so the frontend can boot", async () => {
    // With no store there is simply no session. Refusing these would break the
    // shell over a subsystem it does not depend on.
    const me = await fetch(`${B}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).signedIn, false, "honestly signed out, not an error");

    const out = await fetch(`${B}/api/auth/logout`, { method: "POST" });
    assert.equal(out.status, 200, "logging out of nothing succeeds");
  });

  await t.test("the site itself still serves", async () => {
    // The compiled frontend and the public record routes have nothing to do
    // with local accounts and must be unaffected.
    const page = await fetch(`${B}/`);
    assert.equal(page.status, 200, "the application shell is served");
    const status = await fetch(`${B}/api/status`);
    assert.equal(status.status, 200, "/api/status answers");
  });
});

// The other regime, asserted rather than assumed.
//
// Under NODE_ENV=production server.js does not mount authRoutes or userData at
// all, and server/authority-release.js answers 410 Gone to the three local
// sign-in POSTs. That is deliberate: the local SQLite identity store lives in
// the deploy image and is recreated empty on every cold start, so it is not an
// authority a public deployment may trust, and the compiled frontend does not
// use it — it signs in through Supabase and makes zero requests to any
// /api/auth path.
//
// Left implicit, that decision reads as an accident whenever a test hits a 410
// it did not expect, which is exactly what happened. It is pinned here so
// re-mounting local auth in production is a deliberate, visible change.
const PORT_PROD = 5214;
const BP = `http://localhost:${PORT_PROD}`;
const prodDataDir = mkdtempSync(path.join(os.tmpdir(), "acct-store-prod-"));
let prodChild;

test("in production the local account routes are closed, not merely broken", async (t) => {
  await new Promise((resolve, reject) => {
    prodChild = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT_PROD),
        APP_DATA_DIR: prodDataDir,
        NODE_ENV: "production",
        // Pinned off for the same reason as the development server above: the
        // assertions here read 410 Gone from authority-release.js, which the
        // gate's 401 would mask.
        SITE_PASSWORD: "",
        OWNER_PASSWORD: "",
        SOCRATA_DOMAIN: "203.0.113.1",
        SOCRATA_CACHE_DIR: path.join(prodDataDir, "cache")
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    prodChild.on("error", reject);
    (async () => {
      for (let i = 0; i < 120; i++) {
        try { await fetch(`${BP}/healthz`); return resolve(); } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      reject(new Error("production server did not start"));
    })();
  });
  t.after(() => {
    try { prodChild?.kill(); } catch { /* already down */ }
    rmSync(prodDataDir, { recursive: true, force: true });
  });

  await t.test("the sign-in POSTs are 410 Gone, with a reason", async () => {
    for (const [route, payload] of [
      ["/api/auth/signup", { email: "x@example.com", password: "longenough1" }],
      ["/api/auth/login", { email: "x@example.com", password: "longenough1" }],
      ["/api/auth/magic", { email: "x@example.com" }]
    ]) {
      const res = await fetch(`${BP}${route}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
      });
      assert.equal(res.status, 410, `${route} is deliberately closed, not "try again later"`);
      assert.equal((await res.json()).error, "local_auth_disabled");
    }
  });

  await t.test("no local-auth path can create a session", async () => {
    // The escalation this closes: a disposable SQLite file being empty must
    // never be a route to owner on a public deployment.
    const res = await fetch(`${BP}/api/auth/signup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `first${Date.now()}@example.com`, password: "longenough1" })
    });
    assert.equal(res.status, 410);
    assert.equal(res.headers.get("set-cookie"), null, "and it hands out no session cookie");
  });

  await t.test("the product itself is unaffected", async () => {
    // Verified against the shipped bundle: it makes zero /api/auth requests, so
    // closing these paths cannot affect what the user sees.
    assert.equal((await fetch(`${BP}/`)).status, 200, "the application shell is served");
    assert.equal((await fetch(`${BP}/api/status`)).status, 200, "/api/status answers");
  });
});
