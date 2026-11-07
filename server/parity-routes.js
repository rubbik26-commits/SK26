// Observable-contract parity routes for the exact production frontend.
//
// These handlers sit in front of the legacy/demo router and fill the remaining
// places where the shipped frontend expects live NYC records but the clean-room
// reconstruction still answered from the seeded city model. Every response in
// this file is built from public records; if an upstream source is unavailable
// we return an explicit unavailable state rather than manufacturing a record.
import { Router } from "express";
import { soql, escSoql } from "./adapters/socrata.js";
import {
  DS, plutoByZips, plutoBbox, plutoRowToBuilding, rollingSalesByZips,
  dobNowByZips, parseSalesNum
} from "./adapters/nyc.js";
import { mapPlutoTileAll, mapPlutoProperties } from "./adapters/mappluto.js";
import { liveBuilding, liveMarket, liveMaturityWall } from "./live.js";
import { computePropensity } from "./scoring.js";
import { TERRITORIES } from "./territories.js";
import { meterBump } from "./routes.js";

const router = Router();
const TAX_LOT_POLYGONS = "i38t-6if2"; // DOF Digital Tax Map TAX_LOT_POLYGON
// NYC planimetric BUILDING.
//
// This was "3g6p-4u5s", which is a retired dataset that fails in the worst
// possible way: it still answers HTTP 200, but every row comes back as `{}` —
// the columns are gone. A `within_box(the_geom, ...)` filter against it returns
// `no-such-column: the_geom`, so /api/footprints answered 503 and
// /api/bldg-tiles (the 3D City extrusions) had nothing to draw. Verified by
// hand against Socrata: `3g6p-4u5s.json?$limit=2` → `[{},{}]`.
//
// 5zhs-2jue is the live one and carries the columns this file already reads:
// the_geom, base_bbl, mappluto_bbl, bin, height_roof, construction_year.
const BUILDING_FOOTPRINTS = "5zhs-2jue";
const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const day = (v) => v ? String(v).slice(0, 10) : null;
const digits = (v) => String(v ?? "").replace(/[^0-9]/g, "");
const median = (a) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
const avg = (a) => a.length ? a.reduce((n, v) => n + v, 0) / a.length : null;

function unavailable(res, source, detail) {
  return res.status(503).json({ provenance: "unavailable", error: "live_source_unavailable", source, detail: detail || undefined });
}
function bblFromParts(boro, block, lot) {
  const b = digits(boro).slice(-1), bl = digits(block), l = digits(lot);
  return b && bl && l ? `${b}${bl.padStart(5, "0")}${l.padStart(4, "0")}` : null;
}
function rowBbl(r) {
  for (const k of ["bbl", "base_bbl", "map_pluto_bbl", "mapplutobbl", "map_bbl", "billbbl"]) {
    const d = digits(r?.[k]);
    if (d.length === 10) return d;
  }
  return bblFromParts(r?.borough ?? r?.boro ?? r?.borocode ?? r?.boro_code, r?.block ?? r?.tax_block, r?.lot ?? r?.tax_lot);
}
function modeForClass(cls, unitsRes = 0) {
  const c = String(cls || "").toUpperCase().slice(0, 1);
  if ((c === "C" || c === "D") && unitsRes >= 5) return "multifamily";
  if (c === "A" || c === "B") return "smallresi";
  if (c === "O") return "office";
  if (c === "K") return "retail";
  if (["E", "F", "L"].includes(c)) return "industrial";
  if (["V", "Z", "G"].includes(c)) return "development";
  if (c === "H") return "hotels";
  if (c === "R") return "condo";
  return "misc";
}
function modeLabel(mode) {
  return {
    multifamily: "Multifamily (5+ units)", smallresi: "1–4 family / townhouse",
    office: "Office", retail: "Retail / storefront", industrial: "Industrial / warehouse",
    development: "Development / land", hotels: "Hotel", condo: "Condo units", misc: "Other"
  }[mode] || mode;
}
function territoryLabelForZip(zip) {
  const hit = TERRITORIES.find((t) => Array.isArray(t.zips) && t.zips.includes(String(zip)));
  return hit?.label ? `${hit.label} / ${zip}` : `ZIP ${zip}`;
}
function qualifies(b, mode) {
  const c = String(b.bldgClass || "").slice(0, 1).toUpperCase();
  if (mode === "multifamily") return (c === "C" || c === "D") && (b.unitsRes || 0) >= 20;
  if (mode === "condo") return c === "R";
  if (mode === "office") return c === "O";
  if (mode === "hotels") return c === "H";
  if (mode === "development") return (b.builtFar || 0) < 1.5 && (b.maxFar || 0) >= 3;
  if (mode === "misc") return !["C", "D", "R", "O", "H"].includes(c);
  return true;
}
function saleMode(s) {
  const cls = String(s.building_class_at_present || "").toUpperCase();
  const units = num(s.residential_units);
  return modeForClass(cls, units);
}
function saleObject(s) {
  const price = num(s.sale_price), gsf = parseSalesNum(s.gross_square_feet), land = parseSalesNum(s.land_square_feet);
  return {
    bbl: bblFromParts(s.borough, s.block, s.lot),
    address: s.address || "—", saleDate: day(s.sale_date), salePrice: price,
    bldgClass: s.building_class_at_present || "", gsf: gsf || null, landSf: land || null,
    units: num(s.residential_units) || null, zip: String(s.zip_code || ""),
    ppsf: gsf && price ? Math.round(price / gsf) : null
  };
}

