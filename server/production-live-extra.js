// Live implementations for production-visible map/territory endpoints that the
// original reconstruction served from its synthetic city model. Registered
// ahead of legacy routes so Render never needs invented parcel geometry,
// development pipeline, market index, or assemblage data.
import { Router } from "express";
import {
  mapPlutoAtPoint, mapPlutoByBbl, mapPlutoBbox, mapPlutoTile,
  normalizeMapPlutoFeature, mapPlutoProperties,
  buildingFootprintsBbox, buildingFootprintsTile, buildingFootprintFeature
} from "./adapters/mappluto.js";
import { rollingSalesByZips, parseSalesNum, dobNowPipelineCounts, plutoBbox, plutoRowToBuilding } from "./adapters/nyc.js";
import { liveAreaBuildings, liveMarket } from "./live.js";
import { soql } from "./adapters/socrata.js";
const TAX_LOT_POLYGONS = "i38t-6if2"; // DOF Digital Tax Map TAX_LOT_POLYGON

const router = Router();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const cleanBbl = (v) => { const d = String(v ?? "").replace(/[^0-9]/g, ""); return d.length === 10 ? d : ""; };
const zipsFrom = (v) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];
const median = (a) => { const x = a.filter(Number.isFinite).sort((p,q)=>p-q); return x.length ? x[Math.floor(x.length/2)] : null; };
const average = (a) => { const x = a.filter(Number.isFinite); return x.length ? x.reduce((s,v)=>s+v,0)/x.length : null; };
const cutoff12 = () => Date.now() - 366 * 864e5;

function landUseLabel(code) {
  return ({
    "01":"1–2 Family","02":"Multifamily Walk-up","03":"Multifamily Elevator","04":"Mixed Resi/Commercial",
    "05":"Commercial / Office","06":"Industrial / Manufacturing","07":"Transportation / Utility",
    "08":"Public Facility / Institution","09":"Open Space / Recreation","10":"Parking Facility","11":"Vacant Land"
  })[String(code ?? "").padStart(2,"0")] ?? String(code ?? "");
}
function assetClass(b) {
  const c = String(b?.bldgClass ?? "")[0]?.toUpperCase();
  if (c === "C" || c === "D") return "multifamily";
  if (c === "R") return "condo";
  if (c === "O") return "office";
  if (c === "H") return "hotels";
  if (["V","Z","G"].includes(c) || ((b?.builtFar ?? 0) < .6 && (b?.maxFar ?? 0) >= 3)) return "development";
  return "misc";
}
function qualifies(b, mode) {
  const c = String(b?.bldgClass ?? "")[0]?.toUpperCase();
  if (mode === "multifamily") return (c === "C" || c === "D") && (b.unitsRes ?? 0) >= 20;
  if (mode === "condo") return c === "R";
  if (mode === "office") return c === "O";
  if (mode === "hotels") return c === "H";
  if (mode === "development") return ["V","Z","G"].includes(c) || ((b.builtFar ?? 0) < 1.5 && (b.maxFar ?? 0) >= 3);
  return !["C","D","R","O","H"].includes(c);
}
function asLotProperties(p) {
  return {
    bbl:p.bbl,address:p.address,owner:p.owner,ownerType:p.ownerType,bldgClass:p.bldgClass,zoning:p.zoning,
    zoneDist1:p.zoneDist1,zoneDist2:p.zoneDist2,zoneDist3:p.zoneDist3,zoneDist4:p.zoneDist4,
    overlay:p.overlay,overlay2:p.overlay2,specialDistrict:p.specialDistrict,specialDistrict2:p.specialDistrict2,specialDistrict3:p.specialDistrict3,
    units:p.units,unitsRes:p.unitsRes,yearBuilt:p.yearBuilt,landUse:p.landUse,lotArea:p.lotArea,bldgArea:p.bldgArea,
    builtFar:p.builtFar,maxResidFar:p.maxResidFar,maxCommFar:p.maxCommFar,maxFacilFar:p.maxFacilFar,floors:p.floors,
    assessedTotal:p.assessedTotal,assessedLand:p.assessedLand,exemptTotal:p.exemptTotal,landmark:p.landmark,histDist:p.histDist,
    eDesig:p.eDesig,splitZone:p.splitZone,ltdHeight:p.ltdHeight,lotFront:p.lotFront,lotDepth:p.lotDepth,
    lat:p.lat,lng:p.lng,zip:p.zip,provenance:"live",source:p.source
  };
}

