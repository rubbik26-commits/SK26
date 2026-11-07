import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190004_buyer_intelligence_refresh_status.sql", import.meta.url),
  "utf8"
);
const router = readFileSync(new URL("../server/buyer-intelligence.js", import.meta.url), "utf8");
const blueprint = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");

test("refresh status is additive, read-only, and service-role-only", () => {
  const executableSql = migration.replace(/^\s*--.*$/gm, "");
  assert.match(migration, /create or replace function public\.buyer_intelligence_refresh_status\(\)/i);
  assert.match(migration, /language sql\s+stable\s+security definer\s+set search_path = pg_catalog/i);
  assert.match(migration, /public\.buyer_intelligence_schema_check\(\)/i,
    "freshness must carry the address-linked Manhattan buyer integrity certificate");
  assert.match(migration, /revoke all on function public\.buyer_intelligence_refresh_status\(\) from public/i);
  assert.match(migration, /revoke execute on function public\.buyer_intelligence_refresh_status\(\) from anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.buyer_intelligence_refresh_status\(\) to service_role/i);
  assert.doesNotMatch(executableSql, /\b(insert|update|delete|truncate|drop table|alter table)\b/i,
    "the observability migration must never mutate or remove buyer records");
});

test("refresh status covers every production buyerDB source with explicit freshness", () => {
  for (const job of [
    "acris_refresh",
    "traded_refresh",
    "rolling_sales",
    "crexi_refresh",
    "phase2_enrichment",
    "dos_enrich",
    "property_owner_refresh"
  ]) assert.match(migration, new RegExp(`'${job}'`));
  assert.match(migration, /stuck\.status in \('requested', 'running'\)/i);
  assert.match(migration, /stuck\.started_at < pg_catalog\.now\(\) - interval '2 hours'/i);
  assert.match(migration, /run\.status = 'completed'/i,
    "only a completed run can satisfy the data-freshness check");
  assert.match(migration, /'missingPropertyAddresses'/,
    "the inherited integrity payload must retain the address completeness field");
});

test("Lucia exposes freshness only through the existing owner-only buyer router", () => {
  assert.match(router, /router\.get\("\/api\/buyer-intel\/status", requireBuyerIntelOwner/);
  assert.match(router, /\/rest\/v1\/rpc\/buyer_intelligence_refresh_status/);
  assert.match(router, /token: adminKey\(\)/);
  assert.doesNotMatch(router, /BUYERDB_SCRAPER_TRIGGER_SECRET/,
    "the browser-facing route must not know the scheduler credential");
});

test("the Blueprint has one existing web service and one disabled cron, not a cloned web app", () => {
  assert.equal((blueprint.match(/^\s+- type: web$/gm) || []).length, 1);
  assert.equal((blueprint.match(/^\s+- type: cron$/gm) || []).length, 1);
  assert.match(blueprint, /^  - type: web\n    name: lucia$/m);
  assert.match(blueprint, /name: lucia-buyerdb-refresh/);
  assert.match(blueprint, /schedule: "17 13 \* \* \*"/);
  assert.match(blueprint, /key: BUYERDB_REFRESH_ENABLED\s+value: "0"/);
  assert.match(blueprint, /key: BUYERDB_SCRAPER_TRIGGER_SECRET\s+sync: false/);
  assert.doesNotMatch(blueprint, /name: lucia-9hpv/,
    "a Render collision suffix is never a canonical service name");
});
