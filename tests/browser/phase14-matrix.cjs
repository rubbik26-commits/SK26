// Phase 14 — the page-by-page functional matrix.
//
//   node tests/browser/phase14-matrix.cjs [baseUrl] [--md path]
//
// Thirteen routes × thirteen dimensions = 169 cells, driven in Chromium against
// a live server. Every cell is one of:
//
//   PASS  the check ran against this route and succeeded
//   FAIL  the check ran and the route failed it
//   n/a   the route genuinely has no such surface
//   GATED the surface exists and is reachable, but refuses pending sign-in.
//         Counted and reported separately from n/a: a control that is present
//         and blocked is not the same as a control that does not exist, and
//         collapsing the two is how "you can't save them" got filed as n/a.
//
// `n/a` is *derived from the rendered DOM*, never declared here. A route is
// marked n/a for exports because it renders no export control, not because this
// file decided it shouldn't have one. That distinction is the whole point: a
// matrix whose blanks are hand-waved is a worse artifact than no matrix, since
// it reads as coverage. The summary therefore reports covered cells separately
// from n/a cells, so shrinking coverage is visible rather than quiet.
//
// The application is hash-routed — `${BASE}/pipeline` renders Market Intel, not
// Pipeline — so every navigation here goes through `${BASE}/?…#/route`.
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

const DIMENSIONS = [
  "load", "api", "buttons", "filters", "search", "drawers", "nav",
  "mutations", "exports", "empty", "error", "refresh", "deeplink"
];

const ROUTES = [
  ["/", "Market Intel", { testid: "map-container" }],
  ["/dossier", "Parcel Dossier", { text: "Search any asset" }],
  ["/pipeline", "Pipeline / CRM", { testid: "column-watchlist" }],
  ["/live", "Live Details", { text: "Start Live Details" }],
  ["/territory", "Territory Mastery", { text: "Know Your Market" }],
  ["/radar", "Deal Radar", { text: "off-market targets" }],
  ["/calculator", "Deal Calculator", { text: "Upload rent roll" }],
  ["/comps", "Comps / Land Index", { testid: "export-csv" }],
  ["/present", "Presentation Mode", { text: "Top 5 opportunities" }],
  ["/investors", "Investors", { text: "Investor buy boxes" }],
  ["/desk", "My Desk", { text: "My Desk" }],
  ["/sources", "Source Registry", { text: "Source Registry" }],
  ["/no-such-route", "404", { text: "404 Page Not Found" }]
];

// External font/CDN hosts are outside the deployment's control.
const EXTERNAL = /^https?:\/\/(fonts\.|api\.fontshare\.com|unpkg\.com|cdn\.)/;

const SET_VALUE = `(el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}`;

const results = new Map();      // route -> { dimension: {state, detail} }
const cell = (route, dim, state, detail = "") => {
  results.get(route)[dim] = { state, detail: String(detail).slice(0, 110) };
};

// Chrome's innerText returns rendered text, so a heading with
// text-transform:uppercase never matches the source copy exactly.
const marked = (page, marker, timeout = 45000) =>
  marker.testid
    ? page.waitForSelector(`[data-testid="${marker.testid}"]`, { timeout }).then(() => true).catch(() => false)
    : page.waitForFunction((t) => (document.body.innerText || "").toLowerCase().includes(t), marker.text.toLowerCase(), { timeout }).then(() => true).catch(() => false);

const textOf = (page) => page.evaluate(() => document.body.innerText || "");