// ---------------------------------------------------------------- real parcel geometry
//
// WHY THIS HANDS OFF INSTEAD OF ANSWERING
// The lot grid drew almost nothing. Toggling "Lot grid: on" over Midtown and
// zooming all the way in produced three vector paths, so there was nearly
// nothing on the map to click — which is what "you can't even click them"
// looks like from the outside.
//
// The cause is the source, not the drawing code. This handler was answering
// from the ArcGIS MapPLUTO_Public FeatureServer, and that service is a subset,
// not the citywide lot layer. Measured against the service itself:
//
//   .../MapPLUTO_Public/FeatureServer/0/query?where=1=1&returnCountOnly=true
//     -> {"count":34138}          NYC has ~860,000 tax lots
//   same service, envelope for tile 17/38596/49266
//     -> {"count":1}
//   DOF Digital Tax Map (Socrata i38t-6if2), identical envelope
//     -> 37 rows, every one with a 10-digit BBL and real polygon geometry
//
// So the grid was drawing 1 lot where the tax map records 37. Express matches
// the first router that registers a path, and this file is mounted ahead of
// server/parity-routes.js (server.js:98 before :99), so this thin answer was
// winning over the DOF-backed one that already existed there and joins each
// polygon to its PLUTO attributes.
//
// Falling through with next() gives the grid the authoritative citywide tax-lot
// layer. Nothing is removed: mapPlutoTile and the normalizers stay exactly where
// they are and are still used by /api/lot-at and /api/zip-at below, which ask
// for one parcel at a point — a job the ArcGIS service does correctly.
router.get("/api/lot-tiles/:z/:x/:y", (req, res, next) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  if (![z,x,y].every(Number.isInteger)) return res.status(400).json({ error:"invalid_tile" });
  return next();
});

