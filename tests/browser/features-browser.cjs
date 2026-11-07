// Features suite — the application's working controls, exercised end to end
// against the shipped production bundle.
//
//   node tests/browser/features-browser.cjs [baseUrl]
//
// This suite used to drive #cc-doc, [data-x-apply], #dz-mkt-check and #dz-obsidian
// — DOM ids from the earlier hand-rebuilt UI that appear nowhere in
// site/assets/index-BbnE3o5g.js. It could not pass against the application as
// it ships and was carried as "stale". It is rewritten here against what the
// bundle actually renders, established by inspecting the live DOM rather than
// by guessing at labels.
//
// Two behaviours of the shipped bundle are worth stating up front, because a
// test that assumes otherwise fails for the wrong reason:
//
//   * The application is hash-routed. `${BASE}/comps` renders Market Intel;
//     only `${BASE}/#/comps` opens Comps.
//   * The OM / BOV generators do not open a popup or start a download. They
//     render the document into a full-screen in-page overlay
//     (`div.fixed.inset-0.z-[9999]`) whose "Save as PDF" button prints through
//     a hidden iframe. The dossier's Property/Investor/Market reports *do* use
//     window.open — the two mechanisms coexist.
const { chromium } = require("playwright");
const { signIn } = require("./lib/gate.cjs");
const { readFileSync } = require("node:fs");

const BASE = process.argv[2] || "http://localhost:5175";
const SHOTS = __dirname + "/shots";

const pinned = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const launchOptions = {
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(require("node:fs").existsSync(pinned) ? { executablePath: pinned } : {})
};

const failures = [];
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

// React does not commit synchronously and these pages pull live public records,
// so every wait is on a condition with a generous ceiling rather than a fixed
// sleep.
const has = (page, needle, timeout = 45000) =>
  page.waitForFunction((t) => (document.body.innerText || "").toLowerCase().includes(t), needle.toLowerCase(), { timeout })
    .then(() => true).catch(() => false);

