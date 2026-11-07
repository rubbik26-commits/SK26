// ACRIS → acris_docs. Warehouse ingestion uses the complete paged ACRIS
// adapter, not the bounded live-UI history adapter. A certifying citywide run
// fails on any unavailable parcel source instead of skipping it and issuing a
// false freshness certificate.
//
// Usage:
//   node scripts/ingest/acris.js --zips=10001 --limit=150
//   node scripts/ingest/acris.js --bbls=1008350041,1006750001
import { requireStore, upsert, args, storeBbls, sleep, strictComplete, runTimestamp } from "./lib.js";
import { completeAcrisByLot } from "../../server/adapters/nyc-complete.js";

const day = (v) => (v ? String(v).slice(0, 10) : null);
const amount = (v) => {
  const n = Number(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export async function ingestAcris(a) {
  const bbls = await storeBbls(a);
  const stamp = runTimestamp(a);
  const syncId = strictComplete(a) ? String(a.__fullSyncId || "") : "";
  let docs = 0;
  let unavailable = 0;

  for (const bbl of bbls) {
    const r = await completeAcrisByLot(bbl).catch((e) => ({ live: false, documents: [], error: e?.message || String(e) }));
    if (!r?.live) {
      unavailable += 1;
      const message = `[acris] ${bbl}: ${r?.error || "source unavailable"}`;
      if (strictComplete(a)) throw new Error(`${message}; complete citywide run aborted`);
      console.warn(`${message}; skipped (scoped run is not certifying)`);
      continue;
    }

    const rows = (r.documents ?? []).map((m) => ({
      document_id: m.document_id,
      bbl,
      doc_type: m.doc_type ?? null,
      doc_date: day(m.document_date),
      recorded_at: m.recorded_datetime ?? null,
      amount: amount(m.document_amt),
      parties: Array.isArray(m.parties) ? m.parties : [],
      raw: m,
      updated_at: stamp,
      ...(syncId ? { full_sync_id: syncId } : {})
    })).filter((x) => x.document_id);

    if (rows.length) {
      await upsert("acris_docs", rows, "document_id,bbl");
      docs += rows.length;
    }
    console.log(`[acris] ${bbl}: ${rows.length} complete documents (${docs} total)`);
    await sleep(120);
  }

  console.log(`[acris] done — ${docs} documents across ${bbls.length} parcels; unavailable=${unavailable}`);
  return { documents: docs, parcels: bbls.length, unavailable, fullSyncId: syncId || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireStore();
  ingestAcris(args()).catch((e) => { console.error(e); process.exit(1); });
}
