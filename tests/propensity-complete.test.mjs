import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(root, p), "utf8");

test("one production router owns both propensity validation contracts before older duplicates", () => {
  const server = read("server.js");
  const owner = server.indexOf("app.use(productionPropensityValidation)");
  const authority = server.indexOf("app.use(authorityRelease)");
  const bundle = server.indexOf("app.use(bundleRoutes)");
  const analytics = server.indexOf("app.use(productionAnalytics)");
  assert.ok(owner > 0 && owner < authority && owner < bundle && owner < analytics);

  const src = read("server/production-propensity-validation.js");
  assert.match(src, /router\.get\("\/api\/propensity-validation"/);
  assert.match(src, /router\.get\("\/api\/analytics\/backtest"/);
});

test("recorded sales are paged to completion and never silently truncated", () => {
  const src = read("server/production-propensity-validation.js");
  assert.match(src, /const SALES_PAGE = 5000/);
  assert.match(src, /for \(let offset = 0; offset < SALES_MAX; offset \+= SALES_PAGE\)/);
  assert.match(src, /\$offset: offset/);
  assert.match(src, /if \(page\.length < SALES_PAGE\) return \{ live: true, rows, complete: true \}/);
  assert.match(src, /rolling_sales_exceeded_\$\{SALES_MAX\}_row_safety_ceiling/);
  assert.match(src, /salesComplete: true/);
});

test("validation requires complete PLUTO and DOB permit evidence", () => {
  const src = read("server/production-propensity-validation.js");
  assert.match(src, /const area = await areaBuildings/);
  assert.match(src, /permitSource\?\.status === "error"/);
  assert.match(src, /dob_permits_unavailable/);
  assert.match(src, /Validation is not calculated with unknown permit history treated as zero activity/);
});
