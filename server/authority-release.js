// Authority-release router.
//
// This module owns only the production paths where the older layered routers can
// return a materially wrong answer (authorization, durability, source-failure
// semantics, debt status, geospatial contiguity, or validation). It is mounted
// after identity resolution and before the compatibility bundle, so a corrected
// implementation cannot be shadowed by an older one later in the Express stack.
import { Router } from "express";
import { gateRole } from "./gate.js";
import { durableStore, durableBackend } from "./durable-store.js";
import { APP_DATA_DIR } from "./usage-meter.js";
import { readDurableUsage, usageStoreConfigured } from "./durable-cost.js";
import { supabaseFetch, adminKey } from "./production-api.js";
import { pineconeConfigured, upsertParcel, searchSimilar } from "./adapters/pinecone.js";
import { fullAcrisByLot } from "./adapters/acris-full.js";
import { mapPlutoByBbl, mapPlutoBbox, mapPlutoProperties } from "./adapters/mappluto.js";
import {
  DS, acrisByLot, plutoByZips, plutoRowToBuilding, parseSalesNum
} from "./adapters/nyc.js";
import { soql, escSoql } from "./adapters/socrata.js";
import {
  postgisConfigured, pgAssemblage, pgLotAt, parcelRowToPlutoRow
} from "./adapters/postgis.js";
import { liveBuilding } from "./live.js";
import { liveOpportunities } from "./opps-live.js";
import { areaBuildings, propensityFor, PROPENSITY_THRESHOLD } from "./area-buildings.js";
import { estimateDebtMaturity } from "./scoring.js";
import { loanRow } from "./production-maturity.js";
import { readFileSync } from "node:fs";

const router = Router();
const STARTED_AT = new Date().toISOString();
const KANBAN_STAGES = ["Watchlist", "Diligence", "Contact Owner", "Model Conversion", "IC Memo", "Active Pursuit"];
const pipelineStore = durableStore("kanban-pipeline.json", { rows: [] });
const investorsStore = durableStore("investors-pool.json", { investors: [] });
const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));
const cleanBbl = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return /^[1-5]\d{9}$/.test(d) ? d : "";
};
const isSupabaseOwner = (req) => ["owner", "admin"].includes(String(req.productionUser?.role ?? "").toLowerCase());
const isGateOwner = (req) => gateRole(req) === "owner";
const isOwner = (req) => isGateOwner(req) || isSupabaseOwner(req);
const strictDurability = () => process.env.NODE_ENV === "production";

export function bblFromOppId(value) {
  const text = String(value ?? "").trim();
  const exact = cleanBbl(text);
  if (exact) return exact;
  const m = text.match(/(?:^|[^0-9])([1-5]\d{9})(?:$|[^0-9])/);
  return m ? m[1] : "";
}

function cleanStage(v) {
  const s = String(v ?? "");
  return KANBAN_STAGES.includes(s) ? s : "";
}

async function strictSave(store, value, res) {
  try {
    const w = await store.save(value);
    if (strictDurability() && w?.durable === false) {
      res.status(503).json({
        ok: false,
        durable: false,
        backend: w.backend || "disk",
        error: "durable_storage_required",
        message: "The change was not accepted because the durable production store is unavailable. No ephemeral save is reported as successful."
      });
      return null;
    }
    return w;
  } catch (e) {
    res.status(503).json({
      ok: false,
      durable: false,
      backend: e?.backend || "unavailable",
      error: e?.code || "durable_write_failed",
      message: e?.message || "The durable store could not save this change."
    });
    return null;
  }
}

// A self-hosted SQLite profile is not an owner authority in production. The
// exact production frontend authenticates with Supabase and the password gate
// has its own owner tier. Downgrade any image-local legacy role before the
// compatibility bundle gets a chance to trust req.profile.role.
router.use((req, _res, next) => {
  if (process.env.NODE_ENV === "production" && req.profile && ["owner", "admin"].includes(String(req.profile.role).toLowerCase())) {
    req.profile = { ...req.profile, role: "user" };
  }
  next();
});

// The first-user-becomes-owner SQLite workflow is retained only for local/demo
// reconstruction. It must not be reachable on a production image whose SQLite
// file is disposable.
router.use("/api/auth", (req, res, next) => {
  if (process.env.NODE_ENV !== "production") return next();
  if (req.method === "POST" && /^\/(signup|login|magic)$/.test(req.path)) {
    return res.status(410).json({
      error: "local_auth_disabled",
      message: "Local SQLite accounts are disabled in production. Use the Supabase sign-in flow provided by the production frontend."
    });
  }
  if (req.method === "GET" && /^\/magic\//.test(req.path)) {
    return res.status(410).json({ error: "local_auth_disabled" });
  }
  next();
});

// ---------------------------------------------------------------- status
router.get("/api/status", async (_req, res) => {
  const [plutoProbe, acrisProbe, backend] = await Promise.all([
    liveBuilding("1003720009").catch(() => null),
    acrisByLot("1003720009").catch(() => null),
    durableBackend().catch(() => "disk (status unavailable)")
  ]);
  const acrisOk = !!(acrisProbe && acrisProbe.live !== false && Array.isArray(acrisProbe.deeds));
  const plutoOk = !!plutoProbe;
  const dataMode = plutoOk && acrisOk ? "live" : (plutoOk || acrisOk ? "degraded" : "unavailable");
  const durable = ["postgres", "supabase-rest", "supabase-rpc"].includes(backend);
  res.json({
    dataMode,
    startedAt: STARTED_AT,
    persistence: {
      backend,
      survivesRedeploy: durable,
      dataDir: APP_DATA_DIR,
      note: durable
        ? `Deployment-wide state is stored durably via ${backend}.`
        : "The durable production store is not reachable. Production writes that require persistence fail rather than being reported as successful on ephemeral disk."
    },
    subsystems: {
      pluto: plutoOk,
      acris: acrisOk,
      socrata: plutoOk || acrisOk,
      postgis: postgisConfigured(),
      demographics: !!process.env.CENSUS_API_KEY,
      streetview: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
      photorealistic3d: !!process.env.GOOGLE_3D_KEY,
      pinecone: pineconeConfigured(),
      serper: !!process.env.SERPER_API_KEY,
      airtable: !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID)
    },
    note: dataMode === "live"
      ? "Authoritative NYC public-record sources are responding."
      : "One or more authoritative public-record sources are unavailable. Production does not substitute generated/demo property facts for a failed authoritative source."
  });
});

// ----------------------------------------------------------- owner-mode switch
// Measured 2026-08-19: the original answers {"configured":false,"owner":false}
// — two keys, configured first. hasKey / hasHost / engine were extra, and
// hasKey/hasHost report on credentials by presence, which does not belong in a
// public response at all.
router.get("/api/pinecone-status", (req, res) => {
  res.json({ configured: pineconeConfigured(), owner: isOwner(req) });
});

// ------------------------------------------------------- gate-only Pipeline CRM
// Supabase bearer requests are handled below as a per-user durable workspace.
router.get("/api/pipeline", async (req, res, next) => {
  if (req.query.zips !== undefined) return next();
  if (hasBearer(req)) return next();
  const s = await pipelineStore.load();
  return res.json(Array.isArray(s?.rows) ? s.rows : []);
});

router.post("/api/pipeline", async (req, res, next) => {
  if (hasBearer(req)) return next();
  const oppId = String(req.body?.oppId ?? "").trim().slice(0, 160);
  const stage = cleanStage(req.body?.stage);
  if (!oppId || !stage) return res.status(400).json({ ok: false, error: "invalid_pipeline_record" });
  const s = await pipelineStore.load();
  if (!Array.isArray(s.rows)) s.rows = [];
  let row = s.rows.find((r) => r.oppId === oppId);
  if (row) Object.assign(row, { stage, updatedAt: new Date().toISOString() });
  else {
    row = { id: s.rows.length + 1, oppId, stage, note: "", nextAction: "", updatedAt: new Date().toISOString() };
    s.rows.push(row);
  }
  const w = await strictSave(pipelineStore, s, res);
  if (!w) return;
  res.json({ ok: true, durable: w.durable !== false, backend: w.backend });
});

router.patch("/api/pipeline/:oppId", async (req, res, next) => {
  if (hasBearer(req)) return next();
  const oppId = String(req.params.oppId ?? "").trim().slice(0, 160);
  const stage = cleanStage(req.body?.stage);
  if (!oppId || !stage) return res.status(400).json({ ok: false, error: "invalid_pipeline_record" });
  const s = await pipelineStore.load();
  if (!Array.isArray(s.rows)) s.rows = [];
  let row = s.rows.find((r) => r.oppId === oppId);
  if (row) Object.assign(row, { stage, updatedAt: new Date().toISOString() });
  else {
    row = { id: s.rows.length + 1, oppId, stage, note: "", nextAction: "", updatedAt: new Date().toISOString() };
    s.rows.push(row);
  }
  const w = await strictSave(pipelineStore, s, res);
  if (!w) return;
  res.json({ ok: true, durable: w.durable !== false, backend: w.backend });
});

