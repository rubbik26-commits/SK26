// Market Stadium shell layer — static contract.
// The bundle is checksum-pinned and immutable; the Market Stadium
// surface is a declared shell layer. These tests pin that contract
// without booting the server: the layer files exist, the shell loads
// each exactly once with a ?v= pin equal to the first 12 hex of the
// file's SHA-256, every load is declared in the active section of
// docs/SHELL-DIVERGENCE.md, no inline script sneaks behaviour in, the
// stylesheet stays scoped, no map library is fetched from a CDN, and
// the bundle bytes are still the pinned export.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const sha256 = (rel) => createHash("sha256").update(readFileSync(new URL(`../${rel}`, import.meta.url))).digest("hex");

const html = read("public/index.html");
const doc = read("docs/SHELL-DIVERGENCE.md");

const FILES = [
  "public/css/market-stadium.css",
  "public/js/market-stadium/ms-api.js",
  "public/js/market-stadium/ms-geocoder.js",
  "public/js/market-stadium/ms-map.js",
  "public/js/market-stadium/ms-panels.js",
  "public/js/market-stadium/ms-panels2.js",
  "public/js/market-stadium/ms-panels3.js",
  "public/js/market-stadium/ms-export.js",
  "public/js/market-stadium/ms-territory.js",
  "public/js/market-stadium/ms-dossier.js",
  "public/js/market-stadium/ms-comps.js",
  "public/js/market-stadium/market-stadium.js"
];
const servedPath = (rel) => `/${rel.replace(/^public\//, "")}`;

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("market-stadium layer files exist", () => {
  for (const rel of FILES) {
    assert.ok(existsSync(new URL(`../${rel}`, import.meta.url)), `${rel} must exist`);
  }
});

test("shell loads each market-stadium file once with a pin equal to its content hash", () => {
  for (const rel of FILES) {
    const pin = sha256(rel).slice(0, 12);
    const tag = `${servedPath(rel)}?v=${pin}`;
    assert.equal(count(html, tag), 1, `${tag} must be loaded exactly once with its content-hash pin`);
  }
});

test("every market-stadium load is declared in the active section of SHELL-DIVERGENCE.md", () => {
  const removedAt = doc.search(/^## Removed divergences$/m);
  const activeDoc = removedAt >= 0 ? doc.slice(0, removedAt) : doc;
  const removedDoc = removedAt >= 0 ? doc.slice(removedAt) : "";
  for (const rel of FILES) {
    const pin = sha256(rel).slice(0, 12);
    const name = `${servedPath(rel).slice(1)}?v=${pin}`;
    assert.ok(activeDoc.includes(name), `${name} must be declared (with its pin) in docs/SHELL-DIVERGENCE.md`);
    assert.ok(!removedDoc.includes(servedPath(rel).slice(1)),
      `${servedPath(rel)} must not be listed under Removed divergences while the shell loads it`);
  }
  // The declaration sits in the Behavioural section, like the other
  // behaviour-changing layers (buyer-intelligence, climate-risk).
  const behavioural = doc.slice(doc.indexOf("## Behavioural"), doc.indexOf("## Functional"));
  assert.ok(behavioural.includes("js/market-stadium/market-stadium.js"),
    "the market-stadium declaration must live in the Behavioural section");
});

test("shell gains no inline script from the market-stadium layer", () => {
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  assert.deepEqual(inlineScripts, []);
});

test("market-stadium stylesheet is scoped and map code uses the vendored library only", () => {
  const css = read("public/css/market-stadium.css");
  assert.ok(css.includes(".lucia-market-stadium"), "every market-stadium selector is scoped under .lucia-market-stadium");
  assert.ok(css.includes("@media print"), "the CAP-04 print rules live in the stylesheet, not an injected <style>");
  for (const rel of FILES.filter((f) => f.endsWith(".js"))) {
    const src = read(rel);
    assert.ok(!/https?:\/\/[^"'\s]*(maplibre|leaflet|openlayers|mapbox)/i.test(src),
      `${rel} must not fetch a map library from a CDN`);
  }
  const map = read("public/js/market-stadium/ms-map.js");
  assert.ok(map.includes("/vendor/maplibre/maplibre-gl.js"), "ms-map.js loads the vendored MapLibre build");
});

test("the pinned bundle is byte-identical to the recorded export", () => {
  assert.equal(sha256("public/assets/index-BbnE3o5g.js"),
    "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8",
    "bundle JS must remain the pinned export — the market-stadium layer never edits it");
  assert.equal(sha256("public/assets/index-shmfCHKD.css"),
    "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b",
    "bundle CSS must remain the pinned export");
});
