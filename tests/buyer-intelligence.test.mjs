import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  boroughFromBuyerIntelBbl,
  buyerIntelAssetType,
  buyerIntelDate,
  buyerIntelRpcBody,
  cleanBuyerIntelBbl,
  cleanBuyerIntelEntityId,
  normalizeBuyerIntelHistory,
  normalizeBuyerIntelRows,
  rankBuyerIntelRows
} from "../server/buyer-intelligence-core.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("buyer intelligence accepts only valid NYC BBLs and derives the exact borough", () => {
  assert.equal(cleanBuyerIntelBbl("1-00835-0041"), "1008350041");
  assert.equal(boroughFromBuyerIntelBbl("1008350041"), "Manhattan");
  assert.equal(boroughFromBuyerIntelBbl("3000010001"), "Brooklyn");
  assert.equal(cleanBuyerIntelBbl("9008350041"), "");
  assert.equal(cleanBuyerIntelBbl("100835004"), "");
});

test("building class mapping is narrow and never guesses an ambiguous buyerDB asset type", () => {
  assert.equal(buyerIntelAssetType({ bldgClass: "D6" }), "Multifamily");
  assert.equal(buyerIntelAssetType({ bldgClass: "S9" }), "Mixed-Use");
  assert.equal(buyerIntelAssetType({ bldgClass: "G1" }), "Garage/Auto");
  assert.equal(buyerIntelAssetType({ bldgClass: "V1" }), "Development Site");
  assert.equal(buyerIntelAssetType({ bldgClass: "R4" }), null);
  assert.equal(buyerIntelAssetType({ bldgClass: "Z9" }), null);
});

test("buyer date filters reject impossible calendar dates instead of normalizing them", () => {
  assert.equal(buyerIntelDate("2024-02-29"), "2024-02-29");
  assert.equal(buyerIntelDate("2026-02-29"), null);
  assert.equal(buyerIntelDate("2026-02-31"), null);
  assert.equal(buyerIntelDate("08/19/2026"), null);
});

test("RPC input is bounded and uses the deployed api_buyers argument names", () => {
  assert.deepEqual(buyerIntelRpcBody({ borough: "Queens", assetType: "Industrial", minDeals: -4, rankBy: "volume", limit: 1000 }), {
    borough: "Queens",
    asset_type: "Industrial",
    price_min: null,
    price_max: null,
    date_min: null,
    min_deals: 1,
    rank_by: "vol",
    lim: 200
  });
});

test("buyer entity identifiers are canonical UUIDs before reaching api_entity", () => {
  assert.equal(cleanBuyerIntelEntityId("9F48CC93-58C1-4D0C-9057-0FCBB82A3DF8"), "9f48cc93-58c1-4d0c-9057-0fcbb82a3df8");
  assert.equal(cleanBuyerIntelEntityId("not-a-uuid"), "");
});

