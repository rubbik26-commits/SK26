// Dependency-free buyer-intelligence contracts shared by the runtime router
// and unit tests. The mappings below are intentionally narrow: a NYC building
// class is translated only when its first-letter family has one unambiguous
// counterpart in buyerDB's live sbi_deals.asset_type vocabulary.
export const BUYER_INTEL_ASSET_TYPES = Object.freeze([
  "Church", "Commercial", "Development Site", "Entertainment", "Garage/Auto",
  "Hospital", "Hotel", "Industrial", "Mixed-Use", "Multifamily", "Nursing Home",
  "Office", "Package Deal", "Parking Lot", "Retail", "School", "Senior Housing",
  "Special Purpose", "Storage", "Student Housing"
]);

export const BUYER_INTEL_BOROUGHS = Object.freeze([
  "Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island"
]);

export const DEFAULT_BUYER_INTEL_BOROUGH = "Manhattan";

const BOROUGH_BY_BBL = Object.freeze({
  "1": "Manhattan",
  "2": "Bronx",
  "3": "Brooklyn",
  "4": "Queens",
  "5": "Staten Island"
});

const ASSET_TYPE_BY_CLASS_FAMILY = Object.freeze({
  C: "Multifamily",
  D: "Multifamily",
  E: "Industrial",
  F: "Industrial",
  G: "Garage/Auto",
  H: "Hotel",
  M: "Church",
  O: "Office",
  S: "Mixed-Use",
  V: "Development Site",
  W: "School"
});

export function cleanBuyerIntelBbl(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return /^[1-5]\d{9}$/.test(digits) ? digits : "";
}

export function boroughFromBuyerIntelBbl(value) {
  const bbl = cleanBuyerIntelBbl(value);
  return bbl ? BOROUGH_BY_BBL[bbl[0]] : null;
}

export function buyerIntelAssetType(building) {
  const family = String(building?.bldgClass ?? building?.buildingClass ?? "").trim().charAt(0).toUpperCase();
  return ASSET_TYPE_BY_CLASS_FAMILY[family] ?? null;
}

export function buyerIntelDate(value) {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function cleanBuyerIntelEntityId(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text) ? text : "";
}

export function normalizeBuyerIntelRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    entityId: String(row?.entity_id ?? ""),
    name: String(row?.name ?? "").trim(),
    isSpvSuspect: row?.is_spv_suspect === true,
    dealCount: Math.max(0, Number.parseInt(row?.n, 10) || 0),
    volume: Math.max(0, finiteOrNull(row?.vol) ?? 0),
    lastDeal: row?.last_deal ? String(row.last_deal).slice(0, 10) : null,
    minPrice: finiteOrNull(row?.min_price),
    maxPrice: finiteOrNull(row?.max_price),
    assetTypes: Array.isArray(row?.types) ? row.types.map(String).filter(Boolean) : [],
    boroughs: Array.isArray(row?.boroughs) ? row.boroughs.map(String).filter(Boolean) : [],
    hasContact: row?.has_contact === true
  })).filter((row) => row.entityId && row.name);
}

export function rankBuyerIntelRows(rows, rankBy = "count") {
  const volumeFirst = rankBy === "volume" || rankBy === "vol";
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const primary = volumeFirst
      ? (Number(b.volume) || 0) - (Number(a.volume) || 0)
      : (Number(b.dealCount) || 0) - (Number(a.dealCount) || 0);
    if (primary) return primary;
    const secondary = volumeFirst
      ? (Number(b.dealCount) || 0) - (Number(a.dealCount) || 0)
      : (Number(b.volume) || 0) - (Number(a.volume) || 0);
    if (secondary) return secondary;
    const latest = String(b.lastDeal || "").localeCompare(String(a.lastDeal || ""));
    if (latest) return latest;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

export function normalizeBuyerIntelHistory(payload, { borough = null, assetType = null } = {}) {
  const sourceEntity = payload?.entity && typeof payload.entity === "object" ? payload.entity : null;
  const entityId = cleanBuyerIntelEntityId(sourceEntity?.entity_id);
  const entity = entityId && String(sourceEntity?.display_name ?? "").trim() ? {
    entityId,
    name: String(sourceEntity.display_name).trim(),
    entityType: sourceEntity.entity_type ? String(sourceEntity.entity_type) : null,
    isSpvSuspect: sourceEntity.is_spv_suspect === true
  } : null;
  const transactions = [];
  for (const row of Array.isArray(payload?.deals) ? payload.deals : []) {
    if (String(row?.role ?? "").toLowerCase() !== "buyer") continue;
    const rowBorough = String(row?.borough ?? "").trim() || null;
    const rowAssetType = String(row?.asset_type ?? "").trim() || null;
    if (borough && rowBorough !== borough) continue;
    if (assetType && rowAssetType !== assetType) continue;
    const transaction = {
      saleDate: row?.sale_date ? String(row.sale_date).slice(0, 10) : null,
      address: String(row?.address ?? "").trim() || null,
      borough: rowBorough,
      assetType: rowAssetType,
      salePrice: finiteOrNull(row?.sale_price),
      sourceUrl: String(row?.source_url ?? "").trim() || null
    };
    transactions.push(transaction);
  }
  transactions.sort((a, b) => {
    const dateOrder = String(b.saleDate || "").localeCompare(String(a.saleDate || ""));
    if (dateOrder) return dateOrder;
    const priceOrder = (Number(b.salePrice) || 0) - (Number(a.salePrice) || 0);
    if (priceOrder) return priceOrder;
    return String(a.address || "").localeCompare(String(b.address || ""));
  });
  const priced = transactions.filter((row) => row.salePrice !== null);
  return {
    entity,
    transactions,
    summary: {
      transactionCount: transactions.length,
      addressedTransactions: transactions.filter((row) => row.address).length,
      datedTransactions: transactions.filter((row) => row.saleDate).length,
      pricedTransactions: priced.length,
      sourcedTransactions: transactions.filter((row) => row.sourceUrl).length,
      recordedVolume: priced.reduce((sum, row) => sum + row.salePrice, 0)
    }
  };
}

export function buyerIntelRpcBody({
  borough = null,
  assetType = null,
  priceMin = null,
  priceMax = null,
  dateMin = null,
  minDeals = 1,
  rankBy = "count",
  limit = 60
} = {}) {
  return {
    borough: borough || null,
    asset_type: assetType || null,
    price_min: finiteOrNull(priceMin),
    price_max: finiteOrNull(priceMax),
    date_min: dateMin || null,
    min_deals: Math.min(50, Math.max(1, Number.parseInt(minDeals, 10) || 1)),
    rank_by: rankBy === "volume" || rankBy === "vol" ? "vol" : "count",
    lim: Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 60))
  };
}
