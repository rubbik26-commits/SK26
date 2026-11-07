import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../public/assets/index-BbnE3o5g.js", import.meta.url), "utf8");
const routes = readFileSync(new URL("../server/routes.js", import.meta.url), "utf8");
const status = readFileSync(new URL("../server/production-status.js", import.meta.url), "utf8");
const cert = readFileSync(new URL("../.github/workflows/production-certification.yml", import.meta.url), "utf8");

test("the exact Owner bundle identifies the 2D map as Mapbox + OpenStreetMap", () => {
  assert.match(bundle, /Mapbox &copy; OpenStreetMap — parcels live from public records/);
  assert.match(bundle, /© Mapbox © CARTO © OpenStreetMap — parcels live from public records/);
  assert.match(bundle, /\/api\/mbtile\/streets\/\{z\}\/\{x\}\/\{y\}/);
  assert.match(bundle, /\/api\/mbtile\/nolabels\/\{z\}\/\{x\}\/\{y\}/);
  assert.match(bundle, /\/api\/mbtile\/labels\/\{z\}\/\{x\}\/\{y\}/);
});

test("the serving tile proxy selects the original Mapbox styles when the token exists", () => {
  assert.match(routes, /MAPBOX_TOKEN\s*=\s*process\.env\.MAPBOX_TOKEN\s*\|\|\s*process\.env\.MAPBOX_ACCESS_TOKEN/);
  for (const style of ["streets-v12", "light-v11", "dark-v11", "satellite-v9"]) {
    assert.match(routes, new RegExp(style.replace("-", "\\-")), `missing Mapbox style ${style}`);
  }
});

test("Owner release truth exposes Mapbox presence without exposing the token", () => {
  assert.match(status, /mapboxConfigured/);
  assert.match(status, /missing_mapbox_token/);
  assert.match(status, /mapbox:\s*mapboxConfigured/);
  assert.doesNotMatch(status, /MAPBOX_TOKEN\s*[,}]/, "status response must not serialize the credential");
});

test("Phase 20 requires Mapbox rather than certifying a fallback provider", () => {
  assert.match(cert, /streetview,photorealistic3d,mapbox,pinecone,serper,airtable,demographics/);
});
