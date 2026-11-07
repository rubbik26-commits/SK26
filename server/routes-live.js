// Live-first API layer. Each handler serves REAL NYC public records; when a
// pull fails (or the BBL is a curated demo identifier) it calls next() and the
// demo router answers — with every demo response stamped provenance:"demo" by
// the middleware exported below. The frontend surfaces that label honestly.
import { Router } from "express";
import {
  liveBuilding, liveAddressSearch, liveAssetHistory, liveComps, liveContacts,
  liveDistress, liveTaxHistory, liveLienSale, liveZap, liveTransit, liveCliffs,
  liveAreaBuildings, liveNearby, liveMarket, livePropensityBacktest,
  liveMaturityWall, liveDemographics, parseBbl
} from "./live.js";
import { acrisByLot, plutoByBbl } from "./adapters/nyc.js";
import { computePropensity } from "./scoring.js";
import { durableBackend } from "./durable-store.js";
import { APP_DATA_DIR } from "./usage-meter.js";
import { serperConfigured, serperSearch, listingCheck } from "./adapters/serper.js";
import { pineconeConfigured, upsertParcel, searchSimilar } from "./adapters/pinecone.js";
import { airtableConfigured, crmXref } from "./adapters/airtable.js";

const router = Router();
const bblOf = (req) => String(req.query.bbl ?? "").replace(/[^0-9]/g, "");
const wrap = (fn) => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (out === undefined) return; // handler already responded
    if (out === null) return next(); // fall through to demo
    res.json(out);
  } catch { next(); }
};

// Per-subsystem status — powers the honest data-posture card and Source Registry.
router.get("/api/status", async (req, res) => {
  // Two independent probes: PLUTO for the parcel layer, ACRIS for the recorded
  // documents layer. Run together so the endpoint costs one round trip.
  const [probe, acrisProbe] = await Promise.all([
    liveBuilding("1003720009").catch(() => null),
    acrisByLot("1003720009").catch(() => null)
  ]);
  const acrisOk = !!(acrisProbe && acrisProbe.live !== false && Array.isArray(acrisProbe.deeds));
  // Where saved state actually lives, reported from the running process rather
  // than inferred from configuration. "Everything looks the same after every
  // deploy" was invisible until it had already happened; this makes it a thing
  // you can check on the deployed service before losing anything.
  const backend = await durableBackend();
  res.json({
    dataMode: probe ? "live" : "demo",
    persistence: {
      backend,                                   // "postgres" | "supabase-rest" | "supabase-rpc" | "disk (reason)"
      // Three backends put the state in Postgres and one does not. Comparing
      // against a single name was wrong the moment a second durable path
      // existed: the deployment would have been genuinely durable while this
      // still reported false, which is the same class of lie in the other
      // direction.
      survivesRedeploy: backend === "postgres" || backend === "supabase-rest" || backend === "supabase-rpc",
      dataDir: APP_DATA_DIR,
      note: backend === "postgres" || backend === "supabase-rest" || backend === "supabase-rpc"
        ? `The deployment-wide kanban board and investor pool are stored in Postgres (public.app_state) via ${backend} and survive a redeploy, a restart and a cold start.`
        : `Shared state is being written to APP_DATA_DIR because no durable backend is reachable (${backend}). On a host without a persistent disk — Render's free plan included — that directory is recreated from the deploy image, so saved boards and investors are lost on every deploy. Set SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY + APP_STATE_TOKEN (or SUPABASE_DB_URL) to make it durable.`
    },
    // Each source probed independently.
    //
    // One liveBuilding() call was PLUTO-only, and its single boolean was
    // assigned to pluto, acris and socrata alike — so an ACRIS outage reported
    // acris:true for as long as PLUTO answered, and the health page was
    // reporting a guess about two of the three. Each now answers for itself.
    subsystems: {
      pluto: !!probe,
      acris: acrisOk,
      socrata: !!probe || acrisOk,
      demographics: !!process.env.CENSUS_API_KEY,
      streetview: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
      photorealistic3d: !!process.env.GOOGLE_3D_KEY,
      pinecone: !!(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_HOST),
      serper: !!process.env.SERPER_API_KEY,
      airtable: !!(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID)
    },
    note: probe
      ? "Live NYC public records are being served (PLUTO, ACRIS, DOB, HPD, DOF, lien sale, MTA). Curated demo parcels remain labeled demo."
      : "Live NYC Open Data is unreachable from this host right now — responses fall back to the demo engine and are labeled provenance:'demo'."
  });
});

