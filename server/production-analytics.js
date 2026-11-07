// Production analytics contracts consumed by the immutable frontend. Every
// record below is based on public NYC/Census data; no route falls through to
// the deterministic demo city model in production.
import { Router } from "express";
import { soql, escSoql } from "./adapters/socrata.js";
import {
  DS, plutoByZips, plutoRowToBuilding, rollingSalesByZips, parseSalesNum
} from "./adapters/nyc.js";
import { liveBuilding, liveAreaBuildings } from "./live.js";
import { computePropensity } from "./scoring.js";
import { propensityValidation } from "./area-buildings.js";
import { pineconeConfigured, upsertParcel, searchSimilar } from "./adapters/pinecone.js";

const router = Router();
const zipsFrom = (v) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];
const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
const med = (a) => { const v = a.filter(Number.isFinite).sort((x,y)=>x-y); return v.length ? v[Math.floor(v.length/2)] : null; };
const avg = (a) => { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s,x)=>s+x,0)/v.length : null; };
const round = (n, p=1) => Number.isFinite(n) ? Math.round(n * 10 ** p) / 10 ** p : null;
const dateOnly = (v) => String(v ?? "").slice(0,10) || null;
const cutoff = () => Date.now() - 366 * 864e5;

function saleObject(r) {
  const price = num(r.sale_price) || 0;
  const grossSf = parseSalesNum(r.gross_square_feet);
  const landSf = parseSalesNum(r.land_square_feet);
  return {
    saleDate: dateOnly(r.sale_date), salePrice: price, address: r.address || "",
    bldgClass: r.building_class_at_present || "", category: r.building_class_category || "",
    grossSf, landSf, unitsRes: num(r.residential_units), zip: String(r.zip_code || ""),
    ppsf: grossSf > 0 && price > 0 ? price / grossSf : null,
    bbl: r.borough && r.block && r.lot ? `${r.borough}${String(r.block).padStart(5,"0")}${String(r.lot).padStart(4,"0")}` : null
  };
}

const BUCKETS = [
  { mode:"multifamily", label:"Multifamily (5+ units)", churn:false,
    sale:(s)=>["C","D"].includes(String(s.bldgClass)[0]) && (s.unitsRes||0)>=5,
    stock:"(bldgclass like 'C%' OR bldgclass like 'D%') AND unitsres >= 5" },
  { mode:"smallresi", label:"1–4 family / townhouse", churn:false,
    sale:(s)=>["A","B"].includes(String(s.bldgClass)[0]), stock:"(bldgclass like 'A%' OR bldgclass like 'B%')" },
  { mode:"office", label:"Office", churn:false,
    sale:(s)=>String(s.bldgClass)[0]==="O", stock:"bldgclass like 'O%'" },
  { mode:"retail", label:"Retail / storefront", churn:false,
    sale:(s)=>String(s.bldgClass)[0]==="K", stock:"bldgclass like 'K%'" },
  { mode:"industrial", label:"Industrial / warehouse", churn:false,
    sale:(s)=>["E","F","L"].includes(String(s.bldgClass)[0]), stock:"(bldgclass like 'E%' OR bldgclass like 'F%' OR bldgclass like 'L%')" },
  { mode:"development", label:"Development / land", churn:false,
    sale:(s)=>["V","Z","G"].includes(String(s.bldgClass)[0]), stock:"(bldgclass like 'V%' OR bldgclass like 'Z%' OR bldgclass like 'G%')" },
  { mode:"hotels", label:"Hotel", churn:false,
    sale:(s)=>String(s.bldgClass)[0]==="H", stock:"bldgclass like 'H%'" },
  { mode:"condo", label:"Condo units", churn:true,
    sale:(s)=>String(s.bldgClass)[0]==="R", stock:"bldgclass like 'R%'" }
];

async function stockCount(zips, clause) {
  const list = zips.map((z)=>`'${escSoql(z)}'`).join(",");
  const r = await soql(DS.pluto, { $select:"count(bbl) as n", $where:`zipcode in(${list}) AND ${clause}` }, { ttlMs: 30*60*1000 });
  return r.live ? parseInt(r.rows?.[0]?.n || "0",10) || 0 : null;
}

