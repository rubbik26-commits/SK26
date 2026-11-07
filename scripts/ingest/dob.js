// DOB → dob_filings. Certifying ingestion uses complete paged DOB NOW and DOB
// Permit Issuance pulls. A full-city run aborts if either source is unavailable
// for any selected parcel; scoped runs remain non-certifying and report partial
// source availability explicitly.
//
// Usage:
//   node scripts/ingest/dob.js --zips=10001 --limit=150
//   node scripts/ingest/dob.js --bbls=1008350041
import { requireStore, upsert, args, storeBbls, sleep, strictComplete, runTimestamp } from "./lib.js";
import { completeDobNowByLot, completeDobPermitsByLot } from "../../server/adapters/nyc-complete.js";

const day = (v) => (v ? String(v).slice(0, 10) : null);

export async function ingestDob(a) {
  const bbls = await storeBbls(a);
  const stamp = runTimestamp(a);
  const syncId = strictComplete(a) ? String(a.__fullSyncId || "") : "";
  let filings = 0;
  let unavailable = 0;

  for (const bbl of bbls) {
    const [nowR, permitsR] = await Promise.all([
      completeDobNowByLot(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) })),
      completeDobPermitsByLot(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }))
    ]);

    if (!nowR?.live || !permitsR?.live) {
      unavailable += 1;
      const missing = [
        !nowR?.live ? `DOB NOW (${nowR?.error || "unavailable"})` : null,
        !permitsR?.live ? `DOB Permit Issuance (${permitsR?.error || "unavailable"})` : null
      ].filter(Boolean).join("; ");
      if (strictComplete(a)) throw new Error(`[dob] ${bbl}: ${missing}; complete citywide run aborted`);
      console.warn(`[dob] ${bbl}: ${missing}; scoped run will store only sources that responded`);
    }

    const rows = [];
    for (const x of nowR?.live ? nowR.rows ?? [] : []) {
      const id = x.job_filing_number ?? null;
      if (!id) continue;
      rows.push({
        id: `dob_now:${id}`,
        bbl, bin: x.bin ?? null, source: "dob_now",
        filing_type: x.job_type ?? null, status: x.filing_status ?? null,
        filed_at: day(x.filing_date), raw: x, updated_at: stamp,
        ...(syncId ? { full_sync_id: syncId } : {})
      });
    }
    for (const x of permitsR?.live ? permitsR.rows ?? [] : []) {
      // DOB Permit Issuance publishes permit_sequence__; include it so multiple
      // permits under the same job/date cannot collapse into one warehouse row.
      const id = [x.job__, x.permit_sequence__, x.issuance_date].filter(Boolean).join(":");
      if (!id) continue;
      rows.push({
        id: `dob_permits:${id}`,
        bbl, bin: x.bin__ ?? null, source: "dob_permits",
        filing_type: x.job_type ?? x.permit_type ?? null,
        status: x.permit_status ?? null,
        filed_at: day(x.issuance_date ?? x.filing_date), raw: x, updated_at: stamp,
        ...(syncId ? { full_sync_id: syncId } : {})
      });
    }

    if (rows.length) {
      await upsert("dob_filings", rows, "id");
      filings += rows.length;
    }
    console.log(`[dob] ${bbl}: ${rows.length} filings (${filings} total)`);
    await sleep(120);
  }

  console.log(`[dob] done — ${filings} filings across ${bbls.length} parcels; unavailable=${unavailable}`);
  return { filings, parcels: bbls.length, unavailable, fullSyncId: syncId || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireStore();
  ingestDob(args()).catch((e) => { console.error(e); process.exit(1); });
}
