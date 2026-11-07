// Phase 20 — final verification against the DEPLOYED service.
//
// Diagnostic:
//   SITE_PASSWORD=... node tests/browser/production-verify.cjs <url>
//
// Certification (BLOCKED is fatal):
//   P20_CERTIFY=1 SITE_PASSWORD=... node tests/browser/production-verify.cjs <url>
//
// The deployed /api/status appVariant is authoritative. For the full Owner
// product, SITE_PASSWORD itself must grant Owner. A distinct OWNER_PASSWORD is
// required only when certifying the later APP_VARIANT=user product.
//
// Optional evidence inputs:
//   OWNER_PASSWORD               only required by APP_VARIANT=user
//   P20_SUPABASE_ACCESS_TOKEN    real production Supabase user token; never printed
//   P20_REQUIRED_INTEGRATIONS    comma list of integrations that must be live
//   P20_PERSISTENCE_MARKER       marker created before an external restart/redeploy
//   P20_PREVIOUS_STARTED_AT      /api/status startedAt captured before restart
//   P20_PREVIOUS_RENDER_ID       rndr-id captured before restart
//   P20_KEEP_MARKER=1            retain a newly-created marker for second-run proof
const { chromium } = require("playwright");
const { writeFileSync } = require("node:fs");

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("http")) || "https://lucia-ru5s.onrender.com").replace(/\/$/, "");
const MD_PATH = args.includes("--md") ? args[args.indexOf("--md") + 1] : null;
const SITE_PASSWORD = process.env.SITE_PASSWORD || "";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";
const CERTIFY = process.env.P20_CERTIFY === "1";
const SUPABASE_ACCESS_TOKEN = process.env.P20_SUPABASE_ACCESS_TOKEN || "";
const EXISTING_MARKER = process.env.P20_PERSISTENCE_MARKER || "";
const MARKER = EXISTING_MARKER || `p20-${process.env.RUN_MARKER || Date.now().toString(36)}`;
const PREVIOUS_STARTED_AT = process.env.P20_PREVIOUS_STARTED_AT || "";
const PREVIOUS_RENDER_ID = process.env.P20_PREVIOUS_RENDER_ID || "";
const REQUIRED_INTEGRATIONS = [...new Set(String(process.env.P20_REQUIRED_INTEGRATIONS || "")
  .split(",").map((x) => x.trim()).filter(Boolean))];

const results = [];
function record(id, state, detail = "") {
  const mark = state === "PASS" ? "  ok  " : state === "BLOCKED" ? " ---- " : " FAIL ";
  console.log(`${mark} ${id.padEnd(8)}${String(detail).slice(0, 180)}`);
  results.push({ id, state, detail: String(detail).slice(0, 400) });
}

async function get(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(90000) });
  const text = await r.text().catch(() => "");
  let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, headers: r.headers, text, json };
}
const pipelineRows = (json) => Array.isArray(json) ? json : Array.isArray(json?.rows) ? json.rows : [];

async function gateCookie(password) {
  const r = await fetch(`${BASE}/__gate`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    signal: AbortSignal.timeout(90000)
  });
  const set = r.headers.getSetCookie?.() ?? [];
  return {
    status: r.status,
    cookie: set.map((c) => c.split(";")[0]).join("; "),
    names: set.map((c) => c.split("=", 1)[0])
  };
}

async function instanceOf() {
  const s = await get("/api/status");
  return { startedAt: s.json?.startedAt ?? null, render: s.headers.get("rndr-id") ?? null, status: s.status };
}

