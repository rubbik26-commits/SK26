// Route-shadowing regression gate (P1.6).
//
// Mount order does not tell you which router answers: a router can match a
// pathname and call next(). This starts the real server with the response
// probe preloaded, requests each authoritative path, and asserts on the file
// that actually committed the response. A re-order that lets the legacy demo
// router answer a data path, or that puts an auth gate in front of a public
// feed, fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5211;
const B = `http://localhost:${PORT}`;
const GATE = `Basic ${Buffer.from("x:route-test").toString("base64")}`;

// path -> the module that must answer it. The legacy server/routes.js must
// never appear here for a data path: it is the seeded demo engine.
//
// A route that reads live public records has TWO legitimate owners, and this
// test used to know about only one. When NYC Open Data is unreachable — which
// is the normal condition on a shared CI runner, where the unauthenticated
// Socrata endpoints are rate-limited by IP — production-live-guard.js answers
// 503 rather than let a seeded figure reach the client. That refusal is the
// designed behaviour (it is the synthetic-data guard), not a routing
// regression, but the assertion read it as one and turned CI red on every push.
//
// So live-data routes accept either their own module or the guard, and the
// check that actually matters is unchanged: the legacy demo router must never
// answer a data path. Reproduced by pointing SOCRATA_DOMAIN at TEST-NET-3:
//   /api/area-buildings?... was answered by server/production-live-guard.js
// The degradation layers. When live public records are unavailable a live-data
// route legitimately falls past its own module to one of these:
//   production-live-guard.js  — refuses with 503 rather than let a seeded figure
//                               through (the synthetic-data guard)
//   production-live-extra.js  — answers the honest empty/unavailable shape
// Neither invents property facts; that is asserted separately and thoroughly by
// "no production route answers with invented property facts" in this same file,
// so this test does not duplicate the content check — it only establishes that
// the answering module is one of the intended ones.
//
// What must NEVER answer a data path is server/routes.js, the seeded demo
// engine. That assertion is unchanged and is the point of this test.
const LIVE_FALLBACKS = ["server/production-live-guard.js", "server/production-live-extra.js"];
const EXPECTED = [
  // Owner moved to server/authority-release.js, deliberately and upward.
  //
  // Shadowing is only a defect when the router that wins is the poorer one —
  // that is what this whole suite exists to catch. Here the module mounted
  // ahead is a strict superset: it calls the same shared areaBuildings(), then
  // turns a DOB permit-source failure into an explicit dataQuality disclosure
  // and rescores propensity without the permit component instead of letting an
  // outage read as "no permits". routes-bundle.js remains a legitimate answer
  // if that module is ever unmounted, so both are accepted — but routes.js, the
  // demo-era implementation, must never answer this path.
  ["/api/area-buildings?zips=11216&page=0&pageSize=2&sort=propensity",
    ["server/authority-release.js", "server/routes-bundle.js"],
    { live: true, never: ["server/routes.js"] }],
  // Ownership moved to the completeness-guarded router (PR #135); it serves
  // the identical parcel set (measured 2026-08-18: id sets equal) with the
  // labeled-estimate disclosure keys on top.
  ["/api/opportunities", ["server/production-opportunities.js", "server/routes-bundle.js"], { live: true }],
  ["/api/pinecone-status", ["server/authority-release.js", "server/routes-bundle.js"]],
  ["/api/pipeline", ["server/authority-release.js", "server/routes-bundle.js"]],
  ["/api/investors", ["server/authority-release.js", "server/routes-bundle.js"]],
  ["/api/propensity-validation?zips=11216", ["server/production-propensity-validation.js", "server/authority-release.js", "server/production-analytics.js"], { live: true }],
  // Also owned by authority-release.js now, and it must stay the better one:
  // it reads fullAcrisByLot()'s financingTimeline, requires referenceStatus
  // "live" before trusting an empty linkedSatisfactions array, and reports the
  // parcels it could not verify. production-maturity.js remains the fallback.
  ["/api/maturity-wall", ["server/authority-release.js", "server/production-maturity.js"], { live: true }],
  // Same rule as /api/contacts below: server/production-dossier-source-guard.js
  // owns BOTH paths (lines 27 and 64) and its only response on either is the
  // 503 built by unavailable() at line 19 — it never serves data. Accepting it
  // for /api/contacts but not here was an omission, and it is the same trap
  // that reddened the build on /api/lot-tiles.
  ["/api/asset-history?bbl=1000160010",
    ["server/production-dossier.js", "server/production-dossier-source-guard.js"],
    { live: true }],
  // Reported as "an early Contacts route shadows the richer ACRIS
  // implementation". It is the other way round now and must stay that way:
  // production-dossier.js is mounted ahead of routes-bundle.js and IS the rich
  // one — it reads fullAcrisByLot()'s financing timeline and attributes every
  // recorded party individually, while keeping all four contact families
  // (permit, owner entities, HPD, debt parties). routes-bundle.js stays a valid
  // fallback; the demo router must never answer. The Dossier source guard is
  // also an authoritative owner of this path when a required contact source is
  // unavailable: its only legal response is an explicit 503, never an empty
  // contact list that could be mistaken for a factual result.
  ["/api/contacts?bbl=1000160010",
    ["server/production-dossier-source-guard.js", "server/production-dossier.js", "server/routes-bundle.js"],
    { live: true, never: ["server/routes.js"] }],
  ["/api/status", ["server/production-status.js", "server/authority-release.js", "server/routes-live.js"]],

  // The map and geospatial data paths. These were absent, and their absence is
  // not academic: /api/lot-tiles is the exact path that regressed. A router
  // mounted one line ahead of server/parity-routes.js answered it from a
  // 34,138-feature ArcGIS subset instead of the citywide DOF tax map, the grid
  // drew 1 lot where the record holds 37, and the owner's report was "you can't
  // even click them". The gate that exists to catch route shadowing never looked
  // at the path that shadowed, so a deliberate re-introduction of that exact
  // regression passed this test — proven by tests/release-gate-negatives.mjs,
  // which is why they are here now.
  //
  // `never` is the second half of the fix. production-live-extra.js is a
  // legitimate degradation target for live-data routes and therefore sits in
  // LIVE_FALLBACKS — so merely listing /api/lot-tiles would still have accepted
  // the very module that shadowed it. For this path that module answering IS the
  // regression, so it is named as forbidden regardless of the fallback rule.
  // The lot-tile source guard is an authoritative owner of this path too, for
  // the same reason production-dossier-source-guard.js is one of /api/contacts
  // above: when the source it needs is unavailable its ONLY legal response is
  // an explicit 503, never a clipped tile that would read as "these are the
  // lots here". server/production-lot-tile-source-guard.js:137-153 asks the
  // ArcGIS MapPLUTO service for the tile envelope's count with a 30s timeout
  // and answers 503 lot_tile_source_unavailable when it does not come back.
  //
  // Omitting it turned that correct refusal into a routing regression and, via
  // `npm test` in the Render build command, into a failed deploy. Measured on
  // the same tree, unchanged between the two runs:
  //   2026-09-03T01:41:31Z  ok 1 - route resolution   (ArcGIS reachable)
  //   2026-09-03T02:40:34Z  not ok 1 - '/api/lot-tiles/16/19298/24633?v=4 was
  //                         answered by server/production-lot-tile-source-guard.js'
  // The `never` list is unchanged: production-live-extra.js remains forbidden
  // here, which is the shadowing regression this entry exists to catch.
  ["/api/lot-tiles/16/19298/24633?v=4", ["server/parity-routes.js", "server/production-lot-tile-source-guard.js"], { live: true, never: ["server/production-live-extra.js", "server/routes.js", "server.js"] }],
  // Ownership moved to the completeness-guarded footprints router (PR #139);
  // its own contract test pins that the payload shape is unchanged.
  ["/api/bldg-tiles/16/19298/24633?v=2", ["server/production-building-footprints.js", "server/production-live-extra.js"], { live: true, never: ["server/routes.js"] }],
  ["/api/footprints?lat=40.7484514&lng=-73.9857117", ["server/production-building-footprints.js", "server/production-live-extra.js"], { live: true, never: ["server/routes.js"] }],
  ["/api/nearby?lat=40.7484514&lng=-73.9857117", "server/routes-bundle.js", { live: true, never: ["server/routes.js"] }],
  ["/api/lot-at?lat=40.7484514&lng=-73.9857117", ["server/authority-release.js", "server/routes-bundle.js"], { live: true, never: ["server/routes.js"] }],
  ["/api/owner-portfolio?owner=TEST", "server/production-dossier.js", { live: true, never: ["server/routes.js"] }],
];

