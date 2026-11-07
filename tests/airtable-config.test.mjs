import { test } from "node:test";
import assert from "node:assert/strict";
import { airtableConfiguration, crossFieldFormula, normalizeEntity } from "../server/adapters/airtable.js";

function withEnv(values, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("Airtable is not called configured merely because two malformed strings exist", () => {
  withEnv({ AIRTABLE_PAT: undefined, AIRTABLE_API_KEY: "legacy-or-wrong", AIRTABLE_BASE_ID: "patNotABase" }, () => {
    const c = airtableConfiguration();
    assert.equal(c.configured, false);
    assert.ok(c.reasons.includes("invalid_personal_access_token_format"));
    assert.ok(c.reasons.includes("invalid_base_id_format"));
  });
});

test("current PAT + base-id forms are accepted", () => {
  withEnv({ AIRTABLE_PAT: "patExample.token", AIRTABLE_API_KEY: undefined, AIRTABLE_BASE_ID: "appExample123" }, () => {
    assert.deepEqual(airtableConfiguration(), { configured: true, reasons: [] });
  });
});

test("owner and parcel matching normalization stays deterministic", () => {
  assert.equal(normalizeEntity("Avenue C, L.L.C."), "AVENUE C");
  const formula = crossFieldFormula(["AVENUE C", "1003720009"], ["Name", "BBL"]);
  assert.match(formula, /\{Name\}/);
  assert.match(formula, /\{BBL\}/);
  assert.match(formula, /1003720009/);
});