// A route "settles" when its marker is up; content beyond that arrives on the
// public records' own schedule, so give it a short grace period rather than a
// long fixed sleep.
async function goto(page, route, marker, tag = "m") {
  await page.goto(`${BASE}/?p14=${tag}${route.replace(/\W/g, "")}#${route}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const ok = await marked(page, marker);
  await page.waitForTimeout(1500);
  return ok;
}

// Refuse to run against a deliberately-broken tree.
//
// tests/release-gate-negatives.mjs edits real files while it runs — an injected
// uncaught exception in the shell, a shadowing router, a byte appended to the
// pinned CSS. A matrix run that overlaps one measures that damage and reports it
// as product failures. This exact collision produced a `/` load:FAIL once; the
// lock file is the fix.
{
  const lock = require("node:path").join(__dirname, "..", "..", ".release-gate-negatives.lock");
  if (require("node:fs").existsSync(lock)) {
    console.error(
      "REFUSING TO RUN: tests/release-gate-negatives.mjs holds the tree lock, so files are " +
      "intentionally broken right now and every result would be meaningless. Wait for it to finish."
    );
    process.exit(3);
  }
}

(async () => {
  const browser = await chromium.launch(launchOptions);

  for (const [route, label, marker] of ROUTES) {
    results.set(route, {});
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    // Every suite goes through the gate. Six of eight never did, and passed only
    // because the harness left the gate disabled — i.e. they were exercising a
    // server configuration that is never deployed.
    await signIn(context, BASE);
    const page = await context.newPage();

    const pageErrors = [];
    const apiSeen = [];
    const badRequests = [];
    page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 120)));
    const bodyReads = [];
    page.on("response", (r) => {
      const u = r.url();
      if (!u.startsWith(BASE)) return;
      if (/\/api\//.test(u)) {
        const entry = { url: u.replace(BASE, ""), status: r.status(), unconfigured: false, bodyError: null };
        apiSeen.push(entry);
        // A 5xx is read, not assumed. This codebase answers an integration whose
        // credential is absent with 503 AND `configured: false` — see
        // server/buyer-intelligence.js configuredResponse(), which returns
        // {configured:false, error:"buyer_intelligence_unconfigured"}. That is a
        // declared credential state, not an outage, and it is the permanent
        // condition of any runner that holds no service-role key.
        //
        // Status alone cannot tell the two apart, so the body decides. A real
        // 5xx carries no `configured:false` and still fails below. In production,
        // where the credential exists, `configured` is never false — so this
        // cannot mask a production break either.
        if (r.status() >= 500) {
          bodyReads.push(r.text()
            .then((t) => { entry.unconfigured = /"configured"\s*:\s*false/.test(t); })
            .catch((e) => { entry.bodyError = String(e.message).slice(0, 80); }));
        }
      }
      else if (r.status() >= 400) badRequests.push(`${r.status()} ${u.replace(BASE, "")}`);
    });

    process.stdout.write(`\n── ${route}  (${label})\n`);

    // ---------------------------------------------------------------- load
    const loaded = await goto(page, route, marker, "load");
    const mounted = await page.evaluate(() => {
      const root = document.getElementById("root");
      return !!root && root.children.length > 0 && (root.innerText || "").trim().length > 0;
    });
    cell(route, "load", loaded && mounted && !pageErrors.length ? "PASS" : "FAIL",
      loaded ? (pageErrors[0] || `${(await textOf(page)).length} chars`) : "route marker never rendered");

    // ---------------------------------------------------------------- api
    // Only this route's own API traffic counts. A 4xx from a public-record
    // endpoint with nothing to report is honest; a 5xx is not.
    {
      // Settle the 5xx body reads started above before judging any of them. A
      // body that could not be read is NOT treated as unconfigured; it stays a
      // failure and names the read error.
      await Promise.all(bodyReads);
      const own = apiSeen.filter((r) => !/pinecone-status|client-diag/.test(r.url));
      const unconfigured = own.filter((r) => r.status >= 500 && r.unconfigured);
      const broken = own.filter((r) => r.status >= 500 && !r.unconfigured);
      const unconfiguredNote = unconfigured.length
        ? ` · ${unconfigured.length} unconfigured integration(s): ${unconfigured.map((u) => `${u.status} ${u.url}`).join(" ").slice(0, 90)}`
        : "";
      if (!own.length) cell(route, "api", "n/a", "route issues no API request of its own");
      else cell(route, "api", broken.length === 0 && badRequests.length === 0 ? "PASS" : "FAIL",
        broken.length ? broken.map((b) => `${b.status} ${b.url}${b.bodyError ? ` (body unreadable: ${b.bodyError})` : ""}`).join(" ").slice(0, 100)
          : badRequests.length ? badRequests[0]
            : `${own.length} calls, worst ${Math.max(...own.map((r) => r.status))}${unconfiguredNote}`);
    }

    // ---------------------------------------------------------------- buttons
    {
      const btns = await page.evaluate(() => {
        const vis = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
        return { total: vis.length, enabled: vis.filter((b) => !b.disabled).length };
      });
      if (!btns.total) cell(route, "buttons", "n/a", "route renders no button");
      else cell(route, "buttons", btns.enabled > 0 ? "PASS" : "FAIL", `${btns.enabled}/${btns.total} enabled`);
    }

    // ---------------------------------------------------------------- drawers
    // "Does clicking a record do what this route offers?" — deliberately early,
    // because it needs the record list exactly as the route loaded it. Running
    // after `filters`/`search` would leave a filtered or emptied list and the
    // cell would report n/a for a route that does have a record — an n/a that
    // came from test ordering, not from the product.
    //
    // The bundle gives records three different affordances and all three are
    // legitimate; only a record that does nothing at all is a defect:
    //   * an overlay / drawer            — Market Intel's opportunity cards
    //   * a link to another route        — a comps row wraps an <a href="…#/dossier">
    //   * selection within the page      — a kanban pcard's button sets selectedId,
    //                                      which only repaints that card's border
    // The click therefore targets the record's own interactive child (the <a> or
    // <button> a person actually clicks), not the wrapper, and the outcome is
    // classified from what changed.
    {
      // Deal Radar renders no rows until you scan, so "no record at load" would
      // report n/a for a route that plainly has records. Look, and if the route
      // is empty but searchable, run its search once and look again — the n/a
      // then means the route really has nothing to open, not that the test
      // arrived too early.
      const RECORDS = '[data-testid^="card-opp-"], [data-testid^="pcard-"], [data-testid^="comp-"], [data-testid^="present-row-"], [data-testid^="source-"]';
      const findRecord = () => page.evaluate((sel) => {
        const byId = document.querySelector(sel);
        if (byId) return { sel: `[data-testid="${byId.getAttribute("data-testid")}"]`, name: byId.getAttribute("data-testid") };
        // Result tables (Deal Radar) carry no testid of their own, so a bare
        // table row is the fallback — but ONLY when the row is actually a record
        // affordance, meaning it holds something to click.
        //
        // Without that condition this picked up informational tables. On
        // /dossier the first table on the page is the seller-propensity
        // breakdown — "SIGNAL | PTS | WHAT THE RECORD SHOWS — VERIFY | SOURCE
        // (DATASET · FIELD)" — whose rows are explanatory text with zero
        // interactive children. Clicking one does nothing, correctly, and the
        // cell reported that correct behaviour as a failure.
        const rows = [...document.querySelectorAll("table tbody tr")];
        const hit = rows.find((r) => r.querySelector("a[href], button, [role=button]"));
        if (!hit) return null;
        // Tag the element rather than compute a positional selector for it.
        // `table tbody tr:nth-of-type(n)` counts among siblings inside ONE
        // tbody, but the index here is across every table on the page — on a
        // route with seven tables those are different elements, the selector
        // resolves to null, and the caller throws on it.
        hit.setAttribute("data-p14-record", "1");
        return { sel: '[data-p14-record="1"]', name: "first result row" };
      }, RECORDS);

      let rec = await findRecord();
      let viaSearch = false;
      if (!rec) {
        const searchable = await page.evaluate(() =>
          !![...document.querySelectorAll("input")].find((x) =>
            x.type !== "file" && x.type !== "checkbox" && /search|address|zip|neighborhood|bbl/i.test(x.placeholder || "")));
        if (searchable) {
          await page.evaluate((sv) => {
            const set = eval(sv);
            const i = [...document.querySelectorAll("input")].find((x) =>
              x.type !== "file" && x.type !== "checkbox" && /search|address|zip|neighborhood|bbl/i.test(x.placeholder || ""));
            if (i) set(i, "11216");
            const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
            for (const re of [/Open territory/i, /Scan area/i, /Open dossier/i, /^Search$/i]) {
              const b = buttons.find((x) => re.test(x.textContent || ""));
              if (b) { b.click(); return; }
            }
          }, SET_VALUE);
          await page.waitForFunction((sel) => !!document.querySelector(sel) || !!document.querySelector("table tbody tr"),
            RECORDS, { timeout: 60000 }).catch(() => {});
          rec = await findRecord();
          viaSearch = !!rec;
        }
      }

      // A record with no link, no button and no button role is markup, not a
      // control — the Source Registry's cards are reference panels of published
      // text. Clicking one and calling the silence a failure would invent a
      // defect; the cell is n/a because the DOM says there is nothing to click.
      const affordance = rec && await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        const target = el.querySelector("a[href], button, [role=button]");
        if (target) return target.tagName.toLowerCase();
        return /^(a|button)$/i.test(el.tagName) || el.getAttribute("role") === "button" ? el.tagName.toLowerCase() : null;
      }, rec.sel);

      const found = rec ? `${rec.name}${viaSearch ? " (after a scan)" : ""}` : "";
      if (!rec) cell(route, "drawers", "n/a", "route renders no record to open, before or after a search");
      else if (!affordance) cell(route, "drawers", "n/a", `${found} is a static card — no link, button or button role`);
      else {
        const snap = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          const target = el.querySelector("a[href], button, [role=button]") || el;
          const href = target.tagName === "A" ? target.getAttribute("href") : null;
          let external = false, host = "";
          if (href) {
            try {
              const u = new URL(href, location.href);
              external = u.origin !== location.origin || target.getAttribute("target") === "_blank";
              host = u.host;
            } catch { /* a relative href that will not parse is treated as in-app */ }
          }
          return {
            chars: (document.body.innerText || "").length,
            cls: el.className || "",
            href, external, host,
            kind: target.tagName.toLowerCase(),
            loc: location.hash
          };
        }, rec.sel);

        if (snap.external) {
          // A dossier result row links out to the city's own system (ACRIS, DOB,
          // ZoLa). That is the record's affordance and it is verified by the
          // href, not by following it — clicking navigates the whole page off
          // the application, which took the sidebar, the search input and the
          // route with it and turned four later cells into nonsense.
          cell(route, "drawers", "PASS", `${found} links out to ${snap.host}`);
        } else {
          // The full URL, not just the hash — and navigation-aware waiting.
          //
          // A record can link WITHIN the app and still reload the document. The
          // similar-properties row on /dossier is exactly that:
          //   <a href="/?dossierBbl=4021550001&dossierAddr=…#/dossier">Dossier →</a>
          // Same hash, different query, whole page reloads. The previous version
          // compared only location.hash and polled with waitForFunction — which
          // cannot survive the navigation it is waiting for: the execution
          // context is destroyed, the poll throws, the catch turns it into null,
          // and a link that works perfectly was reported as "clicking changed
          // nothing". So: click, let any navigation settle, and compare the whole
          // URL first; only poll in-page when the document did not change.
          const beforeUrl = page.url();
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            (el.querySelector("a[href], button, [role=button]") || el).click();
          }, rec.sel).catch(() => { /* the click itself may start the navigation */ });
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await page.waitForTimeout(1200);

          let outcome = null;
          if (page.url() !== beforeUrl) {
            outcome = "navigated";
          } else {
            outcome = await page.waitForFunction((s) => {
              const el = document.querySelector(s.sel);
              if (document.querySelector('div[class*="z-[9999]"], [role="dialog"], [aria-modal="true"]')) return "drawer";
              if (location.href !== s.url) return "navigated";
              if (Math.abs((document.body.innerText || "").length - s.chars) > 40) return "content";
              if (el && (el.className || "") !== s.cls) return "selected";
              return false;
            }, { sel: rec.sel, url: beforeUrl, ...snap }, { timeout: 25000 }).then((h) => h.jsonValue()).catch(() => null);
          }

          const detail = {
            drawer: `${found} opens a drawer`,
            navigated: `${found} links to ${snap.href || "another route"}`,
            content: `${found} loads its record in place`,
            selected: `${found} selects the record in place`
          }[outcome];
          cell(route, "drawers", outcome ? "PASS" : "FAIL",
            detail || `clicking ${found}'s ${snap.kind} changed nothing`);

          // Leave the route as it was found, or an overlay's text pollutes every
          // later cell's before/after comparison.
          if (outcome === "drawer") {
            await page.keyboard.press("Escape").catch(() => {});
            await page.evaluate(() => {
              const ov = document.querySelector('div[class*="z-[9999]"], [role="dialog"], [aria-modal="true"]');
              [...(ov?.querySelectorAll("button") || [])].find((b) => /close|✕|×/i.test(b.textContent || ""))?.click();
            });
          }
        }

        // Whatever happened above, the next ten cells are about *this* route, so
        // put the page back on it before they run. Without this a single stray
        // navigation cascades: search, nav and empty all reported n/a for
        // /dossier because the page was no longer the application.
        if (!(await marked(page, marker, 4000))) await goto(page, route, marker, "back");
        await page.waitForTimeout(800);
      }
    }

    // ---------------------------------------------------------------- filters
    {
      // Runs after `drawers`, which needs the route's freshly loaded record
      // list — filtering and searching first would empty it out and the drawer
      // cell would read n/a for a route that has one.
      const filters = await page.evaluate(() =>
        document.querySelectorAll('[data-testid^="filter-"], [data-testid^="chip-area-"], [data-testid^="lens-"], [data-testid^="slider-"], [data-testid^="switch-"], select').length);
      if (!filters) cell(route, "filters", "n/a", "route renders no filter control");
      else {
        // Clicking whichever control is first is not a test: on Presentation
        // Mode the first lens is the one already selected, so the click is a
        // legitimate no-op that reads as a dead control. Walk the controls until
        // one changes the page, and fail only when none of them does.
        const ids = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="filter-"], [data-testid^="chip-area-"], [data-testid^="lens-"]')]
            .map((n) => n.getAttribute("data-testid")));
        if (!ids.length) cell(route, "filters", "n/a", `${filters} controls, none toggleable`);
        else {
          let changed = false, used = "";
          for (const id of ids.slice(0, 4)) {
            const before = await textOf(page);
            await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), id);
            changed = await page.waitForFunction((b) => (document.body.innerText || "") !== b, before, { timeout: 20000 })
              .then(() => true).catch(() => false);
            used = id;
            if (changed) break;
          }
          cell(route, "filters", changed ? "PASS" : "FAIL",
            changed ? `${filters} controls, toggled ${used}` : `${filters} controls, none of ${ids.slice(0, 4).join(", ")} changed the page`);
        }
      }
    }

    // ---------------------------------------------------------------- search
    {
      const probe = await page.evaluate(() => {
        const i = [...document.querySelectorAll("input")].find((x) =>
          x.type !== "file" && x.type !== "checkbox" && /search|address|zip|neighborhood|bbl/i.test(x.placeholder || ""));
        return i ? (i.placeholder || "").slice(0, 40) : null;
      });
      if (!probe) cell(route, "search", "n/a", "route renders no search input");
      else {
        // Feed the input the kind of value it asks for, and accept either shape
        // where the field takes both. An address field ("Property address (for
        // the OM / BOV cover)") does a parcel lookup and finds nothing for a
        // bare ZIP; Territory Mastery's "neighborhood or ZIP" field answers to
        // the name but not to 11216. Handing every input "11216" made both look
        // broken when it was the query that was wrong. The cell fails only if no
        // accepted shape produces a result.
        const queries = /address/i.test(probe) && !/zip/i.test(probe)
          ? ["60 Wall Street"]
          : ["11216", "Gowanus"];
        let changed = false, used = "", submit = null;
        for (const q of queries) {
          const before = await textOf(page);
          submit = await page.evaluate(({ sv, q }) => {
            const set = eval(sv);
            const i = [...document.querySelectorAll("input")].find((x) =>
              x.type !== "file" && x.type !== "checkbox" && /search|address|zip|neighborhood|bbl/i.test(x.placeholder || ""));
            if (i) set(i, q);
            // Most specific submit wins. Taking "the first button whose label
            // matches /Search/" picked Territory Mastery's "Territory Search"
            // *tab* — already active, so clicking it did nothing and the route's
            // real "Open territory →" was never pressed.
            const buttons = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
            for (const re of [/Open territory/i, /Scan area/i, /Open dossier/i, /^Search$/i]) {
              const b = buttons.find((x) => re.test(x.textContent || ""));
              if (b) { b.click(); return (b.textContent || "").trim().slice(0, 30); }
            }
            // No submit control: many search fields commit on Enter instead.
            if (i) i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            return null;
          }, { sv: SET_VALUE, q });
          changed = await page.waitForFunction((b) => (document.body.innerText || "") !== b, before, { timeout: 60000 })
            .then(() => true).catch(() => false);
          used = q;
          if (changed) break;
        }
        // A query-shaped input with no submit control that does nothing on Enter
        // is not a search surface. Deal Calculator's "Property address (for the
        // OM / BOV cover)" is a label for the generated document — the parcel
        // pull it looks like is driven by ?calcAddr/?calcBbl on the URL, not by
        // typing. Calling that a broken search would invent a defect; calling it
        // a passing search would invent a feature.
        cell(route, "search", changed ? "PASS" : submit ? "FAIL" : "n/a",
          changed ? `"${probe}" ← "${used}" via ${submit || "Enter"}`
            : submit ? `"${probe}" ← "${used}" via ${submit} → no change`
              : `"${probe}" has no submit control and does not commit on Enter — it labels rather than queries`);
      }
    }

    // ---------------------------------------------------------------- mutations
    {
      // Two traps here, and the first version of this cell fell into both.
      //
      // Auth-gated controls are not broken controls. The dossier's Watch and Add
      // to Pipeline buttons stay enabled for an anonymous visitor so they can
      // carry the explanation — their title reads "Sign in to use your
      // watchlist" — and clicking does nothing on purpose. That is read off the
      // DOM here rather than assumed, so a genuinely dead button still fails.
      //
      // And "the body text changed" is not evidence the *control* did anything:
      // these pages stream live public records, so a comparison taken across a
      // click catches whatever happened to arrive. This cell passed for Watch
      // that way — a false positive. The outcome must now be attributable: the
      // control's own label or class changes, or the click puts a request on the
      // wire.
      const mutator = await page.evaluate(() => {
        const gated = (el) => /sign in/i.test(`${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""}`);
        // On the kanban, "whichever Advance is first" is not a test: the store
        // persists across runs, so that card drifts to the last stage and
        // Advance becomes a legitimate no-op that reads as a broken control.
        // Take a forward control that provably has somewhere to go.
        const first = document.querySelector('[data-testid="column-watchlist"] [data-testid^="move-fwd-"]');
        if (first && !first.disabled && !gated(first)) {
          const id = first.getAttribute("data-testid");
          return { selector: `[data-testid="${id}"]`, name: `${id} (from Watchlist)` };
        }
        const buttons = [...document.querySelectorAll("button")].filter((x) =>
          x.offsetParent !== null && !x.disabled && /^(Advance|Back|Watch|Add to Pipeline|Add investor|Reset)$/i.test((x.textContent || "").trim()));
        const open = buttons.find((b) => !gated(b));
        if (open) return { text: (open.textContent || "").trim(), name: (open.textContent || "").trim() };
        return buttons.length
          ? { blocked: buttons.map((b) => `${(b.textContent || "").trim()} ("${b.getAttribute("title")}")`).join(", ") }
          : null;
      });

      if (!mutator) cell(route, "mutations", "n/a", "route offers no state-changing control");
      // GATED is its own state, not n/a.
      //
      // This cell used to read n/a, and that was wrong in a way that mattered:
      // "not applicable" says there is nothing here, when in fact the control is
      // right there and refuses to work. The owner's report was "you can't save
      // them", and a matrix that answers n/a hides exactly that. GATED says the
      // control exists, is reachable, and is blocked pending sign-in — which is
      // correct behaviour for a signed-out visitor AND is the thing to look at
      // when someone says saving does not work.
      else if (mutator.blocked) cell(route, "mutations", "GATED", `the control is present and refuses pending sign-in: ${mutator.blocked}`.slice(0, 112));
      else {
        const sel = mutator.selector;
        const snap = await page.evaluate((m) => {
          const el = m.selector
            ? document.querySelector(m.selector)
            : [...document.querySelectorAll("button")].find((x) => x.offsetParent !== null && (x.textContent || "").trim() === m.text);
          return { label: (el?.textContent || "").trim(), cls: el?.className || "" };
        }, mutator);

        // A same-origin write started by the click is the other acceptable
        // proof — a persisted mutation may leave the label alone. `client-diag`
        // is excluded because it is the device-diagnostic beacon: it fires on
        // all sorts of interaction, so accepting it would let any click at all
        // count as a mutation. It did, briefly — Reset and Add investor both
        // "passed" on a client-diag POST before this exclusion.
        const TELEMETRY = /\/api\/client-diag/;
        const wrote = new Promise((resolve) => {
          const onReq = (r) => {
            if (r.url().startsWith(BASE) && /\/api\//.test(r.url()) && r.method() !== "GET" && !TELEMETRY.test(r.url())) {
              page.off("request", onReq);
              resolve(r.method() + " " + r.url().replace(BASE, "").slice(0, 40));
            }
          };
          page.on("request", onReq);
          setTimeout(() => { page.off("request", onReq); resolve(null); }, 25000);
        });

        // Third proof: the page's *controls* changed. Comparing body text across
        // a click is worthless here — these routes stream live public records,
        // so the text moves on its own. Form values, checked states and the
        // selected classes on filter chips do not; they change because something
        // acted on them. This is what catches Reset, whose whole effect is on
        // other controls rather than on itself.
        const controlPrint = () => page.evaluate(() => {
          const fields = [...document.querySelectorAll("input, select, textarea")]
            .map((el) => `${el.type || el.tagName}:${el.value}:${el.checked}`).join("|");
          const chips = [...document.querySelectorAll('[data-testid^="filter-"], [data-testid^="chip-area-"], [data-testid^="lens-"], [data-testid^="column-"]')]
            .map((el) => `${el.getAttribute("data-testid")}:${el.className}`).join("|");
          return `${fields}##${chips}`;
        });
        const printBefore = await controlPrint();

        await page.evaluate((m) => {
          const el = m.selector
            ? document.querySelector(m.selector)
            : [...document.querySelectorAll("button")].find((x) => x.offsetParent !== null && (x.textContent || "").trim() === m.text);
          el && el.click();
        }, mutator);

        const repainted = await page.waitForFunction((s) => {
          const el = s.sel
            ? document.querySelector(s.sel)
            : [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === s.label);
          // The control vanishing (a card moving column) counts too.
          if (!el) return "control moved";
          if ((el.textContent || "").trim() !== s.label) return "label changed";
          if ((el.className || "") !== s.cls) return "style changed";
          const fields = [...document.querySelectorAll("input, select, textarea")]
            .map((n) => `${n.type || n.tagName}:${n.value}:${n.checked}`).join("|");
          const chips = [...document.querySelectorAll('[data-testid^="filter-"], [data-testid^="chip-area-"], [data-testid^="lens-"], [data-testid^="column-"]')]
            .map((n) => `${n.getAttribute("data-testid")}:${n.className}`).join("|");
          if (`${fields}##${chips}` !== s.print) return "page controls changed";
          return false;
        }, { sel, label: snap.label, cls: snap.cls, print: printBefore }, { timeout: 25000 })
          .then((h) => h.jsonValue()).catch(() => null);

        const request = await wrote;
        cell(route, "mutations", repainted || request ? "PASS" : "FAIL",
          `${mutator.name} → ${[repainted, request].filter(Boolean).join(", ") || "no repaint, no control change, no write"}`);
      }
    }

    // ---------------------------------------------------------------- exports
    {
      const exporter = await page.evaluate(() => {
        const byId = document.querySelector('[data-testid="export-csv"], [data-testid="export-xls"]');
        if (byId) return byId.getAttribute("data-testid");
        const b = [...document.querySelectorAll("button")].find((x) => x.offsetParent !== null && /^(CSV|Excel|Export)$/i.test((x.textContent || "").trim()));
        return b ? (b.textContent || "").trim() : null;
      });
      if (!exporter) cell(route, "exports", "n/a", "route renders no export control");
      else {
        const dl = page.waitForEvent("download", { timeout: 25000 }).then((d) => d.suggestedFilename()).catch(() => null);
        if (/^export-/.test(exporter)) await page.locator(`[data-testid="${exporter}"]`).first().click().catch(() => {});
        else await page.evaluate((t) => {
          const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === t);
          b && b.click();
        }, exporter);
        const name = await dl;
        cell(route, "exports", name ? "PASS" : "FAIL", name || `${exporter} produced no download`);
      }
    }

    // ---------------------------------------------------------------- nav
    // Last of the in-place dimensions: navigating away and back re-mounts the
    // route, so anything that runs after this would be measuring a fresh page
    // rather than the one the earlier cells built up.
    {
      const away = route === "/" ? "nav-deal-calculator" : "nav-market-intel";
      const awayMarker = route === "/" ? { text: "Upload rent roll" } : { testid: "map-container" };
      const home = route === "/" ? "nav-market-intel" : null;
      const present = await page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), away);
      if (!present) cell(route, "nav", "n/a", "sidebar not rendered on this route");
      else {
        await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), away);
        const left = await marked(page, awayMarker, 45000);
        // …and back, so a one-way trip does not read as working navigation.
        // Routes without a sidebar entry of their own (the 404, and My Desk when
        // signed out) are returned to by URL — the trip out is the part the
        // sidebar owns.
        let back = false;
        if (left) {
          if (home) {
            await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), home);
            back = await marked(page, marker, 45000);
          } else {
            const own = `nav-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
            const hasOwn = await page.evaluate((t) => !!document.querySelector(`[data-testid="${t}"]`), own);
            if (hasOwn) {
              await page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.click(), own);
              back = await marked(page, marker, 45000);
            } else {
              back = await goto(page, route, marker, "nav");
            }
          }
        }
        cell(route, "nav", left && back ? "PASS" : "FAIL", `left via ${away} ${left}, returned ${back}`);
      }
    }

    // ---------------------------------------------------------------- empty
    // A query that cannot match must produce an empty state, not an exception.
    {
      const searchable = await page.evaluate(() =>
        !![...document.querySelectorAll("input")].find((x) =>
          x.type !== "file" && x.type !== "checkbox" && /search|address|zip|neighborhood|bbl/i.test(x.placeholder || "")));
      if (!searchable) cell(route, "empty", "n/a", "route takes no query to empty out");
      else {
        await goto(page, route, marker, "empty");
        const before = pageErrors.length;
        await page.evaluate((sv) => {
          const set = eval(sv);
          const i = [...document.querySelectorAll("input")].find((x) =>
            x.type !== "file" && x.type !== "checkbox" && /search|address|zip|neighborhood|bbl/i.test(x.placeholder || ""));
          if (i) set(i, "ZZZQQ00000");
          const go = [...document.querySelectorAll("button")].find((b) => /Scan area|Open dossier|Open territory|Search/i.test(b.textContent || ""));
          go && go.click();
        }, SET_VALUE);
        await page.waitForTimeout(9000);
        const alive = await page.evaluate(() => {
          const root = document.getElementById("root");
          return !!root && (root.innerText || "").trim().length > 0;
        });
        cell(route, "empty", alive && pageErrors.length === before ? "PASS" : "FAIL",
          alive ? (pageErrors[before] || "empty query handled, page intact") : "page emptied out");
      }
    }

    // ---------------------------------------------------------------- error
    // Every API request fails. The route must degrade, not throw.
    {
      const errPage = await context.newPage();
      const errs = [];
      errPage.on("pageerror", (e) => errs.push(String(e.message).slice(0, 100)));
      await errPage.route("**/api/**", (r) => r.abort());
      await errPage.goto(`${BASE}/?p14err=${route.replace(/\W/g, "")}#${route}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await errPage.waitForTimeout(9000);
      const alive = await errPage.evaluate(() => {
        const root = document.getElementById("root");
        return !!root && (root.innerText || "").trim().length > 0;
      }).catch(() => false);
      cell(route, "error", alive && errs.length === 0 ? "PASS" : "FAIL",
        alive ? (errs[0] || "renders with every API call aborted") : "blank under API failure");
      await errPage.close();
    }

    // ---------------------------------------------------------------- refresh
    {
      const again = await goto(page, route, marker, "refresh");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      const survived = await marked(page, marker, 45000);
      cell(route, "refresh", again && survived ? "PASS" : "FAIL", survived ? "same route after reload" : "route lost on reload");
    }

    // ---------------------------------------------------------------- deeplink
    // A hash deep link carrying query parameters must land on the right route
    // rather than falling back to Market Intel.
    {
      await page.goto(`${BASE}/?deep=1&zips=11216#${route}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      const landed = await marked(page, marker, 45000);
      const hash = await page.evaluate(() => location.hash);
      cell(route, "deeplink", landed && hash === `#${route}` ? "PASS" : "FAIL", `hash ${hash || "(none)"}`);
    }

    const row = results.get(route);
    process.stdout.write(DIMENSIONS.map((d) => `${d}:${row[d]?.state ?? "?"}`).join("  ") + "\n");
    await page.close();
    await context.close();
  }

  await browser.close();

  // ---------------------------------------------------------------- report
  const width = Math.max(...ROUTES.map(([r]) => r.length));
  console.log(`\n${"=".repeat(64)}\nPHASE 14 MATRIX — ${ROUTES.length} routes × ${DIMENSIONS.length} dimensions\n`);
  console.log("route".padEnd(width) + " │ " + DIMENSIONS.map((d) => d.slice(0, 4).padEnd(4)).join(" "));
  console.log("─".repeat(width) + "─┼─" + "─".repeat(DIMENSIONS.length * 5));
  for (const [route] of ROUTES) {
    const row = results.get(route);
    console.log(route.padEnd(width) + " │ " + DIMENSIONS.map((d) => {
      const s = row[d]?.state;
      return (s === "PASS" ? "ok  " : s === "FAIL" ? "FAIL" : "—   ");
    }).join(" "));
  }

  let pass = 0, fail = 0, na = 0, gated = 0;
  const failures = [];
  for (const [route] of ROUTES) {
    for (const d of DIMENSIONS) {
      const c = results.get(route)[d];
      if (!c) { fail++; failures.push(`${route} ${d}: cell never ran`); continue; }
      if (c.state === "PASS") pass++;
      else if (c.state === "GATED") gated++;
      else if (c.state === "n/a") na++;
      else { fail++; failures.push(`${route} ${d}: ${c.detail}`); }
    }
  }
  const total = ROUTES.length * DIMENSIONS.length;
  console.log(`\n${pass} pass · ${fail} fail · ${gated} gated · ${na} n/a  of ${total} cells (${pass + fail} exercised)`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }

  if (MD_PATH) {
    const esc = (s) => String(s).replace(/\|/g, "\\|");
    const lines = [
      "# Phase 14 — page-by-page functional matrix",
      "",
      `Generated by \`tests/browser/phase14-matrix.cjs\` against \`${BASE}\`.`,
      "",
      "`ok` = the check ran and passed. `FAIL` = the check ran and failed.",
      "`—` = the route has no such surface, **derived from the rendered DOM** —",
      "the exports column is blank for a route that renders no export control, not",
      "because this file decided the route shouldn't have one.",
      "`gated` = the surface **is** there and refuses pending sign-in. It is counted",
      "apart from `—` on purpose: a control that exists and is blocked is not the",
      "same as a control that does not exist, and collapsing the two is how",
      "\"you can't save them\" was previously filed as not-applicable.",
      "",
      `**${pass} pass · ${fail} fail · ${gated} gated · ${na} n/a of ${total} cells (${pass + fail} exercised).**`,
      "",
      "| route | " + DIMENSIONS.join(" | ") + " |",
      "| --- | " + DIMENSIONS.map(() => "---").join(" | ") + " |"
    ];
    for (const [route, label] of ROUTES) {
      const row = results.get(route);
      lines.push(`| \`${route}\` (${esc(label)}) | ` + DIMENSIONS.map((d) => {
        const s = row[d]?.state;
        return s === "PASS" ? "ok" : s === "FAIL" ? "**FAIL**" : s === "GATED" ? "gated" : "—";
      }).join(" | ") + " |");
    }
    lines.push("", "## Cell detail", "", "| route | dimension | state | measured |", "| --- | --- | --- | --- |");
    for (const [route] of ROUTES) {
      for (const d of DIMENSIONS) {
        const c = results.get(route)[d];
        lines.push(`| \`${route}\` | ${d} | ${c?.state ?? "?"} | ${esc(c?.detail ?? "")} |`);
      }
    }
    writeFileSync(MD_PATH, lines.join("\n") + "\n");
    console.log(`\nwrote ${MD_PATH}`);
  }

  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