// ---------------------------------------------------------------- owner portfolio
// The exact bundle calls this endpoint with ?owner=, not ?bbl=.
router.get("/api/owner-portfolio", async (req, res, next) => {
  const owner = String(req.query.owner || "").trim();
  if (!owner) return next();
  try {
    const r = await soql(DS.pluto, {
      $select: "bbl,address,bldgclass,unitsres,zipcode,bldgarea,ownername",
      $where: `upper(ownername)=upper('${escSoql(owner)}')`,
      $order: "bldgarea DESC", $limit: 500
    });
    if (!r.live) return unavailable(res, "PLUTO", r.error);
    const sample = r.rows.map((x) => ({
      bbl: digits(x.bbl), address: x.address || "—", bldgClass: x.bldgclass || "",
      unitsRes: num(x.unitsres), zip: String(x.zipcode || ""), bldgArea: num(x.bldgarea)
    })).filter((x) => x.bbl.length === 10);
    return res.json({
      provenance: "live", owner, total: sample.length,
      units: sample.reduce((n, x) => n + x.unitsRes, 0), sample
    });
  } catch (e) { return unavailable(res, "PLUTO", e?.message); }
});

// ---------------------------------------------------------------- real territory intelligence
router.get("/api/territory", async (req, res, next) => {
  const zips = String(req.query.zips || "").split(",").map((z) => z.trim()).filter(Boolean);
  if (!zips.length) return next();
  const mode = String(req.query.mode || "multifamily");
  try {
    const [plu, saleR] = await Promise.all([
      plutoByZips(zips, { limit: 5000, order: "bldgarea DESC" }),
      rollingSalesByZips(zips, { limit: 1200 })
    ]);
    if (!plu.live || !saleR.live) return unavailable(res, !plu.live ? "PLUTO" : "DOF Rolling Sales", !plu.live ? plu.error : saleR.error);
    const all = plu.rows.map(plutoRowToBuilding);
    const q = all.filter((b) => qualifies(b, mode));
    const sales = saleR.rows.filter((s) => num(s.sale_price) > 10000 && (mode === "misc" ? true : saleMode(s) === mode)).map(saleObject);
    const vals = sales.map((s) => mode === "development" ? (s.landSf ? s.salePrice / s.landSf : null) : s.ppsf).filter((v) => Number.isFinite(v) && v > 0);
    const ownerAgg = new Map();
    for (const b of all) {
      if (!b.owner) continue;
      const cur = ownerAgg.get(b.owner) || { name: b.owner, buildings: 0, units: 0 };
      cur.buildings += 1; cur.units += b.unitsRes || 0; ownerAgg.set(b.owner, cur);
    }
    const owners = [...ownerAgg.values()];
    const top = [...q].sort((a, b) => mode === "development"
      ? (b.unusedFarSf || 0) - (a.unusedFarSf || 0)
      : mode === "office" || mode === "misc" ? (b.bldgArea || 0) - (a.bldgArea || 0)
        : mode === "hotels" ? (b.unitsTotal || 0) - (a.unitsTotal || 0)
          : (b.unitsRes || 0) - (a.unitsRes || 0)).slice(0, 12);
    const totalUnits = q.reduce((n, b) => n + (mode === "hotels" ? b.unitsTotal || 0 : b.unitsRes || 0), 0);
    return res.json({
      provenance: "live", fetchedAt: new Date().toISOString(),
      census: {
        qualifyingCount: q.length, totalUnits,
        avgUnitsPerBldg: q.length ? Math.round(totalUnits / q.length) : 0,
        totalLots: all.length,
        topUnusedBuildableSf: top.reduce((n, b) => n + (b.unusedFarSf || 0), 0)
      },
      sales: {
        count: sales.length, medianPpsf: median(vals) ? Math.round(median(vals)) : null,
        avgPpsf: avg(vals) ? Math.round(avg(vals)) : null,
        metric: mode === "development" ? "$/land sf" : "$/sf",
        latestSaleDate: sales.map((s) => s.saleDate).filter(Boolean).sort().reverse()[0] || null
      },
      top: top.map((b) => ({ ...b, score: mode === "development" ? b.score : computePropensity(b).score })),
      ownersByBuildings: [...owners].sort((a, b) => b.buildings - a.buildings).slice(0, 15),
      ownersByUnits: [...owners].sort((a, b) => b.units - a.units).slice(0, 15)
    });
  } catch (e) { return unavailable(res, "NYC public records", e?.message); }
});