router.get("/api/address", wrap(async (req) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return null;
  const rows = await liveAddressSearch(q);
  if (rows == null || !rows.length) return null;
  return { provenance: "live", buildings: rows };
}));

router.get("/api/asset-history", wrap(async (req) => {
  const rec = await liveAssetHistory(bblOf(req));
  if (!rec) return null;
  rec.comps = (await liveComps(rec.building).catch(() => null)) ?? [];
  return rec;
}));

router.get("/api/area-buildings", wrap(async (req) => {
  const zips = String(req.query.zips ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!zips.length) return null;
  return liveAreaBuildings(zips, {
    page: Math.max(0, parseInt(req.query.page ?? "0", 10)),
    pageSize: Math.min(1000, parseInt(req.query.pageSize ?? "200", 10) || 200),
    sort: req.query.sort ?? "score",
    cls: req.query.class ?? ""
  });
}));

router.get("/api/contacts", wrap(async (req) => {
  const bbl = bblOf(req);
  const b = await liveBuilding(bbl);
  if (!b) return null; // not a real PLUTO lot — demo router serves labeled demo data
  return liveContacts(bbl);
}));

router.get("/api/distress", wrap(async (req) => {
  const bbl = bblOf(req);
  const b = await liveBuilding(bbl);
  if (!b) return null;
  const sig = await liveDistress(bbl, b.address, b.zip);
  if (!sig) return null;
  return { bbl, ...sig, riskFlags: [] };
}));

router.get("/api/tax-history", wrap(async (req) => liveTaxHistory(bblOf(req))));
router.get("/api/liensale", wrap(async (req) => liveLienSale(bblOf(req))));

router.get("/api/transit", wrap(async (req, res) => {
  const bbl = bblOf(req);
  const b = await liveBuilding(bbl);
  if (!b?.lat) {
    // Same contract as the bundle router: a lot PLUTO does not carry answers
    // the original's exact empty shape (200, nearest null), never a 404 and
    // never a 503 that blames a data source for a nonexistent parcel
    // (verified 2026-08-17 against nycremarketintel.com).
    const p = await plutoByBbl(bbl).catch(() => null);
    if (p?.live) return { nearest: null, within: { quarterMile: 0, halfMile: 0 }, provenance: "live" };
    return null;
  }
  const t = await liveTransit(b.lat, b.lng);
  if (!t) return null;
  return { bbl: b.bbl, ...t };
}));

router.get("/api/cliffs", wrap(async (req) => {
  const bbl = bblOf(req);
  const b = await liveBuilding(bbl);
  if (!b) return null;
  return liveCliffs(bbl, b);
}));

// A documented release-surface endpoint (docs/release/route-table.md) that was
// dead in production: liveZap() returned null whenever the ZAP pull failed,
// wrap() turned null into next(), and /api/zap-live was missing from the
// production guard's authoritative set — so every request fell through to
// Express's default HTML 404 page. It now answers JSON in all three states:
// records (200), parcel_not_found (404), or the guard's honest 503 on outage.
router.get("/api/zap-live", wrap(async (req, res) => {
  const bbl = bblOf(req);
  const z = await liveZap(bbl);
  if (z) return z;
  const p = await plutoByBbl(bbl).catch(() => null);
  if (p?.live && !p.rows?.length) { res.status(404).json({ error: "parcel_not_found", provenance: "live" }); return undefined; }
  return null;
}));

router.get("/api/nearby", wrap(async (req) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat)) return null;
  const rows = await liveNearby(lat, lng);
  if (!rows) return null;
  return { provenance: "live", buildings: rows };
}));

router.get("/api/maturity-wall", wrap(async (req) => {
  const bbls = String(req.query.bbls ?? "").split(",").map((s) => s.replace(/[^0-9]/g, "")).filter((s) => s.length === 10 && parseBbl(s));
  if (!bbls.length) return null;
  const out = await liveMaturityWall(bbls);
  return out.loans.length ? out : null;
}));

