// The caches that decide whether this service survives its instance.
//
// Render's instance has 512 MB. Measured on 2026-08-18 against a fresh local
// server, before the fixes these tests pin:
//
//   cold start                                    ~100 MB RSS
//   24 endpoints x 16 concurrent x 4 waves         859 MB RSS, never released
//   /api/cliffs alone at concurrency 8            +594 MB
//   /api/cliffs alone at concurrency 1            +216 MB
//   every other BBL endpoint                      +2 MB to +18 MB
//
// The live service restarted twice while it was being probed concurrently
// (/api/status startedAt moved 16:14:58Z -> 19:00:04Z -> 19:06:28Z) and
// answered 502 on 26 endpoints that return 200 when probed one at a time at
// 3 s spacing. After the fixes, the same load test ends at 366 MB.
//
// These are source assertions so the suite stays hermetic and offline; the
// RSS measurements that justify them are in the commit message.
//
//   node --test tests/memory-bounds.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("the Socrata memory cache evicts; it is not an unbounded Map", () => {
  const src = read("server/adapters/socrata.js");
  // The TTL is only consulted on read, so an expired entry could never be
  // served again yet stayed resident forever holding its parsed row array.
  assert.match(src, /function memSet\(/);
  assert.match(src, /function memDelete\(/);
  assert.match(src, /MEM_MAX_ROWS/);
  assert.match(src, /MEM_MAX_ENTRIES/);
  // Every write goes through the bounded setter.
  const writes = [...src.matchAll(/mem\.set\(/g)];
  assert.equal(writes.length, 1, "mem.set may only be called inside memSet");
  const memSetBody = src.slice(src.indexOf("function memSet("), src.indexOf("export const memStats"));
  assert.ok(memSetBody.includes("mem.set("), "the single mem.set is the one inside memSet");
  assert.match(src, /memSet\(url, fc\.value\)/);
  assert.match(src, /memSet\(url, out\)/);
});

test("the basemap tile cache is bounded by bytes, not by entry count", () => {
  const src = read("server/routes.js");
  // Measured tile sizes on 2026-08-18: 23,745 / 75,880 / 132,355 / 243,308 /
  // 463,052 bytes. The old cap of 3,000 entries permitted ~561 MB.
  assert.match(src, /TILE_MAX_BYTES/);
  assert.match(src, /function tileCacheSet\(/);
  assert.match(src, /tileBytes \+= buf\.length/);
  // The old overflow behaviour discarded the whole cache at once. Checked
  // against code only — the comment above tileCacheSet names what it replaced.
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/tileCache\.clear\(\)/.test(code), "oldest-first eviction, not clear()");
  const writes = [...src.matchAll(/tileCache\.set\(/g)];
  assert.equal(writes.length, 1, "tileCache.set may only be called inside tileCacheSet");
});

test("the DOB workbook is fetched once at a time, not once per concurrent caller", () => {
  const src = read("server/adapters/dob-sustainability.js");
  assert.match(src, /let inFlight = null/);
  assert.match(src, /inFlight = buildWorkbook\(\)\.finally\(\(\) => \{ inFlight = null; \}\)/);
  // A failed build must not be cached: the next request retries.
  const load = src.slice(src.indexOf("async function loadWorkbook"));
  assert.match(load, /if \(cache && cache\.expires > Date\.now\(\)\) return cache\.value/);
  assert.match(load, /if \(inFlight\) return inFlight/);
});

test("XLSX parts inflate on demand, so the 201 MB sheet nothing reads is never expanded", () => {
  const src = read("server/adapters/dob-sustainability.js");
  // cbl26.xlsx central directory, measured 2026-08-18:
  //   xl/worksheets/sheet2.xml   201,157,429 bytes uncompressed
  //   xl/sharedStrings.xml         1,501,784 bytes
  //   xl/worksheets/sheet1.xml        10,785 bytes  <- the only sheet read
  const unzipBody = src.slice(src.indexOf("function unzip("), src.indexOf("function sharedStrings("));
  assert.match(unzipBody, /keys: \(\) => dir\.keys\(\)/);
  assert.match(unzipBody, /clear\(\) \{ dir\.clear\(\); source = null; \}/);
  // Exactly one inflate call, inside get(), reached only for a requested part.
  const inflates = [...unzipBody.matchAll(/inflateRawSync\(/g)];
  assert.equal(inflates.length, 1, "one on-demand inflate, not one per directory entry");
  const getBody = unzipBody.slice(unzipBody.indexOf("get(name)"));
  assert.ok(getBody.includes("inflateRawSync("), "the inflate lives in get()");
  // Unsupported compression still fails during the directory scan.
  assert.match(unzipBody, /Unsupported XLSX ZIP compression method/);
});
