// DOF Property Valuation & Assessment roll → tax_bills. Certifying ingestion
// exhausts the assessment history for every selected parcel and aborts a full
// citywide run if the source is unavailable.
//
// Usage:
//   node scripts/ingest/tax.js --zips=10001 --limit=150
//   node scripts/ingest/tax.js --bbls=1008350041
import { requireStore, upsert, args, storeBbls, sleep, strictComplete, runTimestamp } from "./lib.js";
import { completeTaxHistoryByBbl } from "../../server/adapters/nyc-complete.js";

const num = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };

export async function ingestTax(a) {
  const bbls = await storeBbls(a);
  const stamp = runTimestamp(a);
  const syncId = strictComplete(a) ? String(a.__fullSyncId || "") : "";
  let bills = 0;
  let unavailable = 0;

  for (const bbl of bbls) {
    const r = await completeTaxHistoryByBbl(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }));
    if (!r?.live) {
      unavailable += 1;
      const message = `[tax] ${bbl}: ${r?.error || "source unavailable"}`;
      if (strictComplete(a)) throw new Error(`${message}; complete citywide run aborted`);
      console.warn(`${message}; skipped (scoped run is not certifying)`);
      continue;
    }

    const byYear = new Map();
    for (const x of r.rows ?? []) {
      const year = parseInt(x.year, 10);
      if (!Number.isFinite(year)) continue;
      // PVAD can publish tentative/final rows for the same fiscal year. Preserve
      // the last row in deterministic year/period order, matching the existing
      // one-row-per-BBL/year warehouse key without fabricating a second grain.
      byYear.set(year, {
        bbl, year,
        tax_class: x.curtaxclass ?? x.pytaxclass ?? null,
        market_value: num(x.curmkttot) ?? num(x.pymkttot),
        assessed_total: num(x.curacttot) ?? num(x.pyacttot),
        taxable: num(x.curtxbtot) ?? num(x.pytxbtot),
        raw: x,
        updated_at: stamp,
        ...(syncId ? { full_sync_id: syncId } : {})
      });
    }
    const rows = [...byYear.values()];
    if (rows.length) {
      await upsert("tax_bills", rows, "bbl,year");
      bills += rows.length;
    }
    console.log(`[tax] ${bbl}: ${rows.length} years (${bills} total)`);
    await sleep(120);
  }

  console.log(`[tax] done — ${bills} bill-years across ${bbls.length} parcels; unavailable=${unavailable}`);
  return { billYears: bills, parcels: bbls.length, unavailable, fullSyncId: syncId || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireStore();
  ingestTax(args()).catch((e) => { console.error(e); process.exit(1); });
}