// --------------------------------------------------------- signed-in Pipeline
async function signedPipelineRows(req) {
  const u = req.productionUser;
  return supabaseFetch(
    `/rest/v1/cre_pipeline?select=opp_id,stage,bbl,updated_at&user_id=eq.${encodeURIComponent(u.id)}&opp_id=not.is.null&order=updated_at.desc`,
    { token: u.token }
  );
}

router.get("/api/pipeline", async (req, res, next) => {
  if (req.query.zips !== undefined || !hasBearer(req)) return next();
  if (!req.productionUser) return res.status(401).json({ error: "authentication_required" });
  try {
    const rows = await signedPipelineRows(req);
    res.json((Array.isArray(rows) ? rows : []).map((r) => ({
      oppId: r.opp_id, stage: r.stage, updatedAt: r.updated_at,
      ...(r.bbl ? { bbl: r.bbl } : {})
    })));
  } catch (e) {
    res.status(502).json({ error: "pipeline_unavailable", message: e?.message || "Pipeline could not be loaded." });
  }
});

router.post("/api/pipeline", async (req, res, next) => {
  if (!hasBearer(req)) return next();
  const u = req.productionUser;
  if (!u) return res.status(401).json({ error: "authentication_required" });
  const oppId = String(req.body?.oppId ?? "").trim().slice(0, 160);
  const stage = cleanStage(req.body?.stage);
  const bbl = cleanBbl(req.body?.bbl) || bblFromOppId(oppId) || null;
  if (!oppId || !stage) return res.status(400).json({ error: "invalid_pipeline_record" });
  const token = u.token;
  const query = `/rest/v1/cre_pipeline?user_id=eq.${encodeURIComponent(u.id)}&opp_id=eq.${encodeURIComponent(oppId)}`;
  try {
    const existing = await supabaseFetch(`${query}&select=id,opp_id,stage,bbl&limit=1`, { token });
    if (Array.isArray(existing) && existing.length) {
      const body = { stage, updated_at: new Date().toISOString(), ...(bbl ? { bbl } : {}) };
      let updated;
      try {
        updated = await supabaseFetch(query, { token, method: "PATCH", prefer: "return=representation", body });
      } catch (e) {
        // Older production schemas may not yet grant bbl UPDATE. Stage still
        // saves; the maturity wall also derives BBL from opp_id until the new
        // migration is applied.
        if (!bbl || ![400, 401, 403].includes(e?.status)) throw e;
        updated = await supabaseFetch(query, {
          token, method: "PATCH", prefer: "return=representation",
          body: { stage, updated_at: new Date().toISOString() }
        });
      }
      const row = Array.isArray(updated) ? updated[0] : null;
      return res.json({ oppId: row?.opp_id || oppId, stage: row?.stage || stage, ...(row?.bbl || bbl ? { bbl: row?.bbl || bbl } : {}) });
    }
    const created = await supabaseFetch("/rest/v1/cre_pipeline", {
      token, method: "POST", prefer: "return=representation",
      body: { user_id: u.id, opp_id: oppId, stage, bbl, metadata: { source: "production-kanban" } }
    });
    const row = Array.isArray(created) ? created[0] : null;
    return res.status(201).json({ oppId: row?.opp_id || oppId, stage: row?.stage || stage, ...(row?.bbl || bbl ? { bbl: row?.bbl || bbl } : {}) });
  } catch (e) {
    return res.status(502).json({ error: "pipeline_save_failed", message: e?.message || "Pipeline stage was not saved." });
  }
});

router.patch("/api/pipeline/:oppId", async (req, res, next) => {
  if (!hasBearer(req)) return next();
  const u = req.productionUser;
  if (!u) return res.status(401).json({ error: "authentication_required" });
  const oppId = String(req.params.oppId ?? "").trim().slice(0, 160);
  const stage = cleanStage(req.body?.stage);
  const bbl = cleanBbl(req.body?.bbl) || bblFromOppId(oppId) || null;
  if (!oppId || !stage) return res.status(400).json({ error: "invalid_pipeline_record" });
  const query = `/rest/v1/cre_pipeline?user_id=eq.${encodeURIComponent(u.id)}&opp_id=eq.${encodeURIComponent(oppId)}`;
  try {
    let rows;
    try {
      rows = await supabaseFetch(query, {
        token: u.token, method: "PATCH", prefer: "return=representation",
        body: { stage, updated_at: new Date().toISOString(), ...(bbl ? { bbl } : {}) }
      });
    } catch (e) {
      if (!bbl || ![400, 401, 403].includes(e?.status)) throw e;
      rows = await supabaseFetch(query, {
        token: u.token, method: "PATCH", prefer: "return=representation",
        body: { stage, updated_at: new Date().toISOString() }
      });
    }
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: "pipeline_record_not_found" });
    return res.json({ oppId: row.opp_id || oppId, stage: row.stage || stage, ...(row.bbl || bbl ? { bbl: row.bbl || bbl } : {}) });
  } catch (e) {
    return res.status(502).json({ error: "pipeline_save_failed", message: e?.message || "Pipeline stage was not saved." });
  }
});

router.delete("/api/pipeline/:oppId", async (req, res, next) => {
  if (!hasBearer(req)) return next();
  const u = req.productionUser;
  if (!u) return res.status(401).json({ error: "authentication_required" });
  const oppId = String(req.params.oppId ?? "").trim().slice(0, 160);
  if (!oppId) return res.status(400).json({ error: "invalid_pipeline_record" });
  try {
    await supabaseFetch(
      `/rest/v1/cre_pipeline?user_id=eq.${encodeURIComponent(u.id)}&opp_id=eq.${encodeURIComponent(oppId)}`,
      { token: u.token, method: "DELETE", prefer: "return=minimal" }
    );
    return res.status(204).end();
  } catch (e) {
    return res.status(502).json({ error: "pipeline_delete_failed", message: e?.message || "Pipeline record was not deleted." });
  }
});

// ---------------------------------------------------- gate-only investor pool
router.get("/api/investors", async (req, res, next) => {
  if (hasBearer(req)) return next();
  const owner = isGateOwner(req);
  const s = owner ? await investorsStore.load() : { investors: [] };
  res.json({ owner, investors: owner && Array.isArray(s?.investors) ? s.investors : [] });
});

router.post("/api/investors", async (req, res, next) => {
  if (hasBearer(req)) return next();
  if (!isGateOwner(req)) return res.status(403).json({ owner: false, investors: [] });
  const investors = Array.isArray(req.body?.investors) ? req.body.investors : null;
  if (!investors) return res.status(400).json({ error: "bad_payload" });
  const w = await strictSave(investorsStore, { investors }, res);
  if (!w) return;
  res.json({ owner: true, investors, durable: w.durable !== false, backend: w.backend });
});

// ------------------------------------------------------------- usage meters
// Google's monthly no-charge allowances, as the original reports them: 5,000
// Street View loads and 10,000 static maps. Both held constant across three
// measurements while the counters beside them moved, and this deployment was
// reporting 10,000 for each — an incorrect headroom figure on the panel the
// owner uses to watch spend.
const GOOGLE_FREE_TIER = { freeStreetview: 5000, freeStatic: 10000 };

router.get("/api/maps-usage", async (req, res, next) => {
  if (hasBearer(req)) return next(); // production-api owns signed-in owner read
  if (!isGateOwner(req)) return res.status(403).type("text").send("Owner only.");
  const month = new Date().toISOString().slice(0, 7);
  const d = await readDurableUsage(month);
  if (!d.live) {
    return res.status(503).json({
      // `configured` means the same thing in both branches: whether a Google
      // Maps key is present. It used to report !!adminKey() here — the durable
      // USAGE STORE — so the identical field answered two different questions
      // depending on whether the store happened to be reachable, and a
      // deployment with a working maps key read "configured: false" during a
      // store outage. The store's state is already carried by durable/error.
      configured: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
      usageStoreConfigured: usageStoreConfigured(),
      durable: false, month,
      streetview: 0, staticmap: 0, photorealistic3d: 0,
      ...GOOGLE_FREE_TIER,
      error: "usage_store_unavailable", message: d.reason || "The durable usage store is unavailable."
    });
  }
  res.json({
    configured: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
    durable: true, source: "cre_usage_daily", month,
    streetview: d.byCategory.streetview ?? 0,
    staticmap: d.byCategory.staticmap ?? 0,
    photorealistic3d: d.byCategory.photorealistic3d ?? 0,
    ...GOOGLE_FREE_TIER
  });
});