// Exact market-report response schema, but every number comes from Rolling
// Sales and live PLUTO rather than the old synthetic ledger.
router.get("/api/market-report", async (req,res) => {
  const zips=zipsFrom(req.query.zips);
  if(!zips.length)return res.status(400).json({error:"zips_required"});
  const raw=await rollingSalesByZips(zips,{limit:2500,minPrice:10000});
  if(!raw.live)return res.status(503).json({provenance:"unavailable",error:"rolling_sales_unavailable",message:raw.error});
  const sales=(raw.rows||[]).map(saleObject).filter((s)=>s.salePrice>10000 && new Date(s.saleDate).getTime()>=cutoff());
  const counts=await Promise.all(BUCKETS.map((b)=>stockCount(zips,b.stock)));
  if(counts.some((x)=>x==null))return res.status(503).json({provenance:"unavailable",error:"pluto_stock_unavailable"});
  const byClass=BUCKETS.map((bucket,i)=>{
    const matched=sales.filter(bucket.sale);
    const dollar=matched.reduce((s,x)=>s+x.salePrice,0);
    const ppsf=matched.map((x)=>x.ppsf).filter(Number.isFinite);
    const turnover=!bucket.churn && counts[i] ? round(matched.length/counts[i]*100,1) : null;
    return {
      mode:bucket.mode,class:bucket.label,churn:bucket.churn,stock:counts[i],salesCount:matched.length,dollarVolume:dollar,
      avgPrice:matched.length?Math.round(dollar/matched.length):null,
      avgPpsf:ppsf.length?Math.round(avg(ppsf)):null,
      turnoverPct:turnover,impliedHoldYears:turnover&&turnover>0?Math.round(100/turnover):null
    };
  });
  const allPpsf=sales.map((x)=>x.ppsf).filter((x)=>Number.isFinite(x)&&x>0);
  const bands=[0,150,300,450,600,800,1000,1400,2000];
  const distribution=bands.map((lo,i)=>{const hi=bands[i+1]??Infinity;return{label:hi===Infinity?`$${lo}+`:`$${lo}–${hi}`,count:allPpsf.filter((v)=>v>=lo&&v<hi).length};}).filter((x)=>x.count>0);
  const dates=sales.map((x)=>x.saleDate).filter(Boolean).sort();
  const volume=sales.reduce((s,x)=>s+x.salePrice,0);
  res.json({
    provenance:"live",fetchedAt:new Date().toISOString(),windowStart:dates[0]||null,windowEnd:dates.at(-1)||null,
    recordedTotal:sales.length,byClass,distribution,
    narrative:[
      `${sales.length.toLocaleString()} recorded sales totaling $${Math.round(volume).toLocaleString()} were returned for the selected ZIP codes in the trailing twelve-month window.`,
      "Turnover uses live PLUTO stock counts as the denominator; condo/unit-sale churn is intentionally not presented as whole-building turnover.",
      "Recorded sale consideration and property characteristics come from NYC public records; fields unavailable at the source remain blank rather than estimated."
    ]
  });
});

// Model validation ("backtest"): of the lots that actually sold here in the
// trailing twelve months, what share scored Elevated+ versus the base rate?
// The ratio is the lift the Deal Radar panel renders.
//
// The measurement is real — recorded DOF sales matched against propensity
// scores computed from live PLUTO — and it is labeled for what it is. Current
// PLUTO is not a point-in-time snapshot, so an attribute that changed after a
// sale can inform the score for that sale; `pointInTime: false` says so, and
// the note explains what an archived snapshot would tighten. Withholding the
// number entirely was the wrong trade: it left the panel permanently blank
// while the underlying signal was measurable.
// Elevated+ starts at 35 — the same band boundary the propensity colour scale
// and the Deal Radar banner use. A different number here would have the two
// panels disagree about what "Elevated" means.
const LIFT_THRESHOLD = 35;
const liftCache = new Map();