test("buyer rows expose aggregates and contact availability without contact values", () => {
  const rows = normalizeBuyerIntelRows([{
    entity_id: "9f48cc93-58c1-4d0c-9057-0fcbb82a3df8",
    name: "Example Buyer",
    is_spv_suspect: false,
    n: 3,
    vol: "12500000",
    last_deal: "2026-01-02",
    min_price: "2500000",
    max_price: "6000000",
    types: ["Multifamily"],
    boroughs: ["Brooklyn"],
    has_contact: true,
    phone: "must-not-pass-through",
    email: "must-not-pass-through@example.test"
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dealCount, 3);
  assert.equal(rows[0].volume, 12500000);
  assert.equal(rows[0].hasContact, true);
  assert.equal(Object.hasOwn(rows[0], "phone"), false);
  assert.equal(Object.hasOwn(rows[0], "email"), false);
});

test("buyer ranking uses stable secondary evidence instead of arbitrary tied rows", () => {
  const ranked = rankBuyerIntelRows([
    { name: "Lower volume", dealCount: 2, volume: 8_000_000, lastDeal: "2026-01-01" },
    { name: "Higher volume", dealCount: 2, volume: 12_000_000, lastDeal: "2025-01-01" },
    { name: "Most deals", dealCount: 3, volume: 3_000_000, lastDeal: "2024-01-01" }
  ], "count");
  assert.deepEqual(ranked.map((row) => row.name), ["Most deals", "Higher volume", "Lower volume"]);
});

test("buyer history preserves every exact buyer-role Manhattan row with property addresses", () => {
  const history = normalizeBuyerIntelHistory({
    entity: {
      entity_id: "9f48cc93-58c1-4d0c-9057-0fcbb82a3df8",
      display_name: "Example Buyer",
      entity_type: "company",
      is_spv_suspect: false,
      mailing_address: "must-not-pass-through"
    },
    contacts: [{ phone: "must-not-pass-through" }],
    deals: [
      { role: "buyer", sale_date: "2025-11-02", address: "110 Broadway", borough: "Manhattan", asset_type: "Office", sale_price: "11000000", source_url: "https://example.test/second-source" },
      { role: "buyer", sale_date: "2026-01-02", address: "100 Broadway", borough: "Manhattan", asset_type: "Office", sale_price: "12500000", source_url: "https://example.test/source" },
      { role: "buyer", sale_date: "2026-01-02", address: "100 Broadway", borough: "Manhattan", asset_type: "Office", sale_price: "12500000", source_url: "https://example.test/source" },
      { role: "seller", sale_date: "2025-01-02", address: "200 Broadway", borough: "Manhattan", asset_type: "Office", sale_price: "9000000" },
      { role: "buyer", sale_date: "2024-01-02", address: "300 Atlantic Ave", borough: "Brooklyn", asset_type: "Office", sale_price: "7000000" }
    ]
  }, { borough: "Manhattan", assetType: "Office" });
  assert.equal(history.entity.name, "Example Buyer");
  assert.equal(history.summary.transactionCount, 3);
  assert.equal(history.summary.addressedTransactions, 3);
  assert.equal(history.summary.recordedVolume, 36000000);
  assert.equal(history.transactions[0].address, "100 Broadway");
  assert.equal(Object.hasOwn(history.entity, "mailingAddress"), false);
  assert.equal(Object.hasOwn(history, "contacts"), false);
});

test("runtime mounts one additive owner-only router without changing existing endpoints", () => {
  const server = read("server.js");
  const router = read("server/buyer-intelligence.js");
  const shell = read("public/index.html");
  const ui = read("public/js/buyer-intelligence.js");
  const css = read("public/css/buyer-intelligence.css");
  const uiVersion = createHash("sha256").update(ui).digest("hex").slice(0, 12);
  const cssVersion = createHash("sha256").update(css).digest("hex").slice(0, 12);

  assert.match(server, /import buyerIntelligence from "\.\/server\/buyer-intelligence\.js";/);
  assert.ok(server.indexOf("app.use(authorityRelease);") < server.indexOf("app.use(buyerIntelligence);"));
  assert.ok(server.indexOf("app.use(buyerIntelligence);") < server.indexOf("app.use(gatePipelineDelete);"));
  assert.match(router, /gateRole\(req\) === "owner"/);
  assert.match(router, /adminKey\(\)/);
  assert.match(router, /\/rest\/v1\/rpc\/api_buyers/);
  assert.match(router, /\/rest\/v1\/rpc\/api_entity/);
  assert.match(router, /\/api\/buyer-intel\/buyers\/:entityId\/history/);
  assert.doesNotMatch(ui, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEY|sbi_contacts/);
  assert.match(shell, new RegExp(`/js/buyer-intelligence\\.js\\?v=${uiVersion}`));
  assert.match(shell, new RegExp(`/css/buyer-intelligence\\.css\\?v=${cssVersion}`));
  assert.match(ui, /Historical buyer activity/);
  assert.match(ui, /Most active Manhattan buyers/);
  assert.match(ui, /borough=Manhattan&minDeals=2&limit=200/);
  assert.match(ui, /View addresses/);
  assert.match(ui, /Property address/);
  assert.match(ui, /data-testid\^="pcard-"/);
});
