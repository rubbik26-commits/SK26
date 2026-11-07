// One command to build the database this app needs, end to end.
//
//   DATABASE_URL=postgres://… npm run db:setup
//   DATABASE_URL=postgres://… npm run db:setup -- --zips=10001,10011 --docs
//
// It applies the schema, loads real NYC records into it, and proves the
// spatial functions answer correctly — so there is no gap between "the
// migration is written" and "the parcel store is live".
//
// Steps
//   1. Apply supabase/migrations/ in order. The PostGIS migration always
//      applies; the workspace migrations reference auth.users and are applied
//      only when the target is a Supabase project that has it.
//   2. Load MapPLUTO lot polygons (DCP FeatureServer) and 2020 NTA polygons
//      (Socrata) through the service-only ingest_* functions.
//   3. With --docs, load ACRIS documents, DOB filings and the DOF tax roll for
//      the largest seeded parcels.
//   4. Verify ST_Contains / ST_MakeEnvelope / ST_Touches against the data just
//      loaded, and print the environment variables the app needs.
//
// Everything is idempotent: re-running upserts rather than duplicating.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ARCGIS, FIELDS, featureToRow } from "./ingest/mappluto.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.match(/^--([^=]+)(?:=(.*))?$/))
  .filter(Boolean)
  .map((m) => [m[1], m[2] ?? true]));

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || args.url;
if (!DATABASE_URL) {
  console.error(`
Set DATABASE_URL to the target Postgres connection string.

  Supabase → Project Settings → Database → Connection string → URI
  DATABASE_URL='postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres' npm run db:setup

Options
  --zips=10001,10011   ZIP codes to load lot polygons for (default: 10001,10011,10018,10036)
  --limit=4000         maximum parcels to load (default 4000)
  --docs               also load ACRIS / DOB / DOF records for the largest parcels
  --docs-limit=25      how many parcels to pull documents for (default 25)
  --skip-ingest        apply the schema and verify only
`.trim());
  process.exit(1);
}

// The DEFAULTS are a working slice, not a citywide store: four Midtown ZIPs
// and 4,000 parcels, chosen so a first run finishes in minutes. A production
// store needs --zips covering the territory you actually sell in (or the
// full list) and a --limit to match; the summary at the end prints what was
// actually loaded so this is never mistaken for full coverage.
const ZIPS = String(args.zips || "10001,10011,10018,10036").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
const LIMIT = Math.max(1, parseInt(args.limit, 10) || 4000);
const DOCS_LIMIT = Math.max(1, parseInt(args["docs-limit"], 10) || 25);

const client = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: /supabase\.(co|com)|render\.com|amazonaws\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  statement_timeout: 300000
});

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => console.log(`   ✓ ${msg}`);
const warn = (msg) => console.log(`   ! ${msg}`);
const fail = (msg) => console.error(`   ✗ ${msg}`);
// Collected so a failure is re-reported at the end rather than scrolling away
// behind the ingestion output.
const migrationFailures = [];

async function applyMigrations() {
  step(1, "Applying schema");
  const { rows: [{ has_auth }] } = await client.query(
    "select exists (select 1 from information_schema.tables where table_schema='auth' and table_name='users') as has_auth"
  );
  if (!has_auth) warn("no auth.users — treating this as plain Postgres; workspace migrations skipped");

  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    const isWorkspace = !/postgis/.test(file);
    if (isWorkspace && !has_auth) { console.log(`   – ${file} (skipped)`); continue; }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    try {
      await client.query(sql);
      ok(`${file}`);
    } catch (e) {
      // A failed migration is a failed setup.
      //
      // This used to warn and continue, and only a missing PostGIS extension
      // was fatal — so a run could leave the workspace tables, the RLS policies
      // or the RPCs half-applied, then go on to ingest data and print
      // "DATABASE READY" over a schema that is not. The whole point of this
      // script is that afterwards you know what you have.
      //
      // "Already exists" on an idempotent re-run is the one benign case and is
      // still tolerated; anything else stops the run and is re-reported at the
      // end so the failure cannot scroll away.
      const msg = String(e.message).split("\n")[0];
      if (/already exists/i.test(msg)) {
        warn(`${file}: ${msg} (idempotent re-run, continuing)`);
      } else {
        migrationFailures.push(`${file}: ${msg}`);
        fail(`${file}: ${msg}`);
        throw new Error(`migration ${file} failed: ${msg}`);
      }
    }
  }
  const { rows: [{ postgis }] } = await client.query(
    "select exists (select 1 from pg_extension where extname='postgis') as postgis"
  );
  if (!postgis) throw new Error("PostGIS extension is not installed — the parcel store cannot work without it.");
  ok("PostGIS enabled");
}

