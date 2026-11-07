import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("zip-at owner mounts before compatibility point lookups", () => {
  const server = read("server.js");
  const exact = server.indexOf("app.use(productionZipAt)");
  const liveExtra = server.indexOf("app.use(productionLiveExtra)");
  const parity = server.indexOf("app.use(parityRoutes)");
  assert.ok(exact > 0 && exact < liveExtra && exact < parity);
});

test("zip-at resolves DOF polygon containment and never chooses nearest centroid", () => {
  const src = read("server/production-zip-at.js");
  assert.match(src, /intersects\(the_geom/);
  assert.match(src, /plutoByBbl/);
  assert.ok(!/plutoBbox|Math\.hypot|nearest/i.test(src.replace(/No neighboring parcel was chosen by centroid distance\./, "")));
});

test("a shared polygon boundary is explicit ambiguity, not an arbitrary neighbor", () => {
  const src = read("server/production-zip-at.js");
  assert.match(src, /bbls\.length > 1/);
  assert.match(src, /status\(409\)/);
  assert.match(src, /ambiguous_lot_boundary/);
});
