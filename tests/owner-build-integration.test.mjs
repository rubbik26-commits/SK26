import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.OWNER_BUILD_TEST_PORT || 5193);
const BASE = `http://127.0.0.1:${PORT}`;
const SITE_PASSWORD = "owner-build-site-credential";
const tempData = mkdtempSync(path.join(os.tmpdir(), "lucia-owner-build-"));
let server;

function ownerHeaders(extra = {}) {
  const basic = Buffer.from(`owner-test:${SITE_PASSWORD}`).toString("base64");
  return { authorization: `Basic ${basic}`, accept: "application/json", ...extra };
}

async function waitForServer() {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`Owner build did not start on ${BASE}`);
}

async function requestJson(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: ownerHeaders(body === undefined ? {} : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* asserted by callers */ }
  return { response, body: parsed, text };
}

const getJson = (pathname) => requestJson(pathname);

test.before(async () => {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(PORT),
    APP_VARIANT: "owner",
    SITE_PASSWORD,
    // Deliberately different. The Owner build must promote SITE_PASSWORD and
    // make the ordinary product credential the owner credential.
    OWNER_PASSWORD: "obsolete-separate-owner-credential",
    APP_DATA_DIR: tempData,
    SUPABASE_URL: "",
    SUPABASE_DB_URL: "",
    DATABASE_URL: "",
    SUPABASE_PUBLISHABLE_KEY: "",
    SUPABASE_ANON_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_SECRET_KEY: "",
    AIRTABLE_PAT: "",
    AIRTABLE_API_KEY: "",
    AIRTABLE_BASE_ID: "",
    PINECONE_API_KEY: "",
    PINECONE_INDEX_HOST: "",
    GOOGLE_MAPS_KEY: "",
    GOOGLE_MAPS_API_KEY: "",
    GOOGLE_3D_KEY: ""
  };

  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += String(chunk); });
  server.on("exit", (code) => {
    if (code && code !== 0) stderr += `\nserver exited ${code}`;
  });

  try {
    await waitForServer();
  } catch (error) {
    throw new Error(`${error.message}\n${stderr.slice(-1200)}`);
  }
});

test.after(() => {
  try { server?.kill("SIGKILL"); } catch { /* already stopped */ }
  try { rmSync(tempData, { recursive: true, force: true }); } catch { /* cleanup only */ }
});

test("SITE_PASSWORD activates the full Owner switch without requiring Supabase sign-in", async () => {
  const { response, body, text } = await getJson("/api/pinecone-status");
  assert.equal(response.status, 200, text);
  assert.equal(body?.owner, true, `Owner switch was not enabled: ${text}`);
});

test("gate Owner investor pool is readable and persists exact edits", async () => {
  const initial = await getJson("/api/investors");
  assert.equal(initial.response.status, 200, initial.text);
  assert.equal(initial.body?.owner, true, initial.text);
  assert.ok(Array.isArray(initial.body?.investors), initial.text);

  const investors = [{
    id: "owner-runtime-investor",
    name: "Runtime Investor",
    firm: "Runtime Capital",
    email: "runtime@example.test",
    phone: "212-555-0100",
    buyBox: {
      assetClasses: ["Multifamily"],
      boroughs: ["Manhattan"],
      priceMin: 10000000,
      priceMax: 75000000,
      unitsMin: 20,
      unitsMax: 200,
      notes: "Owner runtime contract"
    }
  }];
  const saved = await requestJson("/api/investors", { method: "POST", body: { investors } });
  assert.equal(saved.response.status, 200, saved.text);
  assert.equal(saved.body?.owner, true, saved.text);
  assert.deepEqual(saved.body?.investors, investors);

  const reread = await getJson("/api/investors");
  assert.equal(reread.response.status, 200, reread.text);
  assert.deepEqual(reread.body?.investors, investors,
    "Owner investor edits must survive a separate request instead of only updating React query cache");
});

test("gate Owner Pipeline / CRM stages persist through the original API contract", async () => {
  const oppId = "OWNER-RUNTIME-1003720009";
  const created = await requestJson("/api/pipeline", {
    method: "POST",
    body: { oppId, stage: "Watchlist" }
  });
  assert.equal(created.response.status, 200, created.text);
  assert.equal(created.body?.ok, true, created.text);

  const firstRead = await getJson("/api/pipeline");
  assert.equal(firstRead.response.status, 200, firstRead.text);
  assert.ok(firstRead.body?.some?.((row) => row.oppId === oppId && row.stage === "Watchlist"), firstRead.text);

  const moved = await requestJson(`/api/pipeline/${encodeURIComponent(oppId)}`, {
    method: "PATCH",
    body: { stage: "Diligence" }
  });
  assert.equal(moved.response.status, 200, moved.text);
  assert.equal(moved.body?.ok, true, moved.text);

  const secondRead = await getJson("/api/pipeline");
  assert.ok(secondRead.body?.some?.((row) => row.oppId === oppId && row.stage === "Diligence"), secondRead.text);
});

test("gate Owner reaches Airtable cross-reference contract instead of an auth wall", async () => {
  const { response, body, text } = await getJson("/api/airtable-xref?owner=TEST&address=1%20TEST%20ST&bbl=1000000001");
  assert.equal(response.status, 200, text);
  assert.notEqual(response.status, 401, text);
  assert.notEqual(response.status, 403, text);
  assert.equal(body?.configured, false, "credentials are intentionally absent in this isolated test");
  assert.ok(Array.isArray(body?.sellerMatches), text);
  assert.ok(Array.isArray(body?.buyerMatches), text);
});

// Re-pinned 2026-08-19: `mapsConfigured` is not a key the original publishes.
// Its envelope is exactly month, configured, streetview, staticmap,
// freeStreetview, freeStatic — an absent meter is still reported by
// configured:false, which is what this test is really about.
test("gate Owner Source Registry reports an absent meter as configured:false", async () => {
  const { response, body, text } = await getJson("/api/maps-usage");
  assert.equal(response.status, 200, text);
  assert.equal(body?.configured, false, text);
  assert.deepEqual(Object.keys(body ?? {}),
    ["month", "configured", "streetview", "staticmap", "freeStreetview", "freeStatic"], text);
});

// Re-pinned 2026-08-19: the original's envelope is {configured, key, used, cap}
// — four keys in that order. `capped` and `durable` were extra. A null key with
// configured:false is still the safe unconfigured state this guards.
test("Owner 3D session returns the exact safe unconfigured contract when no Google 3D key exists", async () => {
  const { response, body, text } = await getJson("/api/3d-session");
  assert.equal(response.status, 200, text);
  assert.deepEqual(Object.keys(body ?? {}), ["configured", "key", "used", "cap"], text);
  assert.equal(body?.configured, false, text);
  assert.equal(body?.key, null, text);
});