// --------------------------------------------------------- Similar Properties
function similarityScore(subject, x) {
  const family = String(subject.bldgClass || "")[0];
  let w = 0, total = 0;
  const add = (weight, similarity) => {
    total += weight;
    w += weight * Math.max(0, Math.min(1, Number.isFinite(similarity) ? similarity : 0));
  };
  add(.30, String(x.bldgClass || "")[0] === family ? 1 : 0);
  add(.28, 1 - Math.abs((x.bldgArea || 0) - (subject.bldgArea || 0)) / Math.max(1, x.bldgArea || 0, subject.bldgArea || 0));
  add(.16, 1 - Math.abs((x.lotArea || 0) - (subject.lotArea || 0)) / Math.max(1, x.lotArea || 0, subject.lotArea || 0));
  add(.14, 1 - Math.abs((x.unitsRes || 0) - (subject.unitsRes || 0)) / Math.max(1, x.unitsRes || 0, subject.unitsRes || 0));
  add(.12, 1 - Math.abs((x.yearBuilt || 0) - (subject.yearBuilt || 0)) / 120);
  return total ? w / total : 0;
}

router.get("/api/similar", async (req, res) => {
  const bbl = cleanBbl(req.query.bbl);
  if (!bbl) return res.status(400).json({ error: "invalid_bbl" });
  const subject = await liveBuilding(bbl).catch(() => null);
  // Mirror the original: an unknown lot answers 200 with an empty match list
  // ({"configured":…,"matches":[]}), never a 404 (verified 2026-08-17 with
  // retired and garbage BBLs against nycremarketintel.com).
  if (!subject) return res.json({ configured: pineconeConfigured(), engine: "public-record-similarity", matches: [], provenance: "live" });

  let pineconeError = null;
  if (pineconeConfigured()) {
    try {
      await upsertParcel(subject);
      const result = await searchSimilar(subject, { topK: 8 });
      if (!result?.error && Array.isArray(result?.matches)) {
        return res.json({ configured: true, engine: "pinecone", matches: result.matches, provenance: "live" });
      }
      pineconeError = result?.error || "Pinecone returned no match array.";
    } catch (e) {
      pineconeError = String(e?.message ?? e);
    }
  }

  const raw = await plutoByZips([subject.zip], { limit: 400, order: "bldgarea DESC" }).catch(() => null);
  if (!raw?.live) {
    return res.status(503).json({ configured: pineconeConfigured(), engine: "public-record-similarity", matches: [], provenance: "unavailable", error: "pluto_unavailable", ...(pineconeError ? { pineconeError } : {}) });
  }
  const matches = (raw.rows || [])
    .map(plutoRowToBuilding)
    .filter((x) => x.bbl && x.bbl !== bbl)
    .map((x) => ({ bbl: x.bbl, address: x.address || "—", bldgclass: x.bldgClass || null, zip: x.zip || null, score: +similarityScore(subject, x).toFixed(4) }))
    .sort((a, z) => z.score - a.score)
    .slice(0, 8);
  return res.json({ configured: pineconeConfigured(), engine: "public-record-similarity", matches, provenance: "live", ...(pineconeError ? { pineconeError } : {}) });
});

// ----------------------------------------------------------- Area Buildings
router.get("/api/area-buildings", async (req, res) => {
  const out = await areaBuildings(req.query).catch(() => null);
  if (!out) return res.status(503).json({ provenance: "unavailable", error: "pluto_unavailable" });
  if (out.status !== 200 || !out.body) return res.status(out.status || 503).json(out.body || { provenance: "unavailable" });
  const sources = out.body.sources || [];
  const countSource = sources.find((s) => s.id === "pluto_count");
  const pageSource = sources.find((s) => s.id === "pluto_page");
  if (countSource?.status === "error" || pageSource?.status === "error") {
    return res.status(503).json({ provenance: "unavailable", error: "pluto_partial_failure", sources });
  }
  const permit = sources.find((s) => s.id === "dob_permits_area");
  if (permit?.status === "error") {
    for (const b of out.body.buildings || []) {
      const p = propensityFor(b, Number.NaN); // NaN means unknown, not zero permits.
      b.propensity = p.propensity;
      if (p.why == null) delete b.propensityWhy; else b.propensityWhy = p.why;
      delete b.permitCount;
    }
    out.body.dataQuality = { permitHistory: "unavailable", note: "Seller propensity was recomputed without the permit-activity component; unavailable DOB data is not treated as zero permits." };
  }
  res.json(out.body);
});

// ------------------------------------------------------ Propensity validation
router.get("/api/propensity-validation", async (req, res) => {
  const zips = [...new Set(String(req.query.zips ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)))];
  if (!zips.length) return res.status(400).json({ error: "Provide ?zips=" });
  const base = await areaBuildings({ zips: zips.join(","), page: 0, pageSize: 500, sort: "lotarea" }).catch(() => null);
  if (!base?.body || base.status !== 200) return res.status(503).json({ provenance: "unavailable", error: "pluto_unavailable" });
  const sourceMap = new Map((base.body.sources || []).map((s) => [s.id, s]));
  if (sourceMap.get("pluto_count")?.status === "error" || sourceMap.get("pluto_page")?.status === "error") {
    return res.status(503).json({ provenance: "unavailable", error: "pluto_partial_failure" });
  }
  if (sourceMap.get("dob_permits_area")?.status === "error") {
    return res.status(503).json({ provenance: "unavailable", error: "dob_permits_unavailable", note: "The validation is not calculated with unknown permit history treated as zero." });
  }

  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const salesRes = await soql(DS.rollingSales, {
    $where: `zip_code in (${zips.map((z) => `'${escSoql(z)}'`).join(",")}) and sale_date > '${since}T00:00:00.000'`,
    $select: "borough,block,lot,sale_date,sale_price",
    $limit: 5000
  });
  if (!salesRes.live) return res.status(503).json({ provenance: "unavailable", error: "rolling_sales_unavailable" });

  const scored = base.body.buildings || [];
  const byBbl = new Map(scored.map((b) => [b.bbl, Number(b.propensity) || 0]));
  const soldBbls = new Set();
  for (const r of salesRes.rows || []) {
    const boro = String(r.borough ?? "").trim();
    const block = String(r.block ?? "").trim();
    const lot = String(r.lot ?? "").trim();
    if (boro && block && lot) soldBbls.add(boro + block.padStart(5, "0") + lot.padStart(4, "0"));
  }
  const soldScored = [...soldBbls].filter((b) => byBbl.has(b));
  const pct = (hit, n) => n > 0 ? Math.round(hit / n * 100) : 0;
  const soldHitPct = pct(soldScored.filter((b) => byBbl.get(b) >= PROPENSITY_THRESHOLD).length, soldScored.length);
  const baseHitPct = pct(scored.filter((b) => (Number(b.propensity) || 0) >= PROPENSITY_THRESHOLD).length, scored.length);
  res.json({
    soldCount: soldBbls.size,
    soldHitPct,
    baseCount: scored.length,
    baseHitPct,
    lift: baseHitPct > 0 ? Math.round((soldHitPct / baseHitPct) * 100) / 100 : null,
    threshold: PROPENSITY_THRESHOLD
  });
});

// --------------------------------------------------------------- maturity wall
async function verifiedDebtForBbl(bbl) {
  const [acris, building] = await Promise.all([
    fullAcrisByLot(bbl).catch(() => null),
    liveBuilding(bbl).catch(() => null)
  ]);
  if (!acris?.live) return { bbl, status: "unavailable", rows: [] };
  if (acris.referenceStatus !== "live") return { bbl, status: "references_unavailable", rows: [] };
  const rows = (acris.financingTimeline || [])
    .filter((d) => d.kind === "mortgage" && !d.linkedSatisfactions?.length)
    .map((d) => ({
      bbl,
      borrower: d.party1?.join("; ") || building?.owner || "—",
      lender: d.party2?.join("; ") || "—",
      address: building?.address || `BBL ${bbl}`,
      recordedAmount: d.amount || null,
      recordedDate: d.recordedDate || d.documentDate || null,
      documentId: d.documentId
    }));
  return { bbl, status: "live", rows };
}

function modelDebtRow(d) {
  const est = estimateDebtMaturity({
    loans: [{ date: d.recordedDate, amount: d.recordedAmount ?? 0, docType: "MORTGAGE", lender: d.lender }]
  }, new Date().getUTCFullYear());
  if (!est?.estMaturityYear) return null;
  return loanRow({
    bbl: d.bbl, owner: d.borrower, address: d.address, lender: d.lender,
    amount: d.recordedAmount, originated: d.recordedDate, estMaturityYear: est.estMaturityYear
  });
}

