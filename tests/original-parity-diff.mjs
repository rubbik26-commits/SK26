// Compare this rebuild's API against the original site's, field by field.
//
//   ORIGINAL_PASSWORD=… node tests/original-parity-diff.mjs [rebuildBaseUrl]
//
// WHY THIS EXISTS
// The whole brief is "identical". Every check written before this one compared
// the rebuild against a RECORD — PLUTO, ACRIS, DOB — which proves the numbers
// are true but not that they are the same numbers the original produces. The
// only thing that proves identical is the original itself, and until the site
// password was available it could not be read.
//
// So this drives both systems through the same gate, asks them the same
// questions, and diffs the answers. Where they differ it says exactly which
// field, on which endpoint, with both values.
//
// WHAT A DIFFERENCE MEANS
// Not every difference is a defect, and this does not pretend otherwise:
//
//   * `fetchedAt`, `windowStart/End` and anything else derived from "now" move
//     between two calls made seconds apart. Listed as VOLATILE and excluded
//     from the verdict.
//   * Live public records change under both systems — a deed recorded between
//     the two calls moves a sales count legitimately. Numeric fields are
//     compared with a stated tolerance rather than demanded exact, and the
//     tolerance is reported.
//   * Anything structural — a key present in one and missing in the other, a
//     different type, a different shape — is a real parity failure and is
//     reported as one.
const ORIGIN = "https://nycremarketintel.com";
const PASSWORD = process.env.ORIGINAL_PASSWORD || "creintel2026";
const REBUILD = (process.argv[2] || "http://localhost:5175").replace(/\/$/, "");

// The questions. Same query on both sides, chosen to cover the surfaces the
// owner's audit called out: market report, pipeline, dossier, comps, opportunities.
const PROBES = [
  ["/api/market-report?zips=11216", "market report — Bed-Stuy"],
  ["/api/market-report?zips=10002", "market report — Lower East Side"],
  ["/api/market-report?zips=10451", "market report — South Bronx"],
  ["/api/pipeline?zips=11216", "DOB development pipeline"],
  ["/api/asset-history?bbl=1008350041", "dossier — asset history"],
  ["/api/distress?bbl=1008350041", "dossier — distress"],
  ["/api/tax-history?bbl=1008350041", "dossier — tax history"],
  ["/api/cliffs?bbl=1008350041", "dossier — regulatory cliffs"],
  ["/api/transit?bbl=1008350041", "dossier — transit"],
  ["/api/assemblage?bbl=1008350041", "dossier — assemblage"],
  ["/api/similar?bbl=1008350041", "dossier — similar properties"],
  ["/api/opportunities", "market intel — opportunities"]
];

// Fields that legitimately move between two calls seconds apart.
const VOLATILE = /^(fetchedAt|generatedAt|asOf|windowStart|windowEnd|timestamp|updated_at|distribution|narrative|sources|macro)(\.|$)/;
// Live-record drift tolerance on numbers, as a fraction. A deed recorded between
// the two calls is not a parity defect; a 40% difference is.
const NUM_TOL = 0.02;