router.get("/api/area-detail", async (req, res, next) => {
  const zips = String(req.query.zips || "").split(",").map((z) => z.trim()).filter(Boolean);
  if (!zips.length) return next();
  const mode = String(req.query.mode || "multifamily"), kind = String(req.query.kind || "qualifying");
  const owner = String(req.query.owner || "").trim();
  try {
    if (kind === "sales") {
      const r = await rollingSalesByZips(zips, { limit: 1200 });
      if (!r.live) return unavailable(res, "DOF Rolling Sales", r.error);
      const sales = r.rows.filter((s) => num(s.sale_price) > 10000 && (mode === "misc" || saleMode(s) === mode)).map(saleObject).sort((a, b) => String(b.saleDate).localeCompare(String(a.saleDate)));
      return res.json({ provenance: "live", coverage: `${sales.length} recorded qualifying sales across ${zips.join(", ")}.`, sales, buildings: [] });
    }
    const r = await plutoByZips(zips, { limit: 5000, order: "bldgarea DESC" });
    if (!r.live) return unavailable(res, "PLUTO", r.error);
    let buildings = r.rows.map(plutoRowToBuilding).filter((b) => kind === "owner" ? b.owner === owner : qualifies(b, mode));
    buildings = buildings.sort((a, b) => mode === "development" ? (b.unusedFarSf || 0) - (a.unusedFarSf || 0) : (b.bldgArea || 0) - (a.bldgArea || 0)).slice(0, 500);
    return res.json({ provenance: "live", coverage: `${buildings.length} live PLUTO tax lots matched the selected lens.`, sales: [], buildings });
  } catch (e) { return unavailable(res, "NYC public records", e?.message); }
});

// ---------------------------------------------------------------- development pipeline
router.get("/api/pipeline", async (req, res, next) => {
  const zips = String(req.query.zips || "").split(",").map((z) => z.trim()).filter(Boolean);
  if (!zips.length) return next();
  try {
    const m = await liveMarket(zips);
    if (!m) return unavailable(res, "DOB NOW");
    const sites = (m.pipeline || []).filter((s) => /new building|foundation|demolition|nb|dm/i.test(`${s.kind} ${s.status}`)).slice(0, 80);
    return res.json({
      provenance: "live", windowMonths: 36, fetchedAt: new Date().toISOString(),
      counts: {
        newBuilding: sites.filter((s) => /new building|\bnb\b/i.test(s.kind)).length,
        foundation: sites.filter((s) => /foundation/i.test(`${s.kind} ${s.status}`)).length,
        demolition: sites.filter((s) => /demolition|\bdm\b/i.test(s.kind)).length,
        proposedUnits: sites.reduce((n, s) => n + (s.proposedUnits || 0), 0)
      }, sites
    });
  } catch (e) { return unavailable(res, "DOB NOW", e?.message); }
});

