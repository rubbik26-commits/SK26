// Phase 7: no production route may answer with invented property facts.
//
// The seeded universe carries owners like "Demo Holdings LLC", authored
// opportunity scores and hand-typed lot areas, in exactly the shape a live
// record arrives in. A user cannot tell the two apart. So when the live
// sources cannot be reached, the correct answer is an explicit unavailable
// state — never a plausible one.
//
// This runs the real server in NODE_ENV=production with the public-record
// hosts pointed at a black hole, and asserts that no seeded parcel reaches a
// response.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5217;
const B = `http://localhost:${PORT}`;
const GATE = `Basic ${Buffer.from("x:synth-test").toString("base64")}`;

// Fingerprints of the seeded universe. None may appear in a production
// response.
const SEEDED = [/Demo Holdings LLC/, /Demo FiDi Office REIT/, /Demo Tenth Ave Land LLC/, /"MR-00\d"/, /Placeholder owner/];

const cacheDir = mkdtempSync(path.join(tmpdir(), "synth-cache-"));

let child;
function start(env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: "production",
        SITE_PASSWORD: "synth-test",
        OWNER_PASSWORD: "synth-test-owner",
        // Cut every live public-record pull: an unroutable proxy host makes
        // each upstream fetch fail the way an outage would.
        SOCRATA_DOMAIN: "https://127.0.0.1:9",
        // An empty cache directory too: a warm response cache would answer
        // from disk and the outage would not be an outage.
        SOCRATA_CACHE_DIR: cacheDir,
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", reject);
    (async () => {
      for (let i = 0; i < 80; i++) {
        try { await fetch(`${B}/healthz`); return resolve(); } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      reject(new Error("server did not start"));
    })();
  });
}

test("no production route answers with invented property facts", async (t) => {
  await start();
  t.after(() => { try { child?.kill(); } catch { /* already down */ } });

  const routes = [
    "/api/opportunities",
    "/api/maturity-wall",
    "/api/area-buildings?zips=11216&page=0&pageSize=5&sort=propensity",
    "/api/market-report?zips=11216",
    "/api/area-detail?zips=11216",
    "/api/territory?zips=11216&mode=multifamily"
  ];

  // /api/maturity-wall serves a DURABLE MIRROR, not a live pull — the
  // original's own published wall, captured 2026-08-20 and checked in at
  // server/data/maturity-wall-mirror.json (see server/authority-release.js for
  // the measurement that forced this). Like the checksum-pinned frontend and
  // the packaged NTA polygons, it legitimately answers during an upstream
  // outage — the original does exactly the same, serving its frozen cache with
  // no request-time pull. It stays in the SEEDED leak sweep: its rows must
  // still never match a generator pattern.
  const DURABLE_MIRROR_ROUTES = new Set(["/api/maturity-wall"]);
  for (const route of routes) {
    const res = await fetch(`${B}${route}`, { headers: { authorization: GATE } });
    const body = await res.text();
    for (const pattern of SEEDED) {
      assert.ok(!pattern.test(body), `${route} leaked seeded data matching ${pattern}: ${body.slice(0, 200)}`);
    }
    if (DURABLE_MIRROR_ROUTES.has(route)) continue;
    // An honest answer is a 5xx, an empty collection, or an explicit error —
    // never a populated one built from seeds.
    assert.ok(res.status >= 400 || body === "[]" || body === "" || /"configured":\s*false|"error"|"provenance":\s*"unavailable"|"loans":\s*\[\]|"buildings":\s*\[\]/.test(body),
      `${route} answered 200 with content while every live source was unreachable: ${body.slice(0, 200)}`);
  }
});

test("the static reachability report is part of the suite", () => {
  // Fails the build if a production router gains a path to a generator. The
  // demo tier behind the live guard is allowed and is excluded by the script.
  const out = execFileSync(process.execPath, ["scripts/synthetic-reachability.mjs"], { cwd: root, encoding: "utf8" });
  // Reachability is allowed — the demo tier exists on purpose. What must hold
  // is that no generator export can answer without passing the guard.
  assert.match(out, /synthetic generator exports without a production guard: 0/, out);
});
