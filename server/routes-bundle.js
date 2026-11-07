// The production frontend's API contract, endpoint by endpoint, matched to
// the shipped bundle (site/assets/index-*.js) and to the running production
// site's observed responses. This router is mounted FIRST and owns every
// endpoint whose shape the bundle depends on; anything it doesn't handle
// falls through to the live/demo routers behind it.
import { Router } from "express";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateRole } from "./gate.js";
import { APP_DATA_DIR } from "./usage-meter.js";
import { durableStore, appStateToken, appStatePublishableKey } from "./durable-store.js";
import { safeJ51 as normalizeJ51, safeLl97 as normalizeLl97, safeNum } from "./cliffs-contract.js";
import { liveOpportunities, curatedAsParcels, plutoRowsToParcels, resolveNeighborhoods, ASSET_CLASS_SOQL } from "./opps-live.js";
import {
  postgisConfigured, pgLotAt, pgNtaPolys, pgAssemblage,
  pgOpportunityRows, pgTaxHistory, pgContacts, parcelRowToPlutoRow
} from "./adapters/postgis.js";
import {
  DS, parseBbl, plutoByBbl, plutoRowToBuilding, plutoByZips,
  acrisByLot, rollingSalesByLot, dobPermitsByLot, dobNowByLot,
  hpdViolationsByBbl, ecbByLot, s311ByAddress, s311ByBbl, taxHistoryByBbl, taxRatesByClass,
  lienSaleByLot, subwayStations, loadAcrisDocTypes, acrisDocTypeLabel
} from "./adapters/nyc.js";
import { soql, escSoql } from "./adapters/socrata.js";
import { geometryContains } from "./adapters/mappluto.js";
// DOF Digital Tax Map TAX_LOT_POLYGON — the authoritative lot geometry, and the
// same dataset the lot grid is drawn from.
const TAX_LOT_POLYGONS = "i38t-6if2";
import { serperConfigured, serperSearch, listingCheck } from "./adapters/serper.js";
import { pineconeConfigured, upsertParcel, searchSimilar } from "./adapters/pinecone.js";
import { airtableConfigured, crmXref } from "./adapters/airtable.js";
import { liveBuilding, liveMaturityWall } from "./live.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// APP_DATA_DIR, not a hard-coded server/data. This file used to pin the path to
// the deploy image, so setting APP_DATA_DIR to a mounted disk moved the usage
// meters and the 3D quota (which read it) and silently left the kanban board and
// the investor pool behind (which did not). Everything that persists now agrees
// on one directory.
const DATA_DIR = APP_DATA_DIR;
mkdirSync(DATA_DIR, { recursive: true });

const router = Router();
const wrap = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out === undefined) return; // handler answered (or intentionally hung up)
    if (out === null) return next();
    res.json(out);
  } catch (e) {
    // A save that could not be made durable is reported as a failure, not
    // handed to the generic error path where it would read as a transient
    // glitch. The caller said "Saved" for months while the row was going to a
    // directory Render rebuilds on every deploy; a 503 that names the reason is
    // the only honest answer.
    if (e?.code === "durable_write_failed") {
      return res.status(503).json({
        ok: false,
        error: "not_saved",
        durable: false,
        backend: e.backend || "disk",
        message: e.message
      });
    }
    next(e);
  }
};

const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : 0; };
const day = (v) => (v ? String(v).slice(0, 10) : null);
// Owner, by any of the three ways this deployment grants it.
//
// This read `req.user?.role`, which is never set: attachUser() puts the
// self-hosted role on `req.profile.role` and leaves `req.user` as {id,email}.
// And a Supabase-authenticated owner carries neither — their role lives behind
// a Bearer token this router is mounted too early to resolve on its own. Both
// gaps sent a legitimate owner down the anonymous path on /api/pinecone-status
// (which is the app-wide owner switch the frontend reads) and
// /api/airtable-xref, so owner mode simply did not turn on for them.
// server.js now resolves the bearer into req.productionUser before this router
// is reached; all three sources are checked here.
const isOwner = (req) =>
  gateRole(req) === "owner" ||
  ["owner", "admin"].includes(String(req.profile?.role ?? "").toLowerCase()) ||
  ["owner", "admin"].includes(String(req.productionUser?.role ?? "").toLowerCase());

function jsonStore(file, fallback) {
  const p = path.join(DATA_DIR, file);
  return {
    load() {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch { return structuredClone(fallback); }
    },
    save(value) {
      const tmp = p + ".tmp";
      writeFileSync(tmp, JSON.stringify(value, null, 2));
      renameSync(tmp, p);
    }
  };
}

// ------------------------------------------------------------- opportunities
// Production: a bare array of live parcels (LIVE-<bbl> ids) filtered by
// zips / assetClass / neighborhood; every field non-nullable (the dossier
// calls .toFixed/.toLocaleString/.join on them directly). The PostGIS parcel
// store is the first source; live PLUTO and the curated universe stand behind.
router.get("/api/opportunities", wrap(async (req) => {
  const { zips = "", assetClass = "", neighborhood = "" } = req.query;
  const zipList = String(zips).split(",").map((z) => z.trim()).filter(Boolean);
  // Only the five classes the original recognises narrow anything; measured
  // 2026-08-18, ?assetClass=misc and ?assetClass=retail both return the
  // unfiltered list rather than an empty one. See opps-live.js for the full
  // tabulation this mapping came from.
  const wantClass = Object.prototype.hasOwnProperty.call(ASSET_CLASS_SOQL, String(assetClass)) ? String(assetClass) : "";
  let list = null;
  if (postgisConfigured()) {
    const rows = await pgOpportunityRows(zipList.length ? zipList : null, 160).catch(() => null);
    if (rows) {
      const parcels = await resolveNeighborhoods(plutoRowsToParcels(rows));
      if (parcels.length) list = parcels;
    }
  }
  if (!list) list = await liveOpportunities();
  if (!list) {
    // Live public records did not answer. The curated universe carries seeded
    // owners and authored scores, so serving it here would put invented
    // property facts on the map in the same shape as recorded ones. Outside a
    // demo build the guard refuses, and production-live-guard.js turns that
    // into a 503 rather than an empty map that looks like "no opportunities".
    try {
      list = curatedAsParcels();
    } catch (e) {
      if (e?.code !== "synthetic_data_refused") throw e;
      return null;
    }
  }
  const zipSet = new Set(zipList);
  if (zipSet.size) {
    // A ZIP request is answered from that ZIP's own record, not by filtering the
    // citywide universe down to whatever happens to fall inside it.
    //
    // WHY THIS CHANGED. The universe here is the citywide top-lot pull, and
    // intersecting it with one ZIP leaves almost nothing: ?zips=10001 answered 2
    // rows where the original answers 150, and ?zips=11216 answered 0 (which is
    // what the 2026-08-17 "when the universe has nothing, pull the ZIP" patch
    // was written for — it fired for 11216 because the intersection was exactly
    // empty, and stayed silent for 10001 because it was merely two rows). The
    // original's own ZIP answers are not subsets of its citywide answer at all:
    // its 11216 list holds Bed-Stuy lots that appear nowhere in the bare list.
    // So the pull is unconditional now, and any universe row for the same ZIP is
    // merged on top rather than being the whole answer.
    //
    // With a class requested, ask PLUTO for that class. The generic building-area
    // page cannot answer ?assetClass=development at all: vacant lots have no
    // building, so they sit at the bottom of that ordering and the 400-row window
    // never reaches them. Lot area is the ordering the original's own development
    // answer follows (its 18 rows for 11216 are that ZIP's 18 largest V lots).
    const universeForZip = list.filter((p) => zipSet.has(p.zip));
    const pulled = wantClass
      ? await plutoByZips(zipList, { limit: 400, order: "lotarea DESC", extraWhere: ASSET_CLASS_SOQL[wantClass] }).catch(() => null)
      : await plutoByZips(zipList, { limit: 400, order: "bldgarea DESC" }).catch(() => null);
    if (pulled && !pulled.live) return null; // honest 503 through the guard, never a short list
    const fromRecord = pulled?.rows?.length
      ? await resolveNeighborhoods(plutoRowsToParcels(pulled.rows))
      : [];
    const seen = new Set(fromRecord.map((p) => p.bbl));
    list = [...fromRecord, ...universeForZip.filter((p) => !seen.has(p.bbl))]
      .sort((a, z) => (z.opportunityScore ?? 0) - (a.opportunityScore ?? 0))
      .slice(0, 150);
  }
  if (wantClass) list = list.filter((p) => p.assetClass === wantClass);
  // No LIVE-* bypass. It existed because every live parcel was labelled
  // "FiDi / Lower Manhattan" regardless of where it was, so an honest filter
  // would have returned nothing for seventeen of the eighteen neighborhoods.
  // The labels are real now, so the filter can be too — letting every live
  // parcel through was the filter silently not working.
  if (neighborhood) list = list.filter((p) => p.neighborhood === neighborhood);
  return list;
}));

// ------------------------------------------------------------------ pipeline
// The kanban stores { oppId, stage } rows globally for the deployment.
// GET bare → array; POST { oppId, stage }; PATCH /:oppId { stage }.
// GET ?zips= is the DOB-NOW development-pipeline feed → falls through.
// Durable, not jsonStore: this board is the deployment's kanban for everyone who
// enters through the password gate without a Supabase account, and on the free
// plan `server/data/` is recreated from git on every deploy. Writing it to disk
// is what made every deploy look identical — the board reset to its seeded rows.
const pipelineStore = durableStore("kanban-pipeline.json", { rows: [] });
const KANBAN_STAGES = ["Watchlist", "Diligence", "Contact Owner", "Model Conversion", "IC Memo", "Active Pursuit"];

// Requests carrying the auth bridge's Supabase bearer belong to a signed-in
// user — their kanban rows live per-user in Supabase (production-private.js).
// Anonymous requests use the deployment-wide store.
const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));

router.get("/api/pipeline", wrap(async (req) => {
  if (req.query.zips !== undefined) return null; // development-pipeline feed
  if (hasBearer(req)) return null; // per-user Supabase rows
  return (await pipelineStore.load()).rows;
}));

router.post("/api/pipeline", wrap(async (req) => {
  if (hasBearer(req)) return null; // per-user Supabase rows
  const { oppId, stage } = req.body ?? {};
  if (!oppId || !KANBAN_STAGES.includes(stage)) { return { ok: false }; }
  const s = await pipelineStore.load();
  const row = s.rows.find((r) => r.oppId === oppId);
  if (row) { row.stage = stage; row.updatedAt = new Date().toISOString(); }
  else s.rows.push({ id: s.rows.length + 1, oppId, stage, note: "", nextAction: "", updatedAt: new Date().toISOString() });
  // Report where it actually landed. A configured-but-unreachable backend
  // throws and wrap() answers 503; disk-by-design answers ok with durable:false
  // so the caller is never told a redeploy-safe save happened when it did not.
  const w = await pipelineStore.save(s);
  return { ok: true, durable: w.durable !== false, backend: w.backend };
}));

router.patch("/api/pipeline/:oppId", wrap(async (req) => {
  if (hasBearer(req)) return null; // per-user Supabase rows
  const { stage } = req.body ?? {};
  if (!KANBAN_STAGES.includes(stage)) return { ok: false };
  const s = await pipelineStore.load();
  const row = s.rows.find((r) => r.oppId === req.params.oppId);
  if (row) { row.stage = stage; row.updatedAt = new Date().toISOString(); }
  else s.rows.push({ id: s.rows.length + 1, oppId: req.params.oppId, stage, note: "", nextAction: "", updatedAt: new Date().toISOString() });
  const w = await pipelineStore.save(s);
  return { ok: true, durable: w.durable !== false, backend: w.backend };
}));

// ------------------------------------------------- owner mode + investor pool
// The app-wide owner gate: the frontend reads /api/pinecone-status.owner with
// strict === true. Owner is whoever entered the owner-tier gate password (or
// a signed-in owner account on the workshop frontend).
router.get("/api/pinecone-status", wrap(async (req) => ({
  configured: pineconeConfigured(),
  owner: isOwner(req) === true
})));

// The investor pool is the owner's private book. A signed-in request carries
// the auth bridge's Supabase bearer and is answered from cre_investors by
// server/production-api.js — a durable per-user row that survives a restart or
// a redeploy. This local file store is only reachable without a bearer, which
// on the deployed service means the gate-password tiers with no account: it
// backs the offline/dev path and the contract tests, never a signed-in book.
// Render's filesystem is wiped on every deploy, so nothing a user would miss
// may live here.
const investorsStore = durableStore("investors-pool.json", { investors: [] });

router.get("/api/investors", wrap(async (req) => {
  if (hasBearer(req)) return null; // durable cre_investors row
  const owner = isOwner(req);
  return { owner, investors: owner ? (await investorsStore.load()).investors : [] };
}));

router.post("/api/investors", wrap(async (req) => {
  if (hasBearer(req)) return null; // durable cre_investors row
  const owner = isOwner(req);
  if (!owner) return { owner: false, investors: [] };
  const investors = Array.isArray(req.body?.investors) ? req.body.investors : [];
  const w = await investorsStore.save({ investors });
  return { owner: true, investors, durable: w.durable !== false, backend: w.backend };
}));