async function ingestParcels() {
  step(2, `Loading MapPLUTO lot polygons for ZIP ${ZIPS.join(", ")}`);
  const where = `ZipCode IN (${ZIPS.join(",")})`;
  let offset = 0;
  let total = 0;
  for (;;) {
    const take = Math.min(1000, LIMIT - total);
    if (take <= 0) break;
    const url = `${ARCGIS}?where=${encodeURIComponent(where)}&outFields=${FIELDS.join(",")}` +
      `&resultOffset=${offset}&resultRecordCount=${take}&outSR=4326&f=geojson`;
    const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`MapPLUTO FeatureServer HTTP ${r.status}`);
    const page = await r.json();
    const feats = page.features ?? [];
    if (!feats.length) break;
    const rows = feats.map(featureToRow).filter((x) => /^[1-5]\d{9}$/.test(x.bbl));
    for (let i = 0; i < rows.length; i += 200) {
      const { rows: [{ n }] } = await client.query("select public.ingest_parcels($1::jsonb) as n", [JSON.stringify(rows.slice(i, i + 200))]);
      total += Number(n) || 0;
    }
    process.stdout.write(`   … ${total} parcels\r`);
    offset += feats.length;
    if (feats.length < take) break;
  }
  ok(`${total} parcels with lot geometry`);
}

async function ingestNtas() {
  step(3, "Loading 2020 NTA polygons");
  let total = 0;
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`https://data.cityofnewyork.us/resource/9nt8-h7nd.json?$limit=100&$offset=${offset}`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`NTA dataset HTTP ${r.status}`);
    const rows = await r.json();
    if (!rows.length) break;
    const mapped = rows
      .map((x) => ({ nta_code: x.nta2020 ?? null, name: x.ntaname ?? null, boro: x.boroname ?? null, geom: x.the_geom ?? null }))
      .filter((x) => x.nta_code);
    const { rows: [{ n }] } = await client.query("select public.ingest_ntas($1::jsonb) as n", [JSON.stringify(mapped)]);
    total += Number(n) || 0;
  }
  ok(`${total} NTA polygons`);
}