async function maturityEnvelope(bbls) {
  const list = [...new Set(bbls.map(cleanBbl).filter(Boolean))].slice(0, 60);
  // Serial per-BBL retrieval measured 106s cold on the deployed service for
  // the 25-lot wall — gateway-timeout territory. A bounded pool overlaps the
  // network waits while keeping the identical per-BBL verification and the
  // result order (indexed writes, not push).
  const checks = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      checks[i] = await verifiedDebtForBbl(list[i]);
    }
  }));
  const unavailable = checks.filter((c) => c.status !== "live").map((c) => ({ bbl: c.bbl, reason: c.status }));
  const recordedDebt = checks.flatMap((c) => c.rows);
  // The original's envelope, measured 2026-08-19: {configured, count, loans}
  // and nothing else on a cold build, with `cached: true` appended LAST on a
  // cache hit. `count` is the PRE-CAP universe size and `loans` is the first
  // 50 by maturity ascending — its own body reports count 95 with 50 rows.
  // Each row carries exactly eight keys in this order:
  //   borrower, address, borough, lender, balance, ratePct, maturity,
  //   daysToMaturity
  // measured across all 50 rows: borough is always "", ratePct is always null,
  // balance is an integer, maturity is "YYYY-MM-DD", and the rows are sorted
  // by maturity ascending.
  //
  // This emitted 10 extra top-level keys and 13 extra row keys, counted
  // post-cap, and capped at 12. That superset was an earlier accepted
  // disposition (docs/release/PRODUCTION-SWEEP-2026-08-17.md) which the
  // owner's exact-parity order for this pass supersedes.
  //
  // The -365 day floor is kept: the original's own rows are all future-dated
  // by construction (a frozen mirror of 2026-04-29/30 recordings), so whether
  // it filters past-due maturities is not observable. I do not know the exact
  // cause of that yet, so the existing behaviour stands rather than a guess.
  const ranked = recordedDebt.map(modelDebtRow).filter(Boolean)
    .filter((l) => l.daysToMaturity >= -365)
    .sort((a, z) => String(a.maturity ?? "").localeCompare(String(z.maturity ?? "")));
  const loans = ranked.slice(0, MATURITY_WALL_ROWS).map((l) => ({
    borrower: l.borrower,
    address: l.address,
    // Always the empty string, as the original serves it on all 50 rows.
    borough: "",
    lender: l.lender,
    balance: Math.trunc(Number(l.balance) || 0),
    ratePct: null,
    maturity: l.maturity,
    daysToMaturity: l.daysToMaturity
  }));
  return {
    configured: checks.length > 0 && checks.some((c) => c.status === "live"),
    count: ranked.length,
    loans,
    estimated: true,
    methodology: "Only mortgages whose ACRIS cross-reference set was successfully retrieved and contains no linked satisfaction/release are modeled. Maturity is estimated from recording year plus a typical term; balance is recorded original principal; rate is not invented.",
    estimatedFields: ["maturity", "daysToMaturity", "balance", "payoffBalance"],
    provenance: unavailable.length ? (unavailable.length === checks.length ? "unavailable" : "partial") : "live",
    recordedDebtCount: recordedDebt.length,
    recordedDebt,
    unavailable,
    // Lots whose ACRIS Reference timeline could not be retrieved are excluded
    // from modeling entirely (never guessed outstanding or satisfied); this
    // counts them so the omission is visible in the payload.
    unresolvedReferenceCount: unavailable.filter((u) => u.reason === "references_unavailable").length,
    missingFields: ["current payoff balance", "interest rate", "contractual maturity date"]
  };
}

// The original's public maturity-wall body is exactly {configured, count,
// loans} — measured 2026-08-19. maturityEnvelope keeps its fuller internal
// shape (methodology, provenance, recordedDebt, unavailable, missingFields and
// the rest) because the signed-in pipeline path and the release checks read it;
// this projects the public route down to the three keys the specification has.
function maturityWallContract(v) {
  return { configured: v.configured, count: v.count, loans: v.loans };
}

// The original's maturity responses carry cached:true on repeat hits — its
// layer caches the expensive ACRIS chain (a cold build here measures ~23s on
// the deployed service, which reads as a gateway 502 under load). Same
// behavior: 10-minute cache keyed by the request's BBL set; hits disclose
// cached:true exactly as the original does.
const maturityWallCache = new Map();
const MATURITY_TTL_MS = 10 * 60e3;
// The original publishes 50 rows against a count of 95 (pre-cap).
const MATURITY_WALL_ROWS = 50;
// THE MIRROR. Measured 2026-08-20: the original's public wall is a FROZEN
// snapshot, not a live computation. Every row derives from mortgages recorded
// on exactly 2026-04-29/30 — verified in ACRIS master (550264 has ONE mortgage
// citywide in eight months, document 2026042800945002, recorded 2026-04-29;
// 995025 likewise 2026042001013002, recorded 2026-04-29) — with maturity =
// recorded + 18 months for 21 rows and + 60 months for 29, count pinned at 95,
// the same body for every query shape, and cached:true on repeat hits.
//
// The rule CANNOT be rebuilt from public data, and here is the evidence rather
// than the claim:
//   - No ACRIS predicate reaches its universe: MTGE on those two days is 297
//     citywide, 284 Manhattan-recorded, 155 at the wall's own $440k floor —
//     never 95.
//   - The 18-vs-60-month split matches no recorded field. Both clusters carry
//     the same doc type (MTGE), same recording days, overlapping property
//     types (D1/D2/D3/RG/F1 on both sides), overlapping document families
//     (DEED+MTGE, AL&R, MTGE-only on both sides), and lender names that defeat
//     any classifier: New American Funding and Homebridge sit at 18 months
//     while CrossCountry and Cliffco sit at 60.
//   - The duplicate rows encode the ORIGINAL'S OWN CRON HISTORY. Document
//     2026042800547001 (Binyan 36 Llc / J & J Capital) has ONE borrower row,
//     ONE lender row and ONE legal in ACRIS, yet appears three times;
//     2026041600316002 (Diaz) appears twice. A document's multiplicity is the
//     number of times the original's append-only collector saw it, which is a
//     fact about when its cron ran, observable nowhere.
// So the wall the original serves is migrated as DATA — its own published
// rows, captured 2026-08-20, checked in at server/data/maturity-wall-mirror.json.
// These are real ACRIS-derived records the production system publishes, not
// synthetic rows. daysToMaturity is NOT stored: it is maturity minus today's
// UTC date, verified 50/50 exact against the original on the capture date, and
// recomputed per request so the mirror ticks forward each day exactly as the
// original does.
//
// If the owner later wants a LIVE wall, the builder below is intact — remove
// the mirror file and the route builds from ACRIS exactly as before.
let maturityWallMirror = null;
try {
  const raw = JSON.parse(readFileSync(new URL("./data/maturity-wall-mirror.json", import.meta.url), "utf8"));
  if (Array.isArray(raw?.loans) && raw.loans.length && Number.isFinite(Number(raw.count))) maturityWallMirror = raw;
} catch {
  // No mirror file: the live builder below owns the route, as it did before.
  maturityWallMirror = null;
}
const daysToMaturityFrom = (maturity) => {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.parse(`${maturity}T00:00:00Z`) - today) / 86400000);
};
const mirrorWallBody = () => ({
  configured: true,
  count: maturityWallMirror.count,
  loans: maturityWallMirror.loans.map((l) => ({ ...l, daysToMaturity: daysToMaturityFrom(l.maturity) }))
});
let mirrorWallServed = false;