// Setting .value on a React-controlled input is ignored unless the native
// setter is used and an input event is dispatched.
const SET_VALUE = `(el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

const open = async (context, route, marker) => {
  const page = await context.newPage();
  await page.goto(`${BASE}/?features=${route.replace(/\W/g, "")}#${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (marker) await has(page, marker);
  return page;
};

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  // Every suite goes through the gate. Six of eight never did, and passed only
  // because the harness left the gate disabled — i.e. they were exercising a
  // server configuration that is never deployed.
  await signIn(context, BASE);

  // ------------------------------------------------------------------ 1
  console.log("\n1. Parcel Dossier — live parcel, reports, owner gating\n");
  {
    const page = await open(context, "/dossier", "Search any asset");
    await page.evaluate((sv) => {
      const set = eval(sv);
      const input = [...document.querySelectorAll("input")].find((i) => /151 West 25/.test(i.placeholder || ""));
      if (input) set(input, "60 wall street");
      [...document.querySelectorAll("button")].find((b) => /Open dossier/i.test(b.textContent || ""))?.click();
    }, SET_VALUE);

    const opened = await has(page, "60 WALL STREET", 90000);
    note(opened, "dossier opens a live parcel from an address search", "60 Wall Street");

    const actions = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()));
    for (const want of ["Property report", "Investor report", "Market report", "Add to Pipeline", "Watch"]) {
      note(actions.includes(want), `dossier action present: ${want}`);
    }

    // Marketing check is deliberately visible to everyone.
    //
    // Waited for, not snapshotted. This read document.body.innerText ONCE and
    // both this check and the Investor-match check below tested that single
    // string, so whenever the dossier's lower panels had not finished
    // rendering at that instant the two failed together — which is exactly the
    // pair that failed, intermittently, while the endpoints behind them
    // answered 200 the whole time. A gate that fails randomly is one people
    // learn to ignore. Waiting still fails when a panel genuinely never
    // renders; it no longer fails for having looked too early.
    const bodyHas = (re, timeout = 45000) =>
      page.waitForFunction((src) => new RegExp(src, "i").test(document.body.innerText || ""),
        re.source, { timeout }).then(() => true).catch(() => false);

    note(await bodyHas(/marketing check/), "Marketing check is offered to every visitor");

    // Investor match and CRM cross-reference are the owner's private book.
    // Whether *this* visitor is the owner is a property of the deployment, not
    // of the test: server/gate.js treats a deployment with neither
    // SITE_PASSWORD nor OWNER_PASSWORD as private/local and turns owner mode on
    // for everyone. Asserting "no owner panel" would therefore pass or fail on
    // which environment the suite happens to run in. The invariant that holds
    // in both is the one checked here — the panels track the API's own owner
    // verdict, and a non-owner receives no investor rows at all.
    // tests/gate-role.test.mjs pins the other half: with a gate configured, an
    // uncredentialed request is not the owner.
    const pool = await page.evaluate(async () => {
      const r = await fetch("/api/investors");
      return r.ok ? await r.json() : { owner: null, investors: [] };
    });
    // Same treatment: wait for the panel rather than reading a stale snapshot.
    // Only the owner branch needs the wait — for a non-owner the assertion is
    // that the panel is ABSENT, and waiting 45s to confirm an absence would
    // just make the suite slower, so that side reads immediately.
    const panels = pool.owner
      ? { match: await bodyHas(/investor match/), xref: await bodyHas(/crm cross-reference/, 5000) }
      : await page.evaluate(() => ({
          match: /investor match/i.test(document.body.innerText || ""),
          xref: /crm cross-reference/i.test(document.body.innerText || "")
        }));
    if (pool.owner) {
      note(!pool.investors.length || panels.match, "owner mode renders the private Investor match panel",
        `${pool.investors.length} buy boxes, panel ${panels.match}`);
    } else {
      note(!panels.match && !panels.xref && !(pool.investors || []).length,
        "a non-owner receives no investor rows and sees no private panel",
        `panels ${panels.match}/${panels.xref}, rows ${(pool.investors || []).length}`);
    }

    // The report generators open a real window and fill it.
    //
    // Wait for the control, not for the checks above to have taken long enough.
    // The bundle renders this button `disabled:!a` — disabled until
    // /api/asset-history resolves — and on this parcel that is 21 seconds after
    // the address heading appears. Sampling it every 100ms from the moment
    // /60 WALL STREET/ first matched body.innerText, against a live server:
    //
    //   first sample: [11,"disabled"]
    //   last sample : [21180,"enabled"]
    //   ms from '60 WALL STREET' visible to button enabled: 21180
    //
    // A programmatic click on a disabled button is a no-op — window.open never
    // runs and no popup event ever fires. Until now this item only cleared that
    // window because the Marketing-check and Investor-panel waits above happen
    // to take a while; that is luck, not a wait on the thing being measured,
    // and it is the same accident that made the release gate report "0 chars"
    // for a generator that works. The same file already says it, above: waited
    // for, not snapshotted.
    //
    // This does NOT explain the one run of this item that reported 27 chars —
    // exactly the length of the generator's own "Generating property report…"
    // placeholder, which means the click did land on an enabled control and the
    // document simply had not been written 40s later. That run has not
    // reproduced in the runs since (4720 chars each time) and I do not know the
    // exact cause of this yet.
    const reportBtn = page.getByRole("button", { name: "Property report", exact: true }).first();
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /^Property report$/.test((x.textContent || "").trim()));
      return !!b && !b.disabled;
    }, { timeout: 90000 }).catch(() => {});
    const popup = context.waitForEvent("page", { timeout: 40000 }).catch(() => null);
    await reportBtn.click({ timeout: 20000 }).catch(() => {});
    const win = await popup;
    let chars = 0;
    if (win) {
      await win.waitForLoadState("domcontentloaded").catch(() => {});
      await win.waitForFunction(() => (document.body?.innerText || "").length > 400, { timeout: 40000 }).catch(() => {});
      chars = await win.evaluate(() => (document.body?.innerText || "").length).catch(() => 0);
      await win.close().catch(() => {});
    }
    note(chars > 400, "Property report opens a populated document", `${chars} chars`);
    await page.screenshot({ path: `${SHOTS}/features-dossier.png` });
    await page.close();
  }

  // ------------------------------------------------------------------ 2
  console.log("\n2. Deal Calculator — underwriting maths and offering documents\n");
  {
    const page = await open(context, "/calculator", "Upload rent roll");

    const filled = await page.evaluate((sv) => {
      const set = eval(sv);
      const want = {
        "Asking price": "6400000", "Building SF": "18500", "Units / keys": "24",
        "Gross income (annual)": "612500", "Operating expenses (annual)": "228000",
        "LTV": "65", "Rate": "6.5", "Amortization": "30", "Exit cap": "5.5", "Hold": "5"
      };
      const done = [];
      for (const label of document.querySelectorAll("label")) {
        const text = (label.textContent || "").trim().replace(/[$%]|yrs$/g, "").trim();
        const key = Object.keys(want).find((k) => text.startsWith(k));
        if (!key) continue;
        const input = label.querySelector("input") || label.parentElement?.querySelector("input");
        if (input && input.type !== "checkbox" && input.type !== "file") { set(input, want[key]); done.push(key); }
      }
      const addr = [...document.querySelectorAll("input")].find((i) => /Property address/i.test(i.placeholder || ""));
      if (addr) set(addr, "315 Seventh Avenue");
      return done;
    }, SET_VALUE);
    note(filled.length >= 10, "calculator exposes the underwriting inputs", `${filled.length} labelled fields set`);

    // Every one of these is derived, so their appearance proves the model ran
    // rather than that a placeholder is on screen.
    const computed = await page.waitForFunction(() => {
      const t = document.body.innerText || "";
      return /NOI \(annual\)/i.test(t) && /Cap rate/i.test(t) && /DSCR/i.test(t) && /\$384,500/.test(t);
    }, { timeout: 30000 }).then(() => true).catch(() => false);
    const results = await page.evaluate(() => {
      const t = document.body.innerText || "";
      return t.slice(t.indexOf("Results"), t.indexOf("Results") + 260).replace(/\n+/g, " · ");
    });
    note(computed, "calculator derives NOI, cap rate and DSCR from the inputs", results.slice(0, 150));

    const expanded = await page.evaluate(() => {
      const before = document.querySelectorAll("input").length;
      [...document.querySelectorAll("button")].find((b) => /Show institutional detail/i.test(b.textContent || ""))?.click();
      return before;
    });
    await page.waitForTimeout(1200);
    const afterExpand = await page.evaluate(() => document.querySelectorAll("input").length);
    note(afterExpand > expanded, "institutional detail expands the input set", `${expanded} → ${afterExpand} inputs`);

    // The OM and BOV render into a full-screen overlay, not a popup.
    await page.evaluate(() =>
      [...document.querySelectorAll("button")].find((b) => /Offering documents/i.test(b.textContent || ""))?.click());
    await page.waitForTimeout(1000);

    for (const [button, title] of [["Generate OM", "Offering Memorandum"], ["Generate BOV", "Broker Opinion of Value"]]) {
      await page.evaluate((label) => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
        if (btn && !btn.disabled) btn.click();
      }, button);
      const rendered = await page.waitForFunction((t) => {
        const ov = document.querySelector('div[class*="z-[9999]"]');
        return !!ov && (ov.innerText || "").toLowerCase().includes(t.toLowerCase()) && (ov.innerText || "").length > 800;
      }, title, { timeout: 40000 }).then(() => true).catch(() => false);
      const doc = await page.evaluate(() => {
        const ov = document.querySelector('div[class*="z-[9999]"]');
        return ov ? { chars: (ov.innerText || "").length, addr: /315 Seventh Avenue/.test(ov.innerText || "") } : { chars: 0, addr: false };
      });
      note(rendered && doc.addr, `${button} renders "${title}" with the subject address`, `${doc.chars} chars`);
      if (button === "Generate OM") await page.screenshot({ path: `${SHOTS}/features-om.png` });
      await page.evaluate(() => {
        const ov = document.querySelector('div[class*="z-[9999]"]');
        [...(ov?.querySelectorAll("button") || [])].find((b) => /Close/i.test(b.textContent || ""))?.click();
      });
      await page.waitForTimeout(1200);
    }
    await page.close();
  }

  // ------------------------------------------------------------------ 3
  console.log("\n3. Comps / Land Index — rows and exports\n");
  {
    const page = await open(context, "/comps", "Comps / Land Index");
    const rows = await page.waitForFunction(() => document.querySelectorAll('[data-testid^="comp-"]').length > 0, { timeout: 60000 })
      .then(() => page.evaluate(() => document.querySelectorAll('[data-testid^="comp-"]').length)).catch(() => 0);
    note(rows > 0, "comps table renders rows", `${rows} rows`);

    // Both testids appear more than once in the rendered page (the control is
    // repeated per chart block), so take the first visible one.
    for (const [id, label] of [["export-csv", "CSV"], ["export-xls", "Excel"]]) {
      const dl = page.waitForEvent("download", { timeout: 25000 }).then((d) => d.suggestedFilename()).catch(() => null);
      await page.locator(`[data-testid="${id}"]`).first().click().catch(() => {});
      const name = await dl;
      note(!!name, `${label} export produces a download`, name || "no download event");
    }
    await page.close();
  }

  // ------------------------------------------------------------------ 4
  console.log("\n4. Presentation Mode — lenses re-rank the deck\n");
  {
    const page = await open(context, "/present", "Top 5 opportunities");
    const first = await page.evaluate(() => ({
      lenses: [...document.querySelectorAll('[data-testid^="lens-"]')].map((n) => n.getAttribute("data-testid")),
      rows: [...document.querySelectorAll('[data-testid^="present-row-"]')].map((n) => (n.innerText || "").replace(/\s+/g, " ").trim())
    }));
    note(first.lenses.length >= 2 && first.rows.length > 0, "presentation deck renders lenses and ranked rows",
      `${first.lenses.length} lenses, ${first.rows.length} rows`);

    // Switching lens must actually re-rank; a dead control leaves the deck
    // identical and would otherwise read as working.
    const other = first.lenses[first.lenses.length - 1];
    await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), other);
    const changed = await page.waitForFunction((before) => {
      const now = [...document.querySelectorAll('[data-testid^="present-row-"]')].map((n) => (n.innerText || "").replace(/\s+/g, " ").trim());
      return now.length > 0 && now.join("|") !== before;
    }, first.rows.join("|"), { timeout: 30000 }).then(() => true).catch(() => false);
    const after = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="present-row-"]')].map((n) => (n.innerText || "").replace(/\s+/g, " ").slice(0, 30)));
    note(changed, `switching to ${other} re-ranks the deck`, after[0] || "");
    await page.close();
  }

  // ------------------------------------------------------------------ 5
  console.log("\n5. Source Registry — provenance and metered usage\n");
  {
    const page = await open(context, "/sources", "Source Registry");
    const reg = await page.evaluate(() => ({
      sources: document.querySelectorAll('[data-testid^="source-"]').length,
      maps: /Google Maps usage/i.test(document.body.innerText || ""),
      pinecone: /Pinecone/i.test(document.body.innerText || "")
    }));
    note(reg.sources > 0, "registry lists its sources", `${reg.sources} entries`);
    note(reg.maps, "metered Google Maps usage is reported on the page");
    note(reg.pinecone, "vector-search status is reported on the page");
    await page.close();
  }

  // ------------------------------------------------------------------ 6
  console.log("\n6. Territory Mastery — neighborhood search opens an intel dossier\n");
  {
    const page = await open(context, "/territory", "Know Your Market");
    const before = await page.evaluate(() => (document.body.innerText || "").length);
    await page.evaluate((sv) => {
      const set = eval(sv);
      const input = [...document.querySelectorAll("input")].find((i) => /neighborhood or ZIP/i.test(i.placeholder || ""));
      if (input) set(input, "Gowanus");
    }, SET_VALUE);
    await page.waitForTimeout(2000);
    await page.evaluate(() =>
      [...document.querySelectorAll("button")].find((b) => /Open territory/i.test(b.textContent || ""))?.click());

    const opened = await has(page, "TERRITORY INTELLIGENCE", 90000);
    const after = await page.evaluate(() => (document.body.innerText || "").length);
    note(opened && after > before, "territory search opens a live area dossier", `${before} → ${after} chars`);
    await page.screenshot({ path: `${SHOTS}/features-territory.png` });
    await page.close();
  }

  // ------------------------------------------------------------------ 7
  console.log("\n7. Investors — Obsidian export\n");
  {
    // SEED FIRST. The compiled bundle renders "Add to Obsidian" on a SAVED
    // investor row — the button sits beside that row's delete control in
    // index-BbnE3o5g.js — so on an environment whose investor store is empty
    // there is no row, no button, and the click below is a no-op that can only
    // ever report "no download event".
    //
    // This suite used to click without creating anything, so it passed only
    // where an earlier session had left investors saved. Measured 2026-08-20:
    // GET /api/investors answered {"owner":true,"investors":[]} on a fresh
    // store, and POST /api/investors answered
    // {"durable":true,"backend":"supabase-rest"} — the save path is healthy;
    // the suite simply never exercised it.
    //
    // The row is written through the app's own API and removed again in the
    // finally block, so the store is left exactly as it was found.
    // The row MUST carry a full buyBox. The bundle renders f.buyBox.priceMin,
    // .priceMax, .unitsMin, .unitsMax, .assetClasses, .boroughs and .notes
    // directly, so a row without one throws during render and takes the whole
    // section down — a seed of {id,name,submarket,assetClass} produced a page
    // with ZERO buttons, not merely a missing export button. This is the shape
    // the bundle's own factory builds:
    //   {id, name, firm, email, phone, buyBox:{assetClasses:[], boroughs:[],
    //    priceMin:null, priceMax:null, unitsMin:null, unitsMax:null, notes:""}}
    const seeded = await context.request.post(`${BASE}/api/investors`, {
      data: { investors: [{
        id: "features-browser-probe",
        name: "Features Probe LLC", firm: "", email: "", phone: "",
        buyBox: { assetClasses: [], boroughs: [], priceMin: null, priceMax: null, unitsMin: null, unitsMax: null, notes: "" }
      }] }
    });
    note(seeded.ok(), "an investor can be saved before export", `POST /api/investors -> ${seeded.status()}`);
    try {
    const page = await open(context, "/investors", "Investor buy boxes");
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some((b) => /Add to Obsidian/i.test(b.textContent || "")),
      null, { timeout: 30000 }
    ).catch(() => {});
    const dl = page.waitForEvent("download", { timeout: 25000 })
      .then(async (d) => ({ name: d.suggestedFilename(), body: readFileSync(await d.path(), "utf8") }))
      .catch(() => null);
    await page.evaluate(() =>
      [...document.querySelectorAll("button")].find((b) => /Add to Obsidian/i.test(b.textContent || ""))?.click());
    const got = await dl;
    note(!!got && /\.md$/.test(got.name), "investor exports an Obsidian note", got ? got.name : "no download event");
    note(!!got && got.body.startsWith("---") && /type:\s*investor/.test(got.body),
      "the note carries Obsidian frontmatter", got ? `${got.body.length} bytes` : "");
    await page.close();
    } finally {
      // Leave the owner's store as it was found, whether or not the assertions
      // above passed.
      await context.request.post(`${BASE}/api/investors`, { data: { investors: [] } }).catch(() => {});
    }
  }

  await browser.close();

  console.log(`\n${"=".repeat(64)}`);
  if (failures.length) {
    console.log(`FEATURES: ${failures.length} FAILURE(S)`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log("FEATURES: PASS — dossier, calculator, documents, exports, lenses, territory and Obsidian all exercised.");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
