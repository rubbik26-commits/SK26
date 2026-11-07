// Official geometry adapters used by the exact production map experience.
// Tax-lot polygons: NYC DCP MapPLUTO Public ArcGIS FeatureServer.
// Building polygons: NYC Open Data BUILDING (5zhs-2jue). This was 3g6p-4u5s,
// which is retired and answers HTTP 200 with every row emptied to `{}`, so a
// within_box(the_geom, ...) filter fails with `no-such-column: the_geom`.
// No record is synthesized here: callers receive real source geometry or an
// explicit live:false/error result.

// The City's own MapPLUTO service, which is the one the original draws the lot
// grid from — it says so in its response header: `x-lot-source: NYC DCP
// MapPLUTO (ArcGIS FeatureServer)`.
//
// This pointed at a third-party copy on a different ArcGIS Online org
// (QygLi7lRn9WflKMX, item title "MapPLUTO_Public"), kept below as the record of
// what was replaced and why. Measured 2026-08-18, `where=1=1&returnCountOnly`:
//   QygLi7lRn9WflKMX/MapPLUTO_Public     34,138 features
//   GfwWNkhOj9bNBqoJ/MAPPLUTO           856,614 features
// NYC has roughly 860,000 tax lots, so the old service carried about 4% of the
// city. That is what made the lot grid draw almost nothing where it drew
// anything at all, and it is why /api/lot-tiles had been rerouted onto the DOF
// Digital Tax Map instead — a source whose condo BASE lots do not join to
// PLUTO's condo BILLING BBLs, so 38 of every 177 lots in a Midtown tile came
// back with a blank address, owner, class and zoning.
// const MAPPLUTO_QUERY_SUPERSEDED = "https://services5.arcgis.com/QygLi7lRn9WflKMX/arcgis/rest/services/MapPLUTO_Public/FeatureServer/0/query";
const MAPPLUTO_QUERY = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
const BUILDING_API = "https://data.cityofnewyork.us/resource/5zhs-2jue.json";
const APP_TOKEN = process.env.NYC_OPEN_DATA_APP_TOKEN || process.env.SOCRATA_APP_TOKEN || "";

const memory = new Map();
const DEFAULT_TTL = 10 * 60 * 1000;
const MAX_CACHE = 500;

function cacheGet(key) {
  const hit = memory.get(key);
  if (!hit || hit.expires <= Date.now()) { if (hit) memory.delete(key); return null; }
  return hit.value;
}
function cachePut(key, value, ttl = DEFAULT_TTL) {
  if (memory.size >= MAX_CACHE) {
    const first = memory.keys().next().value;
    if (first) memory.delete(first);
  }
  memory.set(key, { value, expires: Date.now() + ttl });
  return value;
}

async function fetchJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, {
          signal: controller.signal,
          headers: { "user-agent": "nyc-re-market-intel/production", ...headers }
        });
        if (!r.ok) {
          const body = await r.text().catch(() => "");
          const e = new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 250)}` : ""}`);
          e.status = r.status;
          throw e;
        }
        return await r.json();
      } catch (e) {
        last = e;
        if (attempt === 0 && !controller.signal.aborted && (!e.status || e.status >= 500 || e.status === 429)) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        throw e;
      }
    }
    throw last;
  } finally {
    clearTimeout(timer);
  }
}

function cleanBbl(v) {
  const digits = String(v ?? "").replace(/\..*$/, "").replace(/[^0-9]/g, "");
  return digits.length === 10 ? digits : "";
}
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const s = (v) => v == null ? "" : String(v).trim();

export function tileBounds(z, x, y) {
  const tiles = 2 ** z;
  const lng = (tx) => tx / tiles * 360 - 180;
  const lat = (ty) => {
    const a = Math.PI - (2 * Math.PI * ty) / tiles;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(a) - Math.exp(-a)));
  };
  return {
    minLng: lng(x), maxLng: lng(x + 1),
    maxLat: lat(y), minLat: lat(y + 1)
  };
}

