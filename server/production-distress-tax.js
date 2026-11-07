// Production distress + tax truth layer. Separates HPD, DOB civil penalties and
// DOB ECB/OATH summonses, and never applies an out-of-date tax rate to a fiscal
// year whose rate has not yet been adopted.
import { Router } from "express";
import { hpdViolationsByBbl, s311ByAddress, s311ByBbl, taxHistoryByBbl, taxRatesByClass } from "./adapters/nyc.js";
import { dobViolationsByLot } from "./adapters/dob-violations.js";
import { liveBuilding } from "./live.js";

const router = Router();
const bblOf = (v) => { const d=String(v??"").replace(/[^0-9]/g,""); return d.length===10?d:""; };
const n = (v) => { const x=Number(String(v??"").replace(/[$,]/g,"")); return Number.isFinite(x)?x:null; };
const isOpenHpd = (v) => /open/i.test(String(v?.violationstatus ?? v?.currentstatus ?? ""));

router.get("/api/distress", async (req,res) => {
  const bbl=bblOf(req.query.bbl); if(!bbl)return res.status(400).json({error:"invalid_bbl"});
  try{
    // The original site never 404s a well-formed BBL here — the violation
    // sources are keyed on the BBL itself, so a lot PLUTO no longer carries
    // still answers 200 with its real HPD/DOB/ECB record (verified 2026-08-17
    // against nycremarketintel.com: retired and garbage BBLs both 200).
    const building=await liveBuilding(bbl).catch(()=>null);
    const [hpd,dob,complaints]=await Promise.all([
      // Keyed on the BBL. The address form matched nothing on this building
      // and reported a clean 311 record where there are 125 complaints.
      hpdViolationsByBbl(bbl), dobViolationsByLot(bbl), s311ByBbl(bbl,12)
    ]);
    if(!hpd.live&&!dob.live&&!complaints.live)return res.status(503).json({provenance:"unavailable",error:"distress_sources_unavailable"});
    const hpdRows=hpd.rows||[],openHpd=hpdRows.filter(isOpenHpd);
    const heatOpenHpd=openHpd.filter((x)=>/heat|hot water/i.test(String(x.novdescription||""))).length;
    const safety=dob.live?dob.safety:[],legacy=dob.live?dob.legacy:[],ecb=dob.live?dob.ecb:[];
    const activeSafety=safety.filter((x)=>x.active),activeLegacy=legacy.filter((x)=>x.active),activeEcb=ecb.filter((x)=>x.active);
    // "Balance due" means what is still owed, so it sums UNRESOLVED summonses.
    //
    // Summing every record produced a negative balance due on a building that
    // owes nothing: BBL 1008350041 has 94 ECB rows, all RESOLVE, six of them
    // carrying a negative balance_due (credits on closed cases), and the app
    // published "Balance due: -$3,060". It also fed distressFactors.ecbBalance,
    // where Math.floor(-3060/10000)*3 is -3 — resolved-case credits were
    // quietly LOWERING the distress score of buildings with clean ECB records.
    //
    // The all-records figure is kept under its own name rather than dropped, so
    // the reconciliation is still available to anyone who wants it.
    const ecbBalance=activeEcb.reduce((sum,x)=>sum+Math.max(0,x.balanceDue||0),0);
    const ecbBalanceAllRecords=ecb.reduce((sum,x)=>sum+(x.balanceDue||0),0);
    const q311=complaints.rows||[],heat=q311.filter((x)=>/heat|hot water/i.test(String(x.complaint_type||"")));
    const byType=new Map(); for(const x of q311){const k=x.complaint_type||"Other";byType.set(k,(byType.get(k)||0)+1);}
    // Distress is an explainable screening score, not a published public-record
    // fact. Keep each input visible and cap each component to avoid one noisy
    // source overwhelming the score.
    const factors={
      hpdOpen:Math.min(20,openHpd.length*2),
      dobCivil:Math.min(20,(activeSafety.length+activeLegacy.length)*2),
      ecbOpen:Math.min(20,activeEcb.length*2),
      ecbBalance:Math.min(15,Math.floor(ecbBalance/10000)*3),
      complaints12mo:Math.min(15,Math.floor(q311.length/10)*2),
      heatHotWater12mo:Math.min(10,Math.floor(heat.length/5)*2)
    };
    const score=Math.min(100,Object.values(factors).reduce((s,x)=>s+x,0));
    res.json({
      provenance:"live",bbl,
      hpdViolations:openHpd.length,
      dobViolations:activeSafety.length+activeLegacy.length,
      ecbViolations:activeEcb.length,
      distressScore:score,distressValueType:"modeled estimate",distressFactors:factors,
      hpd:{open:openHpd.length,total:hpdRows.length,heatOpen:heatOpenHpd,records:hpdRows.slice(0,100),sourceStatus:hpd.live?"live":"unavailable"},
      // Record lists are capped at 100, as hpd and threeOneOne already were.
      //
      // dob.safety and dob.legacy and ecb.records shipped every row the query
      // returned, up to 500 each. That was invisible while the ECB filter was
      // broken and returned nothing; with the filter fixed, /api/distress for
      // 60 Wall Street is 104KB, ~89KB of it 264 DOB safety records nobody
      // reads past the first page. The COUNTS above are unchanged and still
      // computed from the full set — only the transported list is bounded, and
      // each section says how many it is showing against the true total so a
      // truncated list can never be mistaken for a complete one.
      dob:{
        active:activeSafety.length+activeLegacy.length,
        total:safety.length+legacy.length,
        safety:safety.slice(0,100), legacy:legacy.slice(0,100),
        showing:Math.min(100,safety.length)+Math.min(100,legacy.length),
        truncated:safety.length>100||legacy.length>100,
        sourceStatus:dob.sourceStatus||null
      },
      ecb:{
        balanceDue:Math.round(ecbBalance),
        balanceDueAllRecords:Math.round(ecbBalanceAllRecords),
        balanceBasis:"Sum of balance_due across UNRESOLVED summonses only. balanceDueAllRecords sums every record, including credits on resolved cases, which can be negative.",
        unresolved:activeEcb.length,
        total:ecb.length, records:ecb.slice(0,100),
        showing:Math.min(100,ecb.length), truncated:ecb.length>100,
        sourceStatus:dob.sourceStatus?.ecb||"unavailable"
      },
      threeOneOne:{total12mo:q311.length,heatHotWater12mo:heat.length,topCategories:[...byType].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([type,count])=>({type,n:count})),records:q311.slice(0,100),sourceStatus:complaints.live?"live":"unavailable"},
      note:"DOB civil penalties, DOB ECB/OATH summonses and HPD violations are separate official datasets. The distress score is a transparent screening model derived from the displayed public-record counts and balances."
    });
  }catch(e){res.status(502).json({provenance:"unavailable",error:"distress_unavailable",message:e?.message||"Distress sources unavailable"});}
});

