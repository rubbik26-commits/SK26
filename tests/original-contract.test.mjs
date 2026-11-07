// The API contract from the source zip, enforced.
//
// WHY THIS EXISTS
// nycdevintelclonev2_2.zip/server.js is the shape specification for this
// system: fifteen endpoints, each with a fixed response shape the compiled
// frontend in nycremarketintelsite_2.zip was built against. That file is a MOCK
// — it imports lib/mockData.js, prints "Mock NYC Dev Intel server running", and
// fabricates the values it returns:
//
//   /api/zip-at      "10" + (block % 100)        -> "1035" for the Empire State Building
//   /api/transit     Math.round(100 + Math.random() * 900)
//   /api/tax-history bldgSf * (30 + i * 2)
//   /api/cliffs      a hardcoded 2011-05-14 deed from "Prior Owner LLC (mock)"
//   /api/contacts    "Not available in mock data"
//
// and the frontend export's own README says the real backend "and underlying
// dataset are NOT included here". So the mock's VALUES cannot be copied — doing
// so would ship invented property data — but its SHAPE is the contract, and
// every endpoint it declares must exist and answer.
//
// This test pins exactly that: the endpoint list, and for each one the fields
// the mock returns. Values come from live public records; only the shape is
// asserted here. If someone drops an endpoint, renames a field, or lets one
// start answering 404/503, this fails.
//
//   node --test tests/original-contract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.CONTRACT_TEST_PORT || 5187);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "contract-test-password";
const BBL = "1008350041";              // Empire State Building
const LAT = 40.7484514, LNG = -73.9857117;

// Every endpoint the original server.js declares, with the response fields it
// returns. `oneOf` means the mock returned a bare value the live version may
// legitimately shape differently (an array vs an envelope) — the test accepts
// either but still requires the endpoint to answer.
const CONTRACT = [
  { path: `/api/nta-polys?bbox=-74.02,40.70,-73.95,40.78`, fields: ["features"] },
  { path: `/api/opportunities`, array: true },
  { path: `/api/lot-at?lat=${LAT}&lng=${LNG}`, fields: ["bbl"] },
  { path: `/api/zip-at?lat=${LAT}&lng=${LNG}`, fields: ["zip"] },
  { path: `/api/address?q=350 5 Avenue`, fields: ["fetchedAt", "total", "returned", "coverage", "buildings"] },
  { path: `/api/gov-links?bbl=${BBL}`, fields: ["acris", "propertyInformationPortal", "buildingsProfile", "zoningMap"] },
  { path: `/api/tax-history?bbl=${BBL}`, fields: ["rows"], rowFields: ["year", "assessedTotal", "taxClass"] },
  { path: `/api/cliffs?bbl=${BBL}`, anyField: ["ll97", "j51", "ll33"] },
  { path: `/api/distress?bbl=${BBL}`, anyField: ["hpd", "threeOneOne", "ecb", "distressScore"] },
  { path: `/api/assemblage?bbl=${BBL}`, anyField: ["count", "lots", "candidateLots"] },
  { path: `/api/transit?bbl=${BBL}`, anyField: ["nearest", "within", "lines"] },
  { path: `/api/contacts?bbl=${BBL}`, anyField: ["permitContacts", "ownerEntities", "hpdContacts", "owner"] },
  { path: `/api/owner-portfolio?owner=${encodeURIComponent("ESRT EMPIRE STATE BUILDING, L.L.C.")}`, anyField: ["total", "sample", "parcels"] },
  { path: `/api/liensale?bbl=${BBL}`, anyField: ["onList", "onLienSaleList", "records"] },
  { path: `/api/listing-check?bbl=${BBL}&addr=350 5 Avenue&boro=1`, anyField: ["configured", "onMarket"] }
];

// The mock's fabrications, as literal values. None of them may ever appear in a
// response: they are the specific numbers that would prove the live server had
// been replaced by the scaffold.
const FORBIDDEN = [
  { what: 'the mock ZIP for this lot ("10" + block % 100)', probe: `/api/zip-at?lat=${LAT}&lng=${LNG}`, absent: /"zip"\s*:\s*"1035"/ },
  { what: "the mock's hardcoded deed party", probe: `/api/cliffs?bbl=${BBL}`, absent: /Prior Owner LLC/i },
  { what: "the mock's contact placeholder", probe: `/api/contacts?bbl=${BBL}`, absent: /Not available in mock data/i },
  { what: "the mock's assemblage disclaimer", probe: `/api/assemblage?bbl=${BBL}`, absent: /Mock adjacency read/i }
];

let server, jar = "";

const startServer = async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), SITE_PASSWORD: PASSWORD, NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (b) => { stderr += b.toString(); });
  for (let i = 0; i < 200; i++) {
    try { await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) }); return; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`server did not start on ${BASE}\n${stderr.slice(-800)}`);
};