// ---------------------------------------------------------------- similar
// { configured, matches[] } — matches MUST be an array whenever configured.
router.get("/api/similar", wrap(async (req) => {
  // Without Pinecone this used to answer `{configured:false}` and stop, which
  // disabled Similar Properties entirely. The public-record similarity engine
  // in server/production-analytics.js sits behind this router and needs no
  // vector index — it compares live PLUTO lots on class, area, lot size, age
  // and unit count. Fall through to it instead of turning the feature off.
  if (!pineconeConfigured()) return null;
  const bbl = String(req.query.bbl ?? "");
  const b = await liveBuilding(bbl).catch(() => null);
  if (!b) return null;
  upsertParcel(b).catch((e) => console.warn(`[similar] index upsert failed for ${bbl}: ${String(e?.message ?? e).slice(0, 160)}`));

  // searchSimilar() returns { configured, engine, matches, error? } — an
  // OBJECT. This read it as an array and called .filter() on it, which throws
  // TypeError on every single request; the bare catch below then answered
  // `{configured:true, matches:[]}`. The net effect was inverted: with Pinecone
  // unconfigured the request fell through to the public-record engine and
  // Similar Properties worked, and configuring Pinecone — the thing that is
  // supposed to improve it — made this router win and return nothing, forever,
  // with no error anywhere. The catch also swallowed the exception whole.
  const found = await searchSimilar(b, { topK: 8 });
  if (found?.error) {
    // Do not publish an empty match list off a vector-index outage. Falling
    // through hands the request to the public-record similarity engine in
    // server/production-analytics.js, which needs no index and is a real
    // answer rather than a blank one.
    console.warn(`[similar] Pinecone search failed for ${bbl}, falling through to the public-record engine: ${String(found.error).slice(0, 160)}`);
    return null;
  }
  const rows = Array.isArray(found?.matches) ? found.matches : [];
  if (!rows.length) return null;
  return {
    configured: true,
    engine: found?.engine ?? "pinecone",
    matches: rows.filter((m) => m.bbl && m.bbl !== bbl).map((m) => ({
      bbl: m.bbl, address: m.address ?? "—", bldgclass: m.bldgclass ?? m.bldgClass ?? null,
      zip: m.zip ?? null, score: typeof m.score === "number" ? m.score : (m._score ?? 0)
    }))
  };
}));

// ------------------------------------------------------------ account-delete
// Bundle flavor: POST with `authorization: Bearer <supabase access token>`.
// Verifies the token against the Supabase project baked into the bundle,
// then removes the user's rows + auth user via the service-role key.
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY || "";

router.post("/api/account-delete", wrap(async (req, res) => {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null; // workshop cookie flavor behind us
  // No legacy default: without a configured project this flavor cannot verify
  // the bearer, so it falls through instead of calling the baked-in project.
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE) return null;
  const token = auth.slice(7);
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE }
  }).catch(() => null);
  if (!userRes?.ok) { res.status(401).json({ error: "Invalid session." }); return; }
  const user = await userRes.json().catch(() => null);
  const uid = user?.id;
  if (!uid) { res.status(401).json({ error: "Invalid session." }); return; }

  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) {
    // Publishable-key + registered-token path — the trust model the kanban,
    // usage meter and 3D quota already use, extended to deletion by
    // 202608170002_account_delete_token_rpc.sql. The JWT check above proved
    // the caller owns this account; the registered token proves the request
    // comes from this deployment. auth.users cascades to auth.identities,
    // sessions and every cre_* workspace row, so one call removes everything.
    const key = appStatePublishableKey();
    const rpcToken = appStateToken();
    if (!key || !rpcToken) {
      res.status(501).json({ error: "Deletion isn't configured on this deployment yet — add the SUPABASE_SERVICE_ROLE_KEY secret or register the app-state write token." });
      return;
    }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cre_account_delete_tk`, {
      method: "POST",
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ p_user_id: uid, p_token: rpcToken }),
      signal: AbortSignal.timeout(10000)
    }).catch(() => null);
    const out = r?.ok ? await r.json().catch(() => null) : null;
    if (out?.deleted !== true) {
      res.status(500).json({ error: `Could not delete the auth user (${r?.status ?? "network"}).` });
      return;
    }
    res.json({ deleted: true });
    return;
  }
  const svcHeaders = { apikey: service, authorization: `Bearer ${service}` };
  for (const table of ["cre_watchlist", "cre_pipeline", "cre_canvass", "cre_profiles"]) {
    const col = table === "cre_profiles" ? "id" : "owner";
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${col}=eq.${uid}`, { method: "DELETE", headers: svcHeaders }).catch(() => {});
  }
  const del = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: svcHeaders }).catch(() => null);
  if (!del?.ok) { res.status(500).json({ error: `Could not delete the auth user (${del?.status ?? "network"}).` }); return; }
  res.json({ deleted: true });
}));

// ------------------------------------------------------------- area-buildings
// The full production contract lives in server/area-buildings.js: envelope,
// coverage sentence, Socrata provenance block, per-building key-omission rules
// and the exact propensity model. Nothing is reshaped here.
import { liveAddressSearch } from "./live.js";
import { areaBuildings } from "./area-buildings.js";
import { marketReport } from "./market-report.js";

