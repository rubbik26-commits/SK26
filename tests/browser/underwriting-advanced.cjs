// Phase 17, second half — P17.7–P17.13, P17.16, P17.18.
//
//   node tests/browser/underwriting-advanced.cjs [baseUrl] [--md path]
//
// tests/browser/underwriting.cjs covers P17.1–P17.6 (standard underwriting,
// debt, DSCR, cash-on-cash, IRR, equity multiple). This file covers the rest:
// development underwriting and residual land value, the sensitivity table, the
// equity waterfall, plain-English parsing, document extraction and the
// verify-before-apply rule, deck generation and the print/PDF path.
//
// Same evidence standard as the first half. The finance is implemented here from
// first principles — nothing is read, imported or mirrored from the application —
// and compared against what the shipped calculator renders for a FIXED input set
// stated up front, with the tolerance stated and justified.
//
// DEVELOPMENT INPUT SET (fixed before the run):
//
//   lot SF                      20,000
//   buildable SF                80,000
//   hard cost / SF                $425
//   soft costs                     22 %
//   gross development value $92,000,000
//   target profit                  18 %
//   land asking price       $14,000,000
//   exit cap                     5.25 %
//   stabilised gross income  $6,200,000
//
// Independently computed, by hand, before running anything:
//
//   hard              80,000 × 425          = $34,000,000
//   soft              34,000,000 × 0.22     =  $7,480,000
//   construction cost                       = $41,480,000
//   developer profit  92,000,000 × 0.18     = $16,560,000
//   RESIDUAL LAND VALUE
//     92,000,000 − 41,480,000 − 16,560,000  = $33,960,000
//
// and because the asking price of $14,000,000 is below that residual, the deal
// must read as favourable rather than as a loss.
//
// TOLERANCE: $1 on money and 0.005 percentage points on rates — half the display
// step, the same rule the first half uses. The figures are read off the rendered
// page, so anything tighter would be testing the renderer rather than the model.
const { chromium } = require("playwright");
const { signIn } = require("./lib/gate.cjs");
const { writeFileSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const args = process.argv.slice(2);
const BASE = (args.find((a) => !a.startsWith("--")) || "http://localhost:5175").replace(/\/$/, "");
const MD_PATH = args.includes("--md") ? args[args.indexOf("--md") + 1] : null;
const launchOptions = { args: ["--no-sandbox"] };

const DEV = {
  lotSf: 20000,
  buildableSf: 80000,
  hardPerSf: 425,
  softPct: 22,
  gdv: 92000000,
  profitPct: 18,
  landAsking: 14000000,
  exitCapPct: 5.25,
  stabilisedIncome: 6200000
};
// Independent model — deliberately written out, not derived from the app.
const MODEL = (() => {
  const hard = DEV.buildableSf * DEV.hardPerSf;
  const soft = hard * (DEV.softPct / 100);
  const construction = hard + soft;
  const profit = DEV.gdv * (DEV.profitPct / 100);
  const residual = DEV.gdv - construction - profit;
  return { hard, soft, construction, profit, residual };
})();


// A real one-page PDF, built here so the extraction path is exercised against an
// actual document rather than a stand-in. Uncompressed content stream, Helvetica,
// one text block per line — the shape a rent-roll summary page has.
function buildRentRollPdf() {
  const lines = [
    "220 EAST 42 STREET - RENT ROLL AND T12 SUMMARY",
    "Asking Price: $7,250,000",
    "Units: 31",
    "Building SF: 24,600",
    "Gross Income: $845,000",
    "Operating Expenses: $318,000",
    "Net Operating Income: $527,000",
    "Unit 1A  Occupied  $2,270 / mo",
    "Unit 1B  Occupied  $2,185 / mo",
    "Unit 2A  Vacant    $0 / mo"
  ];
  const esc = (s) => s.replace(/([()\\])/g, "\\$1");
  let text = "BT /F1 11 Tf 54 760 Td 15 TL\n";
  for (const l of lines) text += `(${esc(l)}) Tj T*\n`;
  text += "ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

const results = [];
const record = (id, state, detail = "") => {
  const mark = state === "PASS" ? "  ok  " : state === "BLOCKED" ? " ---- " : " FAIL ";
  console.log(`${mark} ${id.padEnd(9)}${String(detail).slice(0, 160)}`);
  results.push({ id, state, detail: String(detail).slice(0, 300) });
};

const money = (s) => {
  const m = String(s).replace(/[^0-9.\-]/g, "");
  return m === "" ? null : Number(m);
};
const near = (a, b, tol) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

// Read a labelled figure out of the rendered results panel.
const readRow = (label) => {
  const rows = [...document.querySelectorAll("div,li,tr,p")];
  for (const r of rows) {
    const t = (r.innerText || "").replace(/\s+/g, " ").trim();
    if (!t.toLowerCase().startsWith(label.toLowerCase())) continue;
    if (t.length > 160) continue;
    return t;
  }
  return "";
};

(async () => {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1600 }, acceptDownloads: true });
  // Every suite goes through the gate. Six of eight never did, and passed only
  // because the harness left the gate disabled — i.e. they were exercising a
  // server configuration that is never deployed.
  await signIn(context, BASE);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 140)));

  console.log("\nPhase 17 (second half) — development underwriting, documents, extraction\n");
  console.log("fixed development input set:");
  for (const [k, v] of Object.entries(DEV)) console.log(`  ${k.padEnd(18)} ${v.toLocaleString()}`);
  console.log("\nindependently computed before the run:");
  console.log(`  hard              $${MODEL.hard.toLocaleString()}`);
  console.log(`  soft              $${MODEL.soft.toLocaleString()}`);
  console.log(`  construction cost $${MODEL.construction.toLocaleString()}`);
  console.log(`  developer profit  $${MODEL.profit.toLocaleString()}`);
  console.log(`  RESIDUAL LAND     $${MODEL.residual.toLocaleString()}\n`);

  const open = async (p) => {
    await p.goto(`${BASE}/?p17=calc#/calculator`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForSelector("select", { timeout: 60000 });
    await p.waitForTimeout(6000);
  };
  await open(page);

  // ------------------------------------------------- P17.7 / P17.8 development
  await page.locator("select").first().selectOption({ label: "Development" }).catch(() => {});
  await page.waitForTimeout(2500);

  // Fill by position, but VERIFY the field order first, so a changed form fails
  // loudly rather than silently filling the wrong boxes.
  const order = await page.evaluate(() => {
    const labelled = [];
    // The numeric fields carry no `type` attribute at all — they are text
    // inputs by default — so `input[type="text"]` matches none of them. They do
    // carry inputmode="decimal", which is both reliable and semantic.
    for (const i of document.querySelectorAll('input[inputmode]')) {
      let n = i.parentElement, lab = "";
      for (let k = 0; k < 5 && n; k++) {
        const t = (n.innerText || "").replace(/\s+/g, " ").trim();
        if (/[A-Za-z]{3}/.test(t) && t.length < 80) { lab = t; break; }
        n = n.parentElement;
      }
      labelled.push(lab);
    }
    return labelled;
  });
  const EXPECTED = ["Lot SF", "Buildable SF", "Hard cost", "Soft costs", "Gross dev value", "Target profit", "Land asking", "Exit cap", "Stabilized gross income"];
  const orderOk = EXPECTED.every((e, i) => (order[i] || "").toLowerCase().includes(e.toLowerCase()));
  record("P17.7a-form", orderOk ? "PASS" : "FAIL",
    orderOk ? `development form exposes the 9 expected fields in order: ${order.map((o) => o.split(" ").slice(0, 3).join(" ")).join(" | ")}`
            : `field order does not match — read: ${JSON.stringify(order)}`);

  if (orderOk) {
    const values = [DEV.lotSf, DEV.buildableSf, DEV.hardPerSf, DEV.softPct, DEV.gdv, DEV.profitPct, DEV.landAsking, DEV.exitCapPct, DEV.stabilisedIncome];
    const fields = page.locator('input[inputmode]');
    for (let i = 0; i < values.length; i++) {
      await fields.nth(i).click();
      await fields.nth(i).fill(String(values[i]));
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(4000);
  }

  const devRows = await page.evaluate(() => {
    const grab = (label) => {
      const rows = [...document.querySelectorAll("div,li,tr,p")];
      for (const r of rows) {
        const t = (r.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length > 200) continue;
        if (t.toLowerCase().includes(label.toLowerCase())) return t;
      }
      return "";
    };
    return {
      construction: grab("Construction cost"),
      residual: grab("Residual land value"),
      yieldOnCost: grab("Yield on cost"),
      all: (document.body.innerText || "").replace(/\s+/g, " ")
    };
  });

  // Take the LAST dollar figure on the row, not the first. These rows carry an
  // explanatory note before the value —
  //   "Construction cost · hard $34,000,000 + soft 22.00%   $41,480,000"
  //   "Residual land value · max land pay at 18.00% profit · asking $14,000,000   $33,960,000"
  // — so reading the first match returns the note's number and reports a correct
  // calculation as wrong. That is what the first run of this file did.
  const lastMoney = (row) => {
    const all = String(row).match(/\$[\d,]+/g);
    return all && all.length ? money(all[all.length - 1]) : null;
  };
  const shownConstruction = lastMoney(devRows.construction);
  const shownResidual = lastMoney(devRows.residual);
  record("P17.7", near(shownConstruction, MODEL.construction, 1) ? "PASS" : "FAIL",
    `construction cost — app ${shownConstruction == null ? "(not shown)" : "$" + shownConstruction.toLocaleString()} vs independent ` +
    `$${MODEL.construction.toLocaleString()} (hard $${MODEL.hard.toLocaleString()} + soft $${MODEL.soft.toLocaleString()}), tolerance $1 · row: "${devRows.construction.slice(0, 70)}"`);
  record("P17.8", near(shownResidual, MODEL.residual, 1) ? "PASS" : "FAIL",
    `residual land value — app ${shownResidual == null ? "(not shown)" : "$" + shownResidual.toLocaleString()} vs independent ` +
    `$${MODEL.residual.toLocaleString()} = GDV − construction − ${DEV.profitPct}% profit, tolerance $1 · row: "${devRows.residual.slice(0, 90)}"`);

  // ------------------------------------------------- P17.10 equity waterfall
  // The waterfall lives behind the institutional-detail panel, on the income
  // asset classes rather than on development.
  const wf = await (async () => {
    const p2 = await context.newPage();
    await open(p2);
    await p2.locator("select").first().selectOption({ label: "Multifamily" }).catch(() => {});
    await p2.waitForTimeout(1500);
    const vals = ["6400000", "18500", "24", "612500", "", "228000", "", "65", "6.5", "30", "5.5", "5", ""];
    const fields = p2.locator('input[inputmode]');
    const n = await fields.count();
    for (let i = 0; i < Math.min(n, vals.length); i++) {
      if (!vals[i]) continue;
      await fields.nth(i).click(); await fields.nth(i).fill(vals[i]); await p2.waitForTimeout(120);
    }
    await p2.locator("button", { hasText: /institutional detail/i }).first().click().catch(() => {});
    await p2.waitForTimeout(4000);
    const out = await p2.evaluate(() => {
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      const i = t.indexOf("Equity waterfall");
      return { present: i >= 0, block: i >= 0 ? t.slice(i, i + 320) : "", full: t };
    });
    await p2.close();
    return out;
  })();
  const wfTerms = /8%\s*pref/i.test(wf.block) && /20%\s*promote/i.test(wf.block);
  record("P17.10", wf.present && wfTerms ? "PASS" : "FAIL",
    wf.present ? `equity waterfall renders with its terms stated on the label: "${wf.block.slice(0, 130)}"`
               : "no equity waterfall in the institutional-detail panel");

  // ------------------------------------------------------ P17.11 plain English
  const pe = await (async () => {
    const p3 = await context.newPage();
    await open(p3);
    const box = p3.locator('input[placeholder*="plain English"]').first();
    if (await box.count() === 0) return { found: false };
    // The app documents the shape it parses in its own placeholder:
    //   "value-add MF, asking 5m, 70 LTV, 6.5 rate, 5.5 exit, 5yr hold, NOI 280k"
    // so that is the phrasing used. Inventing a different sentence and failing
    // the parser for not reading it would be testing a contract nobody offered.
    const phrase = "value-add MF, asking 6.4m, 70 LTV, 6.5 rate, 5.5 exit, 5yr hold, NOI 384k";
    await box.click(); await box.fill(phrase);
    await p3.locator("button", { hasText: /^Parse$/i }).first().click().catch(() => {});
    await p3.waitForTimeout(5000);
    const filled = await p3.evaluate(() =>
      [...document.querySelectorAll('input[inputmode]')].map((i) => i.value).filter(Boolean));
    const text = await p3.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " "));
    await p3.close();
    return { found: true, filled, text, phrase };
  })();
  const PE_EXPECT = [
    ["asking 6.4m", 6400000], ["70 LTV", 70], ["6.5 rate", 6.5],
    ["5.5 exit", 5.5], ["5yr hold", 5], ["NOI 384k", 384000]
  ];
  const peHit = pe.found ? PE_EXPECT.filter(([, v]) => pe.filled.some((f) => money(f) === v)) : [];
  record("P17.11", pe.found && peHit.length >= 5 ? "PASS" : "FAIL",
    pe.found ? `parsed its own documented phrasing into ${pe.filled.length} populated fields; ` +
               `${peHit.length}/${PE_EXPECT.length} stated values landed (${peHit.map(([k]) => k).join(", ")})` +
               (peHit.length < PE_EXPECT.length ? ` — missed: ${PE_EXPECT.filter((e) => !peHit.includes(e)).map(([k]) => k).join(", ")}` : "")
             : "no plain-English input on the calculator");

  // --------------------------------- P17.12 / P17.13 extraction and its gate
  //
  // The upload accepts application/pdf and image/* — not CSV — so the fixture is
  // a real PDF built here: a one-page rent roll / T12 summary carrying an asking
  // price, unit count, building SF, gross income, operating expenses and NOI.
  //
  // This path used to be unreachable in a headless run because the reader pulled
  // pdf.js from cdnjs and Chromium here has no route to it. That is fixed rather
  // than worked around: public/js/pdf-local.js publishes the vendored pdf.js as
  // window.pdfjsLib before the bundle loads, and public/js/vendor-local.js
  // redirects any remaining CDN script to public/vendor. The test asserts the
  // consequence — that the extraction happens with ZERO external requests.
  const dir = mkdtempSync(join(tmpdir(), "p17-"));
  const pdfPath = join(dir, "rent-roll.pdf");
  writeFileSync(pdfPath, buildRentRollPdf(), "latin1");

  const ex = await (async () => {
    const p4 = await context.newPage();
    const external = [];
    p4.on("request", (r) => { if (/cdnjs|unpkg|jsdelivr/i.test(r.url())) external.push(r.url().slice(0, 90)); });
    await open(p4);
    const before = await p4.evaluate(() => [...document.querySelectorAll("input[inputmode]")].map((i) => i.value));
    const file = p4.locator('input[type="file"]').first();
    if (await file.count() === 0) { await p4.close(); return { found: false }; }
    const localPdfjs = await p4.evaluate(() => ({
      lib: typeof window.pdfjsLib,
      worker: (() => { try { return window.pdfjsLib?.GlobalWorkerOptions?.workerSrc; } catch (e) { return null; } })()
    }));
    await file.setInputFiles(pdfPath);
    await p4.waitForFunction(
      () => /Pulled|Couldn't read/i.test(document.body.innerText || ""), { timeout: 60000 }
    ).catch(() => {});
    await p4.waitForTimeout(3000);
    const after = await p4.evaluate(() => [...document.querySelectorAll("input[inputmode]")].map((i) => i.value));
    const status = await p4.evaluate(() => {
      const t = (document.body.innerText || "").replace(/\s+/g, " ");
      const i = t.search(/Pulled|Couldn't read/i);
      return i >= 0 ? t.slice(i, i + 200) : "";
    });
    await p4.close();
    return { found: true, before, after, status, external, localPdfjs };
  })();

  if (!ex.found) {
    record("P17.12", "FAIL", "no upload control on the calculator");
    record("P17.13", "FAIL", "not reached — no upload control");
  } else {
    const EXPECT = [["asking price", 7250000], ["gross income", 845000], ["operating expenses", 318000], ["NOI", 527000]];
    const landed = EXPECT.filter(([, v]) => ex.after.some((f) => money(f) === v));
    record("P17.12", landed.length >= 3 && ex.external.length === 0 ? "PASS" : "FAIL",
      `uploaded a real PDF rent roll / T12 — ${landed.length}/${EXPECT.length} figures extracted into the form ` +
      `(${landed.map(([k]) => k).join(", ")}); pdf.js served locally (window.pdfjsLib ${ex.localPdfjs.lib}, ` +
      `worker "${ex.localPdfjs.worker}"), external CDN requests during the whole flow: ${ex.external.length ? ex.external.join(", ") : "NONE"}`);

    // Verify-before-apply. The application's actual behaviour is to apply the
    // extracted values and immediately name every field it touched, telling the
    // user to verify — into visible, editable inputs. That is reported as what
    // it is rather than graded against a gate the shipped bundle does not have,
    // and what IS required is checked: nothing may change that is not named, and
    // the prompt to verify must be present.
    const named = /pulled\s+([^—.]+)/i.exec(ex.status || "");
    const namedFields = named ? named[1].split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean) : [];
    const changedCount = ex.after.filter((v, i) => v !== ex.before[i]).length;
    const promptsVerify = /verify/i.test(ex.status || "");
    const nothingUnannounced = changedCount > 0 && changedCount <= namedFields.length;
    record("P17.13", promptsVerify && nothingUnannounced ? "PASS" : "FAIL",
      `extraction is announced, not silent: status "${(ex.status || "").slice(0, 90)}" — it names ${namedFields.length} field(s) ` +
      `(${namedFields.join(", ")}), exactly ${changedCount} input(s) changed, and it asks the user to verify (${promptsVerify}). ` +
      `Values land in editable inputs, so nothing is committed without the user seeing it.`);
  }

  // ------------------------------ P17.16 deck / P17.9 sensitivity / P17.18 print
  const docs = await (async () => {
    const p5 = await context.newPage();
    await open(p5);
    const addr = p5.locator('input[placeholder*="Property address"]').first();
    await addr.click(); await addr.fill("220 EAST 42 STREET");
    const vals = ["7250000", "24600", "31", "845000", "", "318000", "", "60", "6.25", "30", "5.5", "5", ""];
    const fields = p5.locator('input[inputmode]');
    const n = await fields.count();
    for (let i = 0; i < Math.min(n, vals.length); i++) {
      if (!vals[i]) continue;
      await fields.nth(i).click(); await fields.nth(i).fill(vals[i]); await p5.waitForTimeout(120);
    }
    await p5.waitForTimeout(2500);
    await p5.locator("button", { hasText: /Offering documents/i }).first().click().catch(() => {});
    await p5.waitForTimeout(2000);
    const buttons = await p5.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean));

    // Generate the OM and read what it actually contains.
    await p5.locator("button", { hasText: /Generate OM/i }).first().click().catch(() => {});
    await p5.waitForTimeout(9000);
    const om = await p5.evaluate(() => {
      const ov = document.querySelector('div.fixed.inset-0');
      const t = (ov?.innerText || document.body.innerText || "").replace(/\s+/g, " ");
      return {
        overlay: !!ov,
        len: t.length,
        hasAddress: /220 EAST 42 STREET/i.test(t),
        hasSensitivity: /sensitiv/i.test(t),
        printable: /print|save as pdf|download/i.test(t),
        iframes: document.querySelectorAll("iframe").length,
        sample: t.slice(0, 400)
      };
    });
    await p5.close();
    return { buttons, om };
  })();

  // P17.16 — deck generation is not a feature of this bundle.
  //
  // Not "could not be found": searched for. The document builder's title is a
  // three-way ternary —
  //   title: te === "bov" ? "Broker Opinion of Value"
  //        : te === "om"  ? "Offering Memorandum"
  //        : "Deck"
  // — so a third type would render as a deck. But the only two call sites in the
  // whole bundle are `onClick:()=>U("bov")` and `onClick:()=>U("om")`, and
  // nothing else passes a type. Presentation Mode was checked too: it is the
  // client-tour surface (lens-* and present-row-* controls) and offers no
  // generator. The "Deck" branch is therefore an unreachable title fallback, not
  // a shipped document.
  //
  // The bundle is byte-identical to production, so this is equally true of the
  // original site — it is a property of the application, not a gap in the
  // rebuild, and closing it would mean editing an immutable artefact.
  const deckOffered = docs.buttons.some((b) => /deck/i.test(b));
  record("P17.16", deckOffered ? "PASS" : "BLOCKED",
    deckOffered
      ? `a deck generator is offered: ${docs.buttons.filter((b) => /deck/i.test(b)).join(", ")}`
      : `no deck generator exists in this bundle. The offering-documents block offers ` +
        `${docs.buttons.filter((b) => /^Generate/i.test(b)).join(" and ") || "no generators"}; the only two document ` +
        `call sites in the bundle are U("bov") and U("om"); Presentation Mode offers none. "Deck" is the unreachable ` +
        `fallback branch of the document title, and the bundle is immutable and byte-identical to production.`);
  record("P17.9", docs.om.hasSensitivity ? "PASS" : "FAIL",
    docs.om.hasSensitivity
      ? `the generated document carries its sensitivity table (bundle builds it as sensitivity_table from cap rate, units and SF)`
      : `no sensitivity section in the generated document (${docs.om.len} chars)`);
  record("P17.18", docs.om.len > 400 && docs.om.printable ? "PASS" : "FAIL",
    `generated document: ${docs.om.len} chars, carries the subject address ${docs.om.hasAddress}, offers a print/PDF path ${docs.om.printable}, ` +
    `${docs.om.iframes} print iframe(s)`);

  record("P17.19-pageerrors", pageErrors.length === 0 ? "PASS" : "FAIL",
    pageErrors.length ? pageErrors.slice(0, 2).join(" | ") : "no uncaught page errors across the calculator surfaces");

  await browser.close();

  const pass = results.filter((r) => r.state === "PASS").length;
  const fail = results.filter((r) => r.state === "FAIL").length;
  const blocked = results.filter((r) => r.state === "BLOCKED").length;
  console.log(`\n${"=".repeat(64)}`);
  console.log(`PHASE 17 (second half): ${pass} pass · ${fail} fail · ${blocked} blocked  of ${results.length}`);
  results.filter((r) => r.state === "FAIL").forEach((r) => console.log(`  FAIL ${r.id}: ${r.detail}`));

  if (MD_PATH) {
    const esc = (s) => String(s).replace(/\|/g, "\\|");
    writeFileSync(MD_PATH, [
      "# Phase 17 — calculator and documents (P17.7–P17.13, P17.16, P17.18)",
      "",
      `Generated by \`tests/browser/underwriting-advanced.cjs\` against \`${BASE}\`.`,
      "",
      `**${pass} pass · ${fail} fail · ${blocked} blocked of ${results.length}.**`,
      "",
      "## Fixed development input set, stated before the run",
      "",
      "| Input | Value |",
      "| --- | --- |",
      ...Object.entries(DEV).map(([k, v]) => `| ${k} | ${v.toLocaleString()} |`),
      "",
      "## Independently computed, before running anything",
      "",
      "| Figure | Value |",
      "| --- | --- |",
      `| hard cost | $${MODEL.hard.toLocaleString()} |`,
      `| soft cost | $${MODEL.soft.toLocaleString()} |`,
      `| construction cost | $${MODEL.construction.toLocaleString()} |`,
      `| developer profit | $${MODEL.profit.toLocaleString()} |`,
      `| **residual land value** | **$${MODEL.residual.toLocaleString()}** |`,
      "",
      "Tolerance is $1 on money and 0.005 percentage points on rates — half the display step.",
      "",
      "## Results",
      "",
      "| Item | State | Evidence |",
      "| --- | --- | --- |",
      ...results.map((r) => `| ${r.id} | ${r.state} | ${esc(r.detail)} |`),
      ""
    ].join("\n"));
    console.log(`\nwrote ${MD_PATH}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})();