router.get("/api/lot-at", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const r = await mapPlutoAtPoint(lat,lng);
  if (!r.live) return res.status(503).json({ provenance:"unavailable", error:"mappluto_unavailable", message:r.error });
  if (!r.features.length) {
    // MapPLUTO answering with zero features is not proof that no parcel is
    // here. The ArcGIS layer returns live:true with an empty feature set for
    // points that are plainly inside a lot — the same behaviour that made
    // /api/assemblage answer "parcel_not_found" for the Empire State Building —
    // so a bare 404 turns one source's silence into a statement about the
    // location.
    //
    // Confirm against the DOF Digital Tax Map, which is the authoritative lot
    // polygon set and the one /api/lot-at is supposed to resolve against
    // anyway. "No parcel at this point" is only published when a live,
    // successful query against that source also returns nothing — a point in
    // the river genuinely has no lot, and that answer stays a 404. When DOF
    // cannot be reached, the honest answer is that it is unavailable.
    const dof = await soql(TAX_LOT_POLYGONS, {
      $select: "bbl",
      $where: `intersects(the_geom, "POINT(${lng} ${lat})")`,
      $limit: 1
    }).catch((e) => ({ live: false, rows: [], error: String(e?.message ?? e) }));
    if (!dof.live) {
      return res.status(503).json({
        provenance: "unavailable",
        error: "lot_sources_unavailable",
        message: `MapPLUTO returned no feature and the DOF Digital Tax Map could not be reached (${dof.error ?? "unknown"}), so whether a parcel exists at this point is unknown.`
      });
    }
    if (dof.rows?.length) {
      return res.status(503).json({
        provenance: "unavailable",
        error: "lot_geometry_unavailable",
        message: `The DOF Digital Tax Map holds lot ${dof.rows[0].bbl} at this point but MapPLUTO returned no feature for it, so the parcel detail this endpoint returns could not be assembled.`,
        bbl: String(dof.rows[0].bbl ?? "")
      });
    }
    return res.status(404).json({ error:"no_parcel_found", provenance:"live" });
  }
  res.json({ ...mapPlutoProperties(r.features[0].properties), geometry:r.features[0].geometry });
});
// The ZIP at a point.
//
// The original contract is one field: { zip }. The mock in the source zip
// fabricated it — `"10" + (block % 100)`, which answers "1035" for the Empire
// State Building — so the shape is the only thing worth taking from it; the
// value has to be a real published one.
//
// This asked MapPLUTO's point service, which returns zero features for
// coordinates that /api/lot-at resolves without trouble, so the endpoint
// answered {zip:null} on a valid Midtown address while the lot lookup beside it
// answered correctly. Two point-in-parcel resolvers disagreeing is worse than
// one: this now uses the same PLUTO bounding-box lookup /api/lot-at does, so if
// one of them finds the lot they both do. MapPLUTO stays as the first attempt
// because its geometry is exact when it does answer.
router.get("/api/zip-at", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error:"invalid_coordinates" });

  const arc = await mapPlutoAtPoint(lat,lng).catch(() => ({ live:false }));
  const hit = arc.live && arc.features?.[0] ? mapPlutoProperties(arc.features[0].properties) : null;
  if (hit?.zip) return res.json({ zip:hit.zip, bbl:hit.bbl || null, provenance:"live", source:"MapPLUTO" });

  const d = 0.0012;
  const r = await plutoBbox(lat - d, lng - d, lat + d, lng + d, 60).catch(() => null);
  if (!r?.live) return res.status(503).json({ provenance:"unavailable", error:"pluto_unavailable", message:r?.error || "PLUTO unavailable" });
  const b = (r.rows ?? []).map(plutoRowToBuilding)
    .filter((x) => x.lat && x.lng && x.zip)
    .sort((a, z) => Math.hypot(a.lat - lat, a.lng - lng) - Math.hypot(z.lat - lat, z.lng - lng))[0];
  // No lot within the search box is a real answer — open water, a park, a point
  // outside the city — and it stays null rather than becoming a guessed ZIP.
  res.json({ zip:b?.zip || null, bbl:b?.bbl || null, provenance:"live", source:b ? "NYC PLUTO" : null });
});

router.get("/api/bldg-tiles/:z/:x/:y", async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  if (![z,x,y].every(Number.isInteger)) return res.status(400).json({ error:"invalid_tile" });
  const r = await buildingFootprintsTile(z,x,y);
  if (!r.live) return res.status(503).json({ provenance:"unavailable", error:"building_footprints_unavailable", message:r.error });
  const features = r.rows.map(buildingFootprintFeature).filter((f)=>f.geometry);
  res.set("cache-control","public, max-age=3600, stale-while-revalidate=86400");
  // tile/count and the per-feature yr alias are part of the original's
  // bldg-tiles envelope (A/B diff 2026-08-17). yr mirrors the construction
  // year already carried on the feature.
  for (const f of features) {
    if (f?.properties && f.properties.yr === undefined) {
      const yr = f.properties.yearBuilt ?? f.properties.cnstrct_yr ?? null;
      if (yr != null) f.properties.yr = yr;
    }
  }
  res.json({ type:"FeatureCollection", tile:{ z, x, y }, count:features.length, features, provenance:"live", source:r.source, fetchedAt:new Date().toISOString() });
});

router.get("/api/footprints", async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error:"invalid_coordinates" });
  const d = .0025;
  const r = await buildingFootprintsBbox(lat-d,lng-d,lat+d,lng+d,350);
  if (!r.live) return res.status(503).json({ provenance:"unavailable", error:"building_footprints_unavailable", message:r.error });
  const features = r.rows.map(buildingFootprintFeature).filter((f)=>f.geometry && f.properties.bbl).map((f)=>({ bbl:f.properties.bbl, bin:f.properties.bin, geom:f.geometry, heightRoofFt:f.properties.heightRoofFt, provenance:"live" }));
  res.json({ features, provenance:"live", source:r.source, fetchedAt:new Date().toISOString() });
});