router.get("/api/area-buildings", async (req, res, next) => {
  try {
    const out = await areaBuildings(req.query);
    if (out.status === 503 || out.body === null) return next(); // live pull failed; the guard behind answers
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------- transit
// { nearest: { name, lines, distanceFt }, within: { quarterMile, halfMile } }
//
// A lot PLUTO does not carry answers the original site's exact empty shape —
// 200 {"nearest":null,"within":{"quarterMile":0,"halfMile":0}} (verified
// 2026-08-17 against nycremarketintel.com with retired and garbage BBLs; an
// earlier revision 404'd parcel_not_found here, which no original response
// does). Returning null on that case had sent the request to
// production-live-guard, which reported a 503 decorated with whichever
// dataset most recently failed anywhere — so only a genuine PLUTO outage may
// fall through to the guard.
// The original publishes NO transit measurement on this route. Measured
// 2026-08-19 across eleven identifiers — 1008350041 (Empire State Building,
// two subway lines under it), 1009200012, 1001741307, 3018420015, 3000860011,
// 2024340070, 4089630036, 5035640042, 0000000000, ?lat=40.7484&lng=-73.9857
// and ?lat=40.7527&lng=-73.9772 (Grand Central) — every 200 answer is byte
// for byte:
//   {"nearest":null,"within":{"quarterMile":0,"halfMile":0}}
// and the compiled bundle only ever calls this one way
// (site/assets/index-BbnE3o5g.js @1000279: `/api/transit?bbl=${e}`), so there
// is no other request shape that could unlock a populated answer. The station
// ranking below is therefore STILL COMPUTED — it is real MTA station data and
// the only reason this route reads that dataset — and deliberately not
// published, exactly as the market-report narrative's macro block is.
//
// The 400 is the original's own. Measured: 200 when the bbl digit-strips to
// exactly ten digits (?bbl=3-01842-0015 answers 200) OR when lat and lng are
// both finite (?bbl=abc&lat=40.7484&lng=-73.9857 answers 200); otherwise
//   {"error":"Provide ?bbl= or ?lat= & ?lng="}
// — measured on /api/transit, ?bbl=, ?bbl=%20%20, ?bbl=abc, ?bbl=100835004
// (nine digits), ?lat=40.7484 (no lng), ?lng=-73.9857 (no lat) and
// ?lat=abc&lng=xyz. The rebuild answered the live guard's 503
// {"error":"live_source_unavailable"} for all of them.
router.get("/api/transit", wrap(async (req, res) => {
  const bbl = String(req.query.bbl ?? "");
  const bblDigits = bbl.replace(/[^0-9]/g, "");
  const qLat = parseFloat(req.query.lat), qLng = parseFloat(req.query.lng);
  const haveLatLng = Number.isFinite(qLat) && Number.isFinite(qLng);
  if (bblDigits.length !== 10 && !haveLatLng) {
    res.status(400).json({ error: "Provide ?bbl= or ?lat= & ?lng=" });
    return undefined;
  }

  // Retained, deliberately unpublished — see the measurement above.
  let transitNearest = null;
  let transitWithin = { quarterMile: 0, halfMile: 0 };
  const b = await liveBuilding(bbl).catch(() => null);
  // Whether PLUTO ITSELF answered for this lot. It used to decide between the
  // empty shape and a 503; the original draws no such distinction — it serves
  // the empty shape for a live parcel, a retired one and a garbage identifier
  // alike (measured above) — so the flag is recorded rather than acted on, and
  // the PLUTO read that produces it is kept.
  const transitLotResolved = (b?.lat && b?.lng)
    ? true
    : !!(await plutoByBbl(bbl).catch(() => null))?.live;
  const originLat = b?.lat ?? (haveLatLng ? qLat : null);
  const originLng = b?.lng ?? (haveLatLng ? qLng : null);
  if (originLat != null && originLng != null) {
    const st = await subwayStations();
    if (!st.live || !st.rows?.length) {
      // Named, not swallowed: the ranking below could not be computed. It is
      // not published either way, so this cannot change the answer — but a
      // dead station feed must still be visible to an operator.
      console.warn(`[transit] MTA station list unavailable (live=${st.live}, rows=${st.rows?.length ?? 0}); the unpublished ranking was not computed`);
    } else {
      const ft = (s) => Math.round(Math.hypot((s.lat - originLat) * 364000, (s.lng - originLng) * 280000));
      const withDist = st.rows.map((s) => ({ ...s, distanceFt: ft(s) })).sort((a, z) => a.distanceFt - z.distanceFt);
      const nearest = withDist[0];
      transitNearest = { name: nearest.name, lines: nearest.lines.split(",").filter(Boolean), distanceFt: nearest.distanceFt };
      transitWithin = {
        quarterMile: withDist.filter((s) => s.distanceFt <= 1320).length,
        halfMile: withDist.filter((s) => s.distanceFt <= 2640).length
      };
    }
  }
  void transitNearest; void transitWithin; void transitLotResolved;

  return { nearest: null, within: { quarterMile: 0, halfMile: 0 } };
}));

// -------------------------------------------------------------------- cliffs
// LL84/LL97/LL33 from the live disclosure; J-51 verified against the DOF
// benefit lookup. The dossier template reads these keys directly and calls
// .toLocaleString() on the LL97 figures, so every emitted metric is a safe
// Number primitive (0 when a component cannot be computed) and a section is
// null only when the record legitimately does not exist (the UI hides it).
// The normalizers live in server/cliffs-contract.js so this router and the
// regulatory router behind it emit byte-identical shapes; re-exported here
// because the contract tests read them from the bundle router.
export { safeJ51, safeLl97, safeNum } from "./cliffs-contract.js";

router.get("/api/cliffs", wrap(async (req) => {
  const bbl = String(req.query.bbl ?? "");
  const b = await liveBuilding(bbl).catch(() => null);
  if (!b) return null;
  const { liveCliffs } = await import("./live.js");
  const [c, benefit] = await Promise.all([
    liveCliffs(bbl, b),
    import("./adapters/dof-benefits.js").then((m) => m.dofBenefitsByBbl(bbl)).catch(() => null)
  ]);
  return { j51: normalizeJ51(benefit), ll97: normalizeLl97(c.ll97), ll33: c.ll33 };
}));

// ------------------------------------------------------------------ distress
// { hpd:{open,total,heatOpen}, ecb:{balanceDue,unresolved},
//   threeOneOne:{total12mo,heatHotWater12mo,topCategories:[{type,n}]} }
router.get("/api/distress", wrap(async (req) => {
  const bbl = String(req.query.bbl ?? "");
  const b = await liveBuilding(bbl).catch(() => null);
  if (!b) return null;
  const [hpdR, ecbR, s311R] = await Promise.all([
    hpdViolationsByBbl(bbl), ecbByLot(bbl),
    // Keyed on the BBL — the address match returned nothing on real buildings.
    bbl ? s311ByBbl(bbl) : Promise.resolve({ live: false, rows: [] })
  ]);
  let hpd = null;
  if (hpdR.live) {
    const rows = hpdR.rows ?? [];
    const open = rows.filter((r) => /open/i.test(r.violationstatus ?? r.currentstatus ?? "")).length;
    hpd = {
      open, total: rows.length,
      heatOpen: rows.filter((r) => /open/i.test(r.violationstatus ?? "") && /HEAT|HOT WATER/i.test(r.novdescription ?? "")).length
    };
  }
  let ecb = null;
  if (ecbR.live) {
    const rows = ecbR.rows ?? [];
    ecb = {
      balanceDue: Math.round(rows.reduce((s, r) => s + num(r.balance_due), 0)),
      unresolved: rows.filter((r) => /active|default/i.test(r.ecb_violation_status ?? "")).length
    };
  }
  let threeOneOne = null;
  if (s311R.live) {
    const rows = s311R.rows ?? [];
    const byType = {};
    for (const r of rows) { const t = r.complaint_type ?? "Other"; byType[t] = (byType[t] ?? 0) + 1; }
    threeOneOne = {
      total12mo: rows.length,
      heatHotWater12mo: rows.filter((r) => /HEAT|HOT WATER/i.test(r.complaint_type ?? "")).length,
      // Four, matching the original. The counts already agree exactly
      // (29 / 20 / 14 / 12 on 1008350041); this was cutting the list one row
      // short of what the panel is built to show.
      topCategories: Object.entries(byType).sort((a, z) => z[1] - a[1]).slice(0, 4).map(([type, n]) => ({ type, n }))
    };
  }
  if (!hpd && !ecb && !threeOneOne) return null;
  return { hpd, ecb, threeOneOne };
}));

// ------------------------------------------------------------------ liensale
// Measured 2026-08-19 against the original: a bbl that does not digit-strip to
// EXACTLY ten digits is 400 {"error":"Provide a 10-digit ?bbl="} —
//   /api/liensale, ?bbl=, ?bbl=%20%20, ?bbl=abc, ?bbl=abcdefghij,
//   ?bbl=100835004 (nine), ?bbl=10083500411 (eleven), ?BBL=1008350041 (case)
// all 400, while ?bbl=3-01842-0015 and ?bbl=%20%203018420015%20 and
// ?bbl=0000000000 all answer 200 {"onList":false,"records":[]}. The rebuild
// answered the live guard's 503 {"error":"live_source_unavailable"}.
router.get("/api/liensale", wrap(async (req, res) => {
  if (String(req.query.bbl ?? "").replace(/[^0-9]/g, "").length !== 10) {
    res.status(400).json({ error: "Provide a 10-digit ?bbl=" });
    return undefined;
  }
  const bblRaw = String(req.query.bbl ?? "");
  // parseBbl rejects a borough digit outside 1-5 and a zero block or lot, so
  // lienSaleByLot declines those BBLs without ever running a query — and the
  // rebuild then fell through to the guard's 503. The original QUERIES them:
  // measured 2026-08-19, ?bbl=0000000000, ?bbl=9018420015, ?bbl=1008350000
  // (lot 0) and ?bbl=1000000041 (block 0) all answer 200
  // {"onList":false,"records":[]}. So a ten-digit BBL the adapter will not take
  // is asked here directly, in the adapter's own query shape — and only when
  // the adapter would have declined for that reason. Nothing about
  // lienSaleByLot changes; it is still the path for every BBL it accepts and
  // for its other caller in server/live.js, and a genuine source failure still
  // reports live:false and is still answered by the guard rather than by a
  // fabricated empty list.
  const lienLot = parseBbl(bblRaw);
  const r = lienLot
    ? await lienSaleByLot(bblRaw)
    : await soql(DS.lienSale, {
      $select: "month,cycle,water_debt_only,tax_class_code",
      $where: `borough='${escSoql(bblRaw.replace(/[^0-9]/g, "").slice(0, 1))}' AND block='${escSoql(String(parseInt(bblRaw.replace(/[^0-9]/g, "").slice(1, 6), 10)))}' AND lot='${escSoql(String(parseInt(bblRaw.replace(/[^0-9]/g, "").slice(6), 10)))}'`,
      $order: "month DESC", $limit: 20
    });
  if (!r.live) return null;
  const records = (r.rows ?? []).map((x) => ({
    month: day(x.month), cycle: x.cycle ?? null,
    waterOnly: /^(y|yes|true|1)$/i.test(String(x.water_debt_only ?? ""))
  }));
  return { onList: records.length > 0, records };
}));

// ---------------------------------------------------------------- assemblage
// Real contiguous same-owner lots. PostGIS answers first with ST_Touches
// adjacency over the MapPLUTO polygons; live PLUTO same-owner-on-block is the
// fallback when the store is not configured.
router.get("/api/assemblage", wrap(async (req) => {
  const bbl = String(req.query.bbl ?? "");
  if (postgisConfigured()) {
    const pg = await pgAssemblage(bbl).catch(() => null);
    if (pg && Array.isArray(pg.lots) && pg.lots.length) {
      const lots = pg.lots.map((l) => ({
        bbl: String(l.bbl ?? ""), address: l.address ?? "—",
        lotArea: num(l.lotArea), builtFar: num(l.builtFar), maxFar: num(l.maxFar),
        unusedSf: num(l.unusedSf), touches: l.touches === true
      }));
      const subjectUnusedSf = num(pg.subjectUnusedSf);
      return {
        count: lots.length,
        subjectUnusedSf,
        // totalLotArea is part of the original's assemblage envelope (A/B diff
        // 2026-08-17 flagged it missing from every response of this handler).
        totalLotArea: lots.reduce((s, l) => s + l.lotArea, 0),
        totalUnusedSf: lots.reduce((s, l) => s + l.unusedSf, 0) || subjectUnusedSf,
        owner: pg.owner ?? "—",
        lots
      };
    }
  }
  const p = parseBbl(bbl);
  const b = await liveBuilding(bbl).catch(() => null);
  if (!p || !b) return null;
  const abbr = { 1: "MN", 2: "BX", 3: "BK", 4: "QN", 5: "SI" }[p.boro];
  let lots = [];
  if (b.owner) {
    const r = await soql(DS.pluto, {
      $select: "bbl,address,lotarea,builtfar,residfar,commfar",
      $where: `borough='${abbr}' AND block=${p.block} AND ownername='${escSoql(b.owner)}' AND bldgclass IS NOT NULL`,
      $limit: 40
    });
    if (r.live) {
      lots = (r.rows ?? []).map((x) => {
        const lotArea = num(x.lotarea);
        const builtFar = num(x.builtfar);
        const maxFar = Math.max(num(x.residfar), num(x.commfar));
        return {
          bbl: String(x.bbl ?? "").replace(/\..*$/, ""),
          address: x.address ?? "—", lotArea, builtFar, maxFar,
          unusedSf: Math.max(0, Math.round(lotArea * Math.max(0, maxFar - builtFar)))
        };
      });
    }
  }
  return {
    count: lots.length,
    subjectUnusedSf: b.unusedFarSf ?? 0,
    totalLotArea: lots.reduce((s, l) => s + (l.lotArea || 0), 0),
    totalUnusedSf: lots.reduce((s, l) => s + l.unusedSf, 0) || (b.unusedFarSf ?? 0),
    owner: b.owner ?? "—",
    lots
  };
}));

// ------------------------------------------------- propensity-validation
// Owned by server/production-analytics.js, which serves both this path and
// /api/analytics/backtest. Nothing here so the two cannot report different
// lifts for the same area.
import { rollingSalesByZips } from "./adapters/nyc.js";

// ------------------------------------------------------------- maturity-wall
// Owned by server/production-maturity.js, which is mounted ahead of this
// router. Nothing here so the two cannot drift apart.

// ---------------------------------------------------------------- websearch
// Measured 2026-08-19 on ?q="Empire State Realty" foreclosure New York: the
// original answers
//   {"configured":true,"query":"…","searchUrl":"https://www.google.com/search?q=…","hits":[]}
// — four keys in that order. The rebuild published {error, hits, searchUrl}:
// it dropped configured and query, and added an `error` key the original has
// no counterpart for.
// Measured 2026-08-19 against the original:
//   GET /api/websearch?q=test -> 200
//   {"configured":true,"query":"test","searchUrl":"https://www.google.com/search?q=test","hits":[]}
//   GET /api/websearch            -> 400 {"error":"Provide ?q="}
//   GET /api/websearch?q=         -> 400 {"error":"Provide ?q="}
//   GET /api/websearch?q=%20%20   -> 400 {"error":"Provide ?q="}
//   GET /api/websearch?q=%20%20test%20%20 -> query "test", searchUrl …?q=test
//   GET /api/websearch?q=a&q=b    -> query "a"   (first value, not the array)
// The rebuild answered 502 with an `error` key on every one of them, because
// its provider is failing here; and it published no 400 at all.
router.get("/api/websearch", wrap(async (req, res) => {
  // ?q=a&q=b is the first value, not the joined array — measured above.
  const rawQ = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
  const q = String(rawQ ?? "").trim();
  if (!q) { res.status(400).json({ error: "Provide ?q=" }); return undefined; }
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const configured = serperConfigured();
  if (!configured) return { configured, query: q, searchUrl, hits: [] };
  const r = await serperSearch(q);
  // An upstream failure is reported — to the LOG, with the provider's own
  // reason, not to the caller. The original answers 200 with hits:[] and no
  // `error` key for every query reachable from here, including
  // ?q=empire%20state%20building, so a 502 with an error key is itself a
  // contract break. Nothing is substituted for the empty result: hits stays
  // genuinely empty and the failure is named where an operator will see it.
  if (r.error) {
    console.warn(`[websearch] Serper returned no result for ${JSON.stringify(q)}: ${String(r.error).slice(0, 300)}`);
    return { configured, query: q, searchUrl, hits: [] };
  }
  return {
    configured,
    query: q,
    searchUrl,
    hits: (r.hits ?? []).map((h) => ({ title: h.title, link: h.url, host: (() => { try { return new URL(h.url).hostname; } catch { return h.source ?? ""; } })() }))
  };
}));

// ------------------------------------------------------------- listing-check
// The map popup's listing detector — the hyphenated sibling of
// /api/listingcheck (which is served from server/production-owner-source-
// registry.js, mounted ahead of this router; see commit 54e0a44). Confirmed by
// measurement that THIS handler is the one production serves for the
// hyphenated path: a temporary `__probe5642_lc_err` key added here and then
// removed appeared in GET /api/listing-check on the rebuild.
//
// Measured 2026-08-19 against https://nycremarketintel.com from a gate
// session, 23 probes:
//
//   GET /api/listing-check?addr=350%205th%20Ave -> 200
//   {"configured":true,"address":"350 5th Ave","forSale":false,"hits":[],
//    "checked":1787165726021}
//
// Five differences from what this handler used to serve, each one measured:
//
//  1. `address` is published — the addr as sent, TRIMMED and nothing else.
//     Measured: ?addr=Inner%20%20%20Space%20%20%20Probe publishes
//     "Inner   Space   Probe", inner runs preserved.
//  2. `checked` is published LAST — an epoch-ms stamp of when the address was
//     actually checked. The rebuild published neither key.
//  3. Key order is configured, address, forSale, hits, checked. The rebuild
//     served configured, [error,] forSale, hits.
//  4. A blank, whitespace-only or absent addr is 400 {"error":"Provide ?addr="}
//     — the rebuild answered 200 with an empty-address envelope. Measured:
//       GET /api/listing-check                       -> 400
//       GET /api/listing-check?addr=                 -> 400
//       GET /api/listing-check?addr=%20%20%20        -> 400
//       GET /api/listing-check?address=1%20Wall%20St -> 400 (only `addr` counts)
//       GET /api/listing-check?addr=&addr=350%205th%20Ave -> 400 (first value)
//     A repeated ?addr= takes the FIRST value: ?addr=1%20Wall%20St&addr=2%20
//     Wall%20St answers address "1 Wall St".
//  5. A second answer for the same address REPLAYS the stored payload verbatim
//     — same `checked`, and the casing and inner spacing of the FIRST request.
//     Measured on 350 5th Ave: "  350 5th Ave  " and "350 5TH AVE" both answer
//     address "350 5th Ave" with checked 1787165726021, in 32-36ms against
//     739-1117ms for a fresh address. So the cache key is trim + collapse
//     whitespace runs + lowercase, exactly as the sibling route's is.
//
// ?boro= is NOT part of the cache key and changes nothing in the body:
// measured on a fresh address seeded with boro=Manhattan, then asked with
// boro=Brooklyn and with no boro at all — same `checked`, 29-32ms both times.
// It is still passed to the provider, which is where it was always used.
//
// The two routes DO NOT share a cache — they must not be given one. Measured
// with two brand-new addresses: seeding "Share Probe <t> Street" on
// /api/listing-check (1472ms, fresh) left /api/listingcheck answering it fresh
// (344ms, no `cached` key), and seeding "Share Probe <t> Avenue" on
// /api/listingcheck (366ms, fresh) left /api/listing-check answering it fresh
// (1024ms, a new `checked`). Each route keeps its own store.
//
// Map-popup row shape: { configured, address, forSale,
// hits:[{url,kind,source,title}], checked }. The hits row keys are the ones the
// immutable bundle reads (site/assets/index-BbnE3o5g.js renders j.url, j.kind,
// j.source, j.title), and they are carried over unchanged — the original
// published hits:[] on all 23 probes, so no probe can show a populated row and
// none is invented here.
const listingCheckKeyOf = (addr) => addr.trim().replace(/\s+/g, " ").toLowerCase();
// The original's cache lifetime cannot be measured from outside in one session.
// 24h is the window this app already uses for its own search cache
// (server/adapters/serper.js TTL_MS), so it is the app's existing number rather
// than a new invention — the same choice the sibling route made.
const LISTING_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const listingCheckCache = new Map();
router.get("/api/listing-check", wrap(async (req, res) => {
  // ?addr=a&addr=b is the first value, not the joined array — measured above.
  const rawAddr = Array.isArray(req.query.addr) ? req.query.addr[0] : req.query.addr;
  const addr = String(rawAddr ?? "").trim();
  if (!addr) { res.status(400).json({ error: "Provide ?addr=" }); return undefined; }

  const cacheKey = listingCheckKeyOf(addr);
  const cached = listingCheckCache.get(cacheKey);
  // Replayed verbatim — that is why a repeat answers with the FIRST request's
  // casing and its original `checked` stamp.
  if (cached && Date.now() - cached.at < LISTING_CHECK_TTL_MS) return cached.value;

  if (!serperConfigured()) return { configured: false };
  const r = await listingCheck(addr, String(req.query.boro ?? ""));
  if (!r.configured) return { configured: false };
  // The original answers 200 with hits:[] and NO `error` key when its own
  // provider yields nothing — measured on all 23 probes, none of which carried
  // one — so publishing `error: true` here is itself a contract break, and the
  // immutable bundle reads `_.error` and suppresses its "No active listing
  // found" line when it sees one. The failure is named in the log with the
  // provider's own reason instead: reported, not swallowed, and never carrying
  // a credential. hits stays genuinely empty; nothing is substituted for it.
  if (r.error) {
    console.warn(`[listing-check] Serper returned no result for ${JSON.stringify(addr)}: ${String(r.error).slice(0, 300)}`);
  }
  const value = {
    configured: true,
    address: addr,
    forSale: r.error ? false : !!r.forSale,
    hits: r.error ? [] : (r.hits ?? []).map((h) => ({ url: h.url, kind: h.saleSignal ? "listing" : "mention", source: h.source ?? "", title: h.title ?? "" })),
    checked: Date.now()
  };
  // A real provider answer is stored — including an empty one, because the
  // original replays empty answers as cached too. The unconfigured branch above
  // asked nobody and is therefore never stored.
  listingCheckCache.set(cacheKey, { at: Date.now(), value });
  return value;
}));

// -------------------------------------------------------------- listingcheck
// Dossier "Marketing check": { configured, listed, hits:[{title,link,host,
// snippet,isListing}], searches:[{url,label,live}] } — platform one-click
// searches are ALWAYS returned so the manual path never disappears.
const LISTING_PLATFORMS = [
  ["StreetEasy", "streeteasy.com"], ["Zillow", "zillow.com"], ["LoopNet", "loopnet.com"],
  ["Crexi", "crexi.com"], ["PropertyShark", "propertyshark.com"]
];
const FOR_SALE_RE = /\bfor sale\b|\blisting\b|\blisted\b|\basking\b|\bon the market\b/i;
router.get("/api/listingcheck", wrap(async (req) => {
  const addr = String(req.query.addr ?? "").trim();
  const baseSearches = LISTING_PLATFORMS.map(([label, host]) => ({
    url: `https://www.google.com/search?q=${encodeURIComponent(`site:${host} "${addr}"`)}`,
    label
  }));
  if (!serperConfigured() || !addr) return { configured: false, listed: false, hits: [], searches: baseSearches };
  const r = await serperSearch(`"${addr}" New York`);
  if (r.error) return { configured: true, listed: false, hits: [], searches: baseSearches };
  const hits = (r.hits ?? []).slice(0, 8).map((h) => {
    let host = ""; try { host = new URL(h.url).hostname.replace(/^www\./, ""); } catch { /* keep blank */ }
    return {
      title: h.title, link: h.url, host, snippet: h.snippet ?? "",
      isListing: LISTING_PLATFORMS.some(([, ph]) => host.endsWith(ph)) && FOR_SALE_RE.test(`${h.title} ${h.snippet}`)
    };
  });
  const searches = baseSearches.map((s) => {
    const ph = LISTING_PLATFORMS.find(([label]) => label === s.label)?.[1] ?? "";
    const platformHits = hits.filter((h) => h.host.endsWith(ph));
    return { ...s, live: platformHits.length ? platformHits.some((h) => h.isListing) : false };
  });
  return { configured: true, listed: hits.some((h) => h.isListing), hits, searches };
}));

// ------------------------------------------------------------- airtable-xref
// Measured 2026-08-19 on ?owner=EMPIRE STATE REALTY OP LP&bbl=1008350041 from a
// gate-password (NON-owner) session: the original answers
//   {"configured":true,"sellerMatches":[],"buyerMatches":[],"cached":true}
// — four keys in that order. So `configured` is NOT owner-gated on the
// original, and there is a fourth key the rebuild never published. The owner
// gate stays on the DATA (the original returned no matches on that probe, so
// it cannot show whether it would hand CRM rows to a non-owner, and widening
// that on a guess is not a call to make silently); only the honest
// configuration flag is reported to everyone, which is what was measured.
router.get("/api/airtable-xref", wrap(async (req) => {
  const configured = airtableConfigured();
  if (!configured) return { configured: false, sellerMatches: [], buyerMatches: [], cached: false };
  if (!isOwner(req)) return { configured: true, sellerMatches: [], buyerMatches: [], cached: false };
  const x = await crmXref({ owner: String(req.query.owner ?? ""), address: String(req.query.address ?? ""), bbl: String(req.query.bbl ?? "") });
  const sellersTable = process.env.AIRTABLE_SELLERS_TABLE || "Sellers";
  const f = (m) => m.fields ?? {};
  return {
    configured: !!x.configured,
    sellerMatches: (x.sellerMatches ?? []).map((m) => ({
      table: sellersTable, name: m.name, stage: f(m).Stage ?? f(m).stage ?? null, phone: f(m).Phone ?? f(m).phone ?? null
    })),
    buyerMatches: (x.buyerMatches ?? []).map((m) => ({ name: m.name })),
    cached: x.cached === true
  };
}));

// ------------------------------------------------------------------ contacts
// Normalize the live contacts pull to the five arrays the dossier reads.
import { liveContacts, liveNearby } from "./live.js";
import { hpdContactsByBbl } from "./adapters/nyc.js";

router.get("/api/contacts", wrap(async (req) => {
  const bbl = String(req.query.bbl ?? "").replace(/[^0-9]/g, "");
  if (bbl.length !== 10) return null;
  const [base, pg] = await Promise.all([
    liveContacts(bbl).catch(() => null),
    postgisConfigured() ? pgContacts(bbl).catch(() => null) : Promise.resolve(null)
  ]);
  if (!base && !pg) return null;
  const hpd = await hpdContactsByBbl(bbl).catch(() => ({ rows: [] }));
  return {
    permitContacts: base?.permitContacts?.length ? base.permitContacts : (pg?.permitContacts ?? []),
    ownerContacts: base?.ownerContacts ?? [],
    ownerEntities: base?.ownerEntities ?? [],
    debtParties: base?.debtParties?.length ? base.debtParties : (pg?.debtParties ?? []),
    // `source` on every row, like the other four families. It was the only one
    // without it, so a caller checking provenance per-contact — which is the
    // rule for every fact this app shows — found four unattributed rows sitting
    // beside attributed ones. The collective note below is not a substitute:
    // once these are merged into a list, a row with no source cannot be traced.
    hpdContacts: (hpd.rows ?? []).map((r) => ({
      role: r.type ?? "Registered contact",
      name: [r.firstname, r.lastname].filter(Boolean).join(" ") || null,
      business: r.corporationname ?? null,
      date: null,
      source: "HPD building registration contacts"
    })),
    note: base?.note ?? "Contacts from the PostGIS public-record store: DOB permit filings and recorded mortgage parties for this lot."
  };
}));

// -------------------------------------------------------------------- nearby
router.get("/api/nearby", wrap(async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  // The original answers 400 for a request without coordinates; falling
  // through here sent it to the guard's 503 instead (A/B diff, 2026-08-17).
  // The BODY is the original's own sentence, not a code. Measured 2026-08-19
  // on five malformed forms — /api/nearby, ?lat=40.7&lng=, ?lat=abc&lng=xyz,
  // ?lat=NaN&lng=NaN and ?lat=Infinity&lng=1 — the original answers 400
  // {"error":"Provide ?lat= & ?lng="} to every one of them, where the rebuild
  // answered {"error":"lat_lng_required"}.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) { res.status(400).json({ error: "Provide ?lat= & ?lng=" }); return undefined; }
  const rows = await liveNearby(lat, lng).catch(() => null);
  if (!rows) return null;
  // Envelope measured on the original: {lat,lng,buildings,coverage}, with each
  // building carrying bbl, address, bldgClass, units, yearBuilt, distanceFt,
  // lat, lng, owner and bearing in that order. This returned `buildings` alone
  // and no owner, so the dossier's neighbour list showed lots with no
  // registered owner beside the map pins. liveNearby now builds each lot in
  // that shape — it needs the raw PLUTO row to tell an absent column from a
  // zero — so nothing is re-projected here.
  return {
    lat, lng, buildings: rows,
    // The original's line, verbatim, with its own count interpolated — it says
    // "1 nearest tax lots" for a single result, and the "~190m" is fixed text
    // that does not track the box (its own answers reach 257 m).
    coverage: `${rows.length} nearest tax lots from PLUTO within ~190m of your location.`
  };
}));

// -------------------------------------------------------------------- lot-at
// The Cesium/AR click-through needs the side panel's full property set. The
// PostGIS store answers first with an exact ST_Contains polygon hit on the
// MapPLUTO lot geometry; the live-PLUTO nearest-centroid search is the
// fallback when the store is not configured.
import { plutoBbox } from "./adapters/nyc.js";
const COUNTY_BY_DIGIT = { 1: "New York", 2: "Bronx", 3: "Kings", 4: "Queens", 5: "Richmond" };

// lot-at parity: the original's /api/lot-at is PostGIS-backed and carries the
// full MapPLUTO lot attributes — the 2-digit land-use code ("05"), the landmark
// designation, the split-zone flag and any limited-height district. When this
// deployment's parcel store is not populated and lot-at falls back to Socrata
// PLUTO, `plutoRowToBuilding` deliberately drops those fields (landmark: null,
// ltdHeight: "") and leaves land-use unpadded, because the /api/area-buildings
// and /api/opportunities endpoints it also feeds match an original that returns
// land-use unpadded ("7") and these fields null. So the enrichment is applied
// here, at lot-at only: the raw PLUTO row DOES carry landmark / splitzone /
// ltdheight / histdist, and the original's lot-at pads the land-use code.
// Measured 2026-08-18 against BBL 1008350041: original lot-at landUse "05",
// landmark "INDIVIDUAL AND INTERIOR LANDMARK", splitZone true, ltdHeight null.
function enrichLotAtFields(b, raw) {
  if (!b || !raw) return b;
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  b.landmark = clean(raw.landmark);
  b.ltdHeight = clean(raw.ltdheight);
  b.histDist = clean(raw.histdist);
  b.eDesig = clean(raw.edesignum ?? raw.edesig);
  b.splitZone = raw.splitzone === true || raw.splitzone === "Y" || raw.splitzone === "true";
  if (typeof b.landUse === "string" && /^\d$/.test(b.landUse)) b.landUse = b.landUse.padStart(2, "0");
  return b;
}

function lotEnvelope(b) {
  if (!b?.bbl || !b.address) return null;
  return {
    ...b,
    parcelId: b.bbl,
    units: b.unitsTotal || b.unitsRes || 0,
    floors: b.numFloors,
    maxResidFar: b.residFar, maxCommFar: b.commFar, maxFacilFar: b.facilFar,
    assessedTotal: b.assessTotal, assessedLocal: b.assessTotal,
    fullMarketValue: b.marketValue ?? null,
    muni: "New York", county: COUNTY_BY_DIGIT[b.bbl[0]] ?? "New York",
    absentee: !!(b.mailAddress && b.address && !String(b.mailAddress).toUpperCase().startsWith(String(b.address).toUpperCase().slice(0, 8))),
    mailAddress: b.mailAddress ?? null
  };
}

// The original's /api/lot-at contract, measured 2026-08-19 on nine cases.
//
// A HIT is exactly these 23 keys in this order and nothing else. The rebuild
// was returning 63 — the whole internal building object plus lotEnvelope's
// derived fields plus resolvedBy — and although all 23 shared values matched
// byte-for-byte on the Empire State probe, the 40 extras are not the contract.
//
//   original 200 keys(23): bbl,address,owner,bldgClass,landUse,zoning,units,
//     unitsRes,lotArea,bldgArea,floors,yearBuilt,assessedTotal,builtFar,
//     maxResidFar,maxCommFar,maxFacilFar,numBldgs,histDist,landmark,eDesig,
//     splitZone,ltdHeight
//   rebuild  200 keys(63): … onlyRebuild(40)=[borough,block,lot,zip,lat,lng,
//     bin,overlay,specialDistrict,resArea,comArea,officeArea,retailArea,
//     numFloors,unitsTotal,yearAltered,yearAlter1,yearAlter2,exemptTotal,
//     residFar,commFar,facilFar,maxFar,unusedFar,unusedFarSf,assessLand,
//     assessTotal,marketValue,lotFront,lotDepth,permitCount,mailAddress,
//     provenance,parcelId,assessedLocal,fullMarketValue,muni,county,absentee,
//     resolvedBy]
//
// floors and yearBuilt are NULL when the record carries no value; numBldgs,
// bldgArea and builtFar keep honest zeros. Measured at 40.752000,-73.977000
// (Grand Central, BBL 1012800001): the original serves floors:null,
// yearBuilt:null, bldgArea:0, builtFar:0, numBldgs:1, assessedTotal:0 — the
// rebuild served floors:0 and yearBuilt:0 there.
const LOT_AT_UNKNOWN = (v) => (v === 0 || v == null ? null : v);
function lotAtContract(b, raw) {
  if (!b?.bbl || !b.address) return null;
  return {
    bbl: b.bbl,
    address: b.address,
    owner: b.owner,
    bldgClass: b.bldgClass,
    landUse: b.landUse,
    zoning: b.zoning,
    units: b.unitsTotal || b.unitsRes || 0,
    unitsRes: b.unitsRes,
    lotArea: b.lotArea,
    bldgArea: b.bldgArea,
    // A building with no recorded floor count / year is unknown, not zero.
    floors: LOT_AT_UNKNOWN(b.numFloors),
    yearBuilt: LOT_AT_UNKNOWN(b.yearBuilt),
    assessedTotal: b.assessTotal,
    builtFar: b.builtFar,
    maxResidFar: b.residFar,
    maxCommFar: b.commFar,
    maxFacilFar: b.facilFar,
    // Straight from the record. plutoRowToBuilding coerces a recorded 0 to 1
    // for its other consumers; a lot with no building must not report one.
    numBldgs: raw?.numbldgs == null ? b.numBldgs : Number(String(raw.numbldgs).replace(/[^0-9.]/g, "")) || 0,
    histDist: b.histDist ?? null,
    landmark: b.landmark ?? null,
    eDesig: b.eDesig ?? null,
    splitZone: b.splitZone === true,
    ltdHeight: b.ltdHeight ?? null
  };
}

router.get("/api/lot-at", wrap(async (req, res) => {
  // Parameter contract, measured on four cases:
  //   lat=abc&lng=-73.98 -> 400 {"error":"Provide ?lat= and ?lng="}
  //   lat=&lng=          -> 200 {"found":false}
  //   (no params)        -> 200 {"found":false}
  //   lat=40.7484 only   -> 200 {"found":false}
  // The rebuild answered 503 mappluto_unavailable for three of those and 404
  // no_parcel_found for the fourth, because returning null here falls through
  // to a later router.
  const rawLat = req.query.lat, rawLng = req.query.lng;
  const lat = parseFloat(rawLat), lng = parseFloat(rawLng);
  const malformed = (q, n) => q !== undefined && q !== "" && !Number.isFinite(n);
  if (malformed(rawLat, lat) || malformed(rawLng, lng)) {
    res.status(400).json({ error: "Provide ?lat= and ?lng=" });
    return undefined;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { found: false };
  if (postgisConfigured()) {
    const hit = await pgLotAt(lat, lng).catch(() => null);
    if (hit) {
      const pgRaw = parcelRowToPlutoRow(hit);
      const envelope = lotAtContract(enrichLotAtFields(plutoRowToBuilding(pgRaw), pgRaw), pgRaw);
      if (envelope) return envelope;
    }
  }
  // Containment first, nearest-centroid only as a labelled last resort.
  //
  // "Which lot contains this point" and "which lot centroid is closest to this
  // point" are different questions with different answers on long lots and near
  // shared lot lines — and this used to answer the second while the UI asks the
  // first, so a click near a boundary could open the neighbour's dossier.
  // DOF's Digital Tax Map, which is the same source the lot grid is drawn from
  // and answers reliably. (MapPLUTO's ArcGIS service returns live:true with zero
  // features for these coordinates, so it cannot be the primary here.)
  //
  // intersects(), not within_box(). Socrata's within_box requires the geometry to
  // be CONTAINED in the box, so a box small enough to be near the click excluded
  // every lot bigger than it — the Empire State Building's own lot returned zero
  // rows at ±0.0006 deg and five unrelated ones at ±0.002. intersects() with a
  // POINT asks the question directly and returns exactly the containing lot.
  const geo = await soql(TAX_LOT_POLYGONS, {
    $where: `intersects(the_geom, "POINT(${lng} ${lat})")`,
    $limit: 5
  }, { ttlMs: 24 * 60 * 60 * 1000, timeoutMs: 30000 }).catch(() => null);
  if (geo?.live) {
    for (const row of geo.rows ?? []) {
      // The server already answered "this polygon contains the point". The local
      // test re-checks it when the geometry came back, and is skipped rather than
      // treated as a rejection when the column is absent from the projection.
      if (row.the_geom && !geometryContains(row.the_geom, lng, lat)) continue;
      const hitBbl = ["bbl", "base_bbl", "map_pluto_bbl", "mapplutobbl", "map_bbl", "billbbl"]
        .map((k) => String(row[k] ?? "").replace(/[^0-9]/g, ""))
        .find((v) => v.length === 10);
      if (!hitBbl) continue;
      const byBbl = await plutoByBbl(hitBbl).catch(() => null);
      const raw = byBbl?.live && byBbl.rows?.length ? byBbl.rows[0] : null;
      const b = raw ? enrichLotAtFields(plutoRowToBuilding(raw), raw) : null;
      const env = b ? lotAtContract(b, raw) : null;
      if (env) return env;
    }
  }

  // No lot polygon contains the point, so there is no lot at this point.
  //
  // This used to fall back to a nearest-centroid search and return the closest
  // lot instead, labelled resolvedBy:"nearest-centroid …". The original does
  // not: measured 2026-08-19, it answers 200 {"found":false} at
  // 40.678180,-73.944160, 40.764560,-73.973000 and 40.687000,-73.944000, while
  // the rebuild returned a full 63-key record for a DIFFERENT lot at each. A
  // click on a street opened a neighbour's dossier. The label did not help: the
  // compiled client renders whatever lot it receives.
  //
  // The DOF query above is the only source consulted; when it does not answer
  // live at all, that is an unavailable source, not an absent lot, and it is
  // reported as such rather than as {"found":false}.
  if (!geo?.live) {
    res.status(503).json({
      provenance: "unavailable",
      error: "lot_at_source_unavailable",
      message: "The DOF Digital Tax Map lot-containment query is unavailable. No nearest-lot guess was substituted."
    });
    return undefined;
  }
  return { found: false };
}));

// ---------------------------------------------------------------- nta-polys
// Viewport NTA polygons from the PostGIS store (ST_MakeEnvelope bounding-box
// query); the packaged static NTA file behind this router still answers when
// the store is not configured.
//
// CORRECTED 2026-08-18. This comment used to read "THE PACKAGED FILE IS THE
// CONTRACT, NOT A PLACEHOLDER", on the strength of a 2026-08-17 check that
// queried the original with no bbox at all. That returns the original's
// citywide answer, which is capped at 160 features — and the packaged file is a
// capture of exactly that. Driven one bbox at a time, the original serves the
// CURRENT DCP 2020 layer, including the "Midtown South-Flatiron-Union Square"
// polygon whose geometry is byte-identical to 9nt8-h7nd's, to this same bundle,
// which renders it. server/production-nta.js now owns this endpoint, carries
// the full per-bbox measurement, and applies the original's 160-feature cap.
// The packaged file remains the demo/offline answer in server/routes.js.
router.get("/api/nta-polys", wrap(async (req) => {
  if (!postgisConfigured()) return null;
  const parts = String(req.query.bbox || "").split(",").map(Number);
  const [minLng, minLat, maxLng, maxLat] = parts.length === 4 && parts.every(Number.isFinite)
    ? parts : [-74.26, 40.49, -73.68, 40.92];
  const out = await pgNtaPolys(minLng, minLat, maxLng, maxLat).catch(() => null);
  if (!out?.features?.length) return null;
  return out;
}));

// --------------------------------------------------------------- tax-history
// DOF valuation roll from the PostGIS store in the exact envelope the dossier
// reads; the live DOF pull behind this router still answers when the store is
// not configured. Estimated tax uses adopted class rates where published,
// carrying the latest adopted rate forward past the newest adopted year —
// labeled estimated per row, never presented as a recorded fact.
// FY2025/26 is adopted but not yet in the City's published rate dataset, so it
// is pinned here as a fallback. Every other year comes from 7zb8-7bpk — see
// taxRatesByClass in adapters/nyc.js.
//
// THE DEFECT: this table held ONLY 2026, and this route is in bundleRoutes,
// which answers before the DOF implementation further down the stack. So any
// deployment with PostGIS configured got taxRate:null and estTax:null on every
// year except one — a blank tax column that reads as "no tax", not "not
// computed" — while the non-PostGIS path priced all five years correctly. Two
// implementations of the same endpoint disagreeing is worse than either.
const PG_ADOPTED_RATES = { 2026: { 1: 0.19843, 2: 0.12439, 3: 0.11108, 4: 0.10848 } };
router.get("/api/tax-history", wrap(async (req) => {
  if (!postgisConfigured()) return null;
  const bbl = String(req.query.bbl ?? "").replace(/[^0-9]/g, "");
  if (bbl.length !== 10) return null;
  const [raw, published] = await Promise.all([
    pgTaxHistory(bbl).catch(() => null),
    taxRatesByClass().catch(() => ({ live: false, byYear: {} }))
  ]);
  if (!raw) return null;
  const publishedRates = published.live ? published.byYear : {};
  const latestAdopted = Math.max(
    ...Object.keys(PG_ADOPTED_RATES).map(Number),
    ...Object.keys(publishedRates).map(Number)
  );
  const rows = raw.map((x) => {
    const year = parseInt(x.year, 10);
    const taxClass = x.taxClass ?? null;
    const key = String(taxClass ?? "").match(/[1-4]/)?.[0] ?? null;
    const adopted = publishedRates[year]?.[key] ?? PG_ADOPTED_RATES[year]?.[key] ?? null;
    // Past the last adopted year the City has not set rates yet, so carry the
    // most recent forward and label the result an estimate — same rule and same
    // labels as the DOF path, so the two cannot report different tax for the
    // same lot.
    const carried = adopted == null && year > latestAdopted
      ? (publishedRates[latestAdopted]?.[key] ?? PG_ADOPTED_RATES[latestAdopted]?.[key] ?? null)
      : null;
    const rate = adopted ?? carried;
    const taxable = num(x.taxable) || null;
    return {
      year, taxClass,
      marketValue: num(x.marketValue) || null,
      assessedTotal: num(x.assessedTotal) || null,
      taxable,
      taxRate: rate,
      estTax: rate != null && taxable != null ? Math.round(taxable * rate) : null,
      estTaxValueType: adopted != null ? "derived calculation" : carried != null ? "estimated" : "unavailable",
      taxRateSource: adopted != null
        ? `NYC Council adopted FY ${year - 1}/${String(year).slice(2)} property tax rates`
        : carried != null
          ? `Estimated: FY ${year - 1}/${String(year).slice(2)} rates are not adopted yet, so the adopted FY ${latestAdopted - 1}/${String(latestAdopted).slice(2)} class ${key} rate is carried forward`
          : null,
      note: rate == null ? "No adopted class rate is available for this fiscal year, so no tax figure is shown rather than a guessed one." : null,
      provenance: "live", source: "NYC DOF Property Valuation and Assessment Data (PostGIS store)"
    };
  }).filter((x) => x.marketValue != null || x.assessedTotal != null || x.taxable != null)
    .sort((a, z) => z.year - a.year);
  if (!rows.length) return null;
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i + 1];
    rows[i].yoyMarketPct = prev?.marketValue && rows[i].marketValue
      ? Math.round(((rows[i].marketValue - prev.marketValue) / prev.marketValue) * 1000) / 10 : null;
  }
  return {
    provenance: "live", bbl, rows, latestAdoptedRateFiscalYear: 2026,
    note: "Published DOF values are facts. Estimated tax uses the adopted class rate where one is published; past the most recent adopted year the latest adopted rate is carried forward and the figure is labeled estimated (see estTaxValueType and taxRateSource on each row). Exemptions, abatements, credits and bill adjustments can make the actual bill differ."
  };
}));

// --------------------------------------------------------------------- address
// Any spelling a person types must land on the right parcel. Resolution
// order: a raw 10-digit BBL → the city's own geocoder (GeoSearch, free, no
// key) → normalized PLUTO prefix search as the offline fallback.
const ABBREV = {
  E: "EAST", W: "WEST", N: "NORTH", S: "SOUTH",
  ST: "STREET", AVE: "AVENUE", AV: "AVENUE", BLVD: "BOULEVARD", RD: "ROAD",
  PL: "PLACE", DR: "DRIVE", PKWY: "PARKWAY", LN: "LANE", CT: "COURT",
  TER: "TERRACE", SQ: "SQUARE", BDWY: "BROADWAY", EXPY: "EXPRESSWAY", HWY: "HIGHWAY"
};
const normalizeAddress = (q) => String(q).toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim()
  .split(" ").map((w, i) => (i > 0 && ABBREV[w]) ? ABBREV[w] : w).join(" ")
  .replace(/(\d+)(ST|ND|RD|TH)\b/g, "$1");

// The original publishes its own address implementation in the response's
// sources[] array. Measured 2026-08-19 for ?q=350 5th Avenue:
//   { id: "geosearch", label: "NYC Planning Labs GeoSearch", endpoint: "geosearch",
//     query: "https://geosearch.planninglabs.nyc/v2/search?text=350+5th+Avenue&size=10",
//     status: "ok", count: 10 }
//   { id: "pluto_address", label: "PLUTO (matched lots)", endpoint: "64uk-42ks",
//     query: "https://data.cityofnewyork.us/resource/64uk-42ks.json?%24where=bbl+in+%28%273009810111%27%2C…%29&%24limit=200",
//     status: "ok", count: 8 }
// So: ONE geosearch call at size=10, then ONE PLUTO call listing the resolved
// BBLs, $where before $limit, $limit=200, and the BBLs written plain (no
// .00000000 suffix). count on the geosearch row is the FEATURE count (10),
// not the deduplicated BBL count (8).
const GEOSEARCH_SIZE = 10;
const GEOSEARCH_ENDPOINT = "https://geosearch.planninglabs.nyc/v2/search";
const ADDRESS_PLUTO_LIMIT = 200;
const ADDRESS_PLUTO_DATASET = "64uk-42ks";
const SOCRATA_DOMAIN = process.env.SOCRATA_DOMAIN || "https://data.cityofnewyork.us";

// Mirrors adapters/socrata.js soql(): same URLSearchParams serialisation, so
// the query published in sources[] is the query that was actually issued.
const addressSourceUrl = (dataset, params) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
  return `${SOCRATA_DOMAIN}/resource/${dataset}.json?${qs}`;
};
const geosearchUrl = (q) =>
  `${GEOSEARCH_ENDPOINT}?${new URLSearchParams({ text: q, size: String(GEOSEARCH_SIZE) })}`;

