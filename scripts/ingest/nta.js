// 2020 Neighborhood Tabulation Areas → ntas. The certifying path exhausts the
// official Socrata dataset in deterministic NTA-code order; a safety ceiling
// fails closed instead of returning a partial polygon set.
//
// Usage: node scripts/ingest/nta.js
import { requireStore, rpc, args, chunked, strictComplete } from "./lib.js";
import { soqlAll } from "../../server/adapters/socrata.js";

const DATASET = "9nt8-h7nd";

export async function ingestNtas(a = {}) {
  const source = await soqlAll(DATASET, {
    $select: "nta2020,ntacode,ntaname,boroname,the_geom",
    $order: "nta2020 ASC"
  }, {
    pageSize: 500,
    maxRows: 10000,
    timeoutMs: 60000,
    retries: 2,
    ttlMs: 24 * 60 * 60 * 1000
  });
  if (!source.live || source.complete !== true) {
    throw new Error(`NTA source incomplete: ${source.error || "unknown source failure"}`);
  }

  const mapped = (source.rows || []).map((x) => ({
    nta_code: x.nta2020 ?? x.ntacode ?? null,
    name: x.ntaname ?? null,
    boro: x.boroname ?? null,
    geom: x.the_geom ?? null
  })).filter((x) => x.nta_code);

  if (mapped.length !== source.rows.length) {
    throw new Error(`NTA completeness failure: source rows=${source.rows.length}, rows with NTA code=${mapped.length}`);
  }

  const fullSyncId = strictComplete(a) ? String(a.__fullSyncId || "") : "";
  if (strictComplete(a) && !/^[0-9a-f-]{36}$/i.test(fullSyncId)) {
    throw new Error("Strict NTA ingest requires a full-sync UUID from run-all.");
  }

  let total = 0;
  for (const batch of chunked(mapped, 25)) {
    const n = Number(await rpc("ingest_ntas", { p_rows: batch })) || 0;
    if (n !== batch.length) {
      throw new Error(`NTA ingest count mismatch: batch=${batch.length}, upserted=${n}`);
    }
    if (fullSyncId) {
      const marked = Number(await rpc("mark_nta_full_sync", {
        p_nta_codes: batch.map((x) => x.nta_code),
        p_full_sync_id: fullSyncId
      })) || 0;
      if (marked !== batch.length) {
        throw new Error(`NTA full-sync marking mismatch: batch=${batch.length}, marked=${marked}`);
      }
    }
    total += n;
  }
  if (total !== mapped.length) {
    throw new Error(`NTA ingest count mismatch: source=${mapped.length}, upserted=${total}`);
  }

  console.log(`[nta] done — ${total} NTA polygons; complete source traversal verified`);
  return { polygons: total, complete: true, fullSyncId: fullSyncId || null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  requireStore();
  ingestNtas(args()).catch((e) => { console.error(e); process.exit(1); });
}