router.get("/api/demographics", wrap(async (req) => {
  const zips = String(req.query.zips ?? "").split(",").filter(Boolean);
  if (!zips.length) return null;
  const d = await liveDemographics(zips[0]);
  if (!d.configured) {
    // Honest unconfigured state — the demo generator is NOT used for
    // demographics (audit item 11/36).
    return { configured: false, provenance: "unavailable", note: "Set CENSUS_API_KEY (free at api.census.gov) to enable real ACS demographics." };
  }
  return d.live ? d : { configured: true, provenance: "unavailable", error: d.error };
}));

// Owner portfolio: exact owner-name match across the borough (live PLUTO).
router.get("/api/owner-portfolio", wrap(async (req) => {
  const b = await liveBuilding(bblOf(req));
  if (!b?.owner) return null;
  const { soql, escSoql } = await import("./adapters/socrata.js");
  const r = await soql("64uk-42ks", {
    $select: "bbl,address,bldgclass,unitsres,zipcode",
    $where: `ownername='${escSoql(b.owner)}'`, $limit: 200
  });
  if (!r.live) return null;
  const sample = r.rows.map((x) => ({
    bbl: String(x.bbl ?? "").replace(/\..*$/, ""), address: x.address,
    bldgClass: x.bldgclass, unitsRes: parseFloat(x.unitsres) || 0, zip: x.zipcode
  }));
  return {
    provenance: "live", owner: b.owner, total: sample.length,
    units: sample.reduce((n, x) => n + (x.unitsRes || 0), 0), sample
  };
}));

// Market aggregates from recorded sales + real DOB NOW pipeline.
router.get("/api/market-report", wrap(async (req) => {
  const zips = String(req.query.zips ?? "").split(",").filter(Boolean);
  if (!zips.length) return null;
  const m = await liveMarket(zips);
  if (!m) return null;
  const byClass = {};
  for (const s of m.sales) {
    const k = s.category ?? "OTHER";
    byClass[k] = byClass[k] ?? { category: k, count: 0, totalPrice: 0, ppsfs: [] };
    byClass[k].count++; byClass[k].totalPrice += s.salePrice;
    if (s.ppsf) byClass[k].ppsfs.push(s.ppsf);
  }
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  return {
    provenance: "live", zips,
    totals: {
      sales: m.sales.length,
      volume: m.sales.reduce((n, s) => n + s.salePrice, 0),
      medianPpsf: med(m.sales.map((s) => s.ppsf).filter(Boolean))
    },
    byClass: Object.values(byClass).map((c) => ({
      category: c.category, count: c.count, totalPrice: c.totalPrice, medianPpsf: med(c.ppsfs)
    })).sort((a, z) => z.count - a.count),
    recent: m.sales.slice(0, 40),
    pipeline: m.pipeline.slice(0, 30),
    window: "trailing 12 months (DOF rolling sales)"
  };
}));

router.get("/api/propensity-validation", wrap(async (req) => {
  const zips = String(req.query.zips ?? "").split(",").filter(Boolean);
  if (!zips.length) return null;
  return livePropensityBacktest(zips);
}));