const LOT_FIELDS = [
  "Borough","Block","Lot","ZipCode","Address","ZoneDist1","ZoneDist2","ZoneDist3","ZoneDist4",
  "Overlay1","Overlay2","SPDist1","SPDist2","SPDist3","LtdHeight","SplitZone","BldgClass","LandUse",
  "OwnerType","OwnerName","LotArea","BldgArea","ComArea","ResArea","OfficeArea","RetailArea","GarageArea",
  "StrgeArea","FactryArea","OtherArea","NumBldgs","NumFloors","UnitsRes","UnitsTotal","LotFront","LotDepth",
  "BldgFront","BldgDepth","AssessLand","AssessTot","ExemptTot","YearBuilt","YearAlter1","YearAlter2","HistDist",
  "Landmark","BuiltFAR","ResidFAR","CommFAR","FacilFAR","BoroCode","BBL","CondoNo","ZoneMap","EDesigNum",
  "APPBBL","APPDate","Version","Latitude","Longitude"
].join(",");

async function mapPlutoQuery(params, { ttl = DEFAULT_TTL } = {}) {
  const p = new URLSearchParams({
    f: "geojson",
    where: "1=1",
    outFields: LOT_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    ...params
  });
  const key = `mp:${p}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const body = await fetchJson(`${MAPPLUTO_QUERY}?${p}`);
    if (body?.error) throw new Error(body.error.message || "MapPLUTO query failed");
    return cachePut(key, { live: true, features: Array.isArray(body?.features) ? body.features : [], source: "NYC DCP MapPLUTO Public" }, ttl);
  } catch (e) {
    return { live: false, features: [], source: "NYC DCP MapPLUTO Public", error: String(e?.message ?? e) };
  }
}

export async function mapPlutoByBbl(bbl) {
  const digits = cleanBbl(bbl);
  if (!digits) return { live: false, features: [], error: "invalid bbl" };
  return mapPlutoQuery({ where: `BBL=${Number(digits)}`, resultRecordCount: "2" }, { ttl: 30 * 60 * 1000 });
}

export async function mapPlutoAtPoint(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { live: false, features: [], error: "invalid coordinates" };
  return mapPlutoQuery({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: "5"
  });
}

// Ray casting, on the ring the caller actually gets back.
//
// WHY THIS EXISTS
// /api/lot-at answers "which lot did I just click on". Its fallback searched a
// PLUTO bounding box and returned the lot with the NEAREST CENTROID, which is a
// different question: on a long narrow lot, or standing near a shared lot line,
// the nearest centroid frequently belongs to the neighbour. A click resolving to
// the wrong parcel puts the wrong owner, the wrong debt and the wrong dossier on
// screen with no indication anything is off.
//
// mapPlutoAtPoint asks the ArcGIS service to do this server-side, which is
// exact when it answers — but it returns zero features for coordinates that
// resolve fine otherwise (checked against the Empire State Building's own
// centroid). So containment is also computed here, locally, against the
// geometry the bbox query returns.
//
// Handles both GeoJSON Polygon and MultiPolygon, and honours interior rings: a
// point inside a hole is outside the lot.
function ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function geometryContains(geometry, lng, lat) {
  if (!geometry) return false;
  const polys = geometry.type === "MultiPolygon" ? geometry.coordinates
    : geometry.type === "Polygon" ? [geometry.coordinates]
      : [];
  for (const poly of polys) {
    if (!poly?.length) continue;
    if (!ringContains(poly[0], lng, lat)) continue;
    // Outer ring contains it; a hole would take it back out.
    let inHole = false;
    for (let r = 1; r < poly.length; r++) if (ringContains(poly[r], lng, lat)) { inHole = true; break; }
    if (!inHole) return true;
  }
  return false;
}

export async function mapPlutoBbox(minLat, minLng, maxLat, maxLng, limit = 2000) {
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return { live: false, features: [], error: "invalid bbox" };
  return mapPlutoQuery({
    geometry: `${minLng},${minLat},${maxLng},${maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultRecordCount: String(Math.min(2000, Math.max(1, limit)))
  });
}

export async function mapPlutoTile(z, x, y) {
  const b = tileBounds(z, x, y);
  return mapPlutoBbox(b.minLat, b.minLng, b.maxLat, b.maxLng, 2000);
}

