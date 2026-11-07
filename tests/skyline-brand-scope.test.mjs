import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/css/skyline-brand.css", import.meta.url), "utf8");
const mobileCss = readFileSync(new URL("../public/css/mobile-parity.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("Skyline brand stylesheet contains no product-layout override", () => {
  for (const forbidden of [
    /@media\s*\(max-width/i,
    /@media\s*\(min-width/i,
    /overflow-x\s*:/i,
    /min-height\s*:/i,
    /min-width\s*:/i,
    /max-width\s*:/i,
    /padding-(?:left|right|block)\s*:/i,
    /margin-bottom\s*:/i,
    /touch-action\s*:/i,
    /display\s*:\s*inline-flex/i,
    /recharts-(?:surface|wrapper)[^{]*\{[^}]*overflow\s*:/is,
    /main\s+\[class\*="px-8"\]/i
  ]) {
    assert.doesNotMatch(css, forbidden, `branding CSS must not contain product geometry rule ${forbidden}`);
  }
});

test("Skyline brand stylesheet never removes or hides application elements", () => {
  assert.doesNotMatch(css, /display\s*:\s*none/i);
  assert.doesNotMatch(css, /visibility\s*:\s*hidden/i);
  assert.doesNotMatch(css, /pointer-events\s*:\s*none/i);
});

test("Owner usability corrections remain separate, bounded and loaded", () => {
  assert.match(html, /index-BbnE3o5g\.js/);
  assert.match(html, /index-shmfCHKD\.css/);
  assert.match(html, /\/css\/mobile-parity\.css/);
  assert.match(html, /\/js\/mobile-parity\.js/);
  assert.match(html, /\/js\/estimate-labels\.js/);
  assert.match(html, /\/css\/skyline-brand\.css/);
  assert.match(html, /\/js\/skyline-name\.js/);

  // These are the specific measured conveniences that were accidentally
  // removed from the served shell. Keep the assertions concrete so a future
  // "parity cleanup" cannot silently delete them again.
  assert.match(mobileCss, /flex-wrap:\s*wrap/i, "phone navigation must keep every destination on-screen");
  assert.match(mobileCss, /scroll-snap-type:\s*x\s+mandatory/i, "phone kanban must remain one-column-per-swipe");
  assert.match(mobileCss, /min-height:\s*40px/i, "phone controls keep the measured touch-height floor");
  assert.match(mobileCss, /font-size:\s*16px[\s\S]*min-width:\s*0/i,
    "phone inputs must avoid iOS focus zoom without forcing horizontal overflow");
  assert.match(mobileCss, /\.map-nta-chip[\s\S]*max-width:\s*46vw/i,
    "the two map hint chips must not overlap on a phone");
  assert.match(mobileCss, /\.recharts-yAxis[\s\S]*font-size:\s*9px/i,
    "measured long submarket axis labels must remain small enough not to clip or collide");
  assert.match(mobileCss, /\.recharts-surface[\s\S]*\.recharts-wrapper[\s\S]*overflow:\s*visible/i,
    "unbreakable chart labels must remain allowed to paint into card padding");
  assert.match(mobileCss, /main\s+\[class\*="px-8"\][\s\S]*padding-left:\s*1\.15rem[\s\S]*padding-right:\s*1\.15rem/i,
    "phone presentation cards must retain the measured side-padding correction");
});

test("the usability layer does not hide application controls", () => {
  assert.doesNotMatch(mobileCss, /display\s*:\s*none/i);
  assert.doesNotMatch(mobileCss, /visibility\s*:\s*hidden/i);
  assert.doesNotMatch(mobileCss, /pointer-events\s*:\s*none/i);
});