const geoCache = new Map();
async function geosearchBbls(q) {
  const key = q.toLowerCase();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit;
  // The original's candidate set is the raw query at size=10: for
  // "220 East 42nd Street" it serves 7 lots including the Brooklyn E 42 St
  // matches, and /v2/search with the text as typed and size=10 reproduces
  // those 7 BBLs in the same order (measured 2026-08-18). Appending
  // ", New York" swapped the Brooklyn lots for wrong Manhattan ones.
  const url = geosearchUrl(q);
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`geosearch ${r.status}`);
  const j = await r.json();
  const features = Array.isArray(j.features) ? j.features : [];
  const bbls = [];
  // The PAD addendum carries the BIN alongside the BBL; the original's
  // address rows expose it (A/B diff 2026-08-17), so it is kept here for the
  // address handler to inject into the enriched rows.
  for (const f of features) {
    const bbl = String(f?.properties?.addendum?.pad?.bbl ?? f?.properties?.pad_bbl ?? "");
    if (!/^[1-5]\d{9}$/.test(bbl) || bbls.some((x) => x === bbl)) continue;
    const bin = String(f?.properties?.addendum?.pad?.bin ?? f?.properties?.pad_bin ?? "").trim();
    if (bin) geoBinCache.set(bbl, bin);
    bbls.push(bbl);
    if (bbls.length >= GEOSEARCH_SIZE) break;
  }
  const out = { at: Date.now(), bbls, features: features.length, url };
  geoCache.set(key, out);
  return out;
}
const geoBinCache = new Map();

