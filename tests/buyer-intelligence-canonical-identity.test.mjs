import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190002_buyer_intelligence_canonical_identity.sql", import.meta.url),
  "utf8"
);
const verifier = readFileSync(new URL("../scripts/verify-production-schema.mjs", import.meta.url), "utf8");
const releaseNotes = readFileSync(new URL("../docs/release/BUYER-INTELLIGENCE.md", import.meta.url), "utf8");

function canonicalEntityKey(value) {
  const normalized = String(value ?? "")
    .toUpperCase()
    .replaceAll(".", "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return normalized
    .replace(/(\s+(LLC|INC|CORP|CORPORATION|LP|LTD|COMPANY|CO))+$/g, "")
    .trim() || null;
}

test("canonical buyer identity removes terminal legal suffixes without erasing a meaningful LP prefix", () => {
  assert.equal(canonicalEntityKey("139 BOWERY HOLDINGS LLC"), "139 BOWERY HOLDINGS");
  assert.equal(canonicalEntityKey("139 Bowery Holdings"), "139 BOWERY HOLDINGS");
  assert.equal(canonicalEntityKey("Cohen Brothers Realty Corp."), "COHEN BROTHERS REALTY");
  assert.equal(canonicalEntityKey("LP 208 FLATBUSH LLC"), "LP 208 FLATBUSH");
  assert.notEqual(canonicalEntityKey("LP 208 FLATBUSH LLC"), canonicalEntityKey("208 FLATBUSH LLC"));
});

test("buyer identity migration is additive and never rewrites warehouse rows", () => {
  assert.doesNotMatch(migration, /\b(update|delete\s+from|insert\s+into|truncate|drop\s+table|alter\s+table)\b/i);
  assert.match(migration, /no sbi_\* table row is inserted, updated, merged, or deleted/i);
  assert.match(migration, /create or replace function public\.sbi_canonical_entity_key/);
});

test("buyer ranking counts distinct address-linked deals across canonical aliases", () => {
  assert.match(migration, /select distinct\s+ke\.canonical_key,\s+d\.deal_id/s);
  assert.match(migration, /p\.address_raw as address/);
  assert.match(migration, /count\(distinct dp\.deal_id\)/);
  assert.match(migration, /canonicalRepeatBuyers/);
  assert.match(migration, /missingPropertyAddresses/);
});

test("buyer detail expands the whole canonical group while retaining source deal identity", () => {
  assert.match(migration, /create or replace function public\.api_entity\(eid uuid\)/);
  assert.match(migration, /canonical_entity_ids/);
  assert.match(migration, /'deal_id', dr\.deal_id/);
  assert.match(migration, /order by dr\.sale_date desc nulls last, dr\.deal_id, dr\.role/);
});

test("buyer intelligence RPCs remain service-role-only", () => {
  assert.match(migration, /revoke all on function public\.api_buyers[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.api_entity\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.api_buyers[\s\S]*to service_role/);
  assert.match(migration, /grant execute on function public\.api_entity\(uuid\) to service_role/);
});

test("buyer deployment verification tolerates only the observed PostgREST schema-cache window", () => {
  assert.match(verifier, /callRpcAfterSchemaCacheReload/);
  assert.match(verifier, /"code":"PGRST202"/);
  assert.match(
    verifier,
    /await callRpcAfterSchemaCacheReload\("buyer_intelligence_schema_check"\)/
  );
  assert.match(
    verifier,
    /if \(!schemaCacheMiss \|\| attempt >= schemaCacheRetryDelaysMs\.length\) throw e/
  );
});

test("production fails closed on buyer/address integrity and documents the corrected complete ranking", () => {
  assert.match(verifier, /buyer_intelligence_schema_check/);
  assert.match(verifier, /missingPropertyAddresses\) !== 0/);
  assert.match(verifier, /canonicalRepeatBuyers\) < Number\(buyerIntelligenceSchema\.rawRepeatBuyers/);
  assert.match(releaseNotes, /61 canonical repeat Manhattan buyers/);
  assert.match(releaseNotes, /139 Bowery Holdings/);
  assert.match(releaseNotes, /All 1,153 returned transactions had a recorded property address/);
});