// ---------------------------------------------------------------- exact market-report contract
router.get("/api/market-report", async (req, res, next) => {
  const zips = String(req.query.zips || "").split(",").map((z) => z.trim()).filter(Boolean);
  if (!zips.length) return next();
  try {
    const [plu, saleR] = await Promise.all([
      plutoByZips(zips, { limit: 5000, order: "bldgarea DESC" }),
      rollingSalesByZips(zips, { limit: 1600 })
    ]);
    if (!plu.live || !saleR.live) return unavailable(res, !plu.live ? "PLUTO" : "DOF Rolling Sales", !plu.live ? plu.error : saleR.error);
    const stock = plu.rows.map(plutoRowToBuilding);
    const sales = saleR.rows.filter((s) => num(s.sale_price) > 10000);
    const modes = ["multifamily", "smallresi", "office", "retail", "industrial", "development", "hotels", "condo"];
    const byClass = modes.map((mode) => {
      const isStock = (b) => modeForClass(b.bldgClass, b.unitsRes || 0) === mode;
      const ss = sales.filter((s) => saleMode(s) === mode);
      const st = stock.filter(isStock);
      const prices = ss.map((s) => num(s.sale_price)).filter((v) => v > 0);
      const ppsfs = ss.map((s) => {
        const sf = mode === "development" ? parseSalesNum(s.land_square_feet) : parseSalesNum(s.gross_square_feet);
        return sf && num(s.sale_price) ? num(s.sale_price) / sf : null;
      }).filter((v) => Number.isFinite(v) && v > 0);
      const turnover = mode !== "condo" && st.length ? Math.round((ss.length / st.length) * 1000) / 10 : null;
      return {
        mode, class: modeLabel(mode), churn: mode === "condo", stock: st.length,
        salesCount: ss.length, dollarVolume: prices.reduce((n, v) => n + v, 0),
        avgPrice: avg(prices) ? Math.round(avg(prices)) : null,
        avgPpsf: avg(ppsfs) ? Math.round(avg(ppsfs)) : null,
        turnoverPct: turnover, impliedHoldYears: turnover ? Math.round(100 / turnover) : null
      };
    });
    const allPpsf = sales.map((s) => {
      const sf = parseSalesNum(s.gross_square_feet), price = num(s.sale_price);
      return sf && price ? price / sf : null;
    }).filter((v) => Number.isFinite(v) && v > 0);
    const bands = [0, 150, 300, 450, 600, 800, 1000, 1400, 2000];
    const distribution = bands.map((lo, i) => {
      const hi = bands[i + 1] ?? Infinity;
      return { label: hi === Infinity ? `$${lo}+` : `$${lo}–${hi}`, count: allPpsf.filter((v) => v >= lo && v < hi).length };
    }).filter((d) => d.count > 0);
    const start = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    return res.json({
      provenance: "live", fetchedAt: new Date().toISOString(), windowStart: start,
      windowEnd: new Date().toISOString().slice(0, 10), recordedTotal: sales.length,
      byClass, distribution,
      narrative: [
        `${sales.length} recorded sales with positive consideration were returned across ${zips.length} selected ZIP code${zips.length === 1 ? "" : "s"} for the trailing twelve-month file.`,
        `The live stock denominator contains ${stock.length} PLUTO tax lots in the selected geography.`,
        "Pricing metrics are calculated only where the public sale record supplies a usable gross or land square-foot denominator."
      ]
    });
  } catch (e) { return unavailable(res, "NYC public records", e?.message); }
});

// ---------------------------------------------------------------- exact Comps / Land Index contract
router.get("/api/market-index", async (_req, res) => {
  const markets = [
    { market: "Manhattan", zips: ["10001", "10011", "10016", "10019", "10002", "10025", "10028"] },
    { market: "Brooklyn", zips: ["11201", "11211", "11215", "11216", "11221", "11226"] },
    { market: "Queens", zips: ["11101", "11102", "11106", "11372", "11375", "11432"] }
  ];
  try {
    const fetched = await Promise.all(markets.map(async (m) => ({ ...m, result: await rollingSalesByZips(m.zips, { limit: 1800 }) })));
    const failed = fetched.find((m) => !m.result.live);
    if (failed) return unavailable(res, "DOF Rolling Sales", failed.result.error);
    const strategies = ["multifamily", "condo", "office", "hotels", "development"];
    const outMarkets = [], comps = [];
    for (const m of fetched) {
      const rows = m.result.rows.filter((s) => num(s.sale_price) > 10000);
      const entry = { market: m.market };
      for (const strategy of strategies) {
        const sr = rows.filter((s) => saleMode(s) === strategy);
        const groups = new Map();
        for (const s of sr) {
          const zip = String(s.zip_code || ""), price = num(s.sale_price);
          const land = parseSalesNum(s.land_square_feet), gsf = parseSalesNum(s.gross_square_feet);
          const denom = strategy === "development" ? land : gsf;
          if (!zip || !denom || !price) continue;
          const value = price / denom;
          const g = groups.get(zip) || { name: territoryLabelForZip(zip), values: [], count: 0, units: 0 };
          g.values.push(value); g.count += 1; g.units += num(s.residential_units); groups.set(zip, g);
        }
        entry[strategy] = {
          metric: strategy === "development" ? "$/land sf" : "$/sf",
          submarkets: [...groups.values()].map((g) => ({
            name: g.name, ppsf: Math.round(avg(g.values)), count: g.count, units: g.units || null
          })).sort((a, b) => b.count - a.count || b.ppsf - a.ppsf)
        };
        for (const s of sr) {
          const o = saleObject(s), price = o.salePrice;
          const ppbsf = strategy === "development" && o.landSf ? Math.round(price / o.landSf) : null;
          comps.push({
            address: o.address, market: m.market, submarket: territoryLabelForZip(o.zip),
            strategy: strategy === "hotels" ? "Hotels" : strategy[0].toUpperCase() + strategy.slice(1),
            type: s.building_class_category || s.building_class_at_present || "—",
            units: o.units, gsf: o.gsf, landSf: o.landSf, salePrice: price,
            ppsf: o.ppsf, ppbsf, saleDate: o.saleDate || "", bbl: o.bbl
          });
        }
      }
      outMarkets.push(entry);
    }
    comps.sort((a, b) => String(b.saleDate).localeCompare(String(a.saleDate)));
    // windowMonths is part of the original's market-index envelope (A/B diff
    // 2026-08-17); this layer serves when the earlier handlers fall through.
    return res.json({ provenance: "live", fetchedAt: new Date().toISOString(), windowMonths: 12, markets: outMarkets, comps: comps.slice(0, 120) });
  } catch (e) { return unavailable(res, "DOF Rolling Sales", e?.message); }
});

