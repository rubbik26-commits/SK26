import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("market report exhausts Rolling Sales instead of silently capping at 50k", () => {
  const src = read("server/market-report.js");
  assert.match(src, /import \{ soql, soqlAll, escSoql \}/);
  const sales = src.slice(src.indexOf("async function salesInWindow"), src.indexOf("export async function marketReport"));
  assert.match(sales, /soqlAll\(SALES/);
  assert.match(sales, /maxRows:\s*250000/);
  assert.match(sales, /sale_date ASC,borough ASC,block ASC,lot ASC/);
  assert.ok(!/\$limit:\s*50000/.test(sales), "single-query 50k truncation must not return");
});

test("market report distinguishes intentional null stock from a PLUTO outage", () => {
  const src = read("server/market-report.js");
  const stock = src.slice(src.indexOf("async function stockFor"), src.indexOf("async function salesInWindow"));
  assert.match(stock, /intentional:\s*true/);
  assert.match(stock, /sourceOk:\s*false/);
  const report = src.slice(src.indexOf("export async function marketReport"));
  assert.match(report, /stockResults\.some\(\(r\) => r\.sourceOk === false\)/);
  assert.match(report, /return \{ status: 503, body: null \}/);
});

test("distress preflight requires every official score source before exact handler runs", () => {
  const server = read("server.js");
  const guardAt = server.indexOf("app.use(productionDistressSourceGuard)");
  const exactAt = server.indexOf("app.use(productionDistressTax)");
  assert.ok(guardAt > 0 && exactAt > guardAt, "source preflight must run before score calculation");

  const guard = read("server/production-distress-source-guard.js");
  for (const source of ["HPD violations", "DOB Safety Violations", "DOB Violations (BIS)", "DOB ECB/OATH", "NYC 311"]) {
    assert.ok(guard.includes(source), `${source} must be required`);
  }
  assert.match(guard, /status\(503\)/);
  assert.match(guard, /Missing sources are not treated as zero activity/);
});

test("production durable store rejects before disk on every failed production mutation", () => {
  const src = read("server/durable-store.js");
  const save = src.slice(src.indexOf("async save(value)"));
  const productionThrow = save.indexOf('process.env.NODE_ENV === "production"');
  const fallbackWrite = save.lastIndexOf("writeDisk(value)");
  assert.ok(productionThrow > 0 && fallbackWrite > productionThrow,
    "production fail-closed condition must be reached before the local/dev fallback write");
  assert.match(save.slice(productionThrow, fallbackWrite), /throw durableWriteError\(name\)/);
});