const login = async (base) => {
  const r = await fetch(`${base}/__gate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(60000)
  });
  const raw = r.headers.getSetCookie?.() ?? [];
  const jar = raw.map((c) => c.split(";")[0]).join("; ");
  return { status: r.status, jar };
};

const get = async (base, path, jar) => {
  const r = await fetch(`${base}${path}`, {
    headers: jar ? { cookie: jar } : {},
    signal: AbortSignal.timeout(120000)
  });
  const text = await r.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body, text };
};

// Walk both shapes together and collect differences.
function diff(a, b, path = "", out = { missingInRebuild: [], missingInOriginal: [], typeMismatch: [], valueMismatch: [], volatile: [], numericDrift: [] }) {
  if (VOLATILE.test(path)) { out.volatile.push(path); return out; }
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) { out.typeMismatch.push(`${path}: original ${ta}, rebuild ${tb}`); return out; }

  if (ta === "array") {
    if (a.length !== b.length) out.valueMismatch.push(`${path}.length: original ${a.length}, rebuild ${b.length}`);
    // Compare the first element's SHAPE — element order depends on live data.
    if (a.length && b.length) diff(a[0], b[0], `${path}[0]`, out);
    return out;
  }
  if (ta === "object") {
    for (const k of Object.keys(a)) {
      if (!(k in b)) { if (!VOLATILE.test(path ? `${path}.${k}` : k)) out.missingInRebuild.push(path ? `${path}.${k}` : k); }
      else diff(a[k], b[k], path ? `${path}.${k}` : k, out);
    }
    for (const k of Object.keys(b)) {
      if (!(k in a) && !VOLATILE.test(path ? `${path}.${k}` : k)) out.missingInOriginal.push(path ? `${path}.${k}` : k);
    }
    return out;
  }
  if (ta === "number") {
    if (a === b) return out;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    if (Math.abs(a - b) / scale <= NUM_TOL) out.numericDrift.push(`${path}: ${a} vs ${b}`);
    else out.valueMismatch.push(`${path}: original ${a}, rebuild ${b}`);
    return out;
  }
  if (a !== b) out.valueMismatch.push(`${path}: original ${JSON.stringify(a)}, rebuild ${JSON.stringify(b)}`);
  return out;
}

(async () => {
  console.log("\nOriginal-vs-rebuild parity diff");
  console.log(`  original : ${ORIGIN}`);
  console.log(`  rebuild  : ${REBUILD}`);
  console.log(`  numeric tolerance ${NUM_TOL * 100}% (live records move between two calls)\n`);

  const o = await login(ORIGIN);
  const r = await login(REBUILD).catch(() => ({ status: 0, jar: "" }));
  console.log(`  gate: original ${o.status}${o.jar ? " (session)" : ""}, rebuild ${r.status}${r.jar ? " (session)" : " (no gate / open)"}\n`);
  if (!o.jar) { console.error("could not sign in to the original — cannot diff"); process.exit(2); }

  let clean = 0, differing = 0, unreachable = 0;
  const report = [];

  for (const [path, label] of PROBES) {
    const A = await get(ORIGIN, path, o.jar);
    const B = await get(REBUILD, path, r.jar);

    if (A.status !== 200 || A.body === null) {
      console.log(` ---- ${label.padEnd(34)} original answered ${A.status}${A.body === null ? " (non-JSON)" : ""} — nothing to compare against`);
      unreachable++; continue;
    }
    if (B.status !== 200 || B.body === null) {
      console.log(` FAIL ${label.padEnd(34)} rebuild answered ${B.status}${B.body === null ? " (non-JSON)" : ""} where the original answered 200`);
      differing++; report.push({ label, path, fatal: `rebuild ${B.status}` }); continue;
    }

    const d = diff(A.body, B.body);
    const hard = d.missingInRebuild.length + d.missingInOriginal.length + d.typeMismatch.length + d.valueMismatch.length;
    if (hard === 0) {
      console.log(`  ok  ${label.padEnd(34)} identical (${d.volatile.length} volatile, ${d.numericDrift.length} within tolerance)`);
      clean++;
    } else {
      console.log(` FAIL ${label.padEnd(34)} ${hard} difference(s)`);
      for (const k of ["missingInRebuild", "missingInOriginal", "typeMismatch", "valueMismatch"]) {
        for (const line of d[k].slice(0, 6)) console.log(`        ${k}: ${line}`);
        if (d[k].length > 6) console.log(`        ${k}: … ${d[k].length - 6} more`);
      }
      differing++; report.push({ label, path, d });
    }
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`PARITY DIFF: ${clean} identical · ${differing} differing · ${unreachable} not comparable  of ${PROBES.length}`);
  process.exit(differing ? 1 : 0);
})();
