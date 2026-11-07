import test from "node:test";
import assert from "node:assert/strict";
import {
  TERRITORY_SALES_CAP,
  territoryResponseHitsSalesCap
} from "../server/production-territory-cap-guard.js";

test("Territory refuses an ambiguous response at the hard Rolling Sales ceiling", () => {
  assert.equal(TERRITORY_SALES_CAP, 5000);
  assert.equal(
    territoryResponseHitsSalesCap("/api/territory", {}, { sales: { count: 4999 } }),
    false,
    "a result below the transport ceiling is not rejected"
  );
  assert.equal(
    territoryResponseHitsSalesCap("/api/territory", {}, { sales: { count: 5000 } }),
    true,
    "exactly hitting the ceiling is treated as potentially truncated"
  );
});

test("Area Detail sales refuses 5,000 rows while non-sales detail is unaffected", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ i }));
  assert.equal(territoryResponseHitsSalesCap("/api/area-detail", { kind: "sales" }, { sales: rows }), true);
  assert.equal(territoryResponseHitsSalesCap("/api/area-detail", {}, { sales: rows }), true,
    "sales is the endpoint's default kind");
  assert.equal(territoryResponseHitsSalesCap("/api/area-detail", { kind: "owner" }, { sales: rows }), false,
    "owner/building drill-downs are not Rolling Sales traversals");
});