// Live evidence pull for a real BBL (dossier drawer + building detail).
router.get("/api/livepull", wrap(async (req) => {
  const bbl = bblOf(req);
  if (!parseBbl(bbl)) return null;
  const rec = await liveAssetHistory(bbl);
  if (!rec) return null;
  const b = rec.building;
  const zap = await liveZap(bbl).catch(() => null);
  const debtTop = rec.loans.find((l) => /MTGE|MORTGAGE/i.test(l.docType ?? ""));
  return {
    provenance: "live", mode: "exact",
    coverage: `Exact-parcel pull for BBL ${bbl} — recorded sales, deeds & mortgages, DOB permits, DOB NOW filings, HPD, assessment roll.`,
    fetchedAt: new Date().toISOString(),
    summary: {
      lastSale: rec.metrics.lastSalePrice ? { saleDate: rec.metrics.lastSaleDate, salePrice: rec.metrics.lastSalePrice } : null,
      parcelMatch: "exact-bbl",
      dobPermitCount: rec.permits.length,
      dobNowCount: rec.dobNow.length,
      zoningApplicationCount: zap?.rows?.length ?? 0,
      debtDocCount: rec.loans.length,
      okSources: 5, errorSources: 0
    },
    debt: debtTop
      ? { found: true, amount: debtTop.amount, lender: debtTop.lender, borrower: null, docTypeLabel: debtTop.docType, rows: rec.loans.map((l) => ({ doc_type: l.docType, document_amt: l.amount, recorded_datetime: l.date, document_id: l.docId })) }
      : { found: false, rows: [] },
    permitContact: null,
    sources: [
      { id: "rolling_sales", label: "Recorded sales", rows: rec.sales.map((s) => ({ sale_date: s.date, sale_price: s.amount, building_class_at_present: b.bldgClass, gross_square_feet: b.bldgArea })) },
      { id: "pluto", label: "Parcel record", rows: [{ bbl: b.bbl, address: b.address, zonedist1: b.zoning, landuse: b.landUse, lotarea: b.lotArea, bldgarea: b.bldgArea, builtfar: b.builtFar, yearbuilt: b.yearBuilt, ownername: b.owner }] },
      { id: "dob_permits", label: "Permit issuance", rows: rec.permits.map((p) => ({ issuance_date: p.date, job_type: p.type, permit_status: p.status, applicant_business_name: p.business ?? p.applicant })) },
      { id: "dob_now", label: "Recent filings", rows: rec.dobNow.map((p) => ({ filing_date: p.date, job_type: p.type, filing_status: p.status, applicant_business: p.applicant })) },
      { id: "acris_master", label: "Recorded documents", rows: rec.loans.map((l) => ({ doc_type: l.docType, document_amt: l.amount, recorded_datetime: l.date, document_id: l.docId })) },
      { id: "zap", label: "ZAP zoning applications", rows: (zap?.rows ?? []).map((z) => ({ project_name: z.project_name, current_status: z.project_status, project_brief: z.project_brief })) }
    ]
  };
}));

// ---------------------------------------------------------------- integrations (audit items 20-24)
// Real listing detection via Serper (item 21). Without a key this falls
// through to the demo route's honest manual-search links.
router.get(["/api/listing-check", "/api/listingcheck"], wrap(async (req) => {
  if (!serperConfigured()) return null;
  const addr = String(req.query.addr ?? "").trim();
  if (!addr) return null;
  const out = await listingCheck(addr, String(req.query.boro ?? ""));
  return { addr, provenance: "live", ...out, listed: out.forSale ?? false };
}));

// Real web search via Serper (items 22-23) with normalization + caching.
router.get("/api/websearch", wrap(async (req) => {
  if (!serperConfigured()) return null;
  const q = String(req.query.q ?? "").trim();
  if (!q) return null;
  const out = await serperSearch(q);
  return { provenance: "live", ...out, searchUrl: `https://www.google.com/search?q=${encodeURIComponent(q)}` };
}));

// Real vector similarity via Pinecone (item 24): upsert the viewed parcel
// (the index grows as you open more parcels), then search with metadata
// filters and return similarity scores. Falls through to the local
// heuristic — which labels itself — when unconfigured.
router.get("/api/similar", wrap(async (req) => {
  if (!pineconeConfigured()) return null;
  const b = await liveBuilding(bblOf(req));
  if (!b) return null;
  await upsertParcel(b);
  const out = await searchSimilar(b);
  if (out.error) return { provenance: "live", configured: true, engine: "pinecone", error: out.error, matches: [] };
  return { provenance: "live", configured: true, engine: "pinecone", matches: out.matches };
}));

// Real Airtable CRM cross-reference (item 20). Owner-only — the gate in
// user-data.js runs before this handler.
router.get("/api/airtable-xref", wrap(async (req) => {
  if (!airtableConfigured()) return null;
  const bbl = bblOf(req);
  const b = bbl ? await liveBuilding(bbl) : null;
  const out = await crmXref({
    owner: String(req.query.owner ?? b?.owner ?? ""),
    address: String(req.query.address ?? b?.address ?? ""),
    bbl
  });
  return { provenance: "live", ...out };
}));

// Stamp everything the demo router serves after this point.
export function demoProvenance(req, res, next) {
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === "object" && !Array.isArray(body) && body.provenance == null) {
      return orig({ provenance: "demo", ...body });
    }
    return orig(body);
  };
  next();
}

export default router;
