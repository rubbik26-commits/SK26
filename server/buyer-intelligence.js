// Owner-only bridge from Lucia to buyerDB's historical buyer warehouse.
//
// Both applications already use the same Supabase project. This router reads
// the existing sbi_* warehouse through the existing server-side admin
// credential and the already-deployed api_buyers/api_entity RPCs. It creates no table,
// changes no policy, writes no row, and never sends the admin credential or
// contact values to the browser.
import { Router } from "express";
import { gateRole } from "./gate.js";
import { adminKey, supabaseFetch } from "./production-api.js";
import { liveBuilding } from "./live.js";
import {
  BUYER_INTEL_ASSET_TYPES,
  BUYER_INTEL_BOROUGHS,
  DEFAULT_BUYER_INTEL_BOROUGH,
  boroughFromBuyerIntelBbl,
  buyerIntelAssetType,
  buyerIntelDate,
  buyerIntelRpcBody,
  cleanBuyerIntelBbl,
  cleanBuyerIntelEntityId,
  normalizeBuyerIntelHistory,
  normalizeBuyerIntelRows,
  rankBuyerIntelRows
} from "./buyer-intelligence-core.js";

const router = Router();
const CACHE_TTL_MS = 2 * 60 * 1000;
const STATUS_CACHE_TTL_MS = 30 * 1000;
const responseCache = new Map();
const historyCache = new Map();
let refreshStatusCache = null;

export function buyerIntelOwner(req) {
  if (gateRole(req) === "owner") return true;
  return ["owner", "admin"].includes(String(req.productionUser?.role ?? "").toLowerCase());
}

function requireBuyerIntelOwner(req, res, next) {
  if (buyerIntelOwner(req)) return next();
  if (/^Bearer\s+\S+/i.test(String(req.headers.authorization ?? "")) && !req.productionUser) {
    return res.status(401).json({ error: "authentication_required" });
  }
  return res.status(403).json({ error: "owner_only" });
}

function configuredResponse(res) {
  if (adminKey()) return true;
  res.status(503).json({
    configured: false,
    provenance: "unavailable",
    error: "buyer_intelligence_unconfigured",
    message: "The server-side Supabase admin credential required for buyer intelligence is not configured."
  });
  return false;
}

function optionalMoney(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
}

function cacheKey(body) {
  return JSON.stringify(body);
}

async function historicalBuyers(filters) {
  const requestedBody = buyerIntelRpcBody(filters);
  // api_buyers orders only on the selected primary metric. Pull its full
  // supported window. For count ranking, also pull the volume window so a
  // high-volume buyer is not lost at an arbitrary count-tie boundary. Merge
  // by entity and apply documented deterministic tie-breaks before slicing.
  const body = { ...requestedBody, lim: 200 };
  const tieBody = body.rank_by === "count" ? { ...body, rank_by: "vol" } : null;
  const key = `buyers:${cacheKey(body)}:${tieBody ? cacheKey(tieBody) : "single"}`;
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { buyers: hit.buyers.slice(0, requestedBody.lim), cached: true, body: requestedBody };
  }

  const rpc = (rpcBody) => supabaseFetch("/rest/v1/rpc/api_buyers", {
    token: adminKey(), method: "POST", body: rpcBody
  });
  const payloads = await Promise.all([rpc(body), ...(tieBody ? [rpc(tieBody)] : [])]);
  const merged = new Map();
  for (const payload of payloads) {
    for (const buyer of normalizeBuyerIntelRows(payload?.buyers)) merged.set(buyer.entityId, buyer);
  }
  const buyers = rankBuyerIntelRows([...merged.values()], requestedBody.rank_by);
  responseCache.set(key, { at: Date.now(), buyers });
  if (responseCache.size > 100) responseCache.delete(responseCache.keys().next().value);
  return { buyers: buyers.slice(0, requestedBody.lim), cached: false, body: requestedBody };
}