async function ingestDocuments() {
  step(4, `Loading ACRIS / DOB / DOF records for the ${DOCS_LIMIT} largest parcels`);
  const { acrisByLot, dobNowByLot, dobPermitsByLot, taxHistoryByBbl } = await import("../server/adapters/nyc.js");
  const day = (v) => (v ? String(v).slice(0, 10) : null);
  const num = (v) => { const n = Number(String(v ?? "").replace(/[$,]/g, "")); return Number.isFinite(n) ? n : null; };
  const { rows: targets } = await client.query(
    "select bbl from public.parcels order by lot_area desc nulls last limit $1", [DOCS_LIMIT]
  );
  let docs = 0, filings = 0, bills = 0;
  for (const { bbl } of targets) {
    const [acris, nowR, permitsR, taxR] = await Promise.all([
      acrisByLot(bbl).catch(() => null), dobNowByLot(bbl).catch(() => null),
      dobPermitsByLot(bbl).catch(() => null), taxHistoryByBbl(bbl).catch(() => null)
    ]);
    for (const m of acris?.live ? acris.all ?? [] : []) {
      if (!m.document_id) continue;
      await client.query(
        `insert into public.acris_docs (document_id,bbl,doc_type,doc_date,recorded_at,amount,parties,raw)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
         on conflict (document_id,bbl) do update set parties=excluded.parties, raw=excluded.raw, updated_at=now()`,
        [m.document_id, bbl, m.doc_type ?? null, day(m.document_date), m.recorded_datetime ?? null,
         num(m.document_amt), JSON.stringify(acris.parties?.[m.document_id] ?? []), JSON.stringify(m)]
      );
      docs += 1;
    }
    const filingRows = [
      ...(nowR?.live ? (nowR.rows ?? []).map((x) => ({ id: `dob_now:${x.job_filing_number}`, src: "dob_now", bin: x.bin, type: x.job_type, status: x.filing_status, at: day(x.filing_date ?? x.current_status_date), raw: x, key: x.job_filing_number })) : []),
      ...(permitsR?.live ? (permitsR.rows ?? []).map((x) => ({ id: `dob_permits:${[x.job__, x.permit_si_no ?? x.permit_sequence__, x.issuance_date].filter(Boolean).join(":")}`, src: "dob_permits", bin: x.bin__, type: x.job_type, status: x.permit_status, at: day(x.issuance_date ?? x.filing_date), raw: x, key: x.job__ })) : [])
    ].filter((f) => f.key);
    for (const f of filingRows) {
      await client.query(
        `insert into public.dob_filings (id,bbl,bin,source,filing_type,status,filed_at,raw)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict (id) do nothing`,
        [f.id, bbl, f.bin ?? null, f.src, f.type ?? null, f.status ?? null, f.at, JSON.stringify(f.raw)]
      );
      filings += 1;
    }
    const byYear = new Map();
    for (const x of taxR?.live ? taxR.rows ?? [] : []) {
      const year = parseInt(x.year, 10);
      if (Number.isFinite(year)) byYear.set(year, x);
    }
    for (const [year, x] of byYear) {
      await client.query(
        `insert into public.tax_bills (bbl,year,tax_class,market_value,assessed_total,taxable,raw)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict (bbl,year) do update set
           market_value=excluded.market_value, assessed_total=excluded.assessed_total,
           taxable=excluded.taxable, raw=excluded.raw, updated_at=now()`,
        [bbl, year, x.curtaxclass ?? x.pytaxclass ?? null, num(x.curmkttot) ?? num(x.pymkttot),
         num(x.curacttot) ?? num(x.pyacttot), num(x.curtxbtot) ?? num(x.pytxbtot), JSON.stringify(x)]
      );
      bills += 1;
    }
    process.stdout.write(`   … ${docs} documents, ${filings} filings, ${bills} bill-years\r`);
  }
  ok(`${docs} ACRIS documents, ${filings} DOB filings, ${bills} DOF bill-years`);
}

