import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function count(needle) {
  return html.split(needle).length - 1;
}

test("Owner shell loads the exact production application assets once", () => {
  assert.equal(count("./assets/index-BbnE3o5g.js"), 1);
  assert.equal(count("./assets/index-shmfCHKD.css"), 1);
});

test("Owner shell keeps hosting bridges, preserved conveniences and Skyline branding around the exact bundle", () => {
  for (const required of [
    "/js/supabase-env.js",
    "/js/production-auth-bridge.js",
    "/js/vendor-local.js",
    "/js/pdf-local.js",
    "/css/mobile-parity.css",
    "/js/mobile-parity.js",
    "/js/estimate-labels.js",
    "/css/skyline-brand.css",
    "/js/skyline-name.js"
  ]) {
    assert.equal(count(required), 1, `${required} must be loaded exactly once`);
  }

  // Device diagnostics were useful during reconstruction but are not a product
  // convenience and do not belong in the final Owner shell.
  assert.equal(count("/api/client-diag"), 0, "/api/client-diag must not be injected into the final shell");
});

test("responsive corrections load after the exact stylesheet and before branding", () => {
  const exact = html.indexOf("./assets/index-shmfCHKD.css");
  const mobile = html.indexOf("/css/mobile-parity.css");
  const brand = html.indexOf("/css/skyline-brand.css");
  assert.ok(exact >= 0 && mobile > exact && brand > mobile,
    "the exact app must paint first, bounded usability corrections second, Skyline visual branding last");
});

test("Owner shell contains no extra inline application behavior", () => {
  // External compatibility, usability/disclosure and branding scripts are
  // explicit above. No anonymous inline script is allowed to mutate the app.
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  assert.deepEqual(inlineScripts, []);
});
