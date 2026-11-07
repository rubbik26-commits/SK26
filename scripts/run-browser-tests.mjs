// Runs the complete browser suite against either a locally booted server or an
// explicitly supplied deployment URL. Every listed suite is gating.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const external = process.argv[2];
const PORT = Number(process.env.BROWSER_TEST_PORT || 5175);
const BASE = external || `http://localhost:${PORT}`;
const APP_VARIANT = String(process.env.APP_VARIANT || "owner").trim().toLowerCase() === "user" ? "user" : "owner";
process.env.APP_VARIANT = APP_VARIANT;

const SUITES = [
  ["release-gate", "tests/browser/release-gate.cjs", { gating: true }],
  ["parity", "tests/browser/parity-browser.cjs", { gating: true }],
  ["features", "tests/browser/features-browser.cjs", { gating: true }],
  // The page-by-page matrix is intentionally part of the gate. It exercises
  // every primary route across load/API/buttons/filters/search/drawers/nav/
  // mutations/exports/empty/error/refresh/deeplink and exits non-zero on any
  // FAIL. Keeping it outside this runner allowed a stale one-failure report to
  // coexist with a green `npm run test:browser`.
  ["phase14-matrix", "tests/browser/phase14-matrix.cjs", { gating: true }],
  ["underwriting", "tests/browser/underwriting.cjs", { gating: true }],
  ["viewports", "tests/browser/viewport-sweep.cjs", { gating: true }],
  ["maps", "tests/browser/maps-geospatial.cjs", { gating: true }],
  ["dossier", "tests/browser/dossier.cjs", { gating: true }],
  ["underwriting-advanced", "tests/browser/underwriting-advanced.cjs", { gating: true }]
];

// The current reconstruction target is the complete Owner product. In owner
// mode the ordinary site credential is deliberately promoted to the owner tier
// by server/owner-variant.js, so the test process and the child server must use
// the same credential. Otherwise the helper processes try the obsolete distinct
// OWNER_PASSWORD while the server correctly accepts SITE_PASSWORD as owner and
// every owner-only route fails for a harness mismatch rather than a product bug.
//
// APP_VARIANT=user retains the old two-tier harness for the later reduced build.
if (!external) {
  process.env.SITE_PASSWORD = process.env.SITE_PASSWORD || "browser-gate-site";
  if (APP_VARIANT === "owner") {
    process.env.OWNER_PASSWORD = process.env.SITE_PASSWORD;
  } else {
    process.env.OWNER_PASSWORD = process.env.OWNER_PASSWORD || "browser-gate-owner";
  }
} else {
  if (!process.env.SITE_PASSWORD) {
    console.error("[browser-tests] FATAL: SITE_PASSWORD must be supplied when testing an external deployment.");
    process.exit(2);
  }
  if (APP_VARIANT === "owner") {
    process.env.OWNER_PASSWORD = process.env.SITE_PASSWORD;
  } else if (!process.env.OWNER_PASSWORD) {
    console.error("[browser-tests] FATAL: OWNER_PASSWORD must be supplied when testing an external deployment in APP_VARIANT=user so owner-only surfaces are genuinely exercised.");
    process.exit(2);
  }
}

let server;
let pglite = null;
const PG_PORT = Number(process.env.BROWSER_TEST_PG_PORT || 55433);
const PG_DATA = path.join(root, ".pglite-browser-tests");