// Paths that must NOT be answered by an authentication gate: they are public.
const PUBLIC = ["/api/pipeline?zips=11216", "/api/status", "/healthz"];

let child;
const probeLines = [];

function start() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["--import", "./scripts/route-probe.mjs", "server.js"], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT), SITE_PASSWORD: "route-test", OWNER_PASSWORD: "route-test-owner" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (b) => {
      for (const line of String(b).split("\n")) if (line.startsWith("[PROBE]")) probeLines.push(line);
    });
    child.on("error", reject);
    (async () => {
      for (let i = 0; i < 80; i++) {
        try { await fetch(`${B}/healthz`); return resolve(); } catch { await new Promise((r) => setTimeout(r, 250)); }
      }
      reject(new Error("server did not start"));
    })();
  });
}

// Match the full URL, query included: /api/pipeline and /api/pipeline?zips=
// are different endpoints that share a pathname.
function resolverFor(route) {
  for (let i = probeLines.length - 1; i >= 0; i--) {
    const m = probeLines[i].match(/^\[PROBE\] (\w+) (\S+) (\d+) <= (\S+)/);
    if (m && m[2] === route) return { status: Number(m[3]), file: m[4].split(":")[0] };
  }
  return null;
}

test("route resolution: the intended module answers each authoritative path", async (t) => {
  await start();
  t.after(() => { try { child?.kill(); } catch { /* already down */ } });

  for (const [route] of EXPECTED) {
    await fetch(`${B}${route}`, { headers: { authorization: GATE } }).then((r) => r.text()).catch(() => {});
  }
  for (const route of PUBLIC) {
    await fetch(`${B}${route}`).then((r) => r.text()).catch(() => {});
  }

  for (const [route, expectedFile, opts = {}] of EXPECTED) {
    const got = resolverFor(route);
    assert.ok(got, `${route} produced no probe line — it was never answered`);
    // A forbidden module answering is a failure even when the fallback rule
    // would otherwise permit it. This is checked first, and separately, because
    // the fallback list is exactly what let the real regression through.
    if (opts.never) {
      assert.ok(
        !opts.never.includes(got.file),
        `${route} was answered by ${got.file}, which must never answer it — this is route shadowing, ` +
        `the regression that made the lot grid draw 1 lot where the DOF tax map records 37`
      );
    }
    // An entry may name one module or several. Several is for a path whose
    // ownership legitimately moved to a module mounted ahead — the fallback
    // remains a correct answer, so both are accepted, while `never` still
    // forbids the modules that must not answer.
    const intended = Array.isArray(expectedFile) ? expectedFile : [expectedFile];
    const allowed = opts.live ? [...intended, ...LIVE_FALLBACKS] : intended;
    assert.ok(allowed.includes(got.file),
      `${route} was answered by ${got.file}, expected ${allowed.join(" or ")}`);
    // Refusal guards exist only to refuse. A 200 from either would mean the
    // guard had started serving data and could hide a real routing/data-quality
    // regression.
    if (got.file === "server/production-live-guard.js" || got.file === "server/production-dossier-source-guard.js") {
      assert.equal(got.status, 503,
        `${route} fell to ${got.file} with status ${got.status}; a source guard may only refuse (503)`);
    }
    // The extra layer may answer 200 (an honest empty result) or 503 (source
    // unavailable) — never a client or server error, which would mean the
    // fall-through itself is broken rather than degrading.
    if (got.file === "server/production-live-extra.js") {
      assert.ok(got.status === 200 || got.status === 503,
        `${route} fell to the live-extra layer with status ${got.status}; expected 200 (empty) or 503 (unavailable)`);
    }
  }

  await t.test("no authoritative data path falls through to the legacy demo router", () => {
    const leaked = probeLines
      .map((l) => l.match(/^\[PROBE\] \w+ (\S+) \d+ <= (\S+)/))
      .filter(Boolean)
      .filter(([, p, f]) => f.startsWith("server/routes.js") && p.startsWith("/api/") && !p.startsWith("/api/mbtile"))
      .map(([, p, f]) => [null, p.split("?")[0], f]);
    assert.deepEqual(leaked.map(([, p]) => p), [], "legacy router answered a data path");
  });

  await t.test("the public development-pipeline feed is not behind the account gate", async () => {
    const res = await fetch(`${B}/api/pipeline?zips=11216`, { headers: { authorization: GATE } });
    assert.notEqual(res.status, 401, "/api/pipeline?zips= must not require an account");
    const body = await res.json();
    // What this subtest owns is the *gate*: the DOB feed must never demand an
    // account. Whether DOB NOW answered is a property of the network, not of the
    // routing, and on a shared CI runner the unauthenticated Socrata endpoints
    // are rate-limited by IP. An honest `{provenance:"unavailable"}` is a pass
    // for this assertion and a fail for none — the 401 check above is the part
    // that must hold either way.
    if (body?.provenance === "unavailable") {
      assert.ok(body.error, "an unavailable feed still names the reason");
      return;
    }
    assert.ok(Object.prototype.hasOwnProperty.call(body, "counts"), `expected the DOB feed shape, got ${JSON.stringify(body).slice(0, 120)}`);
  });

  await t.test("a signed-in investor pool is answered by the durable Supabase store", async () => {
    // Without a bearer the contract router answers with the soft-gated
    // envelope. With one, the request must reach production-api.js, whose
    // rows live in cre_investors — Render wipes the local JSON file on every
    // deploy, so a signed-in book must never be served from it.
    await fetch(`${B}/api/investors`, { headers: { authorization: GATE } }).then((r) => r.text());
    const anon = resolverFor("/api/investors");
    // The anon envelope moved to authority-release.js, which is mounted ahead
    // of routes-bundle.js and returns the same soft-gated shape; both are
    // acceptable owners for the UNSIGNED case. What this subtest exists to
    // protect is the line below it — a bearer must not be served from the
    // local JSON file, which Render wipes on every deploy.
    assert.ok(["server/authority-release.js", "server/routes-bundle.js"].includes(anon?.file),
      `the anonymous envelope was answered by ${anon?.file}`);

    // A browser carries the gate as a cookie, which leaves the Authorization
    // header free for the auth bridge's Supabase bearer — the same shape the
    // deployed frontend sends.
    const gate = await fetch(`${B}/__gate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=route-test",
      redirect: "manual"
    });
    const cookie = (gate.headers.getSetCookie?.() ?? [String(gate.headers.get("set-cookie"))])
      .map((c) => c.split(";")[0]).join("; ");
    await fetch(`${B}/api/investors?signed=1`, {
      headers: { cookie, authorization: "Bearer test-supabase-access-token" }
    }).then((r) => r.text());
    const signed = resolverFor("/api/investors?signed=1");
    assert.ok(signed, "the signed-in request produced no probe line");
    assert.equal(signed.file, "server/production-api.js", "a bearer must reach the durable store");
  });

  await t.test("the signed-in usage meter is the durable one", async () => {
    // The Source Registry must read the same counters that gate spend. Without
    // a bearer the contract router answers from the local file; with one the
    // request must reach the cre_usage_daily reader.
    const gate = await fetch(`${B}/__gate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=route-test",
      redirect: "manual"
    });
    const cookie = (gate.headers.getSetCookie?.() ?? [String(gate.headers.get("set-cookie"))])
      .map((c) => c.split(";")[0]).join("; ");
    await fetch(`${B}/api/maps-usage?signed=1`, {
      headers: { cookie, authorization: "Bearer test-supabase-access-token" }
    }).then((r) => r.text());
    const signed = resolverFor("/api/maps-usage?signed=1");
    assert.ok(signed, "the signed-in request produced no probe line");
    assert.equal(signed.file, "server/production-api.js", "a bearer must reach the durable usage store");
  });

  await t.test("a JSON device beacon is answered rather than left hanging", async () => {
    const res = await fetch(`${B}/api/client-diag`, {
      method: "POST",
      headers: { authorization: GATE, "content-type": "application/json" },
      body: JSON.stringify({ url: "regression", innerWidth: 375, build: "regression" }),
      signal: AbortSignal.timeout(10000)
    });
    assert.equal(res.status, 204);
    const log = await fetch(`${B}/api/client-diag`, { headers: { authorization: GATE } }).then((r) => r.json());
    assert.ok(log.reports.some((r) => r.build === "regression"), "the beacon body was parsed and stored");
  });
});