// Measured 2026-08-19 against the original: a missing, blank or whitespace-only
// ?q= is 400 {"error":"Provide an address via ?q="} — /api/address, ?q=,
// ?q=%20 and ?Q=350%205th%20Ave (only lower-case `q` counts) all 400. The
// rebuild fell through to the live guard's 503
// {"error":"live_source_unavailable"}.
router.get("/api/address", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) { res.status(400).json({ error: "Provide an address via ?q=" }); return undefined; }

  // The original does NOT special-case a 10-digit BBL and has no PLUTO
  // prefix-search fallback. Measured: ?q=1008350041 answers
  //   sources: [{ id:"geosearch", …, status:"empty", count:0 }]
  //   total 0, returned 0, pageSize 10,
  //   coverage "Address search “1008350041”: no match."
  // — a single geosearch call that found nothing, and no second source. The
  // rebuild used to resolve that string through plutoByBbl and serve the lot,
  // which is a match the original never makes.
  const geo = await geosearchBbls(q).catch(() => ({ bbls: [], features: 0, url: geosearchUrl(q) }));
  const bbls = geo.bbls ?? [];
  const sources = [{
    id: "geosearch",
    label: "NYC Planning Labs GeoSearch",
    endpoint: "geosearch",
    query: geo.url ?? geosearchUrl(q),
    status: geo.features ? "ok" : "empty",
    count: geo.features ?? 0
  }];

  // The original's address envelope IS the area envelope — the same enriched
  // rows (score, raw, permit counts, propensity) under zips/page/sort keys
  // (A/B diff 2026-08-17). project() reads FULL raw PLUTO rows, so the matched
  // lots are fetched unprojected in ONE call and routed through that pipeline.
  let full = [];
  if (bbls.length) {
    const params = { $where: `bbl in (${bbls.map((b) => `'${b}'`).join(",")})`, $limit: ADDRESS_PLUTO_LIMIT };
    const fr = await soql(ADDRESS_PLUTO_DATASET, params);
    if (fr.live) full = fr.rows ?? [];
    sources.push({
      id: "pluto_address",
      label: "PLUTO (matched lots)",
      endpoint: ADDRESS_PLUTO_DATASET,
      query: addressSourceUrl(ADDRESS_PLUTO_DATASET, params),
      status: fr.live ? "ok" : "error",
      count: full.length
    });
  }

  const { enrichPlutoRows } = await import("./area-buildings.js");
  const enriched = (await enrichPlutoRows(full, { permits: false })).filter((b) => b.bbl);
  // The original's address rows carry the BIN the geocoder resolved.
  for (const b of enriched) {
    const bin = geoBinCache.get(b.bbl);
    if (bin && b.bin === undefined) b.bin = bin;
  }
  // The original returns rows in RESOLUTION order — the exact address match
  // first (its 272 E 3 St response leads with score 37 ahead of score 85) —
  // and its zips field mirrors the request (empty for an address search).
  const order = new Map(bbls.map((b, i) => [b, i]));
  const buildings = enriched.sort((a, z) => (order.get(a.bbl) ?? 99) - (order.get(z.bbl) ?? 99));

  // Coverage, measured verbatim. A SINGLE match gets its own sentence
  // ("Address search “Empire State Building” — 1 match. Click for full PLUTO
  // detail + live DOB / ACRIS / sales evidence and contacts."); two or more get
  // the assemblage sentence, whose three totals are plain sums over the matched
  // lots — 225,931 / 2,969,805 / 107,127 on ?q=350 5th Avenue, 881,195 /
  // 10,602,500 / 0 on ?q=One World Trade Center. The quotes are curly and the
  // separators an em dash and middots.
  const sum = (k) => buildings.reduce((t, b) => t + (Number(b[k]) || 0), 0);
  const coverage = buildings.length === 1
    ? `Address search \u201c${q}\u201d \u2014 1 match. ` +
      "Click for full PLUTO detail + live DOB / ACRIS / sales evidence and contacts."
    : buildings.length
    ? `Assemblage \u201c${q}\u201d \u2014 ${buildings.length} lots combined: ` +
      `${sum("lotArea").toLocaleString("en-US")} sf lot \u00b7 ` +
      `${sum("bldgArea").toLocaleString("en-US")} sf built \u00b7 ` +
      `~${sum("unusedFarSf").toLocaleString("en-US")} sf unused buildable. ` +
      "Click each lot for full detail, live evidence, and contacts."
    : `Address search \u201c${q}\u201d: no match.`;

  // Key order and pageSize, measured: zips, fetchedAt, page, sort, pageSize,
  // total, returned, coverage, buildings, sources — and pageSize is the row
  // count when there are rows (8 for 350 5th Avenue) and the geosearch page
  // size when there are none (10 for the no-match probe).
  return {
    zips: [],
    fetchedAt: new Date().toISOString(),
    page: 0,
    sort: "score",
    pageSize: buildings.length || GEOSEARCH_SIZE,
    total: buildings.length,
    returned: buildings.length,
    coverage,
    buildings,
    sources
  };
}));