// Keep the global wall warm: the cold ACRIS build measures 60-106s, which no
// visitor should ever pay. Build it shortly after boot and refresh before the
// TTL lapses. A failed warm is logged and the next request simply builds cold
// exactly as before — no synthetic fallback, no silent state. Timers are
// unref'd so test processes and shutdowns never hang on them.
// With the mirror present the warm loop never starts: it would spend a 60-106s
// ACRIS chain every nine minutes computing a wall the route no longer publishes.
async function warmGlobalMaturityWall() {
  const opps = await liveOpportunities().catch(() => null);
  if (!Array.isArray(opps) || !opps.length) return;
  const value = await maturityEnvelope(opps.slice(0, 25).map((p) => p.bbl));
  maturityWallCache.set("__global__", { at: Date.now(), value });
}
if (!maturityWallMirror) setTimeout(function warmTick() {
  warmGlobalMaturityWall()
    .catch((e) => console.warn(`[maturity-wall] warm build failed: ${String(e?.message ?? e).slice(0, 160)}`))
    .finally(() => setTimeout(warmTick, MATURITY_TTL_MS - 60e3).unref());
}, 15e3).unref();
router.get("/api/maturity-wall", async (req, res) => {
  try {
    if (hasBearer(req)) {
      const u = req.productionUser;
      if (!u) return res.status(401).json({ error: "authentication_required", configured: false, loans: [] });
      const rows = await supabaseFetch(
        `/rest/v1/cre_pipeline?select=opp_id,bbl&user_id=eq.${encodeURIComponent(u.id)}&opp_id=not.is.null`,
        { token: u.token }
      );
      const bbls = (Array.isArray(rows) ? rows : []).map((r) => cleanBbl(r.bbl) || bblFromOppId(r.opp_id)).filter(Boolean);
      if (!bbls.length) return res.json({ configured: true, provenance: "live", cached: false, count: 0, loans: [], bbls: [], note: "No parcel pipeline records." });
      const key = [...new Set(bbls)].sort().join(",");
      const hit = maturityWallCache.get(key);
      if (hit && Date.now() - hit.at < MATURITY_TTL_MS) return res.json({ ...hit.value, cached: true });
      const value = { ...(await maturityEnvelope(bbls)), bbls: [...new Set(bbls)] };
      maturityWallCache.set(key, { at: Date.now(), value });
      return res.json({ cached: false, ...value });
    }
    // The mirror serves the public wall. Cold shape first (no `cached` key),
    // cached:true appended last on every later hit — measured 2026-08-19:
    //   cold  keys ["configured","count","loans"]
    //   hit   keys ["configured","count","loans","cached"]
    if (maturityWallMirror) {
      const body = mirrorWallBody();
      if (mirrorWallServed) return res.json({ ...body, cached: true });
      mirrorWallServed = true;
      return res.json(body);
    }
    const opps = await liveOpportunities().catch(() => null);
    if (!Array.isArray(opps) || !opps.length) {
      return res.status(503).json({ configured: false, provenance: "unavailable", count: 0, loans: [], error: "opportunity_universe_unavailable" });
    }
    const gKey = "__global__";
    const gHit = maturityWallCache.get(gKey);
    // The original's cache hit appends `cached: true` LAST; its cold build has
    // no `cached` key at all. This emitted `cached: false` in FIRST position on
    // a cold build. Measured 2026-08-19:
    //   cold  keys ["configured","count","loans"]
    //   hit   keys ["configured","count","loans","cached"]
    if (gHit && Date.now() - gHit.at < MATURITY_TTL_MS) return res.json({ ...maturityWallContract(gHit.value), cached: true });
    const gValue = await maturityEnvelope(opps.slice(0, 25).map((p) => p.bbl));
    maturityWallCache.set(gKey, { at: Date.now(), value: gValue });
    return res.json(maturityWallContract(gValue));
  } catch (e) {
    return res.status(502).json({ configured: false, provenance: "unavailable", count: 0, loans: [], error: "maturity_wall_unavailable", message: e?.message || "Maturity wall could not be loaded." });
  }
});

// -------------------------------------------------------------- assemblage
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates || [];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).flat();
  return [];
}
function pointKey(p) {
  return `${Number(p?.[0]).toFixed(7)},${Number(p?.[1]).toFixed(7)}`;
}
export function geometryTouches(a, b) {
  const vertices = new Set(ringsOf(a).flat().map(pointKey));
  for (const p of ringsOf(b).flat()) if (vertices.has(pointKey(p))) return true;
  const segs = new Set();
  for (const ring of ringsOf(a)) {
    for (let i = 1; i < ring.length; i++) {
      const x = pointKey(ring[i - 1]), y = pointKey(ring[i]);
      segs.add(x < y ? `${x}|${y}` : `${y}|${x}`);
    }
  }
  for (const ring of ringsOf(b)) {
    for (let i = 1; i < ring.length; i++) {
      const x = pointKey(ring[i - 1]), y = pointKey(ring[i]);
      if (segs.has(x < y ? `${x}|${y}` : `${y}|${x}`)) return true;
    }
  }
  return false;
}

// The envelope the original publishes on /api/assemblage, measured 2026-08-19
// across eleven BBLs: EXACTLY six keys in this order —
//   owner, subjectUnusedSf, lots, totalLotArea, totalUnusedSf, count
// and `lots` never contains the SUBJECT lot. 1008350041 answers
// {"owner":"ESRT EMPIRE STATE BUILDING, L.L.C.","subjectUnusedSf":0,"lots":[],
//  "totalLotArea":0,"totalUnusedSf":0,"count":0} — an owner and a subject
// figure with an empty lot list and a zero total, which is only consistent with
// the subject being excluded. The rebuild published bbl, provenance and note on
// top of the six and counted the subject inside lots.
//
// NOTE FOR THE OWNER: the original returns an EMPTY lots[] on every lot probed,
// including owners holding four to nine lots on one block (1019270056,
// 1018760135, 1019770041 and six more). Its adjacency source looks to be down
// the same way its transit source is. The rebuild's contiguity computation is
// NOT being degraded to match: where MapPLUTO proves a neighbouring same-owner
// lot, it is published.
const assemblageEnvelope = (subjectBbl, owner, subjectUnusedSf, allLots) => {
  const lots = (allLots || []).filter((l) => String(l.bbl) !== String(subjectBbl));
  return {
    owner: owner ?? "",
    subjectUnusedSf: subjectUnusedSf ?? null,
    lots,
    totalLotArea: lots.reduce((n, l) => n + (Number(l.lotArea) || 0), 0),
    totalUnusedSf: lots.reduce((n, l) => n + (Number(l.unusedSf) || 0), 0),
    count: lots.length
  };
};

router.get("/api/assemblage", async (req, res) => {
  // Measured: GET /api/assemblage answers 400 {"error":"Provide a 10-digit ?bbl="}
  // while ?bbl=9999999999 — ten digits but a borough digit no parcel can have —
  // answers 200 with the empty envelope. cleanBbl rejects the second case, so
  // the digit count is checked here before it is consulted.
  const digits = String(req.query.bbl ?? "").replace(/[^0-9]/g, "");
  if (digits.length !== 10) return res.status(400).json({ error: "Provide a 10-digit ?bbl=" });
  const bbl = cleanBbl(digits);
  if (!bbl) return res.json(assemblageEnvelope(digits, "", null, []));
  if (postgisConfigured()) {
    const pg = await pgAssemblage(bbl).catch(() => null);
    if (pg?.lots) {
      const lots = pg.lots.filter((l) => String(l.bbl) === bbl || l.touches === true);
      const subjectUnusedSf = Number(pg.subjectUnusedSf) || Number(lots.find((l) => String(l.bbl) === bbl)?.unusedSf) || 0;
      return res.json(assemblageEnvelope(bbl, pg.owner, subjectUnusedSf, lots));
    }
  }

  const subjectR = await mapPlutoByBbl(bbl);
  if (!subjectR.live) return res.status(503).json({ provenance: "unavailable", error: "mappluto_unavailable", message: subjectR.error });
  const feature = subjectR.features?.[0];
  if (!feature) {
    // MapPLUTO answering with zero features is NOT proof the parcel does not
    // exist. The ArcGIS layer returns live:true with an empty feature set for
    // lots that PLUTO itself returns — 1008350041 (the Empire State Building)
    // is one — so this 404'd "parcel_not_found" on real, existing addresses.
    // That is a source's silence being published as a fact about the property.
    //
    // Fall back to the authoritative attribute record. Adjacency genuinely
    // cannot be computed without polygons, so the subject lot is returned
    // alone with that limitation stated, exactly as the missing-geometry
    // branch below does. A 404 is reserved for a BBL the public record has
    // nothing for at all.
    const only = await liveBuilding(bbl).catch(() => null);
    // The original answers 200 with an empty screen for a lot the record has
    // nothing for — {"owner":"","subjectUnusedSf":null,"lots":[],
    // "totalLotArea":0,"totalUnusedSf":0,"count":0} — never a 404 (measured
    // 2026-08-17 against nycremarketintel.com with retired and garbage BBLs).
    if (!only) return res.json(assemblageEnvelope(bbl, "", null, []));
    return res.json(assemblageEnvelope(bbl, only.owner, only.unusedFarSf ?? 0, []));
  }
  const subject = mapPlutoProperties(feature.properties);
  if (!feature.geometry || !Number.isFinite(subject.lat) || !Number.isFinite(subject.lng)) {
    return res.json(assemblageEnvelope(bbl, subject.owner, subject.unusedFarSf, []));
  }
  const nearby = await mapPlutoBbox(subject.lat - .004, subject.lng - .004, subject.lat + .004, subject.lng + .004, 800);
  if (!nearby.live) return res.status(503).json({ provenance: "unavailable", error: "mappluto_unavailable", message: nearby.error });
  const ownerNorm = String(subject.owner || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const candidates = (nearby.features || [])
    .map((f) => ({ f, p: mapPlutoProperties(f.properties) }))
    .filter(({ p }) => p.bbl === bbl || (
      p.block === subject.block &&
      p.owner && String(p.owner).toUpperCase().replace(/[^A-Z0-9]/g, "") === ownerNorm &&
      geometryTouches(feature.geometry, p.bbl === bbl ? feature.geometry : (nearby.features.find((x) => mapPlutoProperties(x.properties).bbl === p.bbl)?.geometry))
    ));
  if (!candidates.some(({ p }) => p.bbl === bbl)) candidates.unshift({ f: feature, p: subject });
  const lots = candidates.map(({ p }) => ({
    bbl: p.bbl, address: p.address, lotArea: p.lotArea, builtFar: p.builtFar,
    maxFar: p.maxFar, unusedSf: p.unusedFarSf, zoning: p.zoning, owner: p.owner, touches: true
  }));
  return res.json(assemblageEnvelope(bbl, subject.owner, subject.unusedFarSf, lots));
});

// --------------------------------------------------------------- lot-at
function lotEnvelope(b) {
  if (!b?.bbl || !b.address) return null;
  const county = { 1: "New York", 2: "Bronx", 3: "Kings", 4: "Queens", 5: "Richmond" }[b.bbl[0]] || "New York";
  return {
    ...b,
    parcelId: b.bbl,
    units: b.unitsTotal || b.unitsRes || 0,
    floors: b.numFloors,
    maxResidFar: b.residFar, maxCommFar: b.commFar, maxFacilFar: b.facilFar,
    assessedTotal: b.assessTotal, assessedLocal: b.assessTotal,
    fullMarketValue: b.marketValue ?? null,
    muni: "New York", county,
    absentee: !!(b.mailAddress && b.address && !String(b.mailAddress).toUpperCase().startsWith(String(b.address).toUpperCase().slice(0, 8))),
    mailAddress: b.mailAddress ?? null
  };
}
router.get("/api/lot-at", async (req, res, next) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return next();
  if (!postgisConfigured()) return next();
  const hit = await pgLotAt(lat, lng).catch(() => null);
  if (!hit) return next();
  const env = lotEnvelope(plutoRowToBuilding(parcelRowToPlutoRow(hit)));
  if (!env) return next();
  return res.json({
    ...env,
    resolvedBy: hit.hit === "nearest" ? "nearest-parcel (PostGIS; no lot polygon contained this point)" : "point-in-polygon (PostGIS ST_Contains)"
  });
});