// --------------------------------------------------------------- live opportunity overlay
// The exact bundle already contains the authored production opportunity cards.
// This endpoint contributes dynamic public-record targets and therefore never
// fabricates owner/property facts from the old seed engine.
router.get("/api/opportunities", async (req, res) => {
  const zips = zipsFrom(req.query.zips);
  if (!zips.length) return res.json([]);
  const r = await liveAreaBuildings(zips,{page:0,pageSize:250,sort:"score"});
  if (!r) return res.status(503).json({ provenance:"unavailable", error:"pluto_unavailable" });
  const requested = String(req.query.assetClass ?? "");
  const rows = r.buildings.filter((b)=>!requested || assetClass(b)===requested).slice(0,60).map((b)=>{
    const cls = assetClass(b);
    const signals = [];
    if ((b.unusedFarSf??0)>10000) signals.push("Unused development rights");
    if ((b.propensity??0)>=35) signals.push("Seller propensity");
    if (cls==="development") signals.push("Development potential");
    if (cls==="office") signals.push("Adaptive-reuse screen");
    return {
      id:`LIVE-${b.bbl}`,address:b.address,neighborhood:`ZIP ${b.zip}`,category:cls==="development"?"Development / land":cls,
      lat:b.lat,lng:b.lng,bbl:b.bbl,bin:b.bin||"",block:b.block,lot:b.lot,zoning:b.zoning,landUse:b.landUse,
      lotSf:b.lotArea,bldgSf:b.bldgArea,far:b.builtFar,maxFar:b.maxFar,yearBuilt:b.yearBuilt,floors:b.numFloors,
      owner:b.owner,ownerNote:"Owner of record — NYC PLUTO",conversionFit:cls==="office"?"Possible":"N/A",risk:"Verify",
      status:"Live public-record screen",signals,policyCatalysts:[],adaptiveReuse:cls==="office",riskFlags:[],
      nextAction:"Open the Parcel Dossier and verify live source records.",estLandPpbsf:null,unbuiltFarSf:b.unusedFarSf,
      sourcedFact:"Live PLUTO / NYC public record",opportunityScore:b.score,thesis:b.propensityWhy||"Live public-record opportunity screen.",
      provenance:"live"
    };
  });
  res.json(rows);
});

router.get("/api/gov-links", (req,res) => {
  const bbl = cleanBbl(req.query.bbl);
  if (!bbl) return res.status(400).json({ error:"invalid_bbl" });
  const borough=bbl[0], block=Number(bbl.slice(1,6)), lot=Number(bbl.slice(6));
  res.json({
    acris:`https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${borough}&block=${block}&lot=${lot}`,
    propertyInformationPortal:`https://propertyinformationportal.nyc.gov/parcels/parcel/${bbl}`,
    buildingsProfile:`https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${borough}&block=${block}&lot=${lot}`,
    zoningMap:`https://zola.planning.nyc.gov/l/lot/${borough}/${block}/${lot}`
  });
});