async function historicalBuyerTransactions(entityId, filters) {
  const key = `history:${entityId}:${cacheKey(filters)}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
  const payload = await supabaseFetch("/rest/v1/rpc/api_entity", {
    token: adminKey(),
    method: "POST",
    body: { eid: entityId }
  });
  const value = normalizeBuyerIntelHistory(payload, filters);
  historyCache.set(key, { at: Date.now(), value });
  if (historyCache.size > 300) historyCache.delete(historyCache.keys().next().value);
  return { ...value, cached: false };
}

async function buyerIntelligenceRefreshStatus() {
  if (refreshStatusCache && Date.now() - refreshStatusCache.at < STATUS_CACHE_TTL_MS) {
    return { status: refreshStatusCache.status, cached: true };
  }
  const status = await supabaseFetch("/rest/v1/rpc/buyer_intelligence_refresh_status", {
    token: adminKey(),
    method: "POST",
    body: {}
  });
  refreshStatusCache = { at: Date.now(), status };
  return { status, cached: false };
}

const methodology = Object.freeze({
  source: "buyerDB",
  datasets: ["sbi_entities", "sbi_deal_parties", "sbi_deals", "sbi_properties", "sbi_contacts"],
  contactHandling: "Only contact availability is returned; contact values remain server-side.",
  ranking: "count ranks by distinct matching transactions, then recorded volume, recency, and name; volume ranks by matching recorded sale volume, then count, recency, and name.",
  evidence: "Buyer detail uses buyerDB api_entity records and returns every matching buyer-role row without collapsing indistinguishable records, with its recorded property address, date, borough, asset type, price, and source URL. Missing source facts remain null and are never inferred.",
  matching: "Dossier and Pipeline matches use exact borough plus an asset type only when the NYC building-class family maps unambiguously to buyerDB's live vocabulary. No inferred fallback asset type is substituted."
});

router.get("/api/buyer-intel/status", requireBuyerIntelOwner, async (_req, res) => {
  if (!configuredResponse(res)) return;
  try {
    const result = await buyerIntelligenceRefreshStatus();
    return res.json({
      configured: true,
      provenance: "live",
      cached: result.cached,
      status: result.status
    });
  } catch (error) {
    console.warn(`[buyer-intel] refresh status failed: ${error?.message ?? error}`);
    return res.status(502).json({
      configured: true,
      provenance: "unavailable",
      error: "buyer_intelligence_status_unavailable",
      message: "Buyer intelligence freshness could not be verified."
    });
  }
});

router.get("/api/buyer-intel/buyers", requireBuyerIntelOwner, async (req, res) => {
  if (!configuredResponse(res)) return;
  const borough = req.query.borough === undefined
    ? DEFAULT_BUYER_INTEL_BOROUGH
    : String(req.query.borough ?? "").trim() || null;
  const assetType = String(req.query.assetType ?? "").trim() || null;
  const priceMin = optionalMoney(req.query.priceMin);
  const priceMax = optionalMoney(req.query.priceMax);
  const dateMin = req.query.dateMin ? buyerIntelDate(req.query.dateMin) : null;
  if (borough && !BUYER_INTEL_BOROUGHS.includes(borough)) return res.status(400).json({ error: "invalid_borough" });
  if (assetType && !BUYER_INTEL_ASSET_TYPES.includes(assetType)) return res.status(400).json({ error: "invalid_asset_type" });
  if (Number.isNaN(priceMin) || Number.isNaN(priceMax) || (priceMin !== null && priceMax !== null && priceMin > priceMax)) {
    return res.status(400).json({ error: "invalid_price_range" });
  }
  if (req.query.dateMin && !dateMin) return res.status(400).json({ error: "invalid_date_min" });

  const filters = {
    borough, assetType, priceMin, priceMax, dateMin,
    minDeals: req.query.minDeals ?? 2,
    rankBy: req.query.rankBy,
    limit: req.query.limit
  };
  try {
    const result = await historicalBuyers(filters);
    return res.json({
      configured: true,
      provenance: "live",
      cached: result.cached,
      criteria: {
        borough,
        assetType,
        priceMin: result.body.price_min,
        priceMax: result.body.price_max,
        dateMin: result.body.date_min,
        minDeals: result.body.min_deals,
        rankBy: result.body.rank_by === "vol" ? "volume" : "count",
        limit: result.body.lim
      },
      buyers: result.buyers,
      methodology
    });
  } catch (error) {
    console.warn(`[buyer-intel] buyers lookup failed: ${error?.message ?? error}`);
    return res.status(502).json({
      configured: true,
      provenance: "unavailable",
      error: "buyer_intelligence_unavailable",
      message: error?.message || "Historical buyers could not be loaded."
    });
  }
});

router.get("/api/buyer-intel/buyers/:entityId/history", requireBuyerIntelOwner, async (req, res) => {
  if (!configuredResponse(res)) return;
  const entityId = cleanBuyerIntelEntityId(req.params.entityId);
  if (!entityId) return res.status(400).json({ error: "invalid_entity_id" });
  const borough = req.query.borough === undefined
    ? DEFAULT_BUYER_INTEL_BOROUGH
    : String(req.query.borough ?? "").trim() || null;
  const assetType = String(req.query.assetType ?? "").trim() || null;
  if (borough && !BUYER_INTEL_BOROUGHS.includes(borough)) return res.status(400).json({ error: "invalid_borough" });
  if (assetType && !BUYER_INTEL_ASSET_TYPES.includes(assetType)) return res.status(400).json({ error: "invalid_asset_type" });
  try {
    const result = await historicalBuyerTransactions(entityId, { borough, assetType });
    if (!result.entity) return res.status(404).json({ error: "buyer_not_found" });
    return res.json({
      configured: true,
      provenance: "live",
      cached: result.cached,
      criteria: { role: "buyer", borough, assetType },
      entity: result.entity,
      summary: result.summary,
      transactions: result.transactions,
      methodology
    });
  } catch (error) {
    console.warn(`[buyer-intel] buyer history lookup failed for ${entityId}: ${error?.message ?? error}`);
    return res.status(502).json({
      configured: true,
      provenance: "unavailable",
      error: "buyer_history_unavailable",
      message: error?.message || "Address-linked buyer history could not be loaded."
    });
  }
});

router.get("/api/buyer-intel/matches", requireBuyerIntelOwner, async (req, res) => {
  if (!configuredResponse(res)) return;
  const bbl = cleanBuyerIntelBbl(req.query.bbl);
  if (!bbl) return res.status(400).json({ error: "invalid_bbl" });

  let building = null;
  let buildingError = null;
  try {
    building = await liveBuilding(bbl);
  } catch (error) {
    buildingError = error?.message || "The building record could not be loaded.";
    console.warn(`[buyer-intel] building lookup failed for ${bbl}: ${buildingError}`);
  }

  const borough = boroughFromBuyerIntelBbl(bbl);
  const assetType = buyerIntelAssetType(building);
  try {
    const result = await historicalBuyers({ borough, assetType, minDeals: 1, rankBy: "count", limit: 12 });
    return res.json({
      configured: true,
      provenance: "live",
      cached: result.cached,
      target: {
        bbl,
        address: building?.address ?? null,
        borough,
        buildingClass: building?.bldgClass ?? null,
        assetType,
        assetTypeMapped: !!assetType,
        ...(buildingError ? { buildingSourceWarning: buildingError } : {})
      },
      buyers: result.buyers,
      methodology
    });
  } catch (error) {
    console.warn(`[buyer-intel] match lookup failed for ${bbl}: ${error?.message ?? error}`);
    return res.status(502).json({
      configured: true,
      provenance: "unavailable",
      error: "buyer_match_unavailable",
      message: error?.message || "Historical buyer matches could not be loaded."
    });
  }
});

export { methodology as buyerIntelMethodology };
export default router;
