import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";

const source = readFileSync(new URL("../public/js/skyline-name.js", import.meta.url), "utf8");

function run(initialValue) {
  const values = new Map();
  if (initialValue !== undefined) values.set("ndi_user", initialValue);

  const context = createContext({
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); }
    },
    document: {
      readyState: "complete",
      body: {},
      createTreeWalker() { return { nextNode() { return null; } }; }
    },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    MutationObserver: class { observe() {} },
    requestAnimationFrame(fn) { fn(); }
  });

  new Script(source, { filename: "skyline-name.js" }).runInContext(context);
  return values.get("ndi_user");
}

test("ownership shell seeds Robert Khodadadian on a fresh browser", () => {
  assert.equal(run(undefined), "Robert Khodadadian");
});

test("ownership shell replaces only the compiled legacy report author", () => {
  assert.equal(run("William Lockley"), "Robert Khodadadian");
});

test("ownership shell preserves a user-edited or signed-in profile name", () => {
  assert.equal(run("Lucia de Santa Ana"), "Lucia de Santa Ana");
});