async function propensityLift(zips) {
  const key = zips.join(",");
  const hit = liftCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.value;

  const [area, sales] = await Promise.all([
    liveAreaBuildings(zips, { pageSize: 600, sort: "propensity" }).catch(() => null),
    rollingSalesByZips(zips, { limit: 1500 }).catch(() => null)
  ]);
  if (!area?.buildings?.length) return { error: "area_unavailable" };
  if (!sales?.live) return { error: "rolling_sales_unavailable" };

  const soldBbls = new Set((sales.rows ?? [])
    .map((s) => (s.borough && s.block && s.lot)
      ? `${s.borough}${String(s.block).padStart(5, "0")}${String(s.lot).padStart(4, "0")}`
      : null)
    .filter(Boolean));
  const all = area.buildings;
  const hitFn = (b) => (b.propensity ?? 0) >= LIFT_THRESHOLD;
  const sold = all.filter((b) => soldBbls.has(b.bbl));
  if (!sold.length) return { error: "no_recorded_sales_overlap" };

  const soldHitPct = Math.round((sold.filter(hitFn).length / sold.length) * 100);
  const baseHitPct = Math.round((all.filter(hitFn).length / all.length) * 100) || 1;
  const value = {
    provenance: "live",
    threshold: LIFT_THRESHOLD,
    soldCount: sold.length,
    soldHitPct,
    baseHitPct,
    lift: +(soldHitPct / baseHitPct).toFixed(2),
    scoredLots: all.length,
    pointInTime: false,
    methodology: "trailing-12mo-recorded-sales-vs-current-scores",
    note: "Recorded DOF sales from the trailing twelve months matched against propensity scores computed from current PLUTO. Because PLUTO is a current snapshot rather than an archive, an attribute that changed after a sale can inform that sale's score; an archived point-in-time snapshot would remove that effect."
  };
  liftCache.set(key, { at: Date.now(), value });
  return value;
}

// The Deal Radar banner reads exactly six keys and prints `lift` raw, so this
// path answers with the client contract from server/area-buildings.js. The
// richer diagnostic body below stays on /api/analytics/backtest, and both are
// banded at the same Elevated+ threshold, so they can never disagree about
// which lots count as elevated.
router.get("/api/propensity-validation", async (req, res, next) => {
  try {
    const out = await propensityValidation(req.query);
    if (out.status === 503 || out.body === null) return next();
    return res.status(out.status).json(out.body);
  } catch (e) { return next(e); }
});

// Same measurement under the analytics path the Model Validation panel calls.
router.get("/api/analytics/backtest", async (req, res) => {
  const zips = zipsFrom(req.query.zips);
  if (!zips.length) return res.status(400).json({ error: "zips_required" });
  const out = await propensityLift(zips);
  if (out.error) {
    // A source that returned nothing yields no lift at all. Reporting null is
    // the honest answer; a fabricated ratio here would be indistinguishable
    // from a measured one in the panel that reads it.
    return res.status(503).json({
      provenance: "unavailable", threshold: LIFT_THRESHOLD, soldCount: 0,
      soldHitPct: null, baseHitPct: null, lift: null, pointInTime: false, error: out.error,
      note: "The validation is computed from live PLUTO scores and recorded DOF sales; one of those sources returned nothing for this area, so no lift is reported rather than an invented one."
    });
  }
  return res.json(out);
});

// Real-property fallback for similarity. Pinecone remains first choice; when it
// is not configured or unavailable, the fallback compares only live PLUTO lots
// and labels its engine explicitly.
router.get("/api/similar", async (req,res) => {
  const bbl=String(req.query.bbl||"").replace(/[^0-9]/g,"");
  let pineconeError=null;
  const subject=await liveBuilding(bbl).catch(()=>null);
  if(!subject)return res.status(404).json({configured:pineconeConfigured(),engine:"public-record-similarity",matches:[],provenance:"live",error:"parcel_not_found"});
  if(pineconeConfigured()){
    try{
      await upsertParcel(subject);
      const p=await searchSimilar(subject);
      if(!p?.error)return res.json({configured:true,engine:"pinecone",matches:p.matches||[],provenance:"live"});
    }catch(e){
      // Not silent. Falling through to the public-record engine is the right
      // behaviour — Similar Properties must not go blank because a vector
      // index is down — but swallowing the reason meant a permanently broken
      // Pinecone configuration looked identical to a healthy one that simply
      // preferred the public-record path. The fallback still runs; the failure
      // is now visible in the log and named on the response.
      pineconeError = String(e?.message ?? e).slice(0, 200);
      console.warn(`[similar] Pinecone unavailable for ${bbl}, using the public-record engine: ${pineconeError}`);
    }
  }
  const raw=await plutoByZips([subject.zip],{limit:400,order:"bldgarea DESC"});
  if(!raw.live)return res.status(503).json({configured:pineconeConfigured(),engine:"public-record-similarity",matches:[],provenance:"unavailable",error:"pluto_unavailable",...(pineconeError?{pineconeError}:{})});
  const family=String(subject.bldgClass||"")[0];
  const score=(x)=>{
    let w=0,total=0;
    const add=(weight,similarity)=>{total+=weight;w+=weight*Math.max(0,Math.min(1,similarity));};
    add(.30,String(x.bldgClass||"")[0]===family?1:0);
    add(.28,1-Math.abs((x.bldgArea||0)-(subject.bldgArea||0))/Math.max(1,x.bldgArea||0,subject.bldgArea||0));
    add(.16,1-Math.abs((x.lotArea||0)-(subject.lotArea||0))/Math.max(1,x.lotArea||0,subject.lotArea||0));
    add(.12,1-Math.min(1,Math.abs((x.yearBuilt||1950)-(subject.yearBuilt||1950))/100));
    add(.08,1-Math.abs((x.unitsRes||0)-(subject.unitsRes||0))/Math.max(1,x.unitsRes||0,subject.unitsRes||0));
    add(.06,1-Math.min(1,Math.abs((x.builtFar||0)-(subject.builtFar||0))/5));
    return total?Math.round(w/total*1000)/1000:0;
  };
  const matches=raw.rows.map(plutoRowToBuilding).filter((x)=>x.bbl&&x.bbl!==subject.bbl)
    .map((x)=>({x,score:score(x)})).sort((a,b)=>b.score-a.score).slice(0,8)
    .map(({x,score})=>({bbl:x.bbl,address:x.address,bldgclass:x.bldgClass,zip:x.zip,score}));
  res.json({configured:true,engine:"public-record-similarity",pineconeConfigured:pineconeConfigured(),matches,provenance:"live",...(pineconeError?{pineconeError}:{})});
});