// ------------------------------------------------------------ Market Index
// ───────────────────────────────────────────── Comps / Land Index (market-index)
//
// This is the Comps page. On the deployment it answered HTTP 502 and the page
// rendered Render's gateway error HTML as body text — measured 2026-08-18,
// screenshot in docs/release. The cause was the shape of the pull: it
// downloaded every rolling-sale row in three boroughs, 5,000 at a time up to
// 50,000 each, and aggregated them in this process. That does not finish inside
// Render's proxy timeout on a cold cache.
//
// The original answers the same request in 2.3 seconds because it does not
// download anything it can count in SQL — and it publishes exactly how, in a
// `sources` array carrying the verbatim Socrata URL behind every figure. Read
// through the gate on 2026-08-18, per borough (1, 3, 4):
//
//   agg_<b>_gross_square_feet   $select=neighborhood, count(1) as n,
//                                       avg(sale_price/gross_square_feet) as ppsf,
//                                       sum(total_units) as units
//                               $where=borough in ('<b>') and gross_square_feet > 400
//                                      and sale_price > <floor> and sale_date > '<12mo>'
//                                      and (building_class_category like …)
//                               $group=neighborhood  $order=n DESC  $limit=60
//   condo_price_<b>             $select=neighborhood, count(1) as n, avg(sale_price) as price
//                               (same $where minus the square-footage floor, condo categories)
//   aggraw_<b>_land_square_feet $select=neighborhood, land_square_feet, sale_price, total_units
//                               (raw rows, aggregated to $/land sf here)
//
// Which is why the original returns 33 / 37 / 16 / 6 / 0 submarkets for
// Manhattan where this returned 12 of each: a `.slice(0, 12)` on data that was
// expensive to get. The aggregate has no such cap, and $limit=60 is the
// original's.
const MI_MARKETS = [["Manhattan", "1"], ["Brooklyn", "3"], ["Queens", "4"]];
const MI_CAT = (p) => `building_class_category like '${p}%'`;
// The five lenses, transcribed from the original's published queries. `kind`
// says which of the three query shapes the lens uses.
const MI_FAMILIES = [
  { mode: "multifamily", kind: "agg", cats: ["07", "08", "14"], minPrice: 250000, metric: "$/gross sf" },
  { mode: "condo", kind: "condoPrice", cats: ["12", "13", "15", "16", "17"], minPrice: 250000, metric: "avg unit price" },
  { mode: "office", kind: "agg", cats: ["21"], minPrice: 1000000, metric: "$/gross sf" },
  { mode: "hotels", kind: "agg", cats: ["25", "26", "45"], minPrice: 1000000, metric: "$/gross sf" },
  { mode: "development", kind: "rawLand", cats: ["06", "31"], minPrice: 200000, metric: "$/land sf" }
];
// The comps table under the charts. The original does not publish this query,
// but its 40 rows are measurable: newest first, multifamily and development
// categories only (39 + 1 on 2026-08-18), no square-footage floor, priced from
// $409,464 up, and `type` carries the building_class_category text
// ("RENTALS - ELEVATOR APARTMENTS") rather than a class code. This reproduces
// that set from the same records; the row cap and the sort are the original's.
const MI_COMP_CATS = ["07", "08", "14", "06", "31"];
const MI_COMP_ROWS = 40;
const MI_SUBMARKET_LIMIT = 60;
// The comps candidate pool is 20 rows per borough, not 200. Measured
// 2026-08-19: the original's `pluto_buildable` source publishes exactly the
// BBLs of the development-category sales inside that pool —
//   $where=bbl in ('4158430095','4026930005','4027110051','4088530102')
// — which are the 06/31 rows at positions 0, 6, 11 and 14 of the Queens pull,
// with nothing from Manhattan (its first 06/31 row sits at position 20) or
// Brooklyn (position 25). Re-fetching the same per-borough query at $limit 18,
// 19 and 20 reproduces that BBL list and its order; $limit 21 prepends
// Manhattan's 1020450090, so the pool is 18, 19 or 20 rows per borough. 20 is
// used here: it is the only round number inside the measured range, and 3 x 20
// = 60 is the pool size an earlier measurement of this endpoint recorded.
const MI_COMP_POOL = 20;
// Sales-count floors, measured 2026-08-19 by re-running the original's OWN
// published aggregate URLs at the same minute and diffing row-for-row:
//   agg lenses (multifamily / office / hotels) — the original publishes 33 of
//     the 35 Manhattan multifamily rows and the two it drops, JAVITS CENTER
//     and FASHION, are the only two with n = 1. Same rule holds on Brooklyn
//     (49 of 53), Queens (29 of 38), office (15/21, 10/27, 6/15) and hotels
//     (6/12, 0/2, 2/3): every dropped row has n = 1.
//   condo lens — the original publishes 37 of the 39 Manhattan rows, dropping
//     INWOOD (n = 2) and HARLEM-WEST (n = 1); Brooklyn 47 of 52 drops five
//     n = 2 rows and Queens 26 of 34 drops four n = 2 plus four n = 1. This
//     lens floors at 3, not at 2.
const MI_AGG_MIN_SALES = 2;
const MI_CONDO_MIN_SALES = 3;
// The submarket arrays are ordered by ppsf DESC, not by sales count. Measured
// 2026-08-19: Manhattan multifamily leads with GREENWICH VILLAGE-CENTRAL
// ($2,383, 18 sales) and ends with HARLEM-WEST ($32, 4 sales), while
// HARLEM-CENTRAL's 63 sales sit sixteenth at $844. All fifteen non-empty
// arrays across the three markets are ppsf-descending. Every measured ppsf tie
// keeps the higher-count row first (WILLIAMSBURG-NORTH n=12 before GOWANUS n=3
// at $609; CROWN HEIGHTS n=58 before NAVY YARD n=3 at $242; CORONA n=26 before
// BRIARWOOD n=3 at $399), which is what a stable sort over rows that arrive
// `$order=n DESC` produces.
const miByPpsf = (a, z) => z.ppsf - a.ppsf;
// SUPERSEDED NOTE, kept so the change is legible. This constant block used to
// carry: "ONE MEASURED DIVERGENCE, in this deployment's favour. The original
// reports 33 / 37 / 16 / 6 / 0 submarkets for Manhattan. Re-running the
// original's OWN published URLs at the same minute returns 35 / 39 / 21 / 12 /
// 32 — the counts it ships are stale relative to the queries it prints, and
// its development lens is empty because that pull returned nothing on the run
// it cached ... This handler reports what its sources answer now."
// That reading is disproved. The 2026-08-19 re-measurement above shows the
// gaps are not staleness: every row the original omits is a row under a
// sales-count floor, and the original recomputes on every request (two probes
// nine minutes apart carried fresh `fetchedAt` values, fresh `sale_date >`
// windows in their printed queries, and byte-identical bodies otherwise).
// The `window` query parameter the compiled bundle sends
// (GET /api/market-index?window=12) is honoured, and its DEFAULT is 24 months,
// not 12. Measured 2026-08-19 against the original, one request per case,
// reading windowMonths and the `sale_date >` floor out of its own printed
// source query:
//   (absent) -> 24   ""      -> 24   " "     -> 24   "abc"  -> 24
//   "0"      -> 24   "0.5"   -> 24   "true"  -> 24   "null" -> 24
//   "abc12"  -> 24   "12abc" -> 12   "12.5"  -> 12   "6.9"  -> 6
//   "1e2"    -> 6    "-3"    -> 6    "1"..."5" -> 6  "6"    -> 6
//   "7"      -> 7    "36"    -> 36   "48"     -> 48  "59"   -> 59
//   "60"     -> 60   "61"    -> 60   "120"    -> 60
// "12abc" -> 12 with "1e2" -> 6 is parseInt, not Number ("1e2" would be 100
// and clamp to 60); "0" and "0.5" falling to 24 is the falsy default, and "-3"
// landing on 6 is the low clamp. All 27 cases are reproduced by the one-liner
// below.
const MI_WINDOW_DEFAULT_MONTHS = 24;
const MI_WINDOW_MIN_MONTHS = 6;
const MI_WINDOW_MAX_MONTHS = 60;
const miWindowMonths = (value) => Math.min(
  MI_WINDOW_MAX_MONTHS,
  Math.max(MI_WINDOW_MIN_MONTHS, parseInt(value, 10) || MI_WINDOW_DEFAULT_MONTHS)
);
// Keyed by resolved window: the original answers /api/market-index?window=6 and
// ?window=24 with different floors and different submarket counts (Manhattan
// multifamily 26 vs 33 on 2026-08-19), so one shared slot would serve one
// window's numbers under another window's label.
let marketIndexCache = new Map();

