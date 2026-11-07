// API contract + auth/permission + failure-state + 3D-cap tests (audit item
// 46). Spawns the real server on a test port, exercises the live contract,
// and restores any state files it touches. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 5199;
const B = `http://localhost:${PORT}`;

let child;
// Integration credentials this suite asserts the ABSENCE of. "failure states
// are honest" checks that /api/listing-check and /api/demographics report
// `configured:false` and that the magic-link route reports `sent:false` — all
// three are true only when the key is missing. Inheriting a developer's or a
// CI runner's real key made those assertions fail on a correctly working
// server, which is the opposite of what they exist to catch. Pinned absent,
// exactly like NODE_ENV below; extraEnv still wins so a case can opt back in.
const UNCONFIGURED_FOR_THIS_SUITE = [
  "CENSUS_API_KEY", "SERPER_API_KEY", "SMTP_URL",
  "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL",
  "DATABASE_URL", "APP_STATE_TOKEN"
];
const baseEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !UNCONFIGURED_FOR_THIS_SUITE.includes(k)));

async function startServer(extraEnv = {}) {
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    // NODE_ENV pinned, not inherited. This suite exercises the self-hosted
    // surface — local accounts, magic links, owner mode from the gate tier —
    // and server.js does not mount authRoutes/userData under
    // NODE_ENV=production, where authority-release.js answers those paths 410
    // Gone by design. Inheriting the variable made the suite assert whichever
    // regime the shell happened to be in: green in CI, red on any machine with
    // NODE_ENV=production exported. extraEnv still wins, so an individual case
    // can opt into production deliberately.
    env: { ...baseEnv(), NODE_ENV: "development", PORT: String(PORT), ...extraEnv },
    stdio: "ignore"
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${B}/healthz`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
}
function stopServer() { try { child?.kill(); } catch { /* already down */ } }

// The global site gate protects every route except /assets/* and /healthz.
// API tests authenticate with Basic auth (the password half is the gate
// password); `gate:false` makes a request as a true anonymous client.
const SITE_BASIC = `Basic ${Buffer.from("x:test-gate").toString("base64")}`;
const jar = { cookie: "" };
async function req(path, { method = "GET", body, useJar = true, jarRef = jar, gate = true } = {}) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(gate ? { authorization: SITE_BASIC } : {}),
      ...(useJar && jarRef.cookie ? { cookie: jarRef.cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get("set-cookie");
  if (useJar && setCookie) jarRef.cookie = setCookie.split(";")[0];
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

test("API parity suite", async (t) => {
  // The 3D quota is a durable Supabase RPC counter, not a file on disk, so
  // there is no local state for this suite to save and restore.
  await startServer({ GOOGLE_3D_KEY: "test-cap-key", SITE_PASSWORD: "test-gate", OWNER_PASSWORD: "test-owner" });
  t.after(stopServer);

  await t.test("global site gate: bypass only /assets/* and the liveness probes", async () => {
    const health = await fetch(`${B}/healthz`);
    assert.equal(health.status, 200, "healthz is never gated");
    const asset = await fetch(`${B}/assets/index-shmfCHKD.css`);
    assert.equal(asset.status, 200, "immutable assets are never gated");
    // Both liveness probes must answer without credentials — a platform health
    // check pointed at either one must never 401, or the deploy fails.
    const anonStatus = await fetch(`${B}/api/status`);
    assert.equal(anonStatus.status, 200, "/api/status is a liveness probe and stays open");
    const anonApi = await req("/api/pinecone-status", { useJar: false, gate: false });
    assert.equal(anonApi.status, 401, "every other anonymous /api/* is refused by the gate");
    assert.equal(anonApi.json?.error, "unauthorized");
    const anonPage = await fetch(`${B}/`);
    assert.equal(anonPage.status, 200);
    assert.match(await anonPage.text(), /Enter the access password/, "pages render the password form");
    // Checked against a gated endpoint — /api/status answers everyone by design.
    const badBasic = await fetch(`${B}/api/pinecone-status`, { headers: { authorization: `Basic ${Buffer.from("x:wrong").toString("base64")}` } });
    assert.equal(badBasic.status, 401, "wrong Basic password is refused");
    // Simulated login: POST /__gate sets both the ndi_gate and legacy
    // site_access cookies; either admits the next request.
    const gate = await fetch(`${B}/__gate`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=test-gate", redirect: "manual" });
    assert.equal(gate.status, 303);
    const cookies = gate.headers.getSetCookie?.() ?? [String(gate.headers.get("set-cookie"))];
    const joined = cookies.join("\n");
    assert.match(joined, /ndi_gate=/);
    assert.match(joined, /site_access=/);
    const siteAccess = cookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("site_access="));
    const viaCookie = await fetch(`${B}/api/pinecone-status`, { headers: { cookie: siteAccess } });
    assert.equal(viaCookie.status, 200, "site_access cookie admits gated API requests");
    // Same-origin Supabase env for the immutable bundle's auth bridge.
    const env = await fetch(`${B}/js/supabase-env.js`, { headers: { cookie: siteAccess } });
    assert.equal(env.status, 200);
    assert.match(await env.text(), /__SUPABASE_ENV__/);
  });

  await t.test("client-side routes are deep-linkable (SPA fallback)", async () => {
    // The compiled bundle routes on real paths, not hashes. A deep link or a
    // refresh on any of them must return the app shell, or the page 404s.
    for (const route of [
      "/dossier", "/pipeline", "/live", "/territory", "/radar",
      "/calculator", "/comps", "/present", "/investors", "/desk", "/sources"
    ]) {
      const res = await fetch(`${B}${route}`, { headers: { authorization: SITE_BASIC } });
      assert.equal(res.status, 200, `${route} must serve the shell`);
      const html = await res.text();
      assert.match(html, /assets\/index-BbnE3o5g\.js/, `${route} must serve the compiled bundle`);
    }
    // The fallback must not swallow genuine 404s.
    const missingFile = await fetch(`${B}/does-not-exist.png`, { headers: { authorization: SITE_BASIC } });
    assert.equal(missingFile.status, 404, "a missing file is still a 404");
    const missingApi = await fetch(`${B}/api/no-such-endpoint`, { headers: { authorization: SITE_BASIC } });
    assert.equal(missingApi.status, 404, "an unknown API endpoint is still a 404");
    // And it must not leak the shell past the gate.
    const anon = await fetch(`${B}/dossier`);
    assert.match(await anon.text(), /Enter the access password/, "anonymous deep links hit the gate");
  });

  await t.test("route smokes + contracts", async () => {
    const status = await req("/api/status", { useJar: false });
    assert.equal(status.status, 200);
    // The full vocabulary, not just the happy path.
    //
    // production-status.js reports "live" when PLUTO and ACRIS both answer,
    // "degraded" when one does, and "unavailable" when neither does. This
    // accepted only live/demo, so a genuine NYC Open Data outage — which is
    // where the honest value is "unavailable" — read as a broken status
    // endpoint. What the contract actually requires is that the mode is one of
    // the defined states and that it never claims live data it does not have.
    assert.ok(["live", "degraded", "unavailable", "demo"].includes(status.json.dataMode),
      `dataMode "${status.json.dataMode}" is not one of the defined states`);
    // "demo" is the one value that must never appear on a production build,
    // because it means seeded figures are being served.
    if (process.env.NODE_ENV === "production") {
      assert.notEqual(status.json.dataMode, "demo",
        "a production build must never report demo data");
    }
    assert.equal(typeof status.json.subsystems, "object");

    // Production contract: a bare array of live parcels in the original field
    // vocabulary (curated seeds only when every Socrata pull fails).
    const opps = await req("/api/opportunities?zips=&assetClass=&neighborhood=", { useJar: false });
    assert.equal(opps.status, 200);
    assert.ok(Array.isArray(opps.json), "opportunities is a bare array");
    assert.ok(opps.json.length >= 18 && opps.json.length <= 168, `plausible universe size (got ${opps.json.length})`);
    const p = opps.json[0];
    for (const k of ["id", "address", "neighborhood", "category", "bbl", "zoning", "landUse", "far", "maxFar", "unbuiltFarSf", "owner", "ownerNote", "opportunityScore", "conversionFit", "risk", "status", "signals", "policyCatalysts", "riskFlags", "thesis", "nextAction"]) {
      assert.ok(p[k] !== undefined, `opportunity field ${k} must always be present`);
    }

    // Measured original contract (2026-08-17): a well-formed unknown BBL is
    // NEVER a 404 — the original answers 200 with pluto:null and whatever the
    // record sources hold. Offline, the honest-outage 503 is the only other
    // permitted answer.
    const bad = await req("/api/asset-history?bbl=0000000000", { useJar: false });
    assert.notEqual(bad.status, 404, "the original never 404s a well-formed BBL");
    assert.ok([200, 503].includes(bad.status), `200 with per-source nulls, or an honest 503 (got ${bad.status})`);
    if (bad.status === 200) assert.equal(bad.json.pluto, null, "unknown lot carries pluto:null");
    else assert.ok(bad.json.error, "outage names its error");

    if (status.json.dataMode === "live") {
      const liveRec = await req("/api/asset-history?bbl=1003720009", { useJar: false });
      for (const k of ["pluto", "sales", "loans", "permits", "metrics"]) assert.ok(k in liveRec.json, `asset-history missing ${k}`);
      assert.ok(liveRec.json.sales.length > 0, "real parcel has recorded deeds");

      const pull = await req("/api/livepull?bbl=1003720009&borough=1&block=372&lot=9&address=X", { useJar: false });
      assert.ok(["exact", "corridor"].includes(pull.json.mode));
      const ids = pull.json.sources.map((s) => s.id);
      for (const id of ["rolling_sales", "pluto", "dob_permits", "dob_now", "acris_master", "zap"]) {
        assert.ok(ids.includes(id), `livepull missing source ${id}`);
      }
      assert.ok("summary" in pull.json && "debt" in pull.json && "permitContact" in pull.json);
    }
  });

  await t.test("kanban pipeline rows (global, oppId-keyed)", async () => {
    const bare = await req("/api/pipeline", { useJar: false });
    assert.equal(bare.status, 200);
    assert.ok(Array.isArray(bare.json), "bare GET returns the row array");
    await req("/api/pipeline", { method: "POST", body: { oppId: "MR-001", stage: "Diligence" }, useJar: false });
    const p1 = await req("/api/pipeline", { useJar: false });
    assert.ok(p1.json.some((r) => r.oppId === "MR-001" && r.stage === "Diligence"), "POST persists a stage");
    await req("/api/pipeline/MR-001", { method: "PATCH", body: { stage: "IC Memo" }, useJar: false });
    const p2 = await req("/api/pipeline", { useJar: false });
    assert.ok(p2.json.some((r) => r.oppId === "MR-001" && r.stage === "IC Memo"), "PATCH moves the stage");
  });

  await t.test("owner mode is a gate-tier soft gate, never a 401", async () => {
    // A member (site-password tier) is inside the gate but is not the owner.
    const anonPs = await req("/api/pinecone-status", { useJar: false });
    assert.equal(anonPs.status, 200);
    assert.equal(anonPs.json.owner, false, "member tier is not the owner");
    assert.equal(typeof anonPs.json.configured, "boolean");

    const anonInv = await req("/api/investors", { useJar: false });
    assert.equal(anonInv.status, 200);
    assert.deepEqual(anonInv.json, { owner: false, investors: [] }, "soft-gated envelope for the member tier");

    // Entering the owner-tier gate password flips owner mode app-wide.
    const gate = await fetch(`${B}/__gate`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=test-owner", redirect: "manual" });
    assert.equal(gate.status, 303);
    const ownerCookie = String(gate.headers.get("set-cookie")).split(";")[0];
    const ownerPs = await fetch(`${B}/api/pinecone-status`, { headers: { cookie: ownerCookie } }).then((r) => r.json());
    assert.equal(ownerPs.owner, true, "owner password unlocks owner mode");

    const save = await fetch(`${B}/api/investors`, {
      method: "POST", headers: { cookie: ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({ investors: [{ id: "inv_t", name: "Test LP", buyBox: { boroughs: ["Manhattan"] } }] })
    }).then((r) => r.json());
    assert.equal(save.owner, true);
    assert.equal(save.investors.length, 1, "POST answers with the same envelope the GET uses");
    const anonAfter = await req("/api/investors", { useJar: false });
    assert.deepEqual(anonAfter.json.investors, [], "pool stays private to the owner tier");
  });

  await t.test("failure states are honest", async () => {
    // Never a 404 for a well-formed BBL — the original's measured contract.
    const bad = await req("/api/asset-history?bbl=0000000000", { useJar: false });
    assert.notEqual(bad.status, 404, "the original never 404s a well-formed BBL");
    assert.ok([200, 503].includes(bad.status));
    const listing = await req("/api/listing-check?addr=TEST", { useJar: false });
    assert.equal(listing.json.configured, false, "no key -> configured:false, never fake hits");
    const demo = await req("/api/demographics?zips=11211", { useJar: false });
    assert.equal(demo.json.configured, false, "demographics never synthesized without CENSUS_API_KEY");
    const magic = await req("/api/auth/magic", { method: "POST", body: { email: "x@example.com" }, useJar: false });
    assert.equal(magic.json.sent, false, "magic link reports honestly without SMTP");
    const notFound = await req("/api/no-such-endpoint", { useJar: false });
    assert.equal(notFound.status, 404);
  });

  await t.test("auth, roles and row-level isolation", async () => {
    const email = `t${Date.now()}@example.com`;
    const su = await req("/api/auth/signup", { method: "POST", body: { email, password: "longenough1" } });
    assert.equal(su.status, 200);
    assert.equal(su.json.signedIn, true);

    await req("/api/watchlist", { method: "POST", body: { bbl: "1003720009", address: "272 EAST 3 STREET" } });
    const w = await req("/api/watchlist");
    assert.equal(w.json.watchlist.length, 1);

    const anonW = await req("/api/watchlist", { useJar: false });
    assert.equal(anonW.status, 401, "watchlist requires a session");

    const jar2 = { cookie: "" };
    await req("/api/auth/signup", { method: "POST", body: { email: `u${Date.now()}@example.com`, password: "longenough2" }, jarRef: jar2 });
    const w2 = await req("/api/watchlist", { jarRef: jar2 });
    assert.equal(w2.json.watchlist.length, 0, "second user sees only their own rows");

    // Production semantics: account deletion is Supabase-bearer only — a
    // local cookie session must never be able to delete an account.
    const del = await req("/api/account-delete", { method: "POST", jarRef: jar2 });
    assert.notEqual(del.json?.deleted, true, "cookie sessions cannot delete accounts");
  });

  await t.test("3D sessions are metered by the durable Supabase RPC, and fail closed", async () => {
    // The quota lives in Supabase (cre_reserve_3d_session), reserved
    // atomically per session — not in a JSON file on the instance, which a
    // free-plan redeploy would wipe and which two instances would race on.
    // With a Google key but no service key the RPC is unreachable, so the
    // deployment must refuse the session rather than hand out an unmetered
    // paid key: the cost ceiling is the point.
    // Re-pinned 2026-08-19: the original's envelope on this route is
    // {configured, key, used, cap}; `capped` and `durable` are not keys it
    // publishes. The safety property this test exists for is unchanged and is
    // asserted on what survives — a refused reservation hands out NO key and
    // names the durable store as the reason.
    const s = await req("/api/3d-session", { useJar: false });
    assert.equal(s.json.configured, true, "the Google key is present, so 3D reports configured");
    assert.equal(s.json.key, null, "the key is never handed out uncounted");
    assert.equal(s.json.reason, "durable_quota_unavailable", "the reason names the durable store, not a local file");

    // The reservation path must be the RPC — asserted at the source so a
    // regression back to disk/cookie counting fails here rather than in
    // production on a redeploy.
    const quota = readFileSync(new URL("../server/durable-cost.js", import.meta.url), "utf8");
    assert.match(quota, /rest\/v1\/rpc\/\$\{name\}/, "reservations go through a Supabase RPC endpoint");
    assert.match(quota, /cre_reserve_3d_session/);
    assert.match(quota, /cre_increment_usage/);
    assert.doesNotMatch(quota, /readFileSync|writeFileSync/, "the quota must not read or write local files");
  });
});