// ---------------------------------------------------------------- assemblage / zoning-lot screen
router.get("/api/assemblage", async (req,res) => {
  const bbl=cleanBbl(req.query.bbl);
  if (!bbl) return res.status(400).json({error:"invalid_bbl"});
  const subjectR=await mapPlutoByBbl(bbl);
  if (!subjectR.live) return res.status(503).json({provenance:"unavailable",error:"mappluto_unavailable",message:subjectR.error});
  // The original answers 200 with an empty screen for a lot the tax map does
  // not carry (verified 2026-08-17: {"owner":"","subjectUnusedSf":null,
  // "lots":[],"totalLotArea":0,"totalUnusedSf":0,"count":0}); mirror it.
  if (!subjectR.features.length) return res.json({bbl,owner:"",subjectUnusedSf:null,lots:[],totalLotArea:0,totalUnusedSf:0,count:0,provenance:"live"});
  const subject=mapPlutoProperties(subjectR.features[0].properties);
  const lat=subject.lat,lng=subject.lng;
  if (!Number.isFinite(lat)||!Number.isFinite(lng)) return res.json({bbl,owner:subject.owner,count:1,subjectUnusedSf:subject.unusedFarSf,totalLotArea:subject.lotArea||0,totalUnusedSf:subject.unusedFarSf,lots:[{bbl,address:subject.address,lotArea:subject.lotArea,builtFar:subject.builtFar,maxFar:subject.maxFar,unusedSf:subject.unusedFarSf}],provenance:"live",note:"No centroid was published for a broader same-block scan."});
  const nearby=await mapPlutoBbox(lat-.004,lng-.004,lat+.004,lng+.004,800);
  if (!nearby.live) return res.status(503).json({provenance:"unavailable",error:"mappluto_unavailable",message:nearby.error});
  const ownerNorm=String(subject.owner||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
  const candidates=nearby.features.map((f)=>mapPlutoProperties(f.properties)).filter((p)=>p.block===subject.block && p.owner && String(p.owner).toUpperCase().replace(/[^A-Z0-9]/g,"")===ownerNorm);
  if (!candidates.some((p)=>p.bbl===subject.bbl)) candidates.unshift(subject);
  const lots=candidates.map((p)=>({bbl:p.bbl,address:p.address,lotArea:p.lotArea,builtFar:p.builtFar,maxFar:p.maxFar,unusedSf:p.unusedFarSf,zoning:p.zoning,owner:p.owner}));
  // totalLotArea is part of the original's assemblage envelope (the A/B diff
  // flagged it missing here on every probe).
  res.json({bbl,owner:subject.owner,count:lots.length,subjectUnusedSf:subject.unusedFarSf,totalLotArea:lots.reduce((s,x)=>s+(x.lotArea||0),0),totalUnusedSf:lots.reduce((s,x)=>s+(x.unusedSf||0),0),lots,provenance:"live",note:"Same recorded owner + same tax block. This is a screening signal, not proof of a merged zoning lot or transferable development rights."});
});

// ---------------------------------------------------------------- territory analytics
// Page through the territory instead of taking the first thousand rows.
//
// THE DEFECT
// This asked for pageSize:1000 and then computed qualifyingCount, totalUnits,
// the owner leaderboard and the top-buildings list from those 1,000 records —
// while reporting `totalLots` as the FULL count from the same call. A territory
// with 5,000 lots therefore showed a true total beside statistics drawn from a
// fifth of it, with nothing marking the difference. "The three largest owners in
// this territory" was really "the three largest owners among the 1,000
// highest-scoring lots", which is a different and much weaker claim.
//
// It now pages to TERRITORY_MAX_LOTS. When a territory is larger than that the
// response says so explicitly — `sampled:true` with the size and the coverage
// fraction — rather than presenting a sample as a census.
const TERRITORY_PAGE = 1000;
const TERRITORY_MAX_LOTS = 6000;

async function areaSnapshot(zips) {
  const first = await liveAreaBuildings(zips, { page: 0, pageSize: TERRITORY_PAGE, sort: "score" });
  const market = await liveMarket(zips);
  if (!first || !market) return null;

  const total = Number(first.total) || first.buildings.length;
  const want = Math.min(total, TERRITORY_MAX_LOTS);
  const buildings = [...first.buildings];
  const seen = new Set(buildings.map((b) => b.bbl));

  for (let page = 1; buildings.length < want; page++) {
    const next = await liveAreaBuildings(zips, { page, pageSize: TERRITORY_PAGE, sort: "score" }).catch(() => null);
    if (!next?.buildings?.length) break;
    let added = 0;
    for (const b of next.buildings) {
      if (b.bbl && seen.has(b.bbl)) continue;
      if (b.bbl) seen.add(b.bbl);
      buildings.push(b);
      added++;
    }
    if (!added) break; // the source stopped producing new rows
  }

  const area = { ...first, buildings, total };
  area.sampled = buildings.length < total;
  area.sampleSize = buildings.length;
  area.coverage = total > 0 ? Math.round((buildings.length / total) * 1000) / 10 : 100;
  return { area, market };
}

router.get("/api/territory", async (req,res) => {
  const zips=zipsFrom(req.query.zips), mode=String(req.query.mode||"multifamily");
  if (!zips.length) return res.status(400).json({error:"zips_required"});
  const snap=await areaSnapshot(zips);
  if (!snap) return res.status(503).json({provenance:"unavailable",error:"public_records_unavailable"});
  const all=snap.area.buildings, q=all.filter((b)=>qualifies(b,mode));
  const units=q.reduce((s,b)=>s+(mode==="hotels"?(b.unitsTotal||0):(b.unitsRes||0)),0);
  const top=[...q].sort((a,b)=>mode==="development"?(b.unusedFarSf||0)-(a.unusedFarSf||0):(mode==="office"||mode==="misc")?(b.bldgArea||0)-(a.bldgArea||0):(mode==="hotels"?(b.unitsTotal||0)-(a.unitsTotal||0):(b.unitsRes||0)-(a.unitsRes||0))).slice(0,12);
  const fam=(sale)=>String(sale.bldgClass||"")[0];
  const sales=snap.market.sales.filter((s)=>new Date(s.saleDate).getTime()>=cutoff12()).filter((sale)=>{
    const c=fam(sale); if(mode==="multifamily")return c==="C"||c==="D"; if(mode==="condo")return c==="R"; if(mode==="office")return c==="O"; if(mode==="hotels")return c==="H"; if(mode==="development")return ["V","Z","G"].includes(c); return true;
  });
  const vals=sales.map((s)=>mode==="development"?(s.landSf&&s.salePrice?s.salePrice/s.landSf:null):s.ppsf).filter(Number.isFinite);
  const owners=new Map();
  for(const b of all){ if(!b.owner)continue; const cur=owners.get(b.owner)||{name:b.owner,buildings:0,units:0}; cur.buildings++;cur.units+=b.unitsRes||0;owners.set(b.owner,cur); }
  const ownerRows=[...owners.values()];
  res.json({fetchedAt:new Date().toISOString(),provenance:"live",census:{qualifyingCount:q.length,totalUnits:units,avgUnitsPerBldg:q.length?Math.round(units/q.length):0,totalLots:snap.area.total,topUnusedBuildableSf:top.reduce((s,b)=>s+(b.unusedFarSf||0),0),analyzedLots:snap.area.sampleSize,sampled:snap.area.sampled===true,coveragePct:snap.area.coverage,basis:snap.area.sampled?`Qualifying counts, units and owner rankings are computed from the ${Number(snap.area.sampleSize).toLocaleString("en-US")} highest-scoring of ${Number(snap.area.total).toLocaleString("en-US")} lots (${snap.area.coverage}%); totalLots is the full count.`:"Computed across every lot in the territory."},sales:{count:sales.length,medianPpsf:median(vals)!=null?Math.round(median(vals)):null,avgPpsf:average(vals)!=null?Math.round(average(vals)):null,metric:mode==="development"?"$/land sf":"$/sf",latestSaleDate:sales[0]?.saleDate||null},top:top.map((b)=>({bbl:b.bbl,address:b.address,zoning:b.zoning,unitsRes:b.unitsRes,unitsTotal:b.unitsTotal,bldgArea:b.bldgArea,yearBuilt:b.yearBuilt,owner:b.owner,score:b.score,lotArea:b.lotArea,builtFar:b.builtFar,maxFar:b.maxFar,unusedFarSf:b.unusedFarSf})),ownersByBuildings:[...ownerRows].sort((a,b)=>b.buildings-a.buildings).slice(0,10),ownersByUnits:[...ownerRows].sort((a,b)=>b.units-a.units).slice(0,10)});
});

router.get("/api/area-detail", async (req,res) => {
  const zips=zipsFrom(req.query.zips),mode=String(req.query.mode||"multifamily"),kind=String(req.query.kind||"sales"),owner=String(req.query.owner||"");
  if (!zips.length) return res.status(400).json({error:"zips_required"});
  const snap=await areaSnapshot(zips);
  if(!snap)return res.status(503).json({provenance:"unavailable",error:"public_records_unavailable"});
  if(kind==="sales"){
    // Honour `mode`. This accepted the parameter and ignored it, so the drill-down
    // from (say) the Office lens returned condo and walk-up sales mixed in with
    // everything else — the detail list did not match the panel it was opened
    // from. Same class-family rule /api/territory uses, so the two agree.
    const fam=(sale)=>String(sale.bldgClass||"")[0];
    const inMode=(sale)=>{const c=fam(sale);
      if(mode==="multifamily")return c==="C"||c==="D";
      if(mode==="condo")return c==="R";
      if(mode==="office")return c==="O";
      if(mode==="hotels")return c==="H";
      if(mode==="development")return ["V","Z","G"].includes(c);
      return true;};
    const windowed=snap.market.sales.filter((s)=>new Date(s.saleDate).getTime()>=cutoff12());
    const sales=windowed.filter(inMode).slice(0,60);
    return res.json({coverage:`${sales.length} recorded ${mode} sales returned from the official rolling-sales source across ${zips.length} ZIP(s) (${windowed.length} across all asset classes).`,mode,sales,buildings:[],provenance:"live"});
  }
  let list=snap.area.buildings.filter((b)=>qualifies(b,mode));
  if(kind==="owner"&&owner){const n=owner.toUpperCase().replace(/[^A-Z0-9]/g,"");list=snap.area.buildings.filter((b)=>String(b.owner||"").toUpperCase().replace(/[^A-Z0-9]/g,"")===n);}
  res.json({coverage:kind==="owner"?`${list.length} live PLUTO building(s) held by ${owner} in this result set.`:`${list.length} qualifying live PLUTO record(s) for the ${mode} lens.`,sales:[],buildings:list.slice(0,80).map((b)=>({bbl:b.bbl,address:b.address,unitsRes:b.unitsRes,yearBuilt:b.yearBuilt,zoning:b.zoning,lotArea:b.lotArea,builtFar:b.builtFar,maxFar:b.maxFar,unusedFarSf:b.unusedFarSf,owner:b.owner})),provenance:"live"});
});

// Exact /api/pipeline?zips= is public DOB development pipeline, not the user's
// private cre_pipeline CRM table.
const PIPELINE_WINDOW_MONTHS = 36;
const PIPELINE_SITE_LIMIT = 60;

router.get("/api/pipeline", async (req,res,next) => {
  if(!req.query.zips)return next();
  const zips=zipsFrom(req.query.zips); if(!zips.length)return res.status(400).json({error:"zips_required"});
  // Counts aggregate over the whole window; the site list is the most recent
  // page of it. Deriving counts from the page under-reports every area by the
  // size of the page limit, which is what the previous handler did.
  const [market, counts] = await Promise.all([
    liveMarket(zips),
    dobNowPipelineCounts(zips, PIPELINE_WINDOW_MONTHS)
  ]);
  if(!market || !counts.live)return res.status(503).json({provenance:"unavailable",error:"dob_now_unavailable"});
  const sites=market.pipeline.slice(0,PIPELINE_SITE_LIMIT).map((p)=>({
    address:p.address, bbl:p.bbl, bin:p.bin, kind:p.kind, status:p.status,
    filingDate:p.filingDate, proposedUnits:p.proposedUnits, proposedSf:p.proposedSf,
    applicant:p.applicant, owner:p.owner
  }));
  const n=(v)=>Number(v||0).toLocaleString("en-US");
  res.json({
    zips,
    fetchedAt:new Date().toISOString(),
    windowMonths:PIPELINE_WINDOW_MONTHS,
    counts:{newBuilding:counts.newBuilding,foundation:counts.foundation,demolition:counts.demolition,proposedUnits:counts.proposedUnits},
    sites,
    coverage:`${n(counts.newBuilding)} new-building, ${n(counts.foundation)} foundation, and ${n(counts.demolition)} demolition filings in ZIP ${zips.join(", ")} over the last ${PIPELINE_WINDOW_MONTHS} months (DOB NOW). ${n(counts.proposedUnits)} proposed units in the new-building pipeline.`,
    provenance:"live"
  });
});

// ---------------------------------------------------------------- market index
const MARKETS=[
  {market:"Manhattan",zips:["10001","10002","10003","10010","10011","10012","10013","10014","10016","10017","10018","10019","10021","10022","10023","10024","10025","10028","10029","10036"]},
  {market:"Brooklyn",zips:["11201","11205","11206","11211","11215","11216","11217","11221","11222","11225","11226","11231","11232","11237","11238","11249"]},
  {market:"Queens",zips:["11101","11102","11103","11104","11105","11106","11372","11373","11375","11377","11385"]}
];
const STRATS={
  multifamily:{label:"Multifamily",metric:"$/sf",test:(s)=>["C","D"].includes(String(s.bldgClass||"")[0]),den:(s)=>s.grossSf},
  condo:{label:"Condo",metric:"$/sf",test:(s)=>String(s.bldgClass||"")[0]==="R",den:(s)=>s.grossSf},
  office:{label:"Office",metric:"$/sf",test:(s)=>String(s.bldgClass||"")[0]==="O",den:(s)=>s.grossSf},
  hotels:{label:"Hotels",metric:"$/sf",test:(s)=>String(s.bldgClass||"")[0]==="H",den:(s)=>s.grossSf},
  development:{label:"Development",metric:"$/land sf",test:(s)=>["V","Z","G"].includes(String(s.bldgClass||"")[0]),den:(s)=>s.landSf}
};
router.get("/api/market-index", async (_req,res)=>{
  try{
    const markets=[]; const comps=[];
    for(const m of MARKETS){
      const raw=await rollingSalesByZips(m.zips,{limit:1000,minPrice:10000});
      if(!raw.live)throw new Error(raw.error||`Rolling Sales unavailable for ${m.market}`);
      const sales=(raw.rows||[]).map((s)=>({saleDate:String(s.sale_date||"").slice(0,10),salePrice:num(s.sale_price),address:s.address||"",bldgClass:s.building_class_at_present||"",type:s.building_class_category||"",grossSf:parseSalesNum(s.gross_square_feet),landSf:parseSalesNum(s.land_square_feet),units:num(s.residential_units),zip:String(s.zip_code||""),bbl:s.borough&&s.block&&s.lot?`${s.borough}${String(s.block).padStart(5,"0")}${String(s.lot).padStart(4,"0")}`:null})).filter((s)=>s.salePrice>10000&&new Date(s.saleDate).getTime()>=cutoff12());
      const entry={market:m.market};
      for(const [key,strat] of Object.entries(STRATS)){
        const eligible=sales.filter(strat.test).map((s)=>({...s,value:strat.den(s)>0?s.salePrice/strat.den(s):null})).filter((s)=>Number.isFinite(s.value)&&s.value>0);
        const grouped=new Map(); for(const s of eligible){const name=`ZIP ${s.zip||"Unknown"}`;const g=grouped.get(name)||{name,values:[],units:0,count:0};g.values.push(s.value);g.units+=s.units||0;g.count++;grouped.set(name,g);}
        entry[key]={metric:strat.metric,submarkets:[...grouped.values()].map((g)=>({name:g.name,ppsf:Math.round(average(g.values)||0),count:g.count,units:g.units})).sort((a,b)=>b.count-a.count||b.ppsf-a.ppsf)};
        for(const s of eligible.slice(0,20)) comps.push({address:s.address,market:m.market,submarket:`ZIP ${s.zip}`,strategy:strat.label,type:s.type||s.bldgClass,units:s.units||null,gsf:s.grossSf||null,landSf:s.landSf||null,salePrice:s.salePrice,ppsf:s.grossSf?Math.round(s.salePrice/s.grossSf):null,ppbsf:key==="development"&&s.landSf?Math.round(s.salePrice/s.landSf):null,saleDate:s.saleDate,bbl:s.bbl});
      }
      markets.push(entry);
    }
    comps.sort((a,b)=>String(b.saleDate).localeCompare(String(a.saleDate)));
    res.json({fetchedAt:new Date().toISOString(),windowMonths:12,provenance:"live",markets,comps:comps.slice(0,100)});
  }catch(e){res.status(503).json({provenance:"unavailable",error:"market_index_unavailable",message:e?.message||"Rolling Sales unavailable"});}
});

export default router;