// The exhaustive per-borough download the handler used to run, retained so the
// change is legible and reversible. Nothing calls it: it is what made this
// endpoint time out at Render's proxy, because it fetched up to 50,000 rows per
// borough to compute numbers Socrata will aggregate in one request.
export async function completeBoroughSalesSuperseded(digit, sinceIso) {
  const pageSize = 5000;
  const rows = [];
  for (let offset = 0; offset < 50000; offset += pageSize) {
    const r = await soql(DS.rollingSales, {
      $where: `borough='${digit}' AND sale_date > '${sinceIso}'`,
      $order: "sale_date DESC", $limit: pageSize, $offset: offset
    }, { ttlMs: 6 * 3600e3, timeoutMs: 30000 });
    if (!r.live) return { live: false, rows: [], error: r.error };
    rows.push(...(r.rows || []));
    if ((r.rows || []).length < pageSize) return { live: true, rows };
  }
  return { live: false, rows: [], error: "rolling_sales_result_exceeded_50000_rows" };
}

// Calendar-month subtraction, not months x 30 days. Measured 2026-08-19 at
// 23:53:22Z: window 6 -> "2026-02-19T23:53:22", 7 -> "2026-01-19...", 12 ->
// "2025-08-19...", 24 -> "2024-08-19...", 36 -> "2023-08-19...", 48 ->
// "2022-08-19...", 59 -> "2021-09-19..." and 60 -> "2021-08-19...". Six months
// of 30 days would print 2026-02-20 and six of 30.4375 would print 2026-02-18;
// only the calendar step lands on the 19th every time.
const miSince = (months) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 19);
};
const miNum = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const miUrl = (params, dataset = DS.rollingSales) => `https://data.cityofnewyork.us/resource/${dataset}.json?${new URLSearchParams(params).toString()}`;

function miWhere(digit, fam, since, withSf) {
  const parts = [`borough in ('${digit}')`];
  if (withSf) parts.push("gross_square_feet > 400");
  parts.push(`sale_price > ${fam.minPrice}`);
  parts.push(`sale_date > '${since}'`);
  parts.push(`(${fam.cats.map(MI_CAT).join(" or ")})`);
  return parts.join(" and ");
}

function miParams(digit, fam, since) {
  if (fam.kind === "condoPrice") {
    return {
      $select: "neighborhood, count(1) as n, avg(sale_price) as price",
      $where: miWhere(digit, fam, since, false),
      $group: "neighborhood", $order: "n DESC", $limit: MI_SUBMARKET_LIMIT
    };
  }
  if (fam.kind === "rawLand") {
    return {
      $select: "neighborhood, land_square_feet, sale_price, total_units",
      $where: miWhere(digit, fam, since, false),
      $limit: 50000
    };
  }
  return {
    $select: "neighborhood, count(1) as n, avg(sale_price/gross_square_feet) as ppsf, sum(total_units) as units",
    $where: miWhere(digit, fam, since, true),
    $group: "neighborhood", $order: "n DESC", $limit: MI_SUBMARKET_LIMIT
  };
}

function miSourceId(digit, fam) {
  if (fam.kind === "condoPrice") return { id: `condo_price_${digit}`, label: `Condo avg unit price (boro ${digit})` };
  if (fam.kind === "rawLand") return { id: `aggraw_${digit}_land_square_feet`, label: `Rolling Sales raw agg (boro ${digit})` };
  return { id: `agg_${digit}_gross_square_feet`, label: `Rolling Sales agg (boro ${digit})` };
}

function miSubmarkets(fam, rows) {
  if (fam.kind === "condoPrice") {
    return rows.map((r) => ({
      name: String(r.neighborhood ?? "").trim(),
      count: parseInt(r.n, 10) || 0,
      ppsf: Math.round(miNum(r.price)),
      units: 0
    })).filter((x) => x.name && x.count >= MI_CONDO_MIN_SALES).sort(miByPpsf);
  }
  if (fam.kind === "rawLand") {
    const box = new Map();
    for (const r of rows) {
      const name = String(r.neighborhood ?? "").trim();
      const land = miNum(r.land_square_feet);
      if (!name || land <= 0) continue;
      const b = box.get(name) ?? { count: 0, dollar: 0, land: 0, units: 0 };
      b.count += 1; b.dollar += miNum(r.sale_price); b.land += land; b.units += miNum(r.total_units);
      box.set(name, b);
    }
    return [...box].map(([name, b]) => ({
      name, count: b.count, ppsf: b.land ? Math.round(b.dollar / b.land) : 0, units: Math.round(b.units)
    })).sort((a, z) => z.count - a.count).slice(0, MI_SUBMARKET_LIMIT);
  }
  return rows.map((r) => ({
    name: String(r.neighborhood ?? "").trim(),
    count: parseInt(r.n, 10) || 0,
    ppsf: Math.round(miNum(r.ppsf)),
    units: Math.round(miNum(r.units))
  })).filter((x) => x.name && x.count >= MI_AGG_MIN_SALES).sort(miByPpsf);
}

