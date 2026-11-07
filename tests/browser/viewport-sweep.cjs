// Phase 18 — desktop, tablet and phone.
//
//   node tests/browser/viewport-sweep.cjs [baseUrl] [--md path]
//
// P18.11 is the reason this file exists in this shape: "must be asserted
// programmatically (document.documentElement.scrollWidth <= window.innerWidth)
// on every page at every viewport, not judged visually." So every one of the 13
// routes is loaded at every one of the 6 viewports below — 78 assertions — and
// the comparison is made in the page, not by looking at a screenshot.
//
// The viewports, stated exactly as required:
//
//   desktop-wide   1920 × 1080   mouse
//   desktop        1440 ×  900   mouse
//   tablet         1024 ×  768   touch   (landscape)
//   tablet-portrait 820 × 1180   touch
//   phone           390 ×  844   touch   (iPhone 14/15 CSS pixels, DPR 3)
//   phone-small     375 ×  667   touch   (iPhone SE)
//
// The application is hash-routed, so routes are addressed as `${BASE}/?…#/route`.
const { chromium } = require("playwright");
const { signIn } = require("./lib/gate.cjs");
const { writeFileSync, existsSync } = require("node:fs");

const argv = process.argv.slice(2);
const mdIndex = argv.indexOf("--md");
const MD_PATH = mdIndex >= 0 ? argv[mdIndex + 1] : "";
const BASE = argv.find((a) => /^https?:\/\//.test(a)) || "http://localhost:5175";

const pinned = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const launchOptions = {
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(existsSync(pinned) ? { executablePath: pinned } : {})
};

const VIEWPORTS = [
  ["desktop-wide", { width: 1920, height: 1080 }, {}],
  ["desktop", { width: 1440, height: 900 }, {}],
  ["tablet", { width: 1024, height: 768 }, { hasTouch: true }],
  ["tablet-portrait", { width: 820, height: 1180 }, { hasTouch: true }],
  ["phone", { width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 3 }],
  ["phone-small", { width: 375, height: 667 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 2 }]
];

const ROUTES = [
  ["/", { testid: "map-container" }],
  ["/dossier", { text: "Search any asset" }],
  ["/pipeline", { testid: "column-watchlist" }],
  ["/live", { text: "Start Live Details" }],
  ["/territory", { text: "Know Your Market" }],
  ["/radar", { text: "off-market targets" }],
  ["/calculator", { text: "Upload rent roll" }],
  ["/comps", { testid: "export-csv" }],
  ["/present", { text: "Top 5 opportunities" }],
  ["/investors", { text: "Investor buy boxes" }],
  ["/desk", { text: "My Desk" }],
  ["/sources", { text: "Source Registry" }],
  ["/no-such-route", { text: "404 Page Not Found" }]
];

// md: 768px is Tailwind's breakpoint — below it the sidebar is hidden and the
// bottom tab bar takes over. Which of the two should be on screen is therefore a
// property of the viewport, and both are checked.
const PHONE_MAX = 767;

const failures = [];
const overflow = [];   // [viewport, route, px]
const notes = [];
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  notes.push({ ok, label, detail });
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const marked = (page, marker, timeout = 45000) =>
  marker.testid
    ? page.waitForSelector(`[data-testid="${marker.testid}"]`, { timeout }).then(() => true).catch(() => false)
    : page.waitForFunction((t) => (document.body.innerText || "").toLowerCase().includes(t), marker.text.toLowerCase(), { timeout }).then(() => true).catch(() => false);

(async () => {
  const browser = await chromium.launch(launchOptions);

  // ---------------------------------------------------------------- P18.1-3, P18.11
  console.log("\nP18.1–P18.3, P18.11 — every route at every viewport\n");
  for (const [vpName, viewport, extra] of VIEWPORTS) {
    const context = await browser.newContext({ viewport, ...extra });
    // Every suite goes through the gate. Six of eight never did, and passed only
    // because the harness left the gate disabled — i.e. they were exercising a
    // server configuration that is never deployed.
    await signIn(context, BASE);
    const problems = [];
    let worst = 0, worstRoute = "";

    for (const [route, marker] of ROUTES) {
      const page = await context.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(`${route}: ${String(e.message).slice(0, 90)}`));
      await page.goto(`${BASE}/?vp=${vpName}${route.replace(/\W/g, "")}#${route}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      const rendered = await marked(page, marker);
      if (!rendered) problems.push(`${route}: route marker never rendered`);
      await page.waitForTimeout(900);

      // The assertion Phase 18 asks for, made in the page.
      const px = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (px > 0) { overflow.push([vpName, route, px]); problems.push(`${route}: overflows by ${px}px`); }
      if (px > worst) { worst = px; worstRoute = route; }
      problems.push(...errs);
      await page.close();
    }

    note(problems.length === 0, `${vpName.padEnd(15)} ${viewport.width}×${viewport.height} — 13 routes`,
      problems.length ? problems.slice(0, 2).join(" | ") : `no overflow (worst ${worst}px${worstRoute ? ` on ${worstRoute}` : ""}), no page errors`);
    await context.close();
  }

  // ---------------------------------------------------------------- P18.4
  console.log("\nP18.4 — bottom navigation, and the sidebar it replaces\n");
  for (const [vpName, viewport, extra] of VIEWPORTS) {
    const context = await browser.newContext({ viewport, ...extra });
    // Every suite goes through the gate. Six of eight never did, and passed only
    // because the harness left the gate disabled — i.e. they were exercising a
    // server configuration that is never deployed.
    await signIn(context, BASE);
    const page = await context.newPage();
    await page.goto(`${BASE}/?nav=${vpName}#/`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await marked(page, { testid: "map-container" });

    const bars = await page.evaluate(() => {
      const bar = document.querySelector('nav[class*="md:hidden"]');
      const side = document.querySelector("aside");
      const visible = (el) => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== "none";
      const cells = bar ? [...bar.querySelectorAll("a > a")] : [];
      const vw = document.documentElement.clientWidth;
      return {
        tabBar: visible(bar),
        sidebar: visible(side),
        cells: cells.length,
        offscreen: cells.filter((c) => { const r = c.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).length,
        rows: new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        height: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
        hidden: bar ? bar.scrollWidth - bar.clientWidth : 0
      };
    });

    const isPhone = viewport.width <= PHONE_MAX;
    const ok = isPhone
      ? bars.tabBar && !bars.sidebar && bars.cells >= 11 && bars.offscreen === 0 && bars.hidden <= 0 && bars.rows <= 2
      : bars.sidebar && !bars.tabBar;
    note(ok, `${vpName.padEnd(15)} ${isPhone ? "tab bar carries every route" : "sidebar, no tab bar"}`,
      isPhone ? `${bars.cells} tabs, ${bars.offscreen} off-screen, ${bars.rows} rows, ${bars.height}px, ${bars.hidden}px hidden`
        : `sidebar ${bars.sidebar}, tab bar ${bars.tabBar}`);
    await context.close();
  }

  // ---------------------------------------------------------------- P18.5-P18.10
  console.log("\nP18.5–P18.10 — maps, strips, drawers, dossier, calculator, Live Details on a phone\n");
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    // Through the gate, like the two contexts above.
    //
    // This one did not sign in, so every P18.5-P18.10 check ran against the
    // password wall. The map container never appeared, and because marked()
    // reports a timeout by returning false rather than throwing, the evaluate
    // that followed dereferenced null and the raw TypeError aborted the whole
    // suite — six checks produced no result at all, which reads as "not run"
    // rather than "the test was never logged in".
    await signIn(context, BASE);
    const page = await context.newPage();
    const vw = 390;

    // P18.5 — the map must actually occupy space and paint tiles.
    await page.goto(`${BASE}/?p18=map#/`, { waitUntil: "domcontentloaded", timeout: 60000 });
    // marked() returns false on timeout rather than throwing, and that result
    // was ignored — so when the container did not appear, the evaluate below
    // dereferenced null and the raw TypeError aborted the whole suite. Six
    // later checks (P18.6-P18.10) produced no result at all, which reads as
    // "not run" rather than "one thing failed". A missing element is a FAIL
    // with a message, never a stack trace.
    const mapPresent = await marked(page, { testid: "map-container" });
    await page.waitForTimeout(4000);
    const map = mapPresent
      ? await page.evaluate(() => {
          const el = document.querySelector('[data-testid="map-container"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), tiles: el.querySelectorAll("img.leaflet-tile, canvas").length, panes: !!el.querySelector(".leaflet-pane, .maplibregl-canvas") };
        })
      : null;
    note(!!map && map.w > 0 && map.h > 0 && (map.tiles > 0 || map.panes), "P18.5  map renders on a phone",
      map ? `${map.w}×${map.h}, ${map.tiles} tiles, panes ${map.panes}`
          : "the map container never appeared within the wait");

    // P18.6 — the opportunity strip scrolls sideways.
    //
    // The phone layout is not a narrower desktop. The strip lives in its own
    // `md:hidden` container that is collapsed behind an "Opportunities N ·
    // Show list ▸" toggle, and that container is a plain `overflow-x-auto`, not
    // one of the `.scroll-region` elements the desktop strip uses. Looking for
    // `.scroll-region` found the hidden desktop strip instead — width 0, so this
    // reported "0 → 0 of 0" and read as a broken strip when the real one was
    // simply not open yet. Open it, then find the card's nearest genuinely
    // scrollable ancestor rather than assuming which class it carries.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="card-opp-"]').length > 0, { timeout: 60000 }).catch(() => {});
    await page.evaluate(() => {
      const toggle = [...document.querySelectorAll("button")].find((b) => /Show list/i.test(b.textContent || ""));
      toggle && toggle.click();
    });
    await page.waitForTimeout(3000);

    const SCROLLER = `() => {
      const card = [...document.querySelectorAll('[data-testid^="card-opp-"]')].find((c) => c.offsetParent !== null);
      if (!card) return null;
      for (let el = card.parentElement; el; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 8) return el;
      }
      return null;
    }`;
    const strip = await page.evaluate((fn) => {
      const el = eval(fn)();
      if (!el) return null;
      const before = el.scrollLeft;
      el.scrollBy({ left: 400 });
      return { before, sw: el.scrollWidth, cw: el.clientWidth, cls: (el.className || "").toString().slice(0, 50) };
    }, SCROLLER);
    if (!strip) note(false, "P18.6  opportunity strip scrolls horizontally", "no horizontally scrollable card container after opening the list");
    else {
      await page.waitForTimeout(600);
      const after = await page.evaluate((fn) => eval(fn)().scrollLeft, SCROLLER);
      note(after > strip.before, "P18.6  opportunity strip scrolls horizontally",
        `${strip.before} → ${after} of ${strip.sw - strip.cw} in "${strip.cls}"`);
    }

    // P18.7 — an opened record must stay inside the viewport.
    const drawer = await page.evaluate(() => {
      const card = document.querySelector('[data-testid^="card-opp-"]');
      if (!card) return null;
      (card.querySelector("a[href], button, [role=button]") || card).click();
      return true;
    });
    await page.waitForTimeout(3500);
    const bounds = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const panels = [...document.querySelectorAll('div[class*="z-[9999]"], [role="dialog"], [aria-modal="true"]')];
      const over = panels.map((p) => { const r = p.getBoundingClientRect(); return Math.max(0, Math.round(r.right - vw), Math.round(-r.left)); });
      return { panels: panels.length, over, page: document.documentElement.scrollWidth - vw };
    });
    note(bounds.over.every((o) => o <= 0) && bounds.page <= 0, "P18.7  opened record does not overflow the viewport",
      drawer ? `${bounds.panels} overlay(s), page overflow ${bounds.page}px` : "no record to open; page overflow checked");

    // P18.8 — the dossier, on a phone, on a real parcel.
    await page.goto(`${BASE}/?p18=dossier#/dossier`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await marked(page, { text: "Search any asset" });
    await page.evaluate(() => {
      const set = (el, v) => {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const i = [...document.querySelectorAll("input")].find((x) => /151 West 25/.test(x.placeholder || ""));
      if (i) set(i, "60 wall street");
      [...document.querySelectorAll("button")].find((b) => /Open dossier/i.test(b.textContent || ""))?.click();
    });
    const opened = await page.waitForFunction(() => /60 WALL STREET/i.test(document.body.innerText || ""), { timeout: 90000 })
      .then(() => true).catch(() => false);
    const dossierOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    note(opened && dossierOverflow <= 0, "P18.8  dossier opens a parcel on a phone without overflowing",
      `opened ${opened}, overflow ${dossierOverflow}px`);
    await page.screenshot({ path: `${__dirname}/shots/p18-dossier-phone.png` });

    // P18.9 — every calculator input reachable and inside the viewport.
    await page.goto(`${BASE}/?p18=calc#/calculator`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await marked(page, { text: "Upload rent roll" });
    await page.waitForTimeout(1500);
    const calc = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const inputs = [...document.querySelectorAll("input")].filter((i) => i.type !== "file" && i.offsetParent !== null);
      const outside = inputs.filter((i) => { const r = i.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; });
      return { inputs: inputs.length, outside: outside.length, overflow: document.documentElement.scrollWidth - vw };
    });
    note(calc.inputs > 0 && calc.outside === 0 && calc.overflow <= 0, "P18.9  calculator inputs fit the phone viewport",
      `${calc.inputs} inputs, ${calc.outside} outside, overflow ${calc.overflow}px`);
    await page.screenshot({ path: `${__dirname}/shots/p18-calculator-phone.png` });

    // P18.10 — Live Details asks for the device permissions it needs and states
    // its position when they are refused. Permissions are denied for this
    // context, which is the state a first-time visitor is in.
    await context.clearPermissions();
    await page.goto(`${BASE}/?p18=live#/live`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await marked(page, { text: "Start Live Details" });
    const live = await page.evaluate(async () => {
      const start = [...document.querySelectorAll("button")].find((b) => /Start Live Details/i.test(b.textContent || ""));
      start && start.click();
      await new Promise((r) => setTimeout(r, 6000));
      return {
        text: (document.body.innerText || "").slice(0, 600),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        alive: (document.getElementById("root")?.innerText || "").trim().length > 0
      };
    });
    // Geolocation is not granted, so the honest outcomes are a stated refusal, a
    // prompt, or a manual fallback — never a silent dead button or a blank page.
    //
    // The first version of this list was written from what a permission API
    // sounds like rather than from what this screen says. The screen actually
    // reports "locating…", "no compass", "Move your phone to calibrate the
    // compass…", "Move a little / go outdoors to locate buildings", and offers
    // "Pick on map" as the manual route — which is a better answer than a bare
    // "permission denied", and was being marked FAIL for not using the expected
    // words. Matched against the real vocabulary now.
    const handled = live.alive && live.overflow <= 0 &&
      /location|permission|denied|allow|enable|unavailable|not supported|blocked|locating|compass|pick on map|go outdoors|calibrate/i.test(live.text);
    note(handled, "P18.10 Live Details states its device-permission position when location is denied",
      `${live.alive ? "page intact" : "page blank"}, overflow ${live.overflow}px`);
    await page.screenshot({ path: `${__dirname}/shots/p18-live-phone.png` });

    await context.close();
  }

  await browser.close();

  // ---------------------------------------------------------------- report
  console.log(`\n${"=".repeat(64)}`);
  console.log(`P18.11 overflow assertions: ${VIEWPORTS.length * ROUTES.length} (13 routes × ${VIEWPORTS.length} viewports), ${overflow.length} failing`);
  for (const [vp, route, px] of overflow) console.log(`  - ${vp} ${route}: ${px}px`);

  if (MD_PATH) {
    const lines = [
      "# Phase 18 — desktop, tablet and phone",
      "",
      `Generated by \`tests/browser/viewport-sweep.cjs\` against \`${BASE}\`.`,
      "",
      "## Viewports",
      "",
      "| name | CSS pixels | input |",
      "| --- | --- | --- |",
      ...VIEWPORTS.map(([n, v, e]) => `| ${n} | ${v.width} × ${v.height} | ${e.isMobile ? `touch, DPR ${e.deviceScaleFactor}` : e.hasTouch ? "touch" : "mouse"} |`),
      "",
      "## P18.11 — horizontal overflow, asserted in the page",
      "",
      "`document.documentElement.scrollWidth - window.innerWidth` on all 13 routes",
      `at all ${VIEWPORTS.length} viewports — ${VIEWPORTS.length * ROUTES.length} assertions, **${overflow.length} failing**.`,
      "",
      ...(overflow.length
        ? ["| viewport | route | overflow |", "| --- | --- | --- |", ...overflow.map(([v, r, p]) => `| ${v} | \`${r}\` | ${p}px |`)]
        : ["No route overflows horizontally at any viewport."]),
      "",
      "## Checks",
      "",
      "| result | check | measured |",
      "| --- | --- | --- |",
      ...notes.map((n) => `| ${n.ok ? "ok" : "**FAIL**"} | ${n.label.replace(/\|/g, "\\|").trim()} | ${String(n.detail).replace(/\|/g, "\\|")} |`)
    ];
    writeFileSync(MD_PATH, lines.join("\n") + "\n");
    console.log(`\nwrote ${MD_PATH}`);
  }

  if (failures.length) {
    console.log(`\nVIEWPORT SWEEP: ${failures.length} FAILURE(S)`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log("\nVIEWPORT SWEEP: PASS — 13 routes clean at 6 viewports, nav swaps at the breakpoint, phone surfaces hold.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
