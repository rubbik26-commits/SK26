// Runtime regression for the Owner Source Registry spend meter. This starts the
// real Express stack with the response probe preloaded; no static route scan is
// used.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5227;
const BASE = `http://127.0.0.1:${PORT}`;
const basic = (password) => `Basic ${Buffer.from(`probe:${password}`).toString("base64")}`;

function start() {
  return new Promise((resolve, reject) => {
    const probeLines = [];
    const child = spawn(process.execPath, ["--import", "./scripts/route-probe.mjs", "server.js"], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: "test",
        // This test verifies the reduced member/owner split specifically. The
        // production blueprint is the full Owner build, where APP_VARIANT=owner
        // intentionally promotes the site credential to owner. Pinning `user`
        // here prevents that separate product variant from invalidating the
        // authorization contract this regression is meant to exercise.
        APP_VARIANT: "user",
        SITE_PASSWORD: "maps-member-test",
        OWNER_PASSWORD: "maps-owner-test",
        SUPABASE_DB_URL: "",
        DATABASE_URL: "",
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        SUPABASE_SECRET_KEY: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_ANON_KEY: "",
        APP_STATE_TOKEN: "",
        GOOGLE_MAPS_KEY: "",
        GOOGLE_MAPS_API_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (b) => {
      for (const line of String(b).split("\n")) if (line.startsWith("[PROBE]")) probeLines.push(line);
    });
    child.on("error", reject);
    (async () => {
      for (let i = 0; i < 80; i++) {
        try {
          const r = await fetch(`${BASE}/healthz`);
          if (r.ok) return resolve({ child, probeLines });
        } catch { /* booting */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      try { child.kill(); } catch { /* already down */ }
      reject(new Error("server did not start"));
    })();
  });
}

function answeringFile(lines, route) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[PROBE\] \w+ (\S+) \d+ <= (\S+)/);
    if (m && m[1] === route) return m[2].split(":")[0];
  }
  return null;
}

test("owner maps usage preserves the original Source Registry meter contract", async (t) => {
  const { child, probeLines } = await start();
  t.after(() => { try { child.kill(); } catch { /* already down */ } });

  const member = await fetch(`${BASE}/api/maps-usage`, {
    headers: { authorization: basic("maps-member-test") }
  });
  assert.equal(member.status, 403, "ordinary site members cannot read the owner spend meter");

  const owner = await fetch(`${BASE}/api/maps-usage`, {
    headers: { authorization: basic("maps-owner-test") }
  });
  const body = await owner.json();
  assert.equal(owner.status, 200,
    "an intentionally unconfigured meter is a valid Source Registry state, not a transport failure");
  assert.equal(body.configured, false,
    "Source Registry `configured` means the durable usage meter is active, not that a Google key exists");
  // Re-pinned 2026-08-19. This asserted a `mapsConfigured` key the original does
  // not publish. Measured, its envelope is exactly six keys in this order:
  //   {"month":"2026-08","configured":true,"streetview":33,"staticmap":149,
  //    "freeStreetview":5000,"freeStatic":10000}
  assert.deepEqual(Object.keys(body),
    ["month", "configured", "streetview", "staticmap", "freeStreetview", "freeStatic"],
    "the Source Registry meter publishes exactly the original's six keys, in its order");
  assert.equal(body.freeStreetview, 5000, "Street View free-tier contract is 5,000 loads");
  assert.equal(body.freeStatic, 10000, "Static Maps free-tier contract is 10,000 loads");

  assert.equal(answeringFile(probeLines, "/api/maps-usage"), "server/production-owner-source-registry.js",
    "gate-owner usage must be committed by the recovered Owner Source Registry router");
});