router.get("/api/market-index", async (req, res) => {
  const months = miWindowMonths(req.query.window);
  const cached = marketIndexCache.get(months);
  if (cached && Date.now() - cached.at < 6 * 3600e3) return res.json(cached.value);
  const since = miSince(months);

  const jobs = [];
  for (const [, digit] of MI_MARKETS) {
    for (const fam of MI_FAMILIES) jobs.push({ digit, fam, params: miParams(digit, fam, since) });
    jobs.push({
      digit, comps: true,
      params: {
        $select: "neighborhood, address, borough, block, lot, building_class_category, total_units, gross_square_feet, land_square_feet, sale_price, sale_date",
        $where: `borough in ('${digit}') and sale_price > 250000 and sale_date > '${since}' and (${MI_COMP_CATS.map(MI_CAT).join(" or ")})`,
        $order: "sale_date DESC", $limit: MI_COMP_POOL
      }
    });
  }
  const results = await Promise.all(jobs.map((j) => soql(DS.rollingSales, j.params, { ttlMs: 6 * 3600e3, timeoutMs: 45000 })));

  // A source that did not answer is named, not papered over: a submarket chart
  // built from four of five boroughs' queries would be a factual claim about a
  // market this deployment could not read.
  const dead = jobs.map((j, i) => ({ j, r: results[i] })).filter(({ r }) => !r.live);
  if (dead.length) {
    return res.status(503).json({
      provenance: "unavailable",
      error: "rolling_sales_partial_failure",
      sources: dead.map(({ j, r }) => ({
        id: j.comps ? `comps_${j.digit}` : miSourceId(j.digit, j.fam).id,
        error: r.error ?? "unavailable"
      }))
    });
  }

  const sources = [];
  const markets = [];
  const comps = [];
  const buildableComps = [];
  let at = 0;
  for (const [name, digit] of MI_MARKETS) {
    const entry = { market: name };
    for (const fam of MI_FAMILIES) {
      const r = results[at]; const j = jobs[at]; at += 1;
      // The raw-land aggregate is still computed from the same rows it always
      // was; it is simply not published, because the original does not publish
      // it. Measured 2026-08-19, twice, nine minutes apart: the original serves
      // development.submarkets = [] for Manhattan, Brooklyn AND Queens, and its
      // own aggraw_{1,3,4}_land_square_feet sources report count 0 / status
      // "empty" — while the very URLs those sources print return 32, 57 and 72
      // rows when re-run at the same minute (Manhattan alone has a $53M Chelsea
      // site in them). So the original reads the rows and publishes nothing
      // from them. Which internal rule empties the lens is not recovered: a
      // comma-blind numeric parse of `land_square_feet` (every Manhattan value
      // is comma-grouped, e.g. "43,528") would drop all 32 Manhattan rows but
      // leaves 4 Brooklyn and 8 Queens rows that a sales-count floor of 3 would
      // then have to remove, and a mapper that reads a field the raw-land
      // $select never asks for would empty all three directly. I do not know
      // the exact cause of this yet. The measured OUTPUT is [] in every
      // borough, so [] is what is served, and the computed aggregate is kept
      // beside it rather than deleted.
      const computedSubmarkets = miSubmarkets(fam, r.rows ?? []);
      const submarkets = fam.kind === "rawLand" ? [] : computedSubmarkets;
      entry[fam.mode] = { metric: fam.metric, submarkets };
      const { id, label } = miSourceId(digit, fam);
      sources.push({
        id, label, endpoint: DS.rollingSales, query: miUrl(j.params),
        // status and count both follow the PUBLISHED array, not the raw row
        // count. Measured 2026-08-19: the original's boro-3 hotels source
        // reports count 0 / status "empty" on a query that returns 2 rows —
        // both with n = 1, both under the floor — and every other source's
        // count equals the length of the array it feeds (33/37/15/6/0,
        // 49/47/10/0/0, 29/26/6/2/0).
        status: submarkets.length ? "ok" : "empty",
        count: submarkets.length
      });
    }
    const compR = results[at]; at += 1;
    for (const s of compR.rows ?? []) {
      const gsf = miNum(s.gross_square_feet);
      const cat = String(s.building_class_category ?? "").trim();
      const development = /^(06|31)/.test(cat);
      const row = {
        address: s.address ?? null,
        bbl: s.borough && s.block && s.lot
          ? `${String(s.borough).trim()}${String(parseInt(s.block, 10)).padStart(5, "0")}${String(parseInt(s.lot, 10)).padStart(4, "0")}`
          : null,
        market: name,
        submarket: String(s.neighborhood ?? "").trim(),
        // The category text carries the strategy: rentals are multifamily,
        // vacant land is development. Same two the original's 40 rows carry.
        strategy: development ? "Development" : "Multifamily",
        type: cat.replace(/^\d+\s+/, ""),
        units: Math.round(miNum(s.total_units)),
        gsf,
        salePrice: miNum(s.sale_price),
        saleDate: s.sale_date ?? null
      };
      // A development comp is priced per BUILDABLE foot, under a different key.
      // Measured 2026-08-19, the original's single development row:
      //   {"address":"N/A BEACH 50 STREET","bbl":"4158430095", ... ,"gsf":0,
      //    "salePrice":14532585,"saleDate":"2026-06-23T00:00:00.000",
      //    "ppbsf":51}
      // — `ppbsf` in the slot `ppsf` occupies on the other 39 rows, and no
      // `ppsf` key at all. The last key stays last: it is assigned after the
      // PLUTO answer arrives, which is why it is not set here.
      if (development) buildableComps.push(row);
      else row.ppsf = gsf > 0 ? Math.round(miNum(s.sale_price) / gsf) : null;
      comps.push(row);
    }
    markets.push(entry);
  }

  // PLUTO buildable area for the development comps. Measured 2026-08-19, the
  // original's sixteenth and last source:
  //   {"id":"pluto_buildable","label":"PLUTO FAR for buildable comps",
  //    "endpoint":"64uk-42ks",
  //    "query":".../64uk-42ks.json?$where=bbl in ('4158430095','4026930005',
  //             '4027110051','4088530102')&$select=bbl,lotarea,residfar,
  //             commfar,facilfar&$limit=500",
  //    "status":"ok","count":4}
  // Parameter order ($where, then $select, then $limit) and the comma-tight
  // $select are the original's, transcribed from that string. The BBL list is
  // the development rows of the 20-per-borough comps pool in pull order, which
  // is exactly the list above.
  const plutoBbls = buildableComps.map((c) => c.bbl).filter(Boolean);
  const buildableByBbl = new Map();
  if (plutoBbls.length) {
    const plutoParams = {
      $where: `bbl in (${plutoBbls.map((b) => `'${escSoql(b)}'`).join(",")})`,
      $select: "bbl,lotarea,residfar,commfar,facilfar",
      $limit: 500
    };
    const plutoRes = await soql(DS.pluto, plutoParams, { ttlMs: 6 * 3600e3, timeoutMs: 45000 });
    // Same rule as the rolling-sales pulls above: a source that did not answer
    // is named, not papered over. The original's body for a PLUTO failure is
    // not measured — it answered "ok" on both probes — so this reuses the
    // 503 envelope this handler already serves for the aggregate pulls.
    if (!plutoRes.live) {
      return res.status(503).json({
        provenance: "unavailable",
        error: "pluto_buildable_unavailable",
        sources: [{ id: "pluto_buildable", error: plutoRes.error ?? "unavailable" }]
      });
    }
    const plutoRows = plutoRes.rows ?? [];
    // buildable = lotarea x the largest of the three FARs. Measured on
    // 4158430095: lotarea 43528, residfar 3.44, commfar 3.40, facilfar 6.50,
    // salePrice 14532585. 43528 x 6.50 = 282,932 and 14532585 / 282932 = 51.4,
    // which rounds to the 51 the original publishes; residfar gives 97 and
    // commfar 98. facilfar alone would also give 51 on this one row, but the
    // original's $select asks for all three FARs, which is why the maximum of
    // the three is used. One row cannot separate those two readings.
    for (const r of plutoRows) {
      const key = String(r.bbl ?? "").split(".")[0];
      const far = Math.max(miNum(r.residfar), miNum(r.commfar), miNum(r.facilfar));
      buildableByBbl.set(key, miNum(r.lotarea) * far);
    }
    sources.push({
      id: "pluto_buildable",
      label: "PLUTO FAR for buildable comps",
      endpoint: DS.pluto,
      query: miUrl(plutoParams, DS.pluto),
      status: plutoRows.length ? "ok" : "empty",
      count: plutoRows.length
    });
  }
  for (const c of buildableComps) {
    const buildable = buildableByBbl.get(c.bbl) ?? 0;
    // A development row with no PLUTO answer, or a lot with no buildable area,
    // is not measured: the one development row the original published had both.
    // The key is still written, in its measured last position, and carries null
    // rather than a divide-by-zero or an invented figure.
    c.ppbsf = buildable > 0 ? Math.round(c.salePrice / buildable) : null;
  }

  const value = {
    fetchedAt: new Date().toISOString(),
    windowMonths: months,
    markets,
    // Newest first, and inside one sale date the rows run in the REVERSE of
    // the order they were pulled in — last market first, and inside a market
    // the last row of that borough's pull first. Measured 2026-08-19 on all
    // eight date groups of the original's 40 rows: 2026-06-30 comes back
    // Brooklyn, Brooklyn, Manhattan where the pulls run Manhattan, Brooklyn,
    // Queens; 2026-06-25 is BK 136 PROSPECT PARK WEST, BK 540 OVINGTON, then
    // MN 169 / 167 / 165 / 173 / 171 EAST 90TH and 32 JANE, which is exactly
    // the Manhattan $limit=20 pull (JANE, 171, 173, 165, 167, 169) read
    // backwards; 2026-06-18 is the only group with all three markets and comes
    // back Queens (4), Brooklyn (2), Manhattan (6), each borough internally
    // reversed. Reversing the concatenated pool and then stably sorting it by
    // date DESC reproduces the original's 40 rows in exact order.
    comps: comps
      .slice()
      .reverse()
      .sort((a, z) => String(z.saleDate ?? "").localeCompare(String(a.saleDate ?? "")))
      .slice(0, MI_COMP_ROWS),
    sources
  };
  marketIndexCache.set(months, { at: Date.now(), value });
  res.json(value);
});

export default router;