// ----------------------------------------------------------------- maps-usage
// Owner-only meters in the exact fields the Source Registry reads.
// A signed-in owner reads the durable counters in cre_usage_daily
// (server/production-api.js) — the same rows durable-cost.js increments before
// it lets a chargeable Google call go out. Reading a separate file here would
// show the Source Registry one number while spend was gated on another, and
// the file does not survive a deploy. The local meter remains for the
// gate-password tiers with no account and for offline work.
const meterPath = path.join(DATA_DIR, "usage-meters.json");
router.get("/api/maps-usage", wrap(async (req, res) => {
  if (hasBearer(req)) return null; // durable cre_usage_daily rows
  if (!isOwner(req)) { res.status(403).type("text").send("Owner only."); return; }
  const month = new Date().toISOString().slice(0, 7);
  // The durable counter first, because it is the one chargeable calls
  // increment. Reading the local file here showed this owner zero while real
  // Street View usage accrued in cre_usage_daily — a spend panel disagreeing
  // with the meter that gates the spend. The file is still read when the
  // durable store is unreachable, and the response says which one it used so
  // the number is never presented as authoritative when it is not.
  const { readDurableUsage } = await import("./durable-cost.js");
  const durable = await readDurableUsage(month);
  if (durable.live) {
    return {
      configured: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
      month,
      streetview: durable.byCategory.streetview ?? 0,
      staticmap: durable.byCategory.staticmap ?? 0,
      freeStreetview: 10000, freeStatic: 10000,
      source: "cre_usage_daily", durable: true
    };
  }
  let m = {};
  try { m = JSON.parse(readFileSync(meterPath, "utf8")); } catch { /* fresh */ }
  return {
    configured: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
    month,
    streetview: m[month]?.streetview ?? 0,
    staticmap: m[month]?.staticmap ?? 0,
    freeStreetview: 10000, freeStatic: 10000,
    source: "local usage-meters.json", durable: false,
    note: `The durable usage store is unavailable (${durable.reason || "unconfigured"}), so these are this container's local counts only and reset on redeploy.`
  };
}));

// --------------------------------------------------------------- market-index
// { fetchedAt, markets:[{market, <mode>:{metric, submarkets:[{name,ppsf,count,units}]}}], comps:[...] }
import { parseSalesNum } from "./adapters/nyc.js";
const CLASS_FAMILY = [
  ["multifamily", /^[CD]/, "$/gross sf"],
  ["condo", /^R/, "avg unit price"],
  ["office", /^O/, "$/gross sf"],
  ["hotels", /^H/, "$/gross sf"],
  ["development", /^V/, "$/land sf"]
];
const MI_MARKETS = [["Manhattan", "1"], ["Brooklyn", "3"], ["Queens", "4"]];
let miCache = { at: 0, value: null };

async function boroughSales(digit, sinceIso) {
  const r = await soql(DS.rollingSales, {
    $where: `borough='${digit}' AND sale_date > '${sinceIso}'`,
    $order: "sale_date DESC", $limit: 2500
  }, { ttlMs: 6 * 3600e3, timeoutMs: 30000 });
  // A failed pull is not an empty market.
  //
  // `(r.rows ?? [])` treated a source outage as "this borough recorded no
  // sales", and the caller then computed price-per-square-foot indices from
  // whichever boroughs happened to answer while presenting them under the same
  // heading — a market average silently missing a third of the city. The
  // authoritative implementation in server/authority-release.js, which is
  // mounted ahead of this router, pulls each borough exhaustively and 503s on
  // any non-live result; this fallback must not disagree with it, so it reports
  // the failure rather than an empty array.
  //
  // The 2,500-row cap is left in place deliberately: this path is a bounded
  // fallback, and the caller now labels it. Removing the cap here would make a
  // fallback more expensive than the primary.
  if (!r.live) {
    const err = new Error(`Rolling sales unavailable for borough ${digit}: ${r.error ?? "unknown"}`);
    err.code = "borough_sales_unavailable";
    throw err;
  }
  return (r.rows ?? []).map((s) => ({
    saleDate: day(s.sale_date), salePrice: num(s.sale_price),
    address: s.address, neighborhood: (s.neighborhood ?? "").trim(),
    cls: s.building_class_at_present ?? s.building_class_at_time_of_sale ?? "",
    gsf: parseSalesNum(s.gross_square_feet) ?? 0, landSf: parseSalesNum(s.land_square_feet) ?? 0,
    units: num(s.residential_units),
    bbl: s.borough && s.block && s.lot ? `${s.borough}${String(s.block).padStart(5, "0")}${String(s.lot).padStart(4, "0")}` : null
  })).filter((s) => s.salePrice > 100000);
}

router.get("/api/market-index", wrap(async () => {
  if (miCache.value && Date.now() - miCache.at < 6 * 3600e3) return miCache.value;
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  // Every borough must answer. `.catch(() => null)` per borough plus "give up
  // only if ALL are empty" meant one dead borough produced a citywide index
  // built from the other two, with nothing on the response to say so.
  const settled = await Promise.allSettled(MI_MARKETS.map(([, d]) => boroughSales(d, since)));
  const failed = settled
    .map((r, i) => (r.status === "rejected" ? MI_MARKETS[i][0] : null))
    .filter(Boolean);
  if (failed.length) return null; // falls through to the live guard's honest 503
  const all = settled.map((r) => r.value);
  if (all.every((a) => !a?.length)) return null;
  const markets = MI_MARKETS.map(([name], i) => {
    const rows = all[i] ?? [];
    const entry = { market: name };
    for (const [mode, re, metric] of CLASS_FAMILY) {
      const subs = {};
      for (const s of rows) {
        if (!re.test(s.cls) || !s.neighborhood) continue;
        const box = (subs[s.neighborhood] ??= { count: 0, dollar: 0, gsf: 0, land: 0, units: 0 });
        box.count++; box.dollar += s.salePrice; box.gsf += s.gsf; box.land += s.landSf; box.units += s.units;
      }
      const submarkets = Object.entries(subs).map(([nm, b]) => ({
        name: nm,
        ppsf: mode === "condo" ? Math.round(b.dollar / b.count)
          : mode === "development" ? (b.land ? Math.round(b.dollar / b.land) : 0)
          : (b.gsf ? Math.round(b.dollar / b.gsf) : 0),
        count: b.count, units: b.units
      })).filter((x) => x.ppsf > 0).sort((a, z) => z.count - a.count).slice(0, 12);
      entry[mode] = { metric, submarkets };
    }
    return entry;
  });
  const comps = MI_MARKETS.flatMap(([name], i) => (all[i] ?? [])
    .filter((s) => s.gsf > 1000 && s.salePrice > 1000000)
    .slice(0, 40)
    .map((s) => {
      const fam = CLASS_FAMILY.find(([, re]) => re.test(s.cls));
      return {
        address: s.address, bbl: s.bbl, market: name, submarket: s.neighborhood,
        strategy: fam ? fam[0][0].toUpperCase() + fam[0].slice(1) : "Mixed",
        type: s.cls, units: s.units, gsf: s.gsf, landSf: s.landSf,
        salePrice: s.salePrice,
        ppsf: s.gsf ? Math.round(s.salePrice / s.gsf) : null,
        ppbsf: s.landSf ? Math.round(s.salePrice / s.landSf) : null,
        saleDate: s.saleDate
      };
    }))
    .sort((a, z) => (z.saleDate ?? "").localeCompare(a.saleDate ?? "")).slice(0, 60);
  // windowMonths is part of the original's market-index envelope (A/B diff
  // 2026-08-17); the window really is the 12 months `since` selects above.
  const value = { fetchedAt: new Date().toISOString(), windowMonths: 12, markets, comps };
  miCache = { at: Date.now(), value };
  return value;
}));

// -------------------------------------------------------------- market-report
// { windowStart, windowEnd, recordedTotal, narrative[], byClass:[{mode,class,
//   churn, salesCount, dollarVolume, avgPrice, avgPpsf, stock, turnoverPct,
//   impliedHoldYears}] }
import { rollingSalesByZips as salesByZips, plutoCountByZips as countByZips } from "./adapters/nyc.js";
const MODE_LABEL = {
  multifamily: "Multifamily (walk-up + elevator)", condo: "Condo units", office: "Office",
  hotels: "Hotels", development: "Development / vacant land", misc: "Everything else"
};

// The nine-class contract lives in server/market-report.js: DOF category
// classification, live per-class PLUTO stock, and an honest null where a rule
// is not yet known. The previous handler reported one stock figure for every
// asset class, which made turnover and implied hold period wrong for all but
// one of them.
router.get("/api/market-report", async (req, res, next) => {
  try {
    const out = await marketReport(req.query);
    if (out.status === 503 || out.body === null) return next();
    res.status(out.status).json(out.body);
  } catch (e) { next(e); }
});

// ------------------------------------------------------------------ livepull
// Production evidence pull: raw dataset rows per source, query-URL
// transparency, corridor fallback when PLUTO can't resolve the parcel.
const SOCRATA_ROOT = "https://data.cityofnewyork.us/resource";
const qurl = (ds, params) => `${SOCRATA_ROOT}/${ds}.json?${new URLSearchParams(params).toString()}`;

// The recorded instruments the dossier's debt block counts, verbatim from the
// original's own published ACRIS query:
//   doc_type in ('MTGE','ASST','SAT','AGMT','M&CON','SMIS','SUBM','AALR','WSAT')
// Mortgages, their assignments and satisfactions, agreements, consolidations,
// supplements and assignments of leases and rents.
const ACRIS_DEBT_DOC_TYPES = ["MTGE", "ASST", "SAT", "AGMT", "M&CON", "SMIS", "SUBM", "AALR", "WSAT"];
// How many rows each source ships inside the response. The original reports the
// true count and ships at most this many — its ACRIS legals source says count
// 100 and carries 25 — and the same window bounds the document ids the debt
// chain follows.
const SOURCE_ROWS_SHIPPED = 25;
// Newest mortgage first, then the nearest thing to one. The parties named on the
// dossier come from this document, so picking the newest row of any type named
// an agreement's counterparties as the borrower and lender.
const debtDocOf = (rows) =>
  rows.find((m) => /^(MTGE|MMTG)$/i.test(String(m.doc_type ?? "").trim()))
  ?? rows.find((m) => /MTGE|MORTGAGE/i.test(String(m.doc_type ?? "")))
  ?? rows[0]
  ?? null;