// ---------------------------------------------------------------- point lookups
async function nearestLive(lat, lng) {
  for (const d of [0.00035, 0.0008, 0.0018]) {
    const r = await plutoBbox(lat - d, lng - d, lat + d, lng + d, 80);
    if (!r.live) continue;
    const rows = r.rows.map(plutoRowToBuilding).filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lng));
    if (rows.length) return rows.sort((a, b) => ((a.lat - lat) ** 2 + (a.lng - lng) ** 2) - ((b.lat - lat) ** 2 + (b.lng - lng) ** 2))[0];
  }
  return null;
}
router.get("/api/lot-at", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat_lng_required" });
  const b = await nearestLive(lat, lng).catch(() => null);
  if (!b) return res.status(404).json({ error: "no_parcel_found", provenance: "unavailable" });
  return res.json({ provenance: "live", ...b });
});
router.get("/api/zip-at", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat_lng_required" });
  const b = await nearestLive(lat, lng).catch(() => null);
  return res.json({ provenance: b ? "live" : "unavailable", zip: b?.zip || null });
});

// ---------------------------------------------------------------- real geometry
function tileBbox(z, x, y) {
  const n = 2 ** z;
  const lng1 = x / n * 360 - 180, lng2 = (x + 1) / n * 360 - 180;
  const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { minLng: Math.min(lng1, lng2), maxLng: Math.max(lng1, lng2), minLat: Math.min(lat1, lat2), maxLat: Math.max(lat1, lat2) };
}
async function polygonRows(dataset, box, limit = 5000) {
  return soql(dataset, {
    $where: `within_box(the_geom,${box.maxLat},${box.minLng},${box.minLat},${box.maxLng})`,
    $limit: limit
  }, { ttlMs: 24 * 60 * 60 * 1000, timeoutMs: 30000 });
}
// The immutable lot-grid overlay draws Polygon geometry. The original's
// SUPERSEDED for lot tiles 2026-08-20 and kept per the no-removal rule: the
// 2026-08-18 measurement below was taken against DOF TAX_LOT_POLYGON geometry,
// but the original's own lot tiles ship MapPLUTO geometry UNFLATTENED —
// 16/19334/24603 is a single lot served as {"type":"MultiPolygon"} — so the
// largest-part conversion made that tile 13 KB short. The lot-tile handler now
// passes geometry through; nothing else references this function.
//
// Original note: lot-tiles emit `Polygon` (source "pluto"); the DOF
// TAX_LOT_POLYGON the_geom arrives as `MultiPolygon`, which the overlay canvas
// cannot paint — measured 2026-08-18: MultiPolygon tiles render 0/0 pixels
// while the original's Polygon tiles paint. Emit the largest polygon part as a
// single Polygon so each lot renders, matching the original's per-lot Polygon
// shape. (This restores rendering; the DOF-vs-PLUTO source count parity, 177 vs
// 238, is a separate open item.)
function toPolygonGeometry(geom) {
  if (!geom || typeof geom !== "object") return null;
  if (geom.type === "Polygon") return geom;
  if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates) && geom.coordinates.length) {
    const largest = geom.coordinates.reduce(
      (a, b) => ((b?.[0]?.length || 0) > (a?.[0]?.length || 0) ? b : a),
      geom.coordinates[0]
    );
    return Array.isArray(largest) ? { type: "Polygon", coordinates: largest } : null;
  }
  return null;
}
// The original publishes lot-tile coordinates rounded to 6 decimals — measured
// on 16/19298/24633 and 15/9649/12316: every original coordinate is 6-decimal
// (-73.992732) where this handler shipped the source's full precision
// (-73.9927317757529); the counts were already identical (238/238, 980/980) so
// precision was the only remaining diff (3,302 and 5,148 coordinate diffs).
// Math.round(v * 1e6) / 1e6, not Number(v.toFixed(6)): the two disagree only on
// an exact half at the 7th decimal, and on the building tiles that case was
// measured 3 times across 428,094 features — the original matched Math.round on
// all 3 and toFixed on none (commit 1e73a02).
const round6 = (v) => Math.round(v * 1e6) / 1e6;
// Rounds Polygon and MultiPolygon alike: recurse until the leaf pair.
const roundCoords = (c) =>
  Array.isArray(c) ? (typeof c[0] === "number" ? [round6(c[0]), round6(c[1])] : c.map(roundCoords)) : c;
