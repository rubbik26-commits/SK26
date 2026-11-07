// Parity suite — route identity, navigation, scroll regions and the phone
// layout, driven against the shipped production bundle.
//
//   node tests/browser/parity-browser.cjs [baseUrl]
//
// This suite used to drive #opp-cards / .hpaddle / #dk / #cc-om — DOM ids from
// the earlier hand-rebuilt UI. None of them appears in site/assets/
// index-BbnE3o5g.js, so it could not pass against the application as it ships
// and was carried as "stale". It is rewritten here against the bundle's own
// selectors: the data-testid attributes it actually emits (nav-*, map-container,
// column-*, pcard-*, move-fwd-*, export-csv, …) and its own visible copy.
//
// One thing to know before reading the checks: **the application is
// hash-routed.** Loading `${BASE}/pipeline` does not open Pipeline — the router
// normalises the empty hash to `#/` and renders Market Intel, leaving the URL
// at `/pipeline#/`. Every route must therefore be addressed as `${BASE}/#/…`.
// Section 1 exists precisely because a suite that gets this wrong still sees
// twelve pages mount successfully and reports twelve passing routes.
const { chromium } = require("playwright");
const { signIn } = require("./lib/gate.cjs");
const { createHash } = require("node:crypto");

const BASE = process.argv[2] || "http://localhost:5175";
const SHOTS = __dirname + "/shots";

// The development image ships Chromium at a fixed path; a CI runner uses
// Playwright's own download. Use the pinned binary only when it is really
// there, so the same suite runs in both places.
const pinned = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const launchOptions = {
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(require("node:fs").existsSync(pinned) ? { executablePath: pinned } : {})
};

// Each route is identified by copy or a testid that only that route renders.
// `nav` is the sidebar data-testid the bundle derives from the label
// (`label.toLowerCase().replace(/[^a-z]+/g,"-")`).
const ROUTES = [
  ["/", "Market Intel", "nav-market-intel", { testid: "map-container" }],
  ["/dossier", "Parcel Dossier", "nav-parcel-dossier", { text: "Search any asset" }],
  ["/pipeline", "Pipeline / CRM", "nav-pipeline-crm", { testid: "column-watchlist" }],
  ["/live", "Live Details", "nav-live-details", { text: "Start Live Details" }],
  ["/territory", "Territory Mastery", "nav-territory-mastery", { text: "Know Your Market" }],
  ["/radar", "Deal Radar", "nav-deal-radar", { text: "off-market targets" }],
  ["/calculator", "Deal Calculator", "nav-deal-calculator", { text: "Upload rent roll" }],
  ["/comps", "Comps / Land Index", "nav-comps-land-index", { testid: "export-csv" }],
  ["/present", "Presentation Mode", "nav-presentation-mode", { text: "Top 5 opportunities" }],
  ["/investors", "Investors", "nav-investors", { text: "Investor buy boxes" }],
  ["/desk", "My Desk", null, { text: "My Desk" }],
  ["/sources", "Source Registry", "nav-source-registry", { text: "Source Registry" }],
  ["/no-such-route", "404", null, { text: "404 Page Not Found" }]
];

const EXTERNAL = /^https?:\/\/(fonts\.|api\.fontshare\.com|unpkg\.com|cdn\.)/;

const failures = [];
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// Hash-only URL changes do not reload the document, so every navigation carries
// a fresh query string to force a clean boot of the route under test.
const url = (route, i) => `${BASE}/?parity=${i}#${route}`;