const signIn = async () => {
  const r = await fetch(`${BASE}/__gate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(30000)
  });
  jar = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
};

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie: jar }, signal: AbortSignal.timeout(180000) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* asserted below */ }
  return { status: r.status, body, text };
};

// Is the SOURCE down, or is the APP wrong?
//
// Every contract below reads live NYC public records. When that platform is
// down — it answers HTTP 503 with an HTML "Site Currently Unavailable" — the app
// correctly refuses and returns {"provenance":"unavailable","error":
// "pluto_unavailable"}, and this suite went red on nine assertions that had
// nothing to do with the code. A gate that fails whenever a third party has an
// outage is a gate people stop reading.
//
// So the platform is probed ONCE, directly, outside the application. If it is
// down, a live-data contract cannot be evaluated at all and the test is skipped
// with the reason attached — not passed, and not failed. If it is up, a 503 from
// our own endpoint is a real failure and still fails, which is the case that
// matters.
// Probing ONE dataset could not see an outage in a DIFFERENT one, and that is
// exactly how this gate failed a correct refusal. Measured on build
// dep-dacvlaou01pc7396flc0 (2026-09-03 22:58 UTC), on a tree that had built
// green twice the same day:
//
//   not ok 12 - /api/contacts answers and keeps the original's shape
//     /api/contacts?bbl=1008350041 answered 503:
//       {"provenance":"unavailable","error":"contacts_sources_partial", ...}
//     expected: 200   actual: 503
//
// server/production-dossier-source-guard.js:68-77 gates /api/contacts on DOB
// Permit Issuance, HPD Registration Contacts and ACRIS recorded parties, and
// refuses if ANY of the three is not live. The probe below used to ask only
// 64uk-42ks — PLUTO (server/adapters/nyc.js:25) — which that route never reads.
// PLUTO answered fine, so the refusal was scored as a defect and the deploy
// failed on a third-party outage.
//
// Dataset ids are the ones in server/adapters/nyc.js:24-45.
const UPSTREAM_DATASETS = [
  ["PLUTO", "64uk-42ks"],
  ["DOB Permit Issuance", "ipu4-2q9a"],
  ["HPD Registration Contacts", "feu5-w2e2"],
  ["ACRIS legals", "8h5j-fqxa"],
  ["ACRIS parties", "636b-3b5g"]
];

// Returns "" when every dataset these contracts read answered correctly,
// otherwise the reason the first unhealthy one gave. This mirrors the app's own
// rule exactly: the guard refuses when ANY required source is not live, so ANY
// unreachable required dataset makes a refusal legitimate.
async function readUpstream() {
  for (const [label, id] of UPSTREAM_DATASETS) {
    try {
      const r = await fetch(`https://data.cityofnewyork.us/resource/${id}.json?$limit=1`,
        { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return `${label} (${id}) answered HTTP ${r.status}`;
      const b = await r.json().catch(() => null);
      if (!Array.isArray(b)) return `${label} (${id}) returned a non-array body`;
    } catch (e) {
      return `${label} (${id}) unreachable: ${String(e?.message ?? e).slice(0, 80)}`;
    }
  }
  return "";
}

let upstreamDown = "";
async function probeUpstream() {
  upstreamDown = await readUpstream();
}

test.before(async () => { await probeUpstream(); await startServer(); await signIn(); });
test.after(() => { try { server?.kill("SIGKILL"); } catch { /* already gone */ } });

for (const c of CONTRACT) {
  const name = c.path.split("?")[0];
  test(`${name} answers and keeps the original's shape`, async (t) => {
    const r = await get(c.path);
    // Only an upstream outage earns a skip, and only when the response is the
    // app's honest refusal. Anything else is a real failure.
    const refused = (r.status === 503 || r.status === 404) && /unavailable|not_?found/i.test(r.text);
    // Take a FRESH reading on a refusal rather than trusting the start-of-suite
    // one. This suite runs for minutes against a single unauthenticated IP, and
    // the start reading goes stale inside its own runtime: measured 2026-09-03,
    // the start probe reported healthy at 22:20:16 and /api/contacts was
    // correctly refused at 22:21:27, seventy seconds later, with upstreamDown
    // still empty. `upstreamDown` stays as the recorded starting condition.
    const outage = refused ? await readUpstream() : "";
    if (refused && outage) {
      return t.skip(`${outage} — the app correctly refused (${r.text.slice(0, 400)}); the contract cannot be evaluated without the source`);
    }
    // 400 chars, not 200: the guard reports WHICH sources failed in
    // `missingSources`, and truncating at 200 cut that off, leaving no way to
    // tell from a build log which source was actually down.
    assert.equal(r.status, 200, `${c.path} answered ${r.status}: ${r.text.slice(0, 400)}`);
    assert.notEqual(r.body, null, `${c.path} did not return JSON: ${r.text.slice(0, 400)}`);

    if (c.array) {
      assert.ok(Array.isArray(r.body), `${c.path} must return an array, got ${typeof r.body}`);
      return;
    }
    const body = Array.isArray(r.body) ? { rows: r.body } : r.body;

    for (const f of c.fields ?? []) {
      assert.ok(f in body, `${c.path} is missing the contract field "${f}" (has: ${Object.keys(body).join(",")})`);
    }
    if (c.anyField) {
      const present = c.anyField.filter((f) => f in body);
      assert.ok(present.length > 0,
        `${c.path} has none of the contract fields ${c.anyField.join("/")} (has: ${Object.keys(body).join(",")})`);
    }
    if (c.rowFields) {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      assert.ok(rows.length > 0, `${c.path} returned no rows`);
      for (const f of c.rowFields) {
        assert.ok(f in rows[0], `${c.path} row is missing "${f}" (has: ${Object.keys(rows[0]).join(",")})`);
      }
    }
  });
}

for (const f of FORBIDDEN) {
  test(`no mock value survives: ${f.what}`, async () => {
    const r = await get(f.probe);
    assert.ok(!f.absent.test(r.text),
      `${f.probe} returned ${f.what} — the scaffold's fabricated value reached a response:\n${r.text.slice(0, 300)}`);
  });
}

// The two compiled bundle files are the parity contract with the frontend and
// must stay byte-identical to the export. Everything else in this repository is
// free to change; these two are not.
test("the compiled frontend is byte-identical to the export", async () => {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const PINNED = {
    "public/assets/index-BbnE3o5g.js": "4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8",
    "public/assets/index-shmfCHKD.css": "d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b"
  };
  for (const [rel, want] of Object.entries(PINNED)) {
    const got = createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex");
    assert.equal(got, want, `${rel} drifted from the export`);
  }
});