function roundGeometry(geom) {
  if (!geom || !Array.isArray(geom.coordinates)) return geom;
  return { type: geom.type, coordinates: roundCoords(geom.coordinates) };
}
async function plutoMapForBox(box) {
  const r = await plutoBbox(box.minLat, box.minLng, box.maxLat, box.maxLng, 5000);
  if (!r.live) return { live: false, map: new Map(), error: r.error };
  return { live: true, map: new Map(r.rows.map(plutoRowToBuilding).map((b) => [b.bbl, b])) };
}
// The tax-lot grid.
//
// SOURCE. The original draws this from the City's own MapPLUTO ArcGIS service
// and says so: its response carries `x-lot-source: NYC DCP MapPLUTO (ArcGIS
// FeatureServer)` and a top-level `source: "pluto"`. This handler had been
// reading the DOF Digital Tax Map and left-joining PLUTO by BBL, which cannot
// join for condominiums — DOF stores the condo BASE lot, PLUTO the condo
// BILLING BBL (lot 75xx) — so 38 of the 177 lots it returned for a Midtown tile
// came back with a blank address, owner, building class and zoning. It was
// rerouted there because adapters/mappluto.js pointed at a third-party copy of
// MapPLUTO carrying 34,138 of the city's ~860,000 lots; that is fixed at the
// adapter, so the grid can come from the record again.
//
// PREDICATE. Intersects, not contains. Measured on 16/19298/24633: the original
// serves 238 lots, an envelope-contains query returns 177, an intersects query
// returns 238. Every lot straddling a tile edge was being dropped.
//
// ZOOM FLOOR. Below z14 the original answers 200 with
// {"type":"FeatureCollection","features":[],"note":"zoom in"} — no tile, no
// source, no count — rather than assembling a tile nothing will draw.
const LOT_TILE_MIN_ZOOM = 14;
router.get("/api/lot-tiles/:z/:x/:y", async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  if (![z, x, y].every(Number.isInteger)) return res.status(400).json({ error: "invalid_tile" });
  if (z < LOT_TILE_MIN_ZOOM) return res.json({ type: "FeatureCollection", features: [], note: "zoom in" });
  try {
    const r = await mapPlutoTileAll(z, x, y);
    if (!r.live) return unavailable(res, "NYC DCP MapPLUTO", r.error);
    // A tile that could not be paged to the end is unavailable, not short. A
    // half-drawn grid reads as "these are the lots here".
    if (!r.complete) return unavailable(res, "NYC DCP MapPLUTO", r.error || "tile incomplete");
    const features = [];
    for (const f of r.features) {
      const attrs = f?.properties ?? {};
      const p = mapPlutoProperties(attrs);
      // Geometry passes through AS-IS, rounded to 6 decimals. This used to run
      // toPolygonGeometry and flatten a MultiPolygon to its largest part, but
      // the original ships MultiPolygon unflattened: 16/19334/24603 is a single
      // Pelham Bay lot the original serves as {"type":"MultiPolygon"} — the
      // flattening was 13 KB short of its byte length. Rounding is
      // Math.round(v * 1e6) / 1e6, the rule proven on the building tiles over
      // 428,094 features (commit 1e73a02); measured here on 16/19298/24633 and
      // 15/9649/12316, where counts already matched (238, 980) and the full
      // source precision was the only remaining diff (3,302 and 5,148
      // coordinate diffs).
      const geom = roundGeometry(f?.geometry);
      if (!p.bbl || !geom || !Array.isArray(geom.coordinates)) continue;
      // A lot the geometry service knows but PLUTO carries no attributes for —
      // a condo base lot, a street bed — ships NULL for every absent field, not
      // "" and not 0. Measured on 1005500015 (14/4824/6158): the original's
      // feature is {"address":null,"owner":null,"bldgClass":null,"landUse":null,
      // "units":null,"unitsRes":null,"lotArea":null,"bldgArea":null,
      // "floors":null,"yearBuilt":null,"assessedTotal":null,"builtFar":null,
      // "numBldgs":null, ...} while zoning "R6", maxResidFar 2.43 and splitZone
      // true still ride through, because DCP populates the zoning columns even
      // there. A REAL zero survives: the 238-feature census carries units
      // zero=4, bldgArea zero=4, builtFar zero=4. So emission is raw-driven:
      // null in the source -> null on the wire; a number in the source -> that
      // number.
      const rawNum = (v) => (v == null ? null : (Number(v) || 0));
      const rawStr = (v) => (v == null ? null : String(v));
      features.push({
        type: "Feature", geometry: geom,
        properties: {
          // Address is the source string UNTRIMMED: 3087600250 on 16/19308/24672
          // is " SHORE BOULEVARD" on the original, leading space included, and
          // the shared mapper's s() would strip it.
          bbl: p.bbl, address: rawStr(attrs.Address),
          owner: rawStr(attrs.OwnerName), bldgClass: rawStr(attrs.BldgClass),
          // Zero-padded here, unlike /api/area-buildings. The original serves
          // landUse "03" on a lot tile and "3" on an inventory row; they are
          // different endpoints and both were measured. An ABSENT land use is
          // null — the 238-feature census of 16/19298/24633 carries exactly one
          // null and zero ""/"00" — and the shared mapper pads "" to "00", so
          // the raw attribute decides.
          landUse: attrs.LandUse == null || String(attrs.LandUse).trim() === ""
            ? null
            : String(attrs.LandUse).trim().padStart(2, "0"),
          zoning: rawStr(attrs.ZoneDist1),
          units: rawNum(attrs.UnitsTotal), unitsRes: rawNum(attrs.UnitsRes),
          lotArea: rawNum(attrs.LotArea), bldgArea: rawNum(attrs.BldgArea),
          // floors and yearBuilt are null when PLUTO has none AND when it says
          // 0 — the original's census over 238 features: floors null=6 zero=0,
          // yearBuilt null=5 zero=0, and four of those lots are vacant ones
          // whose NumFloors IS 0 in the source. Publishing 0 there is a
          // fabricated figure.
          floors: rawNum(attrs.NumFloors) || null, yearBuilt: rawNum(attrs.YearBuilt) || null,
          assessedTotal: rawNum(attrs.AssessTot),
          builtFar: rawNum(attrs.BuiltFAR),
          maxResidFar: p.maxResidFar ?? null, maxCommFar: p.maxCommFar ?? null, maxFacilFar: p.maxFacilFar ?? null,
          numBldgs: rawNum(attrs.NumBldgs),
          histDist: p.histDist || null, landmark: p.landmark || null,
          eDesig: p.eDesig || null, splitZone: p.splitZone ?? null,
          ltdHeight: p.ltdHeight || null
        }
      });
    }
    res.set("Cache-Control", "public, max-age=3600");
    res.set("x-lot-source", "NYC DCP MapPLUTO (ArcGIS FeatureServer)");
    // Measured 2026-08-20 across ten tiles: every populated tile says source
    // "pluto"; every EMPTY tile says source "nys" — including four tiles over
    // Nassau County and the Hudson, where a live NYS statewide parcel layer
    // would have features, yet the original still answers count 0. So "nys" is
    // observable only as the empty-tile label, whatever produces it upstream.
    return res.json({ type: "FeatureCollection", tile: { z, x, y }, source: features.length ? "pluto" : "nys", count: features.length, features });
  } catch (e) { return unavailable(res, "NYC DCP MapPLUTO", e?.message); }
});
router.get("/api/bldg-tiles/:z/:x/:y", async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y), box = tileBbox(z, x, y);
  try {
    const [geo, plu] = await Promise.all([polygonRows(BUILDING_FOOTPRINTS, box), plutoMapForBox(box)]);
    if (!geo.live || !plu.live) return unavailable(res, !geo.live ? "NYC Building Footprints" : "PLUTO", !geo.live ? geo.error : plu.error);
    const features = [];
    for (const r of geo.rows) {
      const bbl = rowBbl(r), b = bbl ? plu.map.get(bbl) : null, geom = r.the_geom;
      if (!geom || typeof geom !== "object") continue;
      const roofFeet = num(r.height_roof ?? r.heightroof), h = roofFeet > 0 ? roofFeet * 0.3048 : Math.max(4, (b?.numFloors || 1) * 3.3);
      features.push({ type: "Feature", geometry: geom, properties: { bbl: bbl || b?.bbl || "", h, lu: b?.landUse || "", addr: b?.address || "" } });
    }
    res.set("Cache-Control", "public, max-age=3600");
    return res.json({ type: "FeatureCollection", features, provenance: "live" });
  } catch (e) { return unavailable(res, "NYC Building Footprints", e?.message); }
});
router.get("/api/footprints", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: "lat_lng_required" });
  const d = 0.0017, box = { minLat: lat - d, maxLat: lat + d, minLng: lng - d, maxLng: lng + d };
  try {
    const r = await polygonRows(BUILDING_FOOTPRINTS, box, 500);
    if (!r.live) return unavailable(res, "NYC Building Footprints", r.error);
    const features = r.rows.map((x) => ({ bbl: rowBbl(x), geom: x.the_geom })).filter((x) => x.bbl && x.geom && typeof x.geom === "object");
    return res.json({ provenance: "live", features });
  } catch (e) { return unavailable(res, "NYC Building Footprints", e?.message); }
});

