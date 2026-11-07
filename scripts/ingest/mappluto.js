// MapPLUTO → parcels. Pulls tax-lot polygons + attributes from the NYC Dept
// of City Planning MapPLUTO FeatureServer and upserts them through the
// service-only ingest_parcels RPC.
//
// Usage:
//   node scripts/ingest/mappluto.js --zips=10001,10011
//   node scripts/ingest/mappluto.js --borough=MN
//   node scripts/ingest/mappluto.js --limit=5000   # explicit dev/test cap
import { requireStore, rpc, args, zipsOf, chunked, sleep, strictComplete } from "./lib.js";

export const ARCGIS = "https://services5.arcgis.com/GfwWNkhOj9bNBqoJ/arcgis/rest/services/MAPPLUTO/FeatureServer/0/query";
const PAGE = 1000;
export const FIELDS = [
  "BBL", "Borough", "Block", "Lot", "Address", "ZipCode", "OwnerName", "BldgClass", "LandUse",
  "ZoneDist1", "LotArea", "BldgArea", "BuiltFAR", "ResidFAR", "CommFAR", "FacilFAR", "NumFloors",
  "UnitsRes", "UnitsTotal", "YearBuilt", "AssessLand", "AssessTot", "Latitude", "Longitude"
];

function whereClause(a) {
  const zips = zipsOf(a);
  if (zips.length) return `ZipCode IN (${zips.join(",")})`;
  if (a.borough) return `Borough='${String(a.borough).replace(/[^A-Z0-9 ]/gi, "").toUpperCase()}'`;
  if (a.where) return String(a.where);
  return "1=1";
}

async function sourceCount(where) {
  const url = `${ARCGIS}?where=${encodeURIComponent(where)}&returnCountOnly=true&f=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`MapPLUTO count HTTP ${r.status}`);
  const body = await r.json();
  const count = Number(body?.count);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`MapPLUTO count response was not a valid integer: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return count;
}

export function featureToRow(f) {
  const p = f.properties ?? {};
  const attrs = {};
  for (const [k, v] of Object.entries(p)) attrs[k.toLowerCase()] = v == null ? null : String(v);
  const bbl = String(p.BBL ?? "").replace(/\..*$/, "");
  return {
    bbl,
    block: p.Block ?? null,
    lot: p.Lot ?? null,
    address: p.Address ?? null,
    zipcode: p.ZipCode != null ? String(p.ZipCode) : null,
    owner_name: p.OwnerName ?? null,
    bldg_class: p.BldgClass ?? null,
    land_use: p.LandUse != null ? String(parseInt(p.LandUse, 10)) : null,
    zoning: p.ZoneDist1 ?? null,
    lot_area: p.LotArea ?? null,
    bldg_area: p.BldgArea ?? null,
    built_far: p.BuiltFAR ?? null,
    resid_far: p.ResidFAR ?? null,
    comm_far: p.CommFAR ?? null,
    facil_far: p.FacilFAR ?? null,
    num_floors: p.NumFloors ?? null,
    units_res: p.UnitsRes ?? null,
    units_total: p.UnitsTotal ?? null,
    year_built: p.YearBuilt ?? null,
    assess_land: p.AssessLand ?? null,
    assess_total: p.AssessTot ?? null,
    lat: p.Latitude ?? null,
    lng: p.Longitude ?? null,
    attrs,
    geom: f.geometry ?? null
  };
}

export async function ingestMapPluto(a) {
  const where = whereClause(a);
  const parsedLimit = Number.parseInt(a.limit, 10);
  const hardLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : Infinity;
  const expected = await sourceCount(where);
  const captureExactBbls = Boolean(a.zips || a.borough || a.where || Number.isFinite(hardLimit));
  const exactBbls = captureExactBbls ? [] : null;
  const fullSyncId = strictComplete(a) ? String(a.__fullSyncId || "") : "";
  if (strictComplete(a) && !/^[0-9a-f-]{36}$/i.test(fullSyncId)) {
    throw new Error("Strict MapPLUTO ingest requires a full-sync UUID from run-all.");
  }

  let offset = 0;
  let total = 0;
  let seenFeatures = 0;
  let invalidBbls = 0;

  for (;;) {
    const remaining = Number.isFinite(hardLimit) ? hardLimit - seenFeatures : PAGE;
    if (remaining <= 0) break;
    const requestCount = Math.min(PAGE, remaining);
    const url = `${ARCGIS}?where=${encodeURIComponent(where)}&outFields=${FIELDS.join(",")}` +
      `&orderByFields=${encodeURIComponent("BBL ASC")}` +
      `&resultOffset=${offset}&resultRecordCount=${requestCount}&outSR=4326&f=geojson`;
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`MapPLUTO FeatureServer HTTP ${r.status}`);
    const page = await r.json();
    if (!Array.isArray(page.features)) {
      throw new Error(`MapPLUTO FeatureServer returned no features array: ${JSON.stringify(page).slice(0, 300)}`);
    }
    const feats = page.features;
    if (!feats.length) break;

    seenFeatures += feats.length;
    const projected = feats.map(featureToRow);
    const rows = projected.filter((x) => /^[1-5]\d{9}$/.test(x.bbl));
    invalidBbls += projected.length - rows.length;
    if (exactBbls) exactBbls.push(...rows.map((x) => x.bbl));

    for (const batch of chunked(rows, 200)) {
      const n = Number(await rpc("ingest_parcels", { p_rows: batch })) || 0;
      if (n !== batch.length) {
        throw new Error(`MapPLUTO ingest RPC count mismatch: batch=${batch.length}, upserted=${n}`);
      }
      if (fullSyncId) {
        const marked = Number(await rpc("mark_parcel_full_sync", {
          p_bbls: batch.map((x) => x.bbl),
          p_full_sync_id: fullSyncId
        })) || 0;
        if (marked !== batch.length) {
          throw new Error(`MapPLUTO full-sync marking mismatch: batch=${batch.length}, marked=${marked}`);
        }
      }
      total += n;
    }
    console.log(`[mappluto] ${total} parcels upserted (${seenFeatures}/${Number.isFinite(hardLimit) ? Math.min(expected, hardLimit) : expected} source features)`);

    offset += feats.length;
    if (Number.isFinite(hardLimit) && seenFeatures >= hardLimit) break;
    if (feats.length < requestCount) break;
    await sleep(150);
  }

  if (!Number.isFinite(hardLimit)) {
    if (seenFeatures !== expected) {
      throw new Error(`MapPLUTO incomplete traversal: source count=${expected}, traversed=${seenFeatures}`);
    }
    if (invalidBbls > 0 || total !== seenFeatures) {
      throw new Error(`MapPLUTO completeness failure: traversed=${seenFeatures}, valid/upserted=${total}, invalid BBL rows=${invalidBbls}`);
    }
  }

  if (exactBbls) a.__ingestedBbls = [...new Set(exactBbls)];
  a.__mapPlutoMeta = {
    where,
    sourceCount: expected,
    traversed: seenFeatures,
    upserted: total,
    invalidBbls,
    bounded: Number.isFinite(hardLimit),
    fullSyncId: fullSyncId || null,
    exactBblCount: exactBbls ? a.__ingestedBbls.length : null
  };

  console.log(`[mappluto] done — ${total} parcels (source count ${expected}; where: ${where}; ${Number.isFinite(hardLimit) ? `explicit cap ${hardLimit}` : "complete source traversal verified"})`);
  return total;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireStore();
  ingestMapPluto(args()).catch((e) => { console.error(e); process.exit(1); });
}