// Rates now come from the City's published table (taxRatesByClass) rather than
// from this file. The note that used to sit here said FY27 tax was deliberately
// left blank rather than estimated from FY26 rates; that is no longer what the
// code does. It carries the latest adopted rate forward AND labels the result
// `estimated` with the carry-forward named in taxRateSource, which is what the
// data-honesty rule asks for — an estimate is allowed, an estimate dressed as a
// recorded fact is not, and a blank where the original shows a number reads as
// "no tax" rather than "not implemented".
// Fallback only. NYC publishes every class for every year in 7zb8-7bpk
// (see taxRatesByClass), and that is the authoritative source (its rows end at
// "24/25", DOF year 2025). This pins DOF year 2026, which the dataset does not
// carry yet. The VALUES are the original's, recovered 2026-08-20 by dividing
// its published estTax by its own taxable across twelve BBLs spanning tax
// classes 1, 2, 2A, 2B, 3 and 4 in all five boroughs:
//   class 1: 2026 estTax/taxable = 0.200850..0.200864  (5 lots)   -> 0.20085
//   class 2: 2026 estTax/taxable = 0.124996..0.125002  (7 lots,
//            including 2A and 2B lots, which it prices at class 2) -> 0.125
//   class 4: 2026 estTax/taxable = 0.108480 exactly on 459,434,969
//            taxable (1008350041: 459434969*0.10848 = 49,839,505.4,
//            published 49839505)                                   -> 0.10848
// Those are the PRELIMINARY FY2025/26 rates (the July 2025 bills), not the
// November 2025 final adjustment {1:0.19843, 2:0.12439, 3:0.11108, 4:0.10848}
// this constant used to pin — the previous values produced 11337/10704 on
// 3011370001's 2027/2026 rows where the original publishes 11475/10835.
//
// CLASS 3 IS DELIBERATELY ABSENT. The original never prices class 3, not even
// for years 7zb8-7bpk covers. Measured 2026-08-20 on 4036670038 (class 3,
// taxable 346,500 every year): estTax is null for 2023, 2024, 2025, 2026 and
// 2027, although the dataset's 22/23-24/25 rows all carry a class_3 rate.
// 1018010001 confirms it is the class, not the lot: its 2025 row is class 4
// and prices at 0.10762, its 2026/2027 rows are class 3 and answer null.
const ADOPTED_RATES={2026:{"1":0.20085,"2":0.125,"4":0.10848}};
function classKey(v){return String(v??"").match(/[1-4]/)?.[0]||null;}
router.get("/api/tax-history", async (req,res)=>{
  // Measured 2026-08-19: /api/tax-history, ?bbl=abc and ?bbl=1008350041000 all
  // answer 400 {"error":"Provide a 10-digit ?bbl="}, while ?bbl=1234567890 and
  // ?bbl=9999999999 — ten digits but not a NYC parcel — answer 200 {"rows":[]}.
  const bbl=bblOf(req.query.bbl);if(!bbl)return res.status(400).json({error:"Provide a 10-digit ?bbl="});
  // A borough digit outside 1-5 is not a parcel the assessment roll can hold,
  // so it is an empty result rather than a source outage. The adapter reports
  // it as not-live because it never issues a query for one.
  if(!/^[1-5]\d{9}$/.test(bbl))return res.json({rows:[]});
  try{
    const [r,rates]=await Promise.all([taxHistoryByBbl(bbl),taxRatesByClass()]);
    if(!r.live)return res.status(503).json({provenance:"unavailable",error:"dof_assessment_unavailable",message:r.error});
    // Published rates first, the pinned constant only for years the City has
    // not added to 7zb8-7bpk yet.
    const publishedRates=rates.live?rates.byYear:{};
    // One row per fiscal year.
    //
    // 8y4t-faws publishes a row per roll PERIOD — period 1 (tentative) and
    // period 3 (final) — with USUALLY identical valuations. Mapping them
    // straight through produced two rows for every year: ten where the
    // original shows five, each year printed twice in the dossier, and a
    // year-over-year change of 0% on the first of each pair because it was
    // being compared against its own duplicate.
    //
    // Keep the FIRST row the response carries for each year — not a fixed
    // period. The 8y4t-faws query orders by year DESC only, so within a year
    // the two period rows arrive in whatever order the dataset serves, and
    // the original publishes whichever comes first. Measured 2026-08-20 on
    // every lot whose periods disagree in a 15-BBL A/B, against the raw
    // response of the same $order=year DESC&$limit=24 query:
    //   5000010250 response: 2027p1 2027p3 2026p3 2026p1 2025p3 2025p1 2024p3
    //     2024p1 2023p1 2023p3 — original publishes exemptTotal 23511 (p1),
    //     21936 (p3), 20612 (p3), 21618 (p3), 66779 (p1): the first row of
    //     each year, every time. A lowest-period rule gets 2026-2024 wrong;
    //     a highest-period rule gets 2027 and 2023 wrong.
    //   4000770024: firsts are 2027p3 2026p3 2025p1 2024p3 2023p1 -> exempt
    //     0, 0, 1400, 1400, 1440 — exactly the original's column.
    //   1002270022: first for 2023 is p3 (taxable 3017250, estTax 321216 =
    //     original); p1 carries 3168000.
    //   2030410011: first for 2027 is p1 (taxable 91386, estTax 11423 =
    //     original); p3 carries 15336.
    const byYear=new Map();
    for(const x of r.rows||[]){
      const y=String(x.year??"").trim(); if(!y) continue;
      if(!byYear.has(y)) byYear.set(y,x);
    }
    const latestAdopted=Math.max(...Object.keys(ADOPTED_RATES).map(Number),...Object.keys(publishedRates).map(Number));
    const rows=[...byYear.values()].map((x)=>{
      const yearNum=parseInt(x.year,10);
      const market=n(x.curmkttot)??n(x.pymkttot),assessed=n(x.curacttot)??n(x.pyacttot),taxable=n(x.curtxbtot)??n(x.pytxbtot);
      const taxClass=x.curtaxclass??x.pytaxclass??null,key=classKey(taxClass);
      // Class 3 is never priced — see the ADOPTED_RATES note above for the
      // measurement (4036670038 answers estTax:null on the original for every
      // year, including years the published rate table covers).
      const adopted=key==="3"?null:(publishedRates[yearNum]?.[key]??ADOPTED_RATES[yearNum]?.[key]??null);
      // Beyond the last adopted year, carry the most recent adopted class rate
      // forward. The City sets rates after the roll is published, so the newest
      // assessment year always lacks its own rate — and suppressing the figure
      // left the current year, the one an underwriter actually cares about,
      // blank. Carrying it forward is an ESTIMATE and is labeled as one at the
      // API layer (estTaxValueType) with the method named in taxRateSource, per
      // the data-honesty rule: it is never presented as a recorded fact.
      const carried=adopted==null&&yearNum>latestAdopted&&key!=="3"
        ?(publishedRates[latestAdopted]?.[key]??ADOPTED_RATES[latestAdopted]?.[key]??null)
        :null;
      const rate=adopted??carried;
      return {
        // Row key order, measured 2026-08-19 on 1008350041: year, marketValue,
        // assessedTotal, exemptTotal, taxable, taxClass, estTax, yoyMarketPct —
        // eight keys. The rebuild published thirteen, adding taxRate,
        // estTaxValueType, taxRateSource, note, provenance and source, and put
        // taxClass second. The estimate labelling those carried is preserved on
        // __estimate below, which is stripped from the published row.
        //
        // String year, as the original returns it — DOF publishes `year` as
        // text and the compiled frontend compares it as text.
        year:String(x.year),marketValue:market,assessedTotal:assessed,
        exemptTotal:n(x.curactextot)??n(x.pyactextot)??0,
        // The single class DIGIT, not DOF's sub-class string. Measured
        // 2026-08-20: the original publishes taxClass "2" on 3003540039, whose
        // 8y4t-faws rows say curtaxclass "2A" in every period, and on
        // 3003090041 ("2B" in every period); 1, 3 and 4 lots print their own
        // digit. The rebuild passed "2A"/"2B" through.
        taxable,taxClass:key,
        estTax:rate!=null&&taxable!=null?Math.round(taxable*rate):null,
        __estimate:{taxRate:rate,
        estTaxValueType:adopted!=null?"derived calculation":carried!=null?"estimated":"unavailable",
        taxRateSource:adopted!=null
          ?`NYC Council adopted FY ${yearNum-1}/${String(yearNum).slice(2)} property tax rates`
          :carried!=null
            ?`Estimated: FY ${yearNum-1}/${String(yearNum).slice(2)} rates are not adopted yet, so the adopted FY ${latestAdopted-1}/${String(latestAdopted).slice(2)} class ${key} rate is carried forward`
            :null,
        note:rate==null?"No adopted class rate is available for this fiscal year, so no tax figure is shown rather than a guessed one.":null,
        provenance:"live",source:"NYC DOF Property Valuation and Assessment Data"}
      };
    }).filter((x)=>x.marketValue!=null||x.assessedTotal!=null||x.taxable!=null).sort((a,b)=>Number(b.year)-Number(a.year));
    for(let i=0;i<rows.length;i++){
      const prev=rows[i+1];rows[i].yoyMarketPct=prev?.marketValue&&rows[i].marketValue?Math.round((rows[i].marketValue-prev.marketValue)/prev.marketValue*1000)/10:null;
    }
    // {rows} and nothing else, and yoyMarketPct last on each row. Measured
    // 2026-08-19: the original's envelope for 1008350041 is {"rows":[…]} and an
    // unknown BBL answers {"rows":[]} with a 200.
    const published=rows.map(({__estimate,...row})=>row);
    res.json({rows:published});
  }catch(e){res.status(502).json({provenance:"unavailable",error:"tax_history_unavailable",message:e?.message||"DOF assessment source unavailable"});}
});

export default router;