// ---------------------------------------------------------------- real assemblage / same-owner block
router.get("/api/assemblage", async (req, res, next) => {
  const bbl = digits(req.query.bbl);
  if (bbl.length !== 10) return next();
  try {
    const subject = await liveBuilding(bbl);
    if (!subject) return next();
    const d = 0.003, r = await plutoBbox(subject.lat - d, subject.lng - d, subject.lat + d, subject.lng + d, 1000);
    if (!r.live) return unavailable(res, "PLUTO", r.error);
    const lots = r.rows.map(plutoRowToBuilding).filter((b) => b.block === subject.block && b.owner === subject.owner).map((b) => ({
      bbl: b.bbl, address: b.address, lotArea: b.lotArea, builtFar: b.builtFar, maxFar: b.maxFar, unusedSf: b.unusedFarSf
    }));
    return res.json({
      provenance: "live", bbl, owner: subject.owner, count: lots.length,
      subjectUnusedSf: subject.unusedFarSf || 0,
      totalUnusedSf: lots.reduce((n, l) => n + (l.unusedSf || 0), 0), lots
    });
  } catch (e) { return unavailable(res, "PLUTO", e?.message); }
});

// ---------------------------------------------------------------- real BBL imagery coordinates
const imageCache = new Map();
async function imageProxy(res, url, cacheKey) {
  try {
    if (imageCache.has(cacheKey)) {
      const c = imageCache.get(cacheKey);
      res.set("Content-Type", c.type).set("Cache-Control", "public, max-age=86400");
      return res.send(c.buf);
    }
    const r = await fetch(url, { headers: { "user-agent": "nyc-re-market-intel/production" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer()), type = r.headers.get("content-type") || "image/jpeg";
    if (imageCache.size > 500) imageCache.clear();
    imageCache.set(cacheKey, { buf, type });
    res.set("Content-Type", type).set("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch { return res.status(404).end(); }
}
router.get("/api/staticmap", async (req, res, next) => {
  const bbl = digits(req.query.bbl);
  if (bbl.length !== 10) return next();
  const b = await liveBuilding(bbl).catch(() => null);
  if (!b?.lat || !b?.lng) return next();
  const [w, h] = String(req.query.size || "900x300").split("x").map(Number);
  const span = Number(req.query.span) || 0.004, ratio = (w || 900) / (h || 300);
  const bbox = [b.lng - span * ratio, b.lat - span, b.lng + span * ratio, b.lat + span].join(",");
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=3857&size=${w || 900},${h || 300}&format=jpg&f=image`;
  meterBump("staticmap");
  return imageProxy(res, url, `static:${bbl}:${w}x${h}:${span}`);
});
router.get("/api/streetview", async (req, res, next) => {
  const key = (process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY), bbl = digits(req.query.bbl);
  if (!key || bbl.length !== 10) return next();
  const b = await liveBuilding(bbl).catch(() => null);
  if (!b?.lat || !b?.lng) return next();
  meterBump("streetview");
  return imageProxy(res, `https://maps.googleapis.com/maps/api/streetview?size=640x400&location=${b.lat},${b.lng}&key=${encodeURIComponent(key)}`, `sv:${bbl}`);
});

// ---------------------------------------------------------------- My Desk maturity wall
// The exact frontend calls this with no BBL query. If a server-side Supabase
// service key is present, use the authenticated production workspace table as
// the source of tracked BBLs; otherwise report unavailable rather than inventing.
router.get("/api/maturity-wall", async (req, res, next) => {
  if (req.query.bbls) return next();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  if (!service || !url) return res.json({ configured: false, provenance: "unavailable", loans: [] });
  try {
    const r = await fetch(`${url}/rest/v1/cre_pipeline?select=bbl&bbl=not.is.null`, {
      headers: { apikey: service, authorization: `Bearer ${service}` }
    });
    if (!r.ok) return unavailable(res, "Supabase cre_pipeline", `HTTP ${r.status}`);
    const rows = await r.json(), bbls = [...new Set(rows.map((x) => digits(x.bbl)).filter((x) => x.length === 10))];
    if (!bbls.length) return res.json({ configured: true, provenance: "live", loans: [] });
    return res.json(await liveMaturityWall(bbls));
  } catch (e) { return unavailable(res, "Supabase cre_pipeline", e?.message); }
});

export default router;
