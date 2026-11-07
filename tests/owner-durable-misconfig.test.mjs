import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Owner builds promote the normal site credential to Owner. This is the Owner
// counterpart of the historical split-password persistence regression: even on
// first boot, a configured-but-unusable durable backend must never report an
// ephemeral pipeline write as successfully saved.
test("Owner pipeline refuses a non-durable production save", async (t) => {
  const port = 5220;
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "owner-durable-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("SUPABASE_") &&
    key !== "DATABASE_URL" &&
    key !== "APP_STATE_TOKEN" &&
    key !== "OWNER_PASSWORD" &&
    key !== "SITE_PASSWORD"
  ));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...env,
      APP_VARIANT: "owner",
      NODE_ENV: "production",
      PORT: String(port),
      APP_DATA_DIR: dir,
      SUPABASE_URL: "https://hvsvxjdwfbsqaqlmuwlt.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "not-a-real-key-probe",
      SITE_PASSWORD: "owner-durable-site",
      SOCRATA_DOMAIN: "203.0.113.1"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  t.after(() => {
    try { child.kill(); } catch { /* already down */ }
    rmSync(dir, { recursive: true, force: true });
  });

  let up = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) { up = true; break; }
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(up, "the Owner server started");

  const gate = await fetch(`${base}/__gate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "password=owner-durable-site",
    redirect: "manual"
  });
  assert.equal(gate.status, 303, "SITE_PASSWORD is the Owner credential in an Owner build");
  const cookie = (gate.headers.getSetCookie?.() ?? [String(gate.headers.get("set-cookie"))])
    .map((value) => value.split(";")[0])
    .join("; ");

  const role = await fetch(`${base}/api/pinecone-status`, { headers: { cookie } });
  assert.equal(role.status, 200);
  assert.equal((await role.json()).owner, true, "the same site session must expose the full Owner product");

  const res = await fetch(`${base}/api/pipeline`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ oppId: "LIVE-1008350041", stage: "Watchlist" })
  });
  assert.equal(res.status, 503, "a write that cannot be durable must be refused");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.durable, false);
  assert.equal(body.error, "durable_storage_required");
  assert.match(body.message, /no ephemeral save is reported as successful/i);
  assert.match(body.message, /durable production store is unavailable/i);
});