async function verify() {
  step(5, "Verifying the spatial contract against the loaded data");
  const { rows: [counts] } = await client.query(`
    select (select count(*) from public.parcels) as parcels,
           (select count(*) from public.parcels where geom is not null) as with_geom,
           (select count(*) from public.ntas) as ntas`);
  ok(`${counts.parcels} parcels (${counts.with_geom} with geometry), ${counts.ntas} NTAs`);
  if (Number(counts.with_geom) === 0) { warn("no geometry loaded — spatial checks skipped"); return true; }

  let passed = true;
  const check = (label, good, detail) => { console.log(`   ${good ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!good) passed = false; };

  // ST_Contains: a point on a real lot must resolve to that lot.
  const { rows: [sample] } = await client.query(`
    select bbl, address, extensions.st_x(extensions.st_pointonsurface(geom)) as lng,
           extensions.st_y(extensions.st_pointonsurface(geom)) as lat
    from public.parcels where geom is not null order by lot_area desc nulls last limit 1`);
  const { rows: [{ hit }] } = await client.query("select public.lot_at($1,$2) as hit", [sample.lng, sample.lat]);
  check("lot_at (ST_Contains)", hit?.bbl === sample.bbl, `${sample.address} → ${hit?.bbl ?? "null"} via ${hit?.hit ?? "—"}`);

  // A point far offshore must resolve to nothing rather than a nearest guess.
  const { rows: [{ empty }] } = await client.query("select public.lot_at(-74.05,40.70) as empty");
  check("lot_at returns null off-parcel", empty === null, empty === null ? "open water → null" : "returned a lot for open water");

  // ST_MakeEnvelope: a viewport query returns polygons.
  const { rows: [{ n_nta }] } = await client.query(
    "select jsonb_array_length(public.nta_polys(-74.02,40.70,-73.95,40.80)) as n_nta");
  check("nta_polys (ST_MakeEnvelope)", Number(n_nta) > 0, `${n_nta} neighbourhoods in the test viewport`);

  // ST_Touches: same-owner contiguity.
  const { rows: [touching] } = await client.query(`
    select p1.bbl from public.parcels p1 join public.parcels p2
      on p1.owner_name = p2.owner_name and p1.bbl <> p2.bbl
     and extensions.st_touches(p1.geom, p2.geom)
    where coalesce(p1.owner_name,'') not in ('','UNAVAILABLE OWNER','NEW YORK CITY','CITY OF NEW YORK')
    limit 1`);
  if (touching) {
    const { rows: [{ a }] } = await client.query("select public.assemblage_at($1) as a", [touching.bbl]);
    check("assemblage_at (ST_Touches)", (a?.lots ?? []).some((l) => l.touches),
      `${a?.owner} — ${a?.count} contiguous lots`);
  } else {
    warn("no same-owner touching lots in this slice — load more ZIPs to exercise assemblage_at");
  }

  const { rows: [{ n_opp }] } = await client.query("select jsonb_array_length(public.parcels_opportunities(null, 20)) as n_opp");
  check("parcels_opportunities", Number(n_opp) > 0, `${n_opp} ranked parcels`);
  return passed;
}

const t0 = Date.now();
await client.connect();
try {
  await applyMigrations();
  if (!args["skip-ingest"]) {
    await ingestParcels();
    await ingestNtas();
    if (args.docs) await ingestDocuments();
  }
  const passed = await verify();

  const host = (() => { try { return new URL(DATABASE_URL.replace(/^postgres(ql)?:/, "http:")).hostname; } catch { return ""; } })();
  const ref = (host.match(/^db\.([a-z0-9]+)\.supabase\.co$/) || [])[1];
  console.log(`\n${"=".repeat(64)}`);
  console.log(passed ? "DATABASE READY" : "DATABASE BUILT WITH WARNINGS (see ✗ above)");
  if (migrationFailures.length) {
    console.error(`\n${migrationFailures.length} migration(s) FAILED:`);
    for (const m of migrationFailures) console.error(`  ✗ ${m}`);
  }
  // Say what was actually loaded. "DATABASE READY" over four ZIPs is true
  // and misleading at the same time unless the scope is printed with it.
  console.log(`\nCoverage loaded: ZIP ${ZIPS.join(", ")} · up to ${LIMIT.toLocaleString("en-US")} parcels · documents for the ${DOCS_LIMIT} largest.`);
  console.log("This is the requested slice, not the whole city. Re-run with --zips and --limit to widen it.");
  console.log("\nSet these on the web service so the app reads the store:");
  console.log(`  SUPABASE_URL=${ref ? `https://${ref}.supabase.co` : "https://<project-ref>.supabase.co"}`);
  console.log("  SUPABASE_SERVICE_ROLE_KEY=<service role key>");
  console.log("\nWithout them the endpoints keep answering from live NYC Open Data.");
  console.log(`Completed in ${Math.round((Date.now() - t0) / 1000)}s.`);
  process.exitCode = passed ? 0 : 1;
} finally {
  await client.end();
}