// React commits the route asynchronously; wait for the marker rather than for a
// fixed interval, so a slow page fails on its own merits and a fast one does
// not cost 10s.
//
// Text markers are matched case-insensitively on purpose. Chrome's innerText
// returns *rendered* text, so a heading carrying `text-transform: uppercase` —
// several of these pages do — reads back as "TOP 5 OPPORTUNITIES" and an exact
// match on the source copy silently never fires.
const waitForMarker = (page, marker, timeout = 45000) =>
  marker.testid
    ? page.waitForSelector(`[data-testid="${marker.testid}"]`, { timeout }).then(() => true).catch(() => false)
    : page.waitForFunction((t) => (document.body.innerText || "").toLowerCase().includes(t), marker.text.toLowerCase(), { timeout }).then(() => true).catch(() => false);

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Every suite goes through the gate. Six of eight never did, and passed
  // only because the harness left the gate disabled — i.e. they were testing
  // a server configuration that is never deployed.
  await signIn(context, BASE);

  console.log("\n1. Route identity (hash router)\n");
  const fingerprints = new Map();
  for (let i = 0; i < ROUTES.length; i++) {
    const [route, label, , marker] = ROUTES[i];
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${String(e.message).slice(0, 140)}`));
    page.on("console", (m) => {
      if (m.type() !== "error" || /^Failed to load resource/.test(m.text())) return;
      problems.push(`console: ${m.text().slice(0, 140)}`);
    });
    page.on("requestfailed", (r) => {
      if (EXTERNAL.test(r.url())) return;
      problems.push(`requestfailed: ${r.url().slice(0, 100)}`);
    });

    await page.goto(url(route, i), { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => problems.push(`navigation: ${e.message.slice(0, 120)}`));
    const rendered = await waitForMarker(page, marker);
    if (!rendered) problems.push(`route marker not rendered (${marker.testid ? `[data-testid=${marker.testid}]` : `"${marker.text}"`})`);

    const text = await page.evaluate(() => document.body.innerText || "");
    fingerprints.set(route, createHash("sha256").update(text).digest("hex").slice(0, 12));

    note(problems.length === 0, `${route.padEnd(16)} ${label}`, problems.slice(0, 2).join(" | "));
    await page.close();
  }

  // A hash-routed app served through an SPA fallback will happily render the
  // same page for every URL. Distinct fingerprints are what proves the routes
  // are really distinct pages and not one page loaded thirteen times.
  const distinct = new Set(fingerprints.values());
  note(distinct.size === ROUTES.length, "every route renders distinct content",
    `${distinct.size}/${ROUTES.length} distinct fingerprints`);
  if (distinct.size !== ROUTES.length) {
    const byPrint = new Map();
    for (const [r, f] of fingerprints) byPrint.set(f, [...(byPrint.get(f) || []), r]);
    for (const [f, rs] of byPrint) if (rs.length > 1) console.log(`        collision ${f}: ${rs.join(", ")}`);
  }

  console.log("\n2. Sidebar navigation actually navigates\n");
  {
    const page = await context.newPage();
    await page.goto(url("/", "nav"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForMarker(page, { testid: "map-container" });

    const expected = ROUTES.map(([, , nav]) => nav).filter(Boolean);
    // The owner nav group (nav-investors, nav-source-registry) mounts a beat
    // after map-container, so reading the sidebar the instant the map marker
    // appears raced the last two items in. Wait for each expected nav item to
    // hydrate before asserting; an item that never arrives still fails, so this
    // removes the race without weakening the check (verified 2026-08-18: all 11
    // items render; the earlier miss was a read-timing artifact).
    await Promise.all(expected.map((t) =>
      page.waitForSelector(`aside [data-testid="${t}"]`, { timeout: 20000 }).catch(() => {})));
    const present = await page.evaluate(() =>
      [...document.querySelectorAll('aside [data-testid^="nav-"]')].map((n) => n.getAttribute("data-testid")));
    const missing = expected.filter((t) => !present.includes(t));
    note(missing.length === 0, "sidebar exposes a nav item for every public route",
      missing.length ? `missing ${missing.join(", ")}` : `${present.length} items`);

    // Clicking a link has to change the route, not merely the URL.
    for (const [route, label, nav, marker] of ROUTES) {
      if (!nav || route === "/") continue;
      await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), nav);
      const arrived = await waitForMarker(page, marker, 30000);
      const hash = await page.evaluate(() => location.hash);
      note(arrived && hash === `#${route}`, `click ${nav} → ${label}`, `hash ${hash || "(none)"}`);
      await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), "nav-market-intel");
      await waitForMarker(page, { testid: "map-container" }, 30000);
    }
    await page.close();
  }

  console.log("\n3. Scroll regions (desktop)\n");
  {
    const page = await context.newPage();
    await page.goto(url("/", "scroll"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForMarker(page, { testid: "map-container" });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid^="card-opp-"]').length > 0, { timeout: 60000 }).catch(() => {});

    const strip = await page.evaluate(() => {
      const card = document.querySelector('[data-testid^="card-opp-"]');
      const el = card && card.closest(".scroll-region");
      if (!el) return null;
      const before = el.scrollLeft;
      el.scrollBy({ left: 600 });
      return { cards: document.querySelectorAll('[data-testid^="card-opp-"]').length, overflows: el.scrollWidth > el.clientWidth, before, sw: el.scrollWidth, cw: el.clientWidth };
    });
    if (!strip) {
      note(false, "opportunity strip found", "no card-opp-* inside a .scroll-region");
    } else {
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => document.querySelector('[data-testid^="card-opp-"]').closest(".scroll-region").scrollLeft);
      note(strip.overflows && after > strip.before, "opportunity strip scrolls horizontally",
        `${strip.cards} cards, ${strip.before} → ${after} of ${strip.sw - strip.cw}`);
    }

    // The body itself must never scroll sideways — that was the defect behind
    // the original horizontal-overflow report.
    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note(bodyOverflow <= 0, "desktop body does not scroll horizontally", `overflow ${bodyOverflow}px`);
    await page.screenshot({ path: `${SHOTS}/parity-market-intel.png` });

    await page.goto(url("/pipeline", "scroll2"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForMarker(page, { testid: "column-watchlist" });
    const kanban = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="column-watchlist"]').closest(".scroll-region");
      return { columns: document.querySelectorAll('[data-testid^="column-"]').length, cards: document.querySelectorAll('[data-testid^="pcard-"]').length, sw: el.scrollWidth, cw: el.clientWidth };
    });
    note(kanban.columns === 6 && kanban.cards > 0, "kanban renders six stages with cards",
      `${kanban.columns} columns, ${kanban.cards} cards`);
    await page.close();
  }

  console.log("\n4. Phone layout (390×844)\n");
  {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  // Every suite goes through the gate. Six of eight never did, and passed
  // only because the harness left the gate disabled — i.e. they were testing
  // a server configuration that is never deployed.
  await signIn(mctx, BASE);
    const mp = await mctx.newPage();
    const merrors = [];
    mp.on("pageerror", (e) => merrors.push(String(e.message).slice(0, 140)));
    await mp.goto(url("/", "m1"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForMarker(mp, { testid: "map-container" });

    // The bar the original report called "where is the menu": every tab has to
    // be on screen at once, wrapped rather than scrolled off the right edge.
    const nav = await mp.evaluate(() => {
      const bar = document.querySelector('nav[class*="md:hidden"]');
      if (!bar) return null;
      const cells = [...bar.querySelectorAll("a > a")];
      const vw = document.documentElement.clientWidth;
      return {
        height: Math.round(bar.getBoundingClientRect().height),
        cells: cells.length,
        rows: new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        offscreen: cells.filter((c) => { const r = c.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).length,
        clipped: cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length,
        hidden: bar.scrollWidth - bar.clientWidth,
        labels: cells.map((c) => (c.textContent || "").trim())
      };
    });
    if (!nav) {
      note(false, "phone tab bar present", "nav[class*=md:hidden] not found");
    } else {
      note(nav.cells >= 11 && nav.offscreen === 0 && nav.hidden <= 0,
        "every tab is on screen (no horizontal hiding)", `${nav.cells} tabs, ${nav.offscreen} off-screen, ${nav.hidden}px hidden`);
      note(nav.rows <= 2, "tab bar wraps to at most two rows", `${nav.rows} rows: ${nav.labels.join("/")}`);
      note(nav.height <= 96, "tab bar stays within its height budget", `${nav.height}px`);
      note(nav.clipped === 0, "no tab label is clipped", `${nav.clipped} clipped`);
    }

    const mOverflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note(mOverflow <= 0, "phone body does not scroll horizontally", `overflow ${mOverflow}px`);
    await mp.screenshot({ path: `${SHOTS}/parity-mobile-market-intel.png` });

    // Pipeline / CRM on a phone — the second screenshot complaint. A 244px
    // column on a 390px viewport leaves the board unusable; mobile-parity.css
    // widens it to the viewport with scroll-snap.
    await mp.goto(url("/pipeline", "m2"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForMarker(mp, { testid: "column-watchlist" });
    const col = await mp.evaluate(() => {
      const c = document.querySelector('[data-testid="column-watchlist"]');
      const vw = document.documentElement.clientWidth;
      return { width: Math.round(c.getBoundingClientRect().width), vw, snap: getComputedStyle(c).scrollSnapAlign };
    });
    note(col.width > 244 && col.width <= col.vw, "kanban column is sized for the phone viewport",
      `${col.width}px of ${col.vw}px, snap ${col.snap}`);
    await mp.screenshot({ path: `${SHOTS}/parity-mobile-pipeline.png` });

    // Deal Radar on a phone — the first complaint was that search did nothing.
    await mp.goto(url("/radar", "m3"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForMarker(mp, { text: "off-market targets" });
    const radar = await mp.evaluate(() => {
      const input = [...document.querySelectorAll("input")].find((i) => /neighborhood or zip/i.test(i.placeholder || ""));
      if (!input) return null;
      const r = input.getBoundingClientRect();
      const btn = [...document.querySelectorAll("button")].find((b) => /Scan area/i.test(b.textContent || ""));
      const br = btn && btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return { inputVisible: r.width > 0 && r.right <= vw + 1, buttonVisible: !!br && br.width > 0 && br.right <= vw + 1, disabled: btn ? btn.disabled : null };
    });
    note(radar && radar.inputVisible && radar.buttonVisible, "Deal Radar search control is usable on a phone",
      radar ? `input ${radar.inputVisible}, Scan area ${radar.buttonVisible}, disabled ${radar.disabled}` : "search input not found");
    await mp.screenshot({ path: `${SHOTS}/parity-mobile-radar.png` });

    note(merrors.length === 0, "phone session raised no page errors", merrors.slice(0, 2).join(" | "));
    await mp.close();
    await mctx.close();
  }

  await browser.close();

  console.log(`\n${"=".repeat(64)}`);
  if (failures.length) {
    console.log(`PARITY: ${failures.length} FAILURE(S)`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log("PARITY: PASS — routes distinct, nav navigates, strips scroll, phone layout holds.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
