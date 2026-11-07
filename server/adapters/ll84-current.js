// Current consolidated NYC DOB LL84 disclosure (calendar year 2022-present).
// Dataset 5zyy-y8am was verified from NYC Open Data and is updated annually.
import { soql } from "./socrata.js";

export const LL84_CURRENT_DATASET = "5zyy-y8am";
const clean = (v) => String(v ?? "").replace(/\.0$/, "").replace(/[^0-9]/g, "");

export async function currentLl84ByBbl(bbl) {
  const wanted=clean(bbl);
  if(wanted.length!==10)return {live:false,rows:[],error:"invalid bbl",dataset:{id:LL84_CURRENT_DATASET}};
  // NYC has used more than one BBL API-field spelling across LL84 vintages.
  // Query each known current-contract candidate and leave rows untouched so the
  // Dossier can expose the original published record/provenance.
  // Candidate order matters, but the loop's exit condition matters more. The
  // dataset's actual column is nyc_borough_block_and_lot (verified 2026-08-17:
  // it answers 200; the other three answer 400 no-such-column). The old loop
  // only stopped on live-AND-rows, so every building with NO disclosure — most
  // small buildings — fell through to three guaranteed HTTP 400s. Each 400 was
  // recorded by the socrata staleness registry as a 5zyy-y8am failure, which
  // production-live-guard then displayed inside unrelated 503 envelopes ("the
  // source is degraded" on a transit request, blaming the energy dataset).
  // A live response with zero rows means the column exists and the building
  // has no LL84 record — that is the answer, not a reason to try a wrong column.
  const candidates=["nyc_borough_block_and_lot","bbl_10_digits","bbl","nyc_borough_block_and_lot_bbl"];
  let lastError=null;
  for(const field of candidates){
    // Ordered by report year DESC, and the cap raised past what a campus BBL
    // actually holds. With $limit:50 and no $order, BBL 5000760200 — Snug
    // Harbor, 111 LL84 rows across 2022/2023/2024 — came back as fifty 2023
    // rows and NEVER SAW 2024: the dossier published ghg 1805 / reportYear 2023
    // where the original publishes 2094 / 2024. Every multi-row lot probed
    // (2031200020, 2026050040, 4071150002, 4077540003) has the original on the
    // LATEST year, so the newest rows must be in the page.
    const r=await soql(LL84_CURRENT_DATASET,{
      $where:`${field}='${wanted}'`,$order:"report_year DESC",$limit:400
    },{ttlMs:12*60*60*1000,timeoutMs:20000});
    if(r.live&&!(r.rows?.length)){
      return {live:true,rows:[],dataset:{id:LL84_CURRENT_DATASET,name:"NYC Building Energy and Water Data Disclosure for Local Law 84 2023 to Present"},retrievedAt:new Date().toISOString()};
    }
    if(r.live&&r.rows?.length){
      const rows=[...r.rows].sort((a,b)=>{
        const ya=Number(a.calendar_year||a.report_year||a.year||String(a.year_ending||"").slice(0,4))||0;
        const yb=Number(b.calendar_year||b.report_year||b.year||String(b.year_ending||"").slice(0,4))||0;
        return yb-ya;
      });
      return {live:true,rows,dataset:{id:LL84_CURRENT_DATASET,name:"NYC Building Energy and Water Data Disclosure for Local Law 84 2023 to Present"},retrievedAt:new Date().toISOString()};
    }
    if(!r.live)lastError=r.error;
  }
  return {live:lastError==null,rows:[],error:lastError,dataset:{id:LL84_CURRENT_DATASET,name:"NYC Building Energy and Water Data Disclosure for Local Law 84 2023 to Present"},retrievedAt:new Date().toISOString()};
}
