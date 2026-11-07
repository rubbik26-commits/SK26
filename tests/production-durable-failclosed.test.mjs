import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("production durable failure occurs before any ephemeral disk mutation", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "lucia-prod-failclosed-"));
  const moduleUrl = pathToFileURL(path.join(root, "server", "durable-store.js")).href;
  const script = `
    import { existsSync } from "node:fs";
    import path from "node:path";
    const { durableStore, resetDurableStore } = await import(${JSON.stringify(moduleUrl)});
    resetDurableStore();
    const target = path.join(process.env.APP_DATA_DIR, "production-rejected.json");
    const store = durableStore("production-rejected.json", { rows: [] });
    let rejected = false;
    try {
      await store.save({ rows: [{ oppId: "MUST-NOT-APPEAR", stage: "Watchlist" }] });
    } catch (e) {
      rejected = e?.code === "durable_write_failed";
    }
    if (!rejected) throw new Error("production save did not fail closed");
    if (existsSync(target)) throw new Error("rejected production save mutated ephemeral disk");
  `;

  const env = { ...process.env };
  for (const key of [
    "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
    "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "APP_STATE_TOKEN", "SITE_PASSWORD", "OWNER_PASSWORD"
  ]) delete env[key];
  env.NODE_ENV = "production";
  env.APP_DATA_DIR = dataDir;
  // Configured but unreachable, reproducing the exact first-boot/misconfiguration
  // branch that previously wrote disk before authorityRelease returned 503.
  env.SUPABASE_DB_URL = "postgresql://nobody:nothing@127.0.0.1:1/none?sslmode=disable";

  try {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 30000
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
