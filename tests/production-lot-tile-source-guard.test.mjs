import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("lot-tile source guard mounts before the exact parity projector", () => {
  const server = read("server.js");
  const guard = server.indexOf("app.use(productionLotTileSourceGuard)");
  const parity = server.indexOf("app.use(parityRoutes)");
  assert.ok(guard > 0 && parity > guard);
});

// The guard now proves the universe the tile handler actually reads. It used to
// count the DOF Digital Tax Map plus PLUTO; the handler reads the City's own
// MapPLUTO ArcGIS service, which is the source the original names in its
// x-lot-source header, so the old pair proved a source no longer served.
// Measured against the original: /api/lot-tiles/16/19298/24633 -> 238 features
// and /api/lot-tiles/15/9649/12316 -> 980, both now identical in the rebuild.
test("guard proves the MapPLUTO universe the tile handler reads fits its paging envelope", () => {
  const src = read("server/production-lot-tile-source-guard.js");
  assert.match(src, /MAPPLUTO_QUERY/);
  assert.match(src, /returnCountOnly/);
  // Same predicate the handler fetches with, or the count proves the wrong
  // thing: contains returns 177 lots for a tile that intersects 238.
  assert.match(src, /esriSpatialRelIntersects/);
  assert.match(src, /HANDLER_LIMIT = 20000/);
  assert.match(src, /count > HANDLER_LIMIT/);
});

test("dense or unverifiable tiles fail instead of returning clipped GeoJSON", () => {
  const src = read("server/production-lot-tile-source-guard.js");
  assert.match(src, /lot_tile_source_unavailable/);
  assert.match(src, /lot_tile_too_dense/);
  assert.match(src, /status\(503\)/);
});

test("successful tiles still fall through to the existing exact projector", () => {
  const src = read("server/production-lot-tile-source-guard.js");
  assert.match(src, /return next\(\)/);
  const parity = read("server/parity-routes.js");
  assert.match(parity, /router\.get\("\/api\/lot-tiles\/:z\/:x\/:y"/);
  assert.match(parity, /type: "FeatureCollection"/);
});