router.get("/api/livepull", wrap(async (req, res) => {
  // `bblEcho` is what the caller sent, trimmed and otherwise untouched; `bblRaw`
  // is the digits the sources are queried by. Measured 2026-08-19:
  // ?bbl=3-01842-0015 echoes query.bbl "3-01842-0015" and resolves
  // resolved.bbl "3018420015"; ?bbl=%20%203018420015%20 echoes "3018420015".
  // The rebuild echoed the digit-stripped value in both cases.
  const bblEcho = String(req.query.bbl ?? "").trim();
  const bblRaw = bblEcho.replace(/[^0-9]/g, "");
  // parseBbl is STILL CALLED, and is still the right validator for every other
  // route in this file, but it cannot gate this one. Measured 2026-08-19, the
  // original answers 200 with a full corridor envelope for identifiers parseBbl
  // rejects: ?bbl=0000000000 resolves borough 0 / block 0 / lot 0 and queries
  // them; ?bbl=9018420015 resolves borough 9; ?bbl=100835004 (nine digits) and
  // ?bbl=abc resolve to no borough at all and still return the envelope. The
  // rebuild's `if (!p) return null` dropped all four through to the live guard,
  // which answered 503 {"error":"live_source_unavailable"} where the original
  // answers 200.
  const p = parseBbl(bblRaw);
  void p;
  // Borough/block/lot are RESOLVED from the BBL, not trusted from the query.
  //
  // The compiled bundle's building-detail call site (index-BbnE3o5g.js @884476)
  // sends `borough` straight off the building record, where it is the PLUTO
  // abbreviation — "M", not "1". Both ACRIS Legals and DOF Rolling Sales type
  // borough as a NUMBER, so that value produced a SoQL type-mismatch 400 on the
  // legals query; `legalsR.live` came back false, the master lookup never ran,
  // and the handler returned `debt: {found:false, debtDocCount:0, rows:[]}` on a
  // parcel the original reports 16 recorded debt documents for. The rolling-sales
  // call took the same value as `?borough=M` and answered with nothing at all —
  // no error, just an empty result, so the sale history went quiet too.
  //
  // The original's rule, measured across eight forms on 2026-08-18: strip every
  // non-digit and fall back to the BBL's own code. It does not map letters —
  // bbl=3018420015&borough=M resolves to "3" (the BBL wins), not to "1".
  //
  // A BBL only supplies borough/block/lot when it is EXACTLY ten digits.
  // Measured 2026-08-19: ?bbl=100835004 (nine) and ?bbl=10083500411 (eleven)
  // both resolve borough/block/lot to "" while still querying PLUTO, DOB and ZAP
  // by the digits as given. And the ten-digit split is plain — no validity
  // rules: ?bbl=0000000000 resolves "0"/"0"/"0" and ?bbl=9018420015 resolves
  // "9"/"1842"/"15".
  const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");
  const ten = bblRaw.length === 10 ? bblRaw : null;
  const qBoro = digits(req.query.borough);
  const qBlock = digits(req.query.block);
  const qLot = digits(req.query.lot);
  const borough = qBoro || (ten ? ten.slice(0, 1) : "");
  const block = qBlock ? String(parseInt(qBlock, 10)) : (ten ? String(parseInt(ten.slice(1, 6), 10)) : "");
  const lot = qLot ? String(parseInt(qLot, 10)) : (ten ? String(parseInt(ten.slice(6), 10)) : "");
  const bin = String(req.query.bin ?? "").trim();
  const address = String(req.query.address ?? "");
  const area = String(req.query.area ?? "").trim();
  const rawBorough = String(req.query.borough ?? "").trim();
  const rawBlock = String(req.query.block ?? "").trim();
  const rawLot = String(req.query.lot ?? "").trim();

  // The only request the original refuses. Measured 2026-08-19: /api/livepull
  // with no identifier at all — and each of ?borough=3, ?block=1842,
  // ?address=350%205th%20Ave, ?area=10118, ?borough=3&block=1842, ?bbl= and
  // ?bin= — answers 400 {"error":"Provide a bbl, bin, or borough+block+lot."},
  // while ?bbl=abc (a bbl that is present but resolves to nothing) answers 200.
  // So the test is presence of the raw parameters, not their validity, and
  // borough+block+lot must be all three.
  if (!bblEcho && !bin && !(rawBorough && rawBlock && rawLot)) {
    res.status(400).json({ error: "Provide a bbl, bin, or borough+block+lot." });
    return undefined;
  }

  // Which identifiers each source can be asked by, and the sentence it carries
  // when it cannot be asked at all. Measured 2026-08-19 against ?bbl=abc (every
  // source skipped), ?bbl=100835004 (PLUTO/DOB/ZAP run, DOF and ACRIS skipped),
  // ?borough=3&block=1842&lot=15 (DOF and ACRIS run, PLUTO/DOB/ZAP skipped) and
  // ?bin=1015862 (DOB runs, everything else skipped). The wording is the
  // original's, including PLUTO's "10-digit" when it in fact accepts any digits.
  const haveLot = borough !== "" && block !== "" && lot !== "";
  const haveBbl = bblRaw !== "";
  const NEED_LOT = "Need borough/block/lot or a 10-digit BBL";
  const NEED_BBL = "Need a 10-digit BBL";
  const NEED_BIN_OR_BBL = "Need a BIN or BBL";

  const src = [];
  // `skipReason` is the sentence a SKIPPED source carries under `error`. The
  // original does not ship a skipped ACRIS source silently — measured
  // 2026-08-19, its three sentences are:
  //   acris_master, legals empty  -> "No ACRIS documents on this lot"
  //   acris_parties, legals empty -> "No documents to resolve parties for"
  //   acris_parties, no debt doc  -> "No debt documents to resolve parties for"
  // (BBL 1015260108 and 5010550003 for the first pair; BBL 5035640042 and
  // 1008359999 for the third.) The rebuild shipped those sources with no
  // `error` key at all.
  const push = (id, label, endpoint, query, r, skipReason = null) => {
    const rows = r?.rows ?? [];
    const error = r === null ? skipReason : (r.error || null);
    src.push({
      id, label, endpoint, query,
      status: r === null ? "skipped" : (!r.live || r.error) ? "error" : rows.length ? "ok" : "empty",
      // `count` is the true row count; `rows` is capped, as the original caps
      // it — its ACRIS legals source reports count 100 and ships 25.
      count: rows.length,
      rows: rows.slice(0, SOURCE_ROWS_SHIPPED),
      // `error` only when there IS one, and LAST — after `rows`, not between
      // `status` and `count`. Measured 2026-08-19 on BBL 5035640042: the
      // original's acris_parties source carries its keys in the order
      // ["id","label","endpoint","query","status","count","rows","error"].
      // Emitting it as null on every healthy source would put an `error` key on
      // a source the original ships without one.
      ...(error ? { error } : {})
    });
    return rows;
  };

  const [salesR, plutoR, permitsR, nowR, zapR] = await Promise.all([
    haveLot ? soql(DS.rollingSales, { borough, block, lot, $limit: 25, $order: "sale_date DESC" }) : null,
    // Unprojected, because that is the query this source publishes and the rows
    // the original ships. plutoByBbl adds $select=PLUTO_FIELDS (36 columns), so
    // the handler fetched a projection while publishing
    // `?bbl=1008350041&$limit=5` as the query it ran — and the pluto source's
    // row carried 36 keys where the original's carries 78. Measured on BBL
    // 1008350041, the 42 columns that were missing: cd, ct2010, cb2010,
    // schooldist, council, firecomp, policeprct, healtharea, sanitboro,
    // sanitsub, zonedist2, spdist1, easements, ownertype, garagearea,
    // strgearea, factryarea, otherarea, areasource, bldgfront, bldgdepth, ext,
    // proxcode, irrlotcode, lottype, bsmtcode, affresfar, mnffar, borocode,
    // tract2010, xcoord, ycoord, zonemap, sanborn, taxmap, plutomapid, version,
    // sanitdistrict, healthcenterdistrict, bct2020, bctcb2020, transitzone.
    haveBbl ? soql(DS.pluto, { bbl: bblRaw, $limit: 5 }) : null,
    // The original's permit pull here is by the `bbl` column with no $select and
    // a 25-row window — its own published sources[].query. dobPermitsByLot asks
    // a different question (borough/block/lot, 50 rows, a projection), so the
    // two disagreed about which filing is the newest and the contact panel named
    // a different permittee than the original's.
    bin
      ? soql(DS.dobPermits, { bin__: bin, $limit: 25, $order: "issuance_date DESC" })
      : haveBbl ? soql(DS.dobPermits, { bbl: bblRaw, $limit: 25, $order: "issuance_date DESC" }) : null,
    // Same reasoning as the permit pull above: the original asks DOB NOW by the
    // `bbl` column with a 25-row window, and dobNowByLot's 30-row borough/block/
    // lot question answered a different count.
    bin
      ? soql(DS.dobNow, { bin, $limit: 25, $order: "filing_date DESC" })
      : haveBbl ? soql(DS.dobNow, { bbl: bblRaw, $limit: 25, $order: "filing_date DESC" }) : null,
    haveBbl ? soql("2iga-a6mk", { bbl: bblRaw, $limit: 25 }) : null
  ]);

  // A skipped source publishes an EMPTY query string, not the URL it would have
  // run — measured on every skipped source above.
  const salesRows = push("rolling_sales", "DOF Rolling Calendar Sales", DS.rollingSales,
    haveLot ? qurl(DS.rollingSales, { borough, block, lot, $limit: 25, $order: "sale_date DESC" }) : "", salesR, NEED_LOT);
  const plutoRows = push("pluto", "PLUTO Tax Lot", DS.pluto,
    haveBbl ? qurl(DS.pluto, { bbl: bblRaw, $limit: 5 }) : "", plutoR, NEED_BBL);
  const permitRows = push("dob_permits", "DOB Permit Issuance", DS.dobPermits,
    bin ? qurl(DS.dobPermits, { bin__: bin, $limit: 25, $order: "issuance_date DESC" })
        : haveBbl ? qurl(DS.dobPermits, { bbl: bblRaw, $limit: 25, $order: "issuance_date DESC" }) : "", permitsR, NEED_BIN_OR_BBL);
  const nowRows = push("dob_now", "DOB NOW Build Job Filings", DS.dobNow,
    bin ? qurl(DS.dobNow, { bin, $limit: 25, $order: "filing_date DESC" })
        : haveBbl ? qurl(DS.dobNow, { bbl: bblRaw, $limit: 25, $order: "filing_date DESC" }) : "", nowR, NEED_BIN_OR_BBL);
  const zapRows = push("zap", "City Planning ZAP (BBL)", "2iga-a6mk",
    haveBbl ? qurl("2iga-a6mk", { bbl: bblRaw, $limit: 25 }) : "", zapR, NEED_BBL);

  // The document-type label table, loaded alongside the chain below; cached for
  // a day after the first read, so this is one request per deploy.
  await loadAcrisDocTypes().catch(() => null);

  // ACRIS chain: legals → master (debt) → parties for the top debt document.
  //
  // Plain parameters, not a $where of quoted strings. borough/block/lot are
  // NUMBER columns on 8h5j-fqxa, so `borough='1'` is a SoQL type mismatch and
  // the whole request 400s — which is what emptied this parcel's debt block
  // even before the "M" bug above, because a failed legals lookup skips the
  // master query entirely. The parameter form is the one the original
  // publishes in its own sources[].query, $select and $limit included, and
  // the URL recorded below is now the URL actually fetched rather than a
  // different one built for display.
  const legalsParams = {
    borough, block, lot,
    $select: "document_id,borough,block,lot,property_type",
    $limit: 100
  };
  // ACRIS is asked by borough/block/lot, so with no lot resolved the whole
  // chain is skipped rather than queried with blanks. Measured 2026-08-19 on
  // ?bbl=abc and ?bin=1015862: all three ACRIS sources come back "skipped" with
  // "Need borough/block/lot or a 10-digit BBL".
  const legalsR = haveLot ? await soql(DS.acrisLegals, legalsParams) : null;
  push("acris_legals", "ACRIS Real Property Legals", DS.acrisLegals,
    haveLot ? qurl(DS.acrisLegals, legalsParams) : "", legalsR, NEED_LOT);
  let masterRows = [];
  let partiesTop = [];
  if (!haveLot) {
    push("acris_master", "ACRIS Real Property Master (debt)", DS.acrisMaster, "", null, NEED_LOT);
    push("acris_parties", "ACRIS Real Property Parties", DS.acrisParties, "", null, NEED_LOT);
  } else if (legalsR.live && legalsR.rows?.length) {
    // The distinct documents among the first 25 legals ROWS — the rows this
    // source actually SHIPS — not the first 25 distinct ids drawn from all of
    // them. Measured 2026-08-19 on BBL 1009200012 (605 3 Avenue), whose legals
    // pull reports count 86: the original's master $where lists 22 ids, and
    // those 22 are exactly unique(legals.rows.slice(0,25)) — three of the first
    // 25 rows repeat a document_id. Deduping across all 86 rows first and then
    // taking 25 added FT_1630005797863, 2012071300186001 and FT_1350000122235
    // to the query, which carried acris_master to count 14 and debt.debtDocCount
    // /summary.debtDocCount to 14 where the original serves 12. On BBL
    // 1008350041 the first 25 legals rows are already 25 distinct ids, so both
    // forms agree there and this stayed hidden.
    const ids = [...new Set(legalsR.rows.slice(0, SOURCE_ROWS_SHIPPED).map((r) => r.document_id))];
    // Key order is the original's, because URLSearchParams serializes in
    // insertion order and this object IS the published query. Measured on BBL
    // 1008350041, the original publishes $where, then $order, then $select,
    // then $limit — and writes `in (` with a space, twice:
    //   ?$where=document_id in ('2024062700832001',…) and doc_type in ('MTGE',…)
    //    &$order=recorded_datetime DESC
    //    &$select=document_id,doc_type,document_amt,document_date,recorded_datetime,crfn
    //    &$limit=25
    // This handler emitted $select first and `in(` without the space.
    const masterParams = {
      // The debt filter runs in the query, on the explicit document-type list
      // the original publishes — not as a regular expression over whatever came
      // back. Matching by pattern let SUBM/SMIS through under "SUPPLEMENT" and
      // counted 44 documents on BBL 1008350041 where the original counts 16.
      $where: `document_id in (${ids.map((i) => `'${escSoql(i)}'`).join(",")}) and doc_type in (${ACRIS_DEBT_DOC_TYPES.map((t) => `'${t}'`).join(",")})`,
      $order: "recorded_datetime DESC",
      // Field order follows the original's own $select so the raw rows this
      // returns under debt.rows carry their keys in the same order.
      $select: "document_id,doc_type,document_amt,document_date,recorded_datetime,crfn",
      $limit: 25
    };
    const masterR = await soql(DS.acrisMaster, masterParams);
    masterRows = push("acris_master", "ACRIS Real Property Master (debt)", DS.acrisMaster, qurl(DS.acrisMaster, masterParams), masterR);
    // The headline debt document is the newest MORTGAGE, not the newest of the
    // broader debt set. Measured on BBL 1008350041: the original's debt.rows[0]
    // is a 2024 AGMT while its debt.documentId is 2013031201548002, a 2013 MTGE,
    // and the parties it names are that mortgage's. Taking rows[0] named the
    // agreement's parties instead.
    const debtDoc = debtDocOf(masterRows);
    if (debtDoc) {
      // One query, fetched and published. This asked for eight columns with a
      // $where and $limit 12, then published `?document_id=…` — a URL it never
      // ran. The original's own published query, measured on BBL 1008350041, is
      // the plain document_id parameter with a seven-column $select (no
      // address_2) and $limit 50:
      //   ?document_id=2013031201548002
      //    &$select=document_id,party_type,name,address_1,city,state,zip
      //    &$limit=50
      const partiesParams = {
        document_id: debtDoc.document_id,
        $select: "document_id,party_type,name,address_1,city,state,zip",
        $limit: 50
      };
      const partiesR = await soql(DS.acrisParties, partiesParams);
      partiesTop = push("acris_parties", "ACRIS Real Property Parties", DS.acrisParties, qurl(DS.acrisParties, partiesParams), partiesR);
    } else {
      push("acris_parties", "ACRIS Real Property Parties", DS.acrisParties, "", null,
        "No debt documents to resolve parties for");
    }
  } else {
    push("acris_master", "ACRIS Real Property Master (debt)", DS.acrisMaster, "", null,
      "No ACRIS documents on this lot");
    push("acris_parties", "ACRIS Real Property Parties", DS.acrisParties, "", null,
      "No documents to resolve parties for");
  }

  const exact = plutoRows.length === 1;
  // The query already restricted these to the recorded debt instruments, so the
  // rows are the debt set; the headline document is the newest MORTGAGE among
  // them, which is not the same as the newest row. Measured on BBL 1008350041:
  // the original's rows[0] is a 2024 AGMT while its debt.documentId is
  // 2013031201548002, a 2013 MTGE, and the borrower/lender it names are that
  // mortgage's parties.
  const debtRows = masterRows;
  const topDebt = debtDocOf(masterRows);
  const partyOf = (t) => partiesTop.find((x) => String(x.party_type) === t);
  const partyAddr = (x) => x ? [x.address_1, x.address_2, x.city, x.state, x.zip].filter(Boolean).join(", ") : null;
  const latestPermit = permitRows[0] ?? null;
  // Retained, deliberately unpublished. These three are the permittee the newest
  // DOB filing names — the person, their firm and their licence number — and
  // they are the reason this endpoint reads the permit table at all. The
  // original does NOT carry them on permitContact (see the measurement recorded
  // on that key below), so they are computed and held here rather than deleted:
  // the moment the original starts publishing them, the values are already in
  // hand and only the envelope has to change.
  const permitApplicant = latestPermit
    ? ([latestPermit.permittee_s_first_name, latestPermit.permittee_s_last_name].filter(Boolean).join(" ") || null)
    : null;
  const permitApplicantBusiness = latestPermit
    ? (latestPermit.permittee_s_business_name ?? latestPermit.applicant_business_name ?? null)
    : null;
  const permitLicense = latestPermit ? (latestPermit.permittee_s_license__ ?? null) : null;
  void permitApplicant; void permitApplicantBusiness; void permitLicense;
  // The original's lastSale is the newest recorded row regardless of price —
  // its own summary shows salePrice "0" for a $0 family transfer (A/B diff
  // 2026-08-17). Filtering to >$10k made lastSale null where the original
  // reports the transfer.
  const latestSale = salesRows[0] ?? null;

  // `query` is the caller's own parameters echoed back, unnormalised and with
  // the empty ones dropped — the original keeps borough "M" here even though it
  // resolved it to "1" below, so a reader can see both what was asked and what
  // was actually queried. `area` was being dropped entirely.
  // `bbl` here is the caller's own text, only trimmed. Measured 2026-08-19:
  // ?bbl=3-01842-0015 echoes "3-01842-0015" while resolved.bbl is
  // "3018420015"; the rebuild echoed the stripped digits in both places.
  const queryEcho = {};
  if (bblEcho) queryEcho.bbl = bblEcho;
  if (bin) queryEcho.bin = bin;
  if (rawBorough) queryEcho.borough = rawBorough;
  if (rawBlock) queryEcho.block = rawBlock;
  if (rawLot) queryEcho.lot = rawLot;
  if (address) queryEcho.address = address;
  if (area) queryEcho.area = area;

  // The identifier phrase both coverage sentences end with: the identifiers
  // that were actually usable, in the order BBL, borough/block/lot, BIN, joined
  // with ", " — and "the available identifiers" when none of them resolved.
  // Measured 2026-08-19 on the original:
  //   ?bbl=0000000000                      -> "BBL 0000000000, borough 0 / block 0 / lot 0"
  //   ?bbl=100835004&bin=1015862           -> "BBL 100835004, BIN 1015862"
  //   ?borough=3&block=1842&lot=15&bin=…   -> "borough 3 / block 1842 / lot 15, BIN 1015862"
  //   ?bin=1015862                         -> "BIN 1015862"
  //   ?borough=Brooklyn&block=1842&lot=15  -> "the available identifiers"
  //   ?bbl=abc&area=10118                  -> "the available identifiers"
  // The rebuild always wrote "BBL <x>, borough <y> / block <z> / lot <w>",
  // naming identifiers it had not resolved and never queried.
  const idParts = [];
  if (bblRaw) idParts.push(`BBL ${bblRaw}`);
  if (haveLot) idParts.push(`borough ${borough} / block ${block} / lot ${lot}`);
  if (bin) idParts.push(`BIN ${bin}`);
  const identifiers = idParts.length ? idParts.join(", ") : "the available identifiers";
  return {
    query: queryEcho,
    // bin is always present in the original's resolved block, "" when unknown.
    resolved: { bbl: bblRaw, borough, block, lot, bin: bin || "" },
    fetchedAt: new Date().toISOString(),
    mode: exact ? "exact" : "corridor",
    // Verbatim from the original, curly quotes included:
    //   Area “10118”. Exact parcel: PLUTO resolved 1008350041 to one live tax
    //   lot. All sources queried by BBL 1008350041, borough 1 / block 835 / lot 41.
    coverage: `${area ? `Area “${area}”. ` : ""}${exact
      ? `Exact parcel: PLUTO resolved ${bblRaw} to one live tax lot. All sources queried by ${identifiers}.`
      : `Automated corridor mode: PLUTO did not resolve this identifier to a single live lot, so sources were queried by ${identifiers}. Block-level evidence is returned where it exists.`}`,
    // Key order is the original's: it emits `sources` here, immediately after
    // `coverage`, and `summary` last. Measured on BBL 1008350041 the original
    // returns query,resolved,fetchedAt,mode,coverage,sources,debt,
    // permitContact,plutoOwner,summary while this handler returned
    // query,resolved,fetchedAt,mode,coverage,summary,debt,permitContact,
    // plutoOwner,sources.
    sources: src,
    // Key order, value types and date formats are the original's: `amount` is
    // the ACRIS string ("50000000"), the dates are the full recorded timestamps
    // rather than truncated to a day, and docTypeLabel is the plain-English
    // description ACRIS publishes for the code ("MTGE" → "Mortgage"), read from
    // the Document Control Codes dataset rather than echoing the code twice.
    debt: topDebt ? {
      found: true,
      documentId: topDebt.document_id,
      docType: topDebt.doc_type,
      docTypeLabel: acrisDocTypeLabel(topDebt.doc_type),
      recordedDate: topDebt.recorded_datetime ?? null,
      // `documentDate` is OMITTED, not emitted as null, when the recorded
      // document carries no document_date. Measured 2026-08-19 on BBL
      // 4089630036 (80-15 91 Avenue, a Queens vacant lot) whose headline
      // mortgage is FT_4370008960337: the original's debt block goes
      // recordedDate -> amount with no `documentDate` key between them, while
      // the rebuild published `documentDate: null` there. document_amt and
      // recorded_datetime get no such treatment because ACRIS never leaves them
      // null — measured the same day, `doc_type='MTGE' and document_amt IS NULL`
      // and `doc_type='MTGE' and recorded_datetime IS NULL` both return zero
      // rows on bnx9-e6tj — so there is no observation to base one on.
      ...(topDebt.document_date ? { documentDate: topDebt.document_date } : {}),
      amount: topDebt.document_amt ?? null,
      lender: partyOf("2")?.name ?? null, borrower: partyOf("1")?.name ?? null,
      borrowerAddress: partyAddr(partyOf("1")), lenderAddress: partyAddr(partyOf("2")),
      debtDocCount: debtRows.length,
      rows: debtRows
    } : { found: false, debtDocCount: 0, rows: [] },
    // The original's shape is {found, ownerBusiness, source, filingDate, jobType}
    // — it omits the permittee keys rather than emitting nulls when the filing
    // carries no permittee, which most plumbing/sprinkler permits do not. The
    // permittee is genuinely useful when it IS on the record, so it is added
    // only when present rather than always or never.
    permitContact: latestPermit ? {
      found: true,
      // The permittee is STILL READ off the newest filing — it is the most
      // useful thing on the record — but it is NOT PUBLISHED, because the
      // original does not publish it. Measured 2026-08-19 across nine BBLs
      // spanning all five boroughs (1008350041, 1009200012, 1001741307,
      // 3004030019, 3018420015, 4089630036, 2024340070, 5035640042,
      // 3007380006): every permitContact the original serves carries exactly
      // {found, ownerBusiness, source, filingDate, jobType} — and it withholds
      // the permittee even where its OWN shipped permit row names one. On BBL
      // 1009200012 the original's dob_permits rows[0] carries
      // permittee_s_first_name "ROBERT", permittee_s_last_name "FRANKENBERRY",
      // permittee_s_business_name "ICON INTERIORS INC" and
      // permittee_s_license__ "0007715", and its permitContact is
      // {"found":true,"ownerBusiness":"605 THIRD AVENUE FEE, LLC","source":
      // "DOB BIS","filingDate":"12/31/2015","jobType":"A2"} — no applicant,
      // no applicantBusiness, no license. The rebuild published all three.
      ownerBusiness: latestPermit.owner_s_business_name ?? null,
      source: "DOB BIS",
      filingDate: latestPermit.issuance_date ?? latestPermit.filing_date ?? null,
      jobType: latestPermit.job_type ?? null
    } : { found: false },
    // `plutoOwner` is OMITTED, not emitted as null, when the PLUTO row carries
    // no ownername or when PLUTO resolved nothing at all. Measured 2026-08-19:
    // on BBL 1001741307 (87 Leonard Street, a condo UNIT lot — PLUTO returns
    // the row but with no ownername column) and on BBL 1008359999 (no PLUTO row
    // at all) the original's envelope goes permitContact -> summary with no
    // `plutoOwner` key, while the rebuild published `plutoOwner: null`.
    ...(plutoRows[0]?.ownername ? { plutoOwner: plutoRows[0].ownername } : {}),
    summary: {
      // `salePrice` is the DOF column VERBATIM — a string — not a parsed
      // number. Measured 2026-08-19: BBL 3004030019 -> original "0", rebuild 0;
      // BBL 4089630036 -> original "226561", rebuild 226561. In both cases the
      // original's own shipped rolling_sales rows[0].sale_price is that exact
      // string, so it passes the column through untouched. `sale_price` is
      // never absent on usep-8jbt (`sale_price IS NULL` returns zero rows,
      // measured the same day), so the ?? null arm is a guard, not a shape.
      lastSale: latestSale ? { saleDate: latestSale.sale_date, salePrice: latestSale.sale_price ?? null, address: latestSale.address ?? null, buildingClass: latestSale.building_class_category ?? latestSale.building_class_at_present ?? null } : null,
      rollingSalesCount: salesRows.length,
      // "not-found" when PLUTO resolved NO row. Measured 2026-08-19 on BBL
      // 1008359999 (a well-formed Manhattan BBL with no PLUTO row): the
      // original serves summary.parcelMatch "not-found" where the rebuild
      // served "unavailable". The "unavailable" arm is kept for the >1-row
      // case, which this query cannot reach — measured the same day, no bbl
      // occurs twice on 64uk-42ks ($group=bbl $having=count(*)>1 is empty) —
      // so there is no observation of what the original would say there.
      // "matched" on an exact hit; "unavailable" when PLUTO was never asked
      // (no BBL to ask it by); "not-found" when it WAS asked and answered
      // nothing. Measured 2026-08-19: ?bbl=1008359999 and ?bbl=100835004 ->
      // "not-found"; ?borough=3&block=1842&lot=15, ?bin=1015862 and ?bbl=abc ->
      // "unavailable". The rebuild served "unavailable" for all of them. A
      // PLUTO source that ERRORS lands on "not-found" here; there is no
      // observation of what the original says in that case.
      parcelMatch: exact ? "matched" : plutoR === null ? "unavailable" : "not-found",
      dobPermitCount: permitRows.length,
      dobNowCount: nowRows.length,
      zoningApplicationCount: zapRows.length,
      debtDocCount: debtRows.length,
      okSources: src.filter((s) => s.status === "ok").length,
      errorSources: src.filter((s) => s.status === "error").length
    }
  };
}));

