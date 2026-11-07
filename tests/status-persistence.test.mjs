import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("/api/status reports where deployment-wide state actually lives", () => {
  // Both the authoritative status router and its legacy-compatible fallback must
  // ask the running durable store and recognize every backend that truly
  // survives a redeploy. This protects against the old regression where a
  // Supabase REST/RPC deployment was reported as ephemeral or status inferred a
  // backend merely from an environment variable.
  for (const mod of ["../server/production-status.js", "../server/routes-live.js"]) {
    const src = readFileSync(new URL(mod, import.meta.url), "utf8");
    assert.match(src, /persistence:\s*\{/, `${mod} carries a persistence block`);
    assert.match(src, /survivesRedeploy/, `${mod} states whether state survives a redeploy`);
    for (const backend of ["postgres", "supabase-rest", "supabase-rpc"]) {
      assert.ok(src.includes(`"${backend}"`),
        `${mod} must count ${backend} as durable — reporting otherwise tells the owner durable state is ephemeral`);
    }
    assert.match(src, /durableBackend\(\)/,
      `${mod} reports from the running store, not a guessed configuration`);
    assert.ok(!/process\.env\.[A-Z_]+\s*\?\s*"postgres"/.test(src),
      `${mod} must not infer the persistence backend from an environment variable`);
  }
});