// Every lot intersecting a tile, paged.
//
// The service caps a response at 2,000 features, and a z14 tile over Midtown
// holds 4,653 — so a single request silently returns a partial tile, which is
// the failure mode this whole file exists to avoid. Pages with resultOffset
// until a short page comes back, and reports `complete:false` rather than
// handing a caller a tile that looks whole.
export async function mapPlutoTileAll(z, x, y, { pageSize = 2000, maxRows = 20000 } = {}) {
  const b = tileBounds(z, x, y);
  if (![b.minLat, b.minLng, b.maxLat, b.maxLng].every(Number.isFinite)) {
    return { live: false, complete: false, features: [], error: "invalid tile" };
  }
  const envelope = {
    geometry: `${b.minLng},${b.minLat},${b.maxLng},${b.maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    // Intersects, not contains. The service's default for an envelope filter on
    // a polygon layer returns only lots lying WHOLLY inside it, which drops
    // every lot straddling a tile edge — measured on 16/19298/24633:
    // contains 177, intersects 238, and the original serves 238.
    spatialRel: "esriSpatialRelIntersects"
  };
  const features = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const r = await mapPlutoQuery({
      ...envelope,
      resultRecordCount: String(pageSize),
      resultOffset: String(offset)
    }, { ttl: 24 * 3600e3 });
    if (!r.live) return { live: false, complete: false, features: [], error: r.error };
    features.push(...r.features);
    if (r.features.length < pageSize) return { live: true, complete: true, features, source: r.source };
  }
  return { live: true, complete: false, features, source: "NYC DCP MapPLUTO", error: `tile exceeded ${maxRows} lots` };
}

export function mapPlutoProperties(attrs = {}) {
  const maxFar = Math.max(n(attrs.ResidFAR) || 0, n(attrs.CommFAR) || 0, n(attrs.FacilFAR) || 0);
  const builtFar = n(attrs.BuiltFAR) || 0;
  const lotArea = n(attrs.LotArea) || 0;
  const bbl = cleanBbl(attrs.BBL) || `${n(attrs.BoroCode) || ""}${String(n(attrs.Block) || "").padStart(5,"0")}${String(n(attrs.Lot) || "").padStart(4,"0")}`;
  const unusedFar = Math.max(0, maxFar - builtFar);
  return {
    bbl,
    address: s(attrs.Address), owner: s(attrs.OwnerName), ownerType: s(attrs.OwnerType),
    borough: s(attrs.Borough), block: n(attrs.Block), lot: n(attrs.Lot), zip: s(attrs.ZipCode),
    zoning: s(attrs.ZoneDist1), zoneDist1: s(attrs.ZoneDist1), zoneDist2: s(attrs.ZoneDist2), zoneDist3: s(attrs.ZoneDist3), zoneDist4: s(attrs.ZoneDist4),
    overlay: s(attrs.Overlay1), overlay2: s(attrs.Overlay2), specialDistrict: s(attrs.SPDist1), specialDistrict2: s(attrs.SPDist2), specialDistrict3: s(attrs.SPDist3),
    bldgClass: s(attrs.BldgClass), landUse: s(attrs.LandUse).padStart(2,"0"),
    units: n(attrs.UnitsTotal) || 0, unitsRes: n(attrs.UnitsRes) || 0, yearBuilt: n(attrs.YearBuilt),
    yearAltered: n(attrs.YearAlter1) || n(attrs.YearAlter2), floors: n(attrs.NumFloors) || 0,
    numBldgs: n(attrs.NumBldgs) || 0,
    lotArea, bldgArea: n(attrs.BldgArea) || 0, resArea: n(attrs.ResArea) || 0, comArea: n(attrs.ComArea) || 0,
    officeArea: n(attrs.OfficeArea) || 0, retailArea: n(attrs.RetailArea) || 0, garageArea: n(attrs.GarageArea) || 0,
    storageArea: n(attrs.StrgeArea) || 0, factoryArea: n(attrs.FactryArea) || 0, otherArea: n(attrs.OtherArea) || 0,
    builtFar, maxResidFar: n(attrs.ResidFAR), maxCommFar: n(attrs.CommFAR), maxFacilFar: n(attrs.FacilFAR), maxFar,
    unusedFar: Math.round(unusedFar * 100) / 100, unusedFarSf: Math.round(unusedFar * lotArea),
    assessedLand: n(attrs.AssessLand), assessedTotal: n(attrs.AssessTot), exemptTotal: n(attrs.ExemptTot),
    lotFront: n(attrs.LotFront), lotDepth: n(attrs.LotDepth), bldgFront: n(attrs.BldgFront), bldgDepth: n(attrs.BldgDepth),
    landmark: s(attrs.Landmark), histDist: s(attrs.HistDist), eDesig: s(attrs.EDesigNum), splitZone: s(attrs.SplitZone) === "Y", ltdHeight: s(attrs.LtdHeight),
    zoneMap: s(attrs.ZoneMap), condoNo: n(attrs.CondoNo), appBbl: cleanBbl(attrs.APPBBL), appDate: s(attrs.APPDate),
    lat: n(attrs.Latitude), lng: n(attrs.Longitude), version: s(attrs.Version),
    provenance: "live", source: "NYC DCP MapPLUTO Public"
  };
}

export function normalizeMapPlutoFeature(feature) {
  return {
    type: "Feature",
    geometry: feature?.geometry ?? null,
    properties: mapPlutoProperties(feature?.properties ?? {})
  };
}

async function buildingQuery(where, { limit = 800, ttl = DEFAULT_TTL } = {}) {
  const p = new URLSearchParams({ $where: where, $limit: String(Math.min(2000, Math.max(1, limit))) });
  const key = `bld:${p}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const headers = APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {};
    const rows = await fetchJson(`${BUILDING_API}?${p}`, { timeoutMs: 20000, headers });
    return cachePut(key, { live: true, rows: Array.isArray(rows) ? rows : [], source: "NYC Open Data BUILDING 5zhs-2jue" }, ttl);
  } catch (e) {
    return { live: false, rows: [], source: "NYC Open Data BUILDING 5zhs-2jue", error: String(e?.message ?? e) };
  }
}