(async () => {
  console.log(`\nPhase 20 — deployed verification against ${BASE}${CERTIFY ? " [CERTIFICATION MODE]" : ""}\n`);

  const hz = await get("/healthz");
  record("P20.2", hz.status === 200 ? "PASS" : "FAIL", `/healthz -> HTTP ${hz.status}`);

  const st = await get("/api/status");
  const sub = st.json?.subsystems ?? {};
  const core = st.json?.coreSources ?? {};
  const coreKeys = Object.keys(core);
  const coreHealthy = coreKeys.length
    ? coreKeys.every((k) => core[k] === true)
    : st.json?.dataMode === "live" && sub.pluto && sub.acris && sub.socrata;
  const live = st.status === 200 && st.json?.dataMode === "live" && coreHealthy;
  const APP_VARIANT = st.json?.appVariant === "user" ? "user" : "owner";

  record("P20.11", live ? "PASS" : "FAIL",
    coreKeys.length
      ? `dataMode=${st.json?.dataMode}; core ${coreKeys.filter((k) => core[k]).length}/${coreKeys.length}: ${coreKeys.map((k) => `${k}=${!!core[k]}`).join(", ")}`
      : `dataMode=${st.json?.dataMode}; PLUTO=${!!sub.pluto}, ACRIS=${!!sub.acris}, Socrata=${!!sub.socrata}`);

  const third = ["streetview", "photorealistic3d", "pinecone", "serper", "airtable", "demographics"];
  const on = third.filter((k) => sub[k]);
  const off = third.filter((k) => !sub[k]);
  const missingRequired = REQUIRED_INTEGRATIONS.filter((k) => !sub[k]);
  record("P20.12", missingRequired.length ? "FAIL" : "PASS",
    missingRequired.length
      ? `required integration(s) unavailable: ${missingRequired.join(", ")}; live: ${on.join(", ") || "none"}`
      : `live: ${on.join(", ") || "none"}; unavailable and not faked: ${off.join(", ") || "none"}` +
        (REQUIRED_INTEGRATIONS.length ? `; required set satisfied: ${REQUIRED_INTEGRATIONS.join(", ")}` : ""));

  const p = st.json?.persistence ?? {};
  record("P20.18", p.survivesRedeploy === true ? "PASS" : "FAIL",
    `backend=${p.backend}, survivesRedeploy=${p.survivesRedeploy}, dataDir=${p.dataDir}`);

  if (!SITE_PASSWORD) {
    const why = "SITE_PASSWORD is not supplied; production gate behavior cannot be verified.";
    for (const id of ["P20.3", "P20.4", "P20.5", "P20.6", "P20.7", "P20.8", "P20.9", "P20.10", "P20.13", "P20.14", "P20.15", "P20.16", "P20.17", "P20.19"]) record(id, "BLOCKED", why);
    return report();
  }

  const siteGate = await gateCookie(SITE_PASSWORD);
  const entered = siteGate.status === 303 && /(?:^|; )site_access=/.test(siteGate.cookie);
  record("P20.3", entered ? "PASS" : "FAIL",
    entered ? `real site credential accepted; HTTP ${siteGate.status}` : `site credential rejected; HTTP ${siteGate.status}`);
  if (!entered) {
    for (const id of ["P20.4", "P20.5", "P20.6", "P20.7", "P20.8", "P20.9", "P20.10", "P20.13", "P20.14", "P20.15", "P20.16", "P20.17", "P20.19"]) record(id, "BLOCKED", "not reached because site gate authentication failed");
    return report();
  }
  const authed = { headers: { cookie: siteGate.cookie } };

  const pipeline = await get("/api/pipeline", authed);
  const lots = await get("/api/lot-tiles/16/19298/24633?v=4", authed);
  const baseOk = pipeline.status === 200 && Array.isArray(pipelineRows(pipeline.json)) && lots.status === 200 && (lots.json?.features?.length ?? 0) > 0;
  record("P20.4", baseOk ? "PASS" : "FAIL",
    `site gate: pipeline ${pipeline.status} (${pipelineRows(pipeline.json).length} rows), lot tile ${lots.status} (${lots.json?.features?.length ?? 0} lots)`);

  // Owner contract. In the full Owner build there is deliberately no member
  // tier: the normal site credential must expose the complete product. The
  // separate owner credential is only meaningful in APP_VARIANT=user.
  if (APP_VARIANT === "owner") {
    const ownerStatus = await get("/api/pinecone-status", authed);
    const investors = await get("/api/investors", authed);
    const gateTruth = st.json?.gate ?? {};
    const ownerOk = ownerStatus.status === 200 && ownerStatus.json?.owner === true &&
      investors.status === 200 && investors.json?.owner === true &&
      gateTruth.mode === "owner" && gateTruth.ownerAccessFromSiteCredential === true && gateTruth.ownerDistinct === false;
    record("P20.6", ownerOk ? "PASS" : "FAIL",
      `Owner build: owner flag=${ownerStatus.json?.owner}, investors.owner=${investors.json?.owner}, owner-from-site=${gateTruth.ownerAccessFromSiteCredential}, ownerDistinct=${gateTruth.ownerDistinct}`);
  } else if (!OWNER_PASSWORD) {
    record("P20.6", "BLOCKED", "APP_VARIANT=user requires OWNER_PASSWORD to test the distinct owner tier.");
  } else {
    const og = await gateCookie(OWNER_PASSWORD);
    const ownerAuthed = { headers: { cookie: og.cookie } };
    const ownerStatus = await get("/api/pinecone-status", ownerAuthed);
    const ownerOnly = await get("/api/investors", ownerAuthed);
    const memberSame = await get("/api/investors", authed);
    const ownerOk = og.status === 303 && ownerStatus.json?.owner === true && ownerOnly.json?.owner === true && memberSame.json?.owner !== true;
    record("P20.6", ownerOk ? "PASS" : "FAIL",
      `User build split: owner=${ownerStatus.json?.owner}, owner investors=${ownerOnly.json?.owner}, member investors=${memberSame.json?.owner}`);
  }

  // The exact browser bundle performs My Desk table operations directly against
  // Supabase. A real access token remains useful evidence that this deployment's
  // active Supabase identity can be resolved server-side too, but absence is a
  // named certification blocker rather than a fabricated PASS.
  if (!SUPABASE_ACCESS_TOKEN) {
    record("P20.5", "BLOCKED", "P20_SUPABASE_ACCESS_TOKEN not supplied; real production Supabase identity is not certified.");
  } else {
    const signed = await get("/api/pipeline", { headers: { cookie: siteGate.cookie, authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
    const signedOk = signed.status === 200 && Array.isArray(pipelineRows(signed.json));
    record("P20.5", signedOk ? "PASS" : "FAIL",
      signedOk ? `real Supabase bearer resolved; user-scoped compatibility route returned ${pipelineRows(signed.json).length} row(s)`
        : `real Supabase bearer was not accepted; HTTP ${signed.status}`);
  }

  // Durable shared Pipeline proof.
  const STAGE = "Watchlist";
  const board = await get("/api/pipeline", authed);
  const beforeRows = pipelineRows(board.json).length;
  let row = null;
  if (EXISTING_MARKER) {
    row = pipelineRows(board.json).find((r) => r.oppId === MARKER);
    record("P20.7", row ? "PASS" : "FAIL", row ? `pre-restart marker ${MARKER} is present` : `pre-restart marker ${MARKER} is missing`);
    record("P20.8", row ? "PASS" : "FAIL", row ? `fresh GET contains ${MARKER} at ${row.stage}` : `fresh GET does not contain ${MARKER}`);
  } else {
    const wrote = await get("/api/pipeline", {
      method: "POST",
      headers: { cookie: siteGate.cookie, "content-type": "application/json" },
      body: JSON.stringify({ oppId: MARKER, stage: STAGE })
    });
    const wroteOk = wrote.status === 200 && wrote.json?.ok === true && wrote.json?.durable !== false;
    const readBack = await get("/api/pipeline", authed);
    const afterRows = pipelineRows(readBack.json);
    row = afterRows.find((r) => r.oppId === MARKER);
    record("P20.7", wroteOk ? "PASS" : "FAIL", `POST marker -> HTTP ${wrote.status}; durable=${wrote.json?.durable}`);
    record("P20.8", row ? "PASS" : "FAIL",
      row ? `fresh GET found ${row.oppId} at ${row.stage}; board ${beforeRows} -> ${afterRows.length}` : `fresh GET did not contain marker`);
  }

  const currentInstance = await instanceOf();
  const hasPreviousIdentity = !!(PREVIOUS_STARTED_AT || PREVIOUS_RENDER_ID);
  const instanceChanged = hasPreviousIdentity && (
    (PREVIOUS_STARTED_AT && currentInstance.startedAt && PREVIOUS_STARTED_AT !== currentInstance.startedAt) ||
    (PREVIOUS_RENDER_ID && currentInstance.render && PREVIOUS_RENDER_ID !== currentInstance.render)
  );

  if (EXISTING_MARKER && hasPreviousIdentity) {
    record("P20.9", instanceChanged ? "PASS" : "FAIL",
      instanceChanged ? `service instance changed: startedAt=${currentInstance.startedAt}, rndr-id=${currentInstance.render || "n/a"}` : "supplied previous identity does not prove a changed instance");
    record("P20.10", instanceChanged && !!row && p.survivesRedeploy === true ? "PASS" : "FAIL",
      instanceChanged && row && p.survivesRedeploy === true ? `marker ${MARKER} survived changed instance via ${p.backend}`
        : `changed=${instanceChanged}, markerPresent=${!!row}, survivesRedeploy=${p.survivesRedeploy}`);
  } else {
    record("P20.9", "BLOCKED",
      `external restart not yet evidenced. Preserve marker=${MARKER}, startedAt=${currentInstance.startedAt || ""}${currentInstance.render ? `, rndr-id=${currentInstance.render}` : ""} and rerun after restart.`);
    record("P20.10", p.survivesRedeploy === true ? "BLOCKED" : "FAIL",
      p.survivesRedeploy === true ? `durable backend exists, but a changed instance must read marker ${MARKER}` : "service reports survivesRedeploy=false");
  }

  // Deployed browser sweep. Owner-only routes are expected from SITE_PASSWORD in
  // the Owner product. My Desk may show its sign-in state when no Supabase user
  // is present; that is still the correct route and must fit the viewport.
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ROUTES = ["/", "/dossier", "/pipeline", "/live", "/territory", "/radar", "/calculator", "/comps", "/present", "/investors", "/sources", "/desk"];
  const viewports = [
    ["desktop", { width: 1440, height: 900 }, "P20.14"],
    ["phone", { width: 390, height: 844 }, "P20.15"]
  ];
  const pageErrors = [], failedRequests = [], mounted = {};

  for (const [label, viewport, itemId] of viewports) {
    const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
    await ctx.request.post(`${BASE}/__gate`, { form: { password: SITE_PASSWORD } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${label}: ${String(e.message).slice(0, 120)}`));
    page.on("response", (r) => {
      if (r.status() >= 400 && r.url().startsWith(BASE)) failedRequests.push(`${label}: ${r.status()} ${r.url().replace(BASE, "")}`);
    });
    const ok = [];
    for (const route of ROUTES) {
      await page.goto(`${BASE}/?p20=${label}${route.replace(/\W/g, "")}#${route}`, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(3500);
      const body = await page.evaluate(() => (document.getElementById("root")?.innerText || "").trim().length).catch(() => 0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1).catch(() => false);
      if (body > 200 && !overflow) ok.push(route);
      if (overflow) failedRequests.push(`${label}: ${route} overflows horizontally`);
    }
    mounted[label] = ok;
    record(itemId, ok.length === ROUTES.length ? "PASS" : "FAIL",
      `${label} ${viewport.width}×${viewport.height}: ${ok.length}/${ROUTES.length} routes render and fit` +
      (ok.length === ROUTES.length ? "" : `; missing ${ROUTES.filter((r) => !ok.includes(r)).join(", ")}`));
    await ctx.close();
  }
  await browser.close();

  record("P20.13", (mounted.desktop?.length ?? 0) === ROUTES.length ? "PASS" : "FAIL",
    `${mounted.desktop?.length ?? 0}/${ROUTES.length} primary pages verified on deployed service`);
  record("P20.16", pageErrors.length === 0 ? "PASS" : "FAIL",
    pageErrors.length ? `${pageErrors.length} uncaught error(s): ${pageErrors.slice(0, 2).join(" | ")}` : "no uncaught browser errors across desktop + phone");
  const networkFailures = failedRequests.filter((f) => !/overflows horizontally/.test(f));
  record("P20.17", networkFailures.length === 0 ? "PASS" : "FAIL",
    networkFailures.length ? `${networkFailures.length} same-origin HTTP failure(s): ${networkFailures.slice(0, 3).join(" | ")}` : "all observed same-origin requests succeeded");

  if (process.env.P20_KEEP_MARKER === "1" && !EXISTING_MARKER) {
    record("P20.19", "BLOCKED", `probe ${MARKER} intentionally retained for restart/redeploy verification`);
  } else {
    const deleted = await get(`/api/pipeline/${encodeURIComponent(MARKER)}`, { method: "DELETE", headers: { cookie: siteGate.cookie } });
    const finalBoard = await get("/api/pipeline", authed);
    const stillThere = pipelineRows(finalBoard.json).find((r) => r.oppId === MARKER);
    const cleaned = (deleted.status === 204 || deleted.status === 200) && !stillThere;
    record("P20.19", cleaned ? "PASS" : "FAIL",
      cleaned ? `probe ${MARKER} deleted durably and absent on fresh GET` : `DELETE ${deleted.status}; marker ${stillThere ? "still exists" : "is absent"}`);
  }

  return report();

  function report() {
    const pass = results.filter((r) => r.state === "PASS").length;
    const fail = results.filter((r) => r.state === "FAIL").length;
    const blocked = results.filter((r) => r.state === "BLOCKED").length;
    console.log(`\n${"=".repeat(64)}`);
    console.log(`PHASE 20: ${pass} pass · ${fail} fail · ${blocked} blocked of ${results.length}${CERTIFY ? " [CERTIFY]" : ""}`);
    results.filter((r) => r.state === "FAIL").forEach((r) => console.log(`  FAIL ${r.id}: ${r.detail}`));
    results.filter((r) => r.state === "BLOCKED").forEach((r) => console.log(`  BLOCKED ${r.id}: ${r.detail.slice(0, 140)}`));

    if (MD_PATH) {
      const esc = (s) => String(s).replace(/\|/g, "\\|");
      writeFileSync(MD_PATH, [
        "# Phase 20 — final production verification", "",
        `Generated by \`tests/browser/production-verify.cjs\` against \`${BASE}\`${CERTIFY ? " in certification mode" : ""}.`, "",
        `**${pass} pass · ${fail} fail · ${blocked} blocked of ${results.length}.**`, "",
        `Deployment variant observed: **${APP_VARIANT}**.`,
        "No credential value appears in this file. Where an item is blocked, the blocker is named.",
        CERTIFY ? "Certification mode treats BLOCKED as a release failure." : "Diagnostic mode reports BLOCKED without converting it to PASS.", "",
        "| Item | State | Evidence |", "| --- | --- | --- |",
        ...results.map((r) => `| ${r.id} | ${r.state} | ${esc(r.detail)} |`), ""
      ].join("\n"));
      console.log(`\nwrote ${MD_PATH}`);
    }
    process.exit(fail > 0 || (CERTIFY && blocked > 0) ? 1 : 0);
  }
})().catch((e) => { console.error("FATAL", e); process.exit(1); });