// Current ACS 2020-2024 5-year estimates, released in 2026. Estimates and MOEs
// are returned together; the legacy top-level field names are preserved for the
// report components that consume them.
router.get("/api/demographics", async (req,res) => {
  const zips=zipsFrom(req.query.zips); if(!zips.length)return res.status(400).json({error:"zips_required"});
  const key=String(process.env.CENSUS_API_KEY||"");
  if(!key)return res.json({configured:false,provenance:"unavailable",vintage:"ACS 5-year 2024",note:"CENSUS_API_KEY is required by the Census Data API."});
  const zip=zips[0];
  const pairs={
    population:["B01003_001E","B01003_001M"],median_age:["B01002_001E","B01002_001M"],households:["B11001_001E","B11001_001M"],
    median_income:["B19013_001E","B19013_001M"],per_capita_income:["B19301_001E","B19301_001M"],median_gross_rent:["B25064_001E","B25064_001M"],
    household_size:["B25010_001E","B25010_001M"],renter:["B25003_003E","B25003_003M"],tenure_total:["B25003_001E","B25003_001M"],
    unemployed:["B23025_005E","B23025_005M"],labor_force:["B23025_003E","B23025_003M"]
  };
  const vars=[...new Set(Object.values(pairs).flat())];
  const url=`https://api.census.gov/data/2024/acs/acs5?get=${vars.join(",")}&for=zip%20code%20tabulation%20area:${encodeURIComponent(zip)}&key=${encodeURIComponent(key)}`;
  try{
    const r=await fetch(url,{signal:AbortSignal.timeout(15000)}); if(!r.ok)throw new Error(`Census HTTP ${r.status}`);
    const [header,row]=await r.json();
    const val=(code)=>{const i=header.indexOf(code),n=Number(row?.[i]);return Number.isFinite(n)&&n>-6666?n:null;};
    const estimates={},marginsOfError={};
    for(const [name,[e,m]] of Object.entries(pairs)){estimates[name]=val(e);marginsOfError[name]=val(m);}
    const renterPct=estimates.renter!=null&&estimates.tenure_total?Math.round(estimates.renter/estimates.tenure_total*1000)/10:null;
    const unemploymentPct=estimates.unemployed!=null&&estimates.labor_force?Math.round(estimates.unemployed/estimates.labor_force*1000)/10:null;
    res.json({
      configured:true,provenance:"live",geography:`ZCTA ${zip}`,vintage:"ACS 5-year 2024",surveyPeriod:"2020–2024",
      population:estimates.population,median_age:estimates.median_age,households:estimates.households,household_size:estimates.household_size,
      median_income:estimates.median_income,per_capita_income:estimates.per_capita_income,median_gross_rent:estimates.median_gross_rent,
      renter_pct:renterPct,owner_pct:renterPct==null?null:Math.round((100-renterPct)*10)/10,unemployment_pct:unemploymentPct,
      marginsOfError,source:"U.S. Census Bureau ACS 2024 5-year Detailed Tables",retrievedAt:new Date().toISOString()
    });
  }catch(e){res.status(502).json({configured:true,provenance:"unavailable",vintage:"ACS 5-year 2024",error:"census_unavailable",message:e?.message||"Census API unavailable"});}
});

export default router;