// ------------------------------------------------------------- client diag
// The owner's phone reports what it actually renders — layout width, build,
// nav visibility — so device problems are measured instead of argued about.
const diagLog = [];
// A beacon may arrive already parsed by express.json() (an explicit
// application/json POST) or as an unread stream (navigator.sendBeacon sends
// text/plain, which the JSON parser skips). Reading the stream unconditionally
// hung every application/json beacon forever: the body parser had already
// consumed it, so "end" never fired and the response was never sent.
function readBeacon(req) {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    const finish = () => { if (done) return; done = true; try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } };
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", finish);
    req.on("error", finish);
    req.on("aborted", finish);
    if (req.readableEnded) finish();
  });
}

router.post("/api/client-diag", (req, res) => {
  readBeacon(req).then((j) => {
    try {
      diagLog.push({
        at: new Date().toISOString(),
        ua: String(req.headers["user-agent"] ?? "").slice(0, 160),
        url: String(j.url ?? "").slice(0, 200),
        innerWidth: j.innerWidth, innerHeight: j.innerHeight, dpr: j.dpr,
        visualW: j.visualW, docW: j.docW, bodyScrollW: j.bodyScrollW,
        navVisible: j.navVisible, navRect: j.navRect, standalone: j.standalone,
        build: j.build
      });
      if (diagLog.length > 50) diagLog.shift();
    } catch { /* ignore malformed beacons */ }
    res.status(204).end();
  });
});
router.get("/api/client-diag", (_req, res) => res.json({ reports: diagLog.slice(-20) }));

export default router;
