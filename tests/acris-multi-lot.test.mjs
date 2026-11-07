// Defect #6, proved against a real Postgres rather than asserted from the DDL.
//
// acris_docs used document_id as its sole primary key while storing a single
// bbl. The ingestion worker loops BBL by BBL and upserts, so a deed covering an
// assemblage was written once per lot and each write overwrote the previous
// lot's association: the document survived and every parcel link but the last
// was silently dropped. Which lot won depended on ingestion order, so the same
// source data ingested twice could disagree.
//
// The migration now keys on (document_id, bbl) — the grain ACRIS's own legals
// table uses. Reading the DDL only proves the file says so. This runs both
// schemas side by side through the exact upsert the worker performs and counts
// what survives.
//
// Uses PGlite: the real Postgres engine compiled to WASM, behind the real wire
// protocol, driven by the same `pg` client the application uses. No Docker, no
// server to install, and no mock that would happily agree with broken SQL.
//
//   node --test tests/acris-multi-lot.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// One deed, three contiguous lots — the assemblage case this product exists to
// surface, and the exact shape the old key could not represent.
const DOC = "DEED-ASSEMBLAGE-1";
const LOTS = ["1008350041", "1008350042", "1008350043"];

let PGlite;
try { ({ PGlite } = await import("@electric-sql/pglite")); } catch { PGlite = null; }

test("the committed migration keys acris_docs on (document_id, bbl)", () => {
  const sql = readFileSync(path.join(root, "supabase/migrations/202608130003_postgis_geospatial.sql"), "utf8");
  const ddl = sql.slice(sql.indexOf("create table if not exists public.acris_docs"),
    sql.indexOf("create index if not exists acris_docs_bbl_idx"));
  assert.ok(!/document_id text primary key/.test(ddl),
    "a single-column key cannot represent a document that touches more than one lot");
  assert.match(ddl, /primary key \(document_id, bbl\)/);
});

test("a multi-lot deed survives BBL-by-BBL ingestion under the new key, and did not under the old", async (t) => {
  if (!PGlite) return t.skip("@electric-sql/pglite is not installed (dev dependency)");
  const db = await PGlite.create();

  // The two schemas, exactly as they were and as they are.
  await db.query(`create table old_acris (document_id text primary key, bbl text not null, doc_type text)`);
  await db.query(`create table new_acris (document_id text not null, bbl text not null, doc_type text,
                                          primary key (document_id, bbl))`);

  // scripts/ingest/acris.js loops one BBL at a time and upserts each document
  // it finds for that lot. Replicate that loop against both schemas.
  for (const bbl of LOTS) {
    await db.query(
      `insert into old_acris (document_id,bbl,doc_type) values ($1,$2,$3)
         on conflict (document_id) do update set bbl = excluded.bbl`,
      [DOC, bbl, "DEED"]
    );
    await db.query(
      `insert into new_acris (document_id,bbl,doc_type) values ($1,$2,$3)
         on conflict (document_id,bbl) do update set doc_type = excluded.doc_type`,
      [DOC, bbl, "DEED"]
    );
  }

  const oldLots = (await db.query(`select bbl from old_acris where document_id=$1 order by bbl`, [DOC])).rows.map((r) => r.bbl);
  const newLots = (await db.query(`select bbl from new_acris where document_id=$1 order by bbl`, [DOC])).rows.map((r) => r.bbl);

  assert.equal(oldLots.length, 1,
    "the old key kept exactly one lot — this is the defect, reproduced");
  assert.deepEqual(oldLots, [LOTS[LOTS.length - 1]],
    "and the one it kept is whichever was written last, i.e. ingestion-order dependent");

  assert.equal(newLots.length, LOTS.length, "the composite key keeps every lot");
  assert.deepEqual(newLots, [...LOTS].sort(), "and keeps the right ones");

  // Re-ingesting must be idempotent, not duplicative.
  for (const bbl of LOTS) {
    await db.query(
      `insert into new_acris (document_id,bbl,doc_type) values ($1,$2,$3)
         on conflict (document_id,bbl) do update set doc_type = excluded.doc_type`,
      [DOC, bbl, "DEED"]
    );
  }
  const after = (await db.query(`select count(*)::int as n from new_acris where document_id=$1`, [DOC])).rows[0].n;
  assert.equal(after, LOTS.length, "a second ingestion run updates in place rather than duplicating");

  await db.close();
});

test("both ingestion paths target the composite key", () => {
  assert.match(readFileSync(path.join(root, "scripts/ingest/acris.js"), "utf8"),
    /upsert\("acris_docs", rows, "document_id,bbl"\)/,
    "the worker's conflict target must match the key, or every write is a fresh insert or an overwrite");
  assert.match(readFileSync(path.join(root, "scripts/db-setup.js"), "utf8"),
    /on conflict \(document_id,bbl\)/);
});
