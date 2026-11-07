// Violations → dob_filings. Certifying ingestion exhausts both DOB/ECB and HPD
// violation sources. A full-city run aborts on any unavailable source instead of
// converting the failure to an empty violation history.
//
// Usage:
//   node scripts/ingest/violations.js --zips=10001 --limit=150
//   node scripts/ingest/violations.js --bbls=1008350041
import { requireStore, upsert, args, storeBbls, sleep, strictComplete, runTimestamp } from "./lib.js";
import {
  completeEcbByLot as ecbByLot,
  completeHpdViolationsByBbl as hpdViolationsByBbl
} from "../../server/adapters/nyc-complete.js";

const day = (v) => (v ? String(v).slice(0, 10) : null);

export async function ingestViolations(a) {
  const bbls = await storeBbls(a);
  const stamp = runTimestamp(a);
  const syncId = strictComplete(a) ? String(a.__fullSyncId || "") : "";
  let total = 0;
  let unavailable = 0;

  for (const bbl of bbls) {
    const [ecb, hpd] = await Promise.all([
      ecbByLot(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) })),
      hpdViolationsByBbl(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }))
    ]);

    if (!ecb?.live || !hpd?.live) {
      unavailable += 1;
      const missing = [
        !ecb?.live ? `DOB/ECB (${ecb?.error || "unavailable"})` : null,
        !hpd?.live ? `HPD (${hpd?.error || "unavailable"})` : null
      ].filter(Boolean).join("; ");
      if (strictComplete(a)) throw new Error(`[violations] ${bbl}: ${missing}; complete citywide run aborted`);
      console.warn(`[violations] ${bbl}: ${missing}; scoped run will store only sources that responded`);
    }

    const rows = [];
    for (const x of ecb?.live ? ecb.rows ?? [] : []) {
      const id = x.ecb_violation_number ?? null;
      if (!id) continue;
      rows.push({
        id: `dob_violations:ecb:${id}`,
        bbl, bin: null, source: "dob_violations",
        filing_type: `ECB — ${x.violation_type ?? "violation"}`,
        status: x.ecb_violation_status ?? null,
        filed_at: day(x.issue_date), raw: x, updated_at: stamp,
        ...(syncId ? { full_sync_id: syncId } : {})
      });
    }
    for (const x of hpd?.live ? hpd.rows ?? [] : []) {
      const id = x.violationid ?? null;
      if (!id) continue;
      rows.push({
        id: `dob_violations:hpd:${id}`,
        bbl, bin: null, source: "dob_violations",
        filing_type: `HPD class ${x.class ?? "?"} — ${String(x.novdescription ?? "").slice(0, 120)}`,
        status: x.violationstatus ?? x.currentstatus ?? null,
        filed_at: day(x.inspectiondate), raw: x, updated_at: stamp,
        ...(syncId ? { full_sync_id: syncId } : {})
      });
    }

    if (rows.length) {
      await upsert("dob_filings", rows, "id");
      total += rows.length;
    }
    console.log(`[violations] ${bbl}: ${rows.length} violations (${total} total)`);
    await sleep(120);
  }

  console.log(`[violations] done — ${total} violations across ${bbls.length} parcels; unavailable=${unavailable}`);
  return { violations: total, parcels: bbls.length, unavailable, fullSyncId: syncId || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireStore();
  ingestViolations(args()).catch((e) => { console.error(e); process.exit(1); });
}