function startPglite() {
  if (external) return Promise.resolve();
  return new Promise((resolve, reject) => {
    pglite = spawn(process.execPath, ["scripts/pglite-server.mjs", String(PG_PORT), PG_DATA], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    pglite.on("error", reject);
    let settled = false;
    pglite.stdout.on("data", (b) => {
      if (!settled && /listening on/.test(String(b))) {
        settled = true;
        process.env.SUPABASE_DB_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/postgres`;
        console.log(`[browser-tests] durable store: PGlite Postgres on 127.0.0.1:${PG_PORT}`);
        resolve();
      }
    });
    pglite.stderr.on("data", (b) => process.stderr.write(b));
    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("PGlite did not start")); }
    }, 60000);
  });
}

async function reportUpstreamHealth() {
  const probe = "https://data.cityofnewyork.us/resource/64uk-42ks.json?$limit=1";
  try {
    const res = await fetch(probe, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (Array.isArray(body)) {
        console.log("[browser-tests] upstream: NYC Open Data is answering");
        return true;
      }
      console.log("[browser-tests] upstream: NYC Open Data returned a non-array body — treat live-data failures with suspicion");
      return false;
    }
    console.log(
      `\n[browser-tests] ============================================================\n` +
      `[browser-tests] UPSTREAM OUTAGE: NYC Open Data answered HTTP ${res.status}.\n` +
      `[browser-tests] Every suite that reads live public records will fail, and the\n` +
      `[browser-tests] symptoms look like product defects — empty lot grids, "PLUTO\n` +
      `[browser-tests] ground truth unavailable", no hover cards. That is the app\n` +
      `[browser-tests] refusing to invent data, which is the intended behaviour.\n` +
      `[browser-tests] Judge this run's live-data suites only after the source recovers.\n` +
      `[browser-tests] ============================================================\n`
    );
    return false;
  } catch (e) {
    console.log(`[browser-tests] upstream: could not reach NYC Open Data (${String(e?.message ?? e).slice(0, 80)}) — live-data suites will fail for that reason`);
    return false;
  }
}

async function assertPortFree() {
  let res = null;
  try {
    res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return;
  }
  if (res) {
    console.error(
      `[browser-tests] FATAL: something is already serving ${BASE} (HTTP ${res.status}).\n` +
      "[browser-tests] A leftover server from an earlier run would be tested INSTEAD of this one,\n" +
      "[browser-tests] silently and with whatever configuration it was started with.\n" +
      "[browser-tests] Stop it first:  for p in $(lsof -t -i:" + PORT + "); do kill -9 $p; done"
    );
    process.exit(2);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "ignore", "pipe"]
    });
    server.on("error", reject);
    server.on("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`server exited during boot with code ${code}`));
    });
    (async () => {
      for (let i = 0; i < 120; i++) {
        try { await fetch(`${BASE}/healthz`); return resolve(); } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      reject(new Error(`server did not start on ${BASE}`));
    })();
  });
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, BASE], {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b; process.stdout.write(b); });
    child.stderr.on("data", (b) => { out += b; process.stderr.write(b); });
    child.on("close", (code) => resolve({ code, out }));
  });
}

(async () => {
  if (!external) {
    await assertPortFree();
    await reportUpstreamHealth();
    await startPglite();
    process.stdout.write(`[browser-tests] booting the ${APP_VARIANT} application on ${BASE}\n`);
    await startServer();
  } else {
    process.stdout.write(`[browser-tests] running ${APP_VARIANT} verification against external deployment ${BASE}\n`);
  }

  const results = [];
  for (const [name, file, opts] of SUITES) {
    process.stdout.write(`\n===== ${name} =====\n`);
    const { code } = await run(file);
    results.push([name, code, opts]);
  }

  try { server?.kill(); } catch { /* already down */ }
  try { pglite?.kill(); } catch { /* already down */ }

  process.stdout.write("\n===== browser suites =====\n");
  for (const [name, code, opts] of results) {
    process.stdout.write(`${code === 0 ? "PASS" : opts.gating ? "FAIL" : "WARN"}  ${name}\n`);
  }
  const gatingFailures = results.filter(([, code, opts]) => code !== 0 && opts.gating);
  process.stdout.write(`${results.filter(([, c]) => c === 0).length}/${results.length} suites passed, ${gatingFailures.length} gating failure(s)\n`);
  process.exit(gatingFailures.length ? 1 : 0);
})().catch((e) => {
  try { server?.kill(); } catch { /* already down */ }
  try { pglite?.kill(); } catch { /* already down */ }
  console.error("[browser-tests] FATAL", e.message);
  process.exit(1);
});