export async function buildingFootprintsBbox(minLat, minLng, maxLat, maxLng, limit = 900) {
  if (![minLat, minLng, maxLat, maxLng].every(Number.isFinite)) return { live: false, rows: [], error: "invalid bbox" };
  return buildingQuery(`within_box(the_geom,${maxLat},${minLng},${minLat},${maxLng})`, { limit });
}

export async function buildingFootprintsTile(z, x, y) {
  const b = tileBounds(z, x, y);
  return buildingFootprintsBbox(b.minLat, b.minLng, b.maxLat, b.maxLng, 1200);
}

function firstValue(row, ...keys) {
  for (const k of keys) if (row?.[k] != null) return row[k];
  return null;
}
export function buildingFootprintFeature(row) {
  const geom = firstValue(row, "the_geom", "the_geom_1", "geometry");
  // base_bbl, not mappluto_bbl. Measured on tile 16/19298/24633 by joining the
  // original's 244 published features to 5zhs-2jue on bin: the original's `bbl`
  // equals base_bbl on 244/244 rows and mappluto_bbl on only 199/244 — the 45
  // that differ are condo lots, where mappluto_bbl carries the billing BBL and
  // base_bbl the base lot. mappluto_bbl is still read as the fallback so a row
  // that carries only that column still resolves.
  const rawBbl = firstValue(row, "base_bbl", "mappluto_bbl", "mpluto_bbl", "map_pluto_bbl");
  const bbl = cleanBbl(rawBbl);
  // Absent must stay absent. n() alone cannot express that: Number(null) is 0
  // and 0 is finite, so n(firstValue(row, ...)) turned "this row carries no
  // height / no construction year" into a measured 0. That is what published
  // yr:0 for the 3 features of tile 16/19298/24633 whose 5zhs-2jue row has no
  // construction_year, where the original publishes yr:null. The raw value is
  // read first and only converted when the column is actually present.
  const rawRoofFt = firstValue(row, "height_roof", "heightroof");
  const roofFt = rawRoofFt == null ? null : n(rawRoofFt);
  const rawYr = firstValue(row, "construction_year", "cnstrct_yr", "CNSTRCT_YR");
  return {
    type: "Feature",
    geometry: geom && typeof geom === "object" ? geom : null,
    properties: {
      bbl,
      bin: s(firstValue(row, "bin", "BIN")),
      // Metres to one decimal, with no floor. The original publishes h:0 for
      // bin 1084663 (height_roof 0) inside tile 16/19298/24633; clamping to a
      // minimum of 1 invented a metre of height for every unmeasured roof.
      // round(height_roof * 0.3048, 1dp) reproduces the original on 244/244
      // features of that tile.
      h: roofFt != null ? Math.round(roofFt * 0.3048 * 10) / 10 : null,
      heightRoofFt: roofFt,
      // yr is part of the original's bldg-tile feature properties — the footprint
      // record's construction year. The column on 5zhs-2jue is
      // `construction_year`; `cnstrct_yr` is the older MapPLUTO-era name and is
      // absent from every row, so every tile published yr:0 where the original
      // publishes 1853. Both names are read, current one first.
      yr: rawYr == null ? null : n(rawYr),
      provenance: "live",
      source: "NYC Open Data BUILDING 5zhs-2jue"
    }
  };
}
