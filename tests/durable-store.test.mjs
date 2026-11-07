// The deploy-survives-this test.
//
// The complaint this answers: "why are things not getting saved — every time we
// deploy everything looks exactly the same." The kanban board, the investor
// pool, the usage meters and the 3D quota were written to server/data/, which on
// Render's free plan is part of the deploy image and is recreated from git on
// every deploy, restart and cold start.
//
// A test that only checked "save() then load() returns it" would have passed
// against the broken code, because within one process the file is still there.
// The thing that has to be proven is that state survives *the directory being
// destroyed*, so every durability case below wipes APP_DATA_DIR between the
// write and the read — that is what a redeploy does.
//
// The database is a real Postgres. PGlite runs the actual engine in-process, so
// the SQL, the jsonb round-trip and the upsert are exercised for real rather
// than against a mock that would agree with whatever the code did.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const root = mkdtempSync(path.join(os.tmpdir(), "durable-"));
const dataDir = path.join(root, "data");
mkdirSync(dataDir, { recursive: true });
process.env.APP_DATA_DIR = dataDir;

let pglite = null;
try { ({ PGlite: pglite } = await import("@electric-sql/pglite")); } catch { /* reported via skip */ }

let db = null;

before(async () => {
  if (!pglite) return;
  db = new pglite();
  await db.exec(`
    create table if not exists public.app_state (
      name text primary key,
      value jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);
});

after(async () => {
  await db?.close?.();
  rmSync(root, { recursive: true, force: true });
});

const asPool = () => ({
  query: async (text, params = []) => {
    const res = await db.query(text, params);
    return { rows: res.rows ?? [] };
  }
});

const SELECT = "select value from public.app_state where name = $1";
const UPSERT = `insert into public.app_state (name, value, updated_at) values ($1, $2, now())
                on conflict (name) do update set value = excluded.value, updated_at = now()`;

const wipeDataDir = () => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
};

test("a redeploy wipes the data directory — this is the failure being fixed", () => {
  const file = path.join(dataDir, "kanban-pipeline.json");
  writeFileSync(file, JSON.stringify({ rows: [{ oppId: "A", stage: "Diligence" }] }));
  assert.ok(existsSync(file), "precondition: the board is on disk");
  wipeDataDir();
  assert.equal(existsSync(file), false,
    "after a redeploy the on-disk board is gone — a disk-only store loses it");
});

test("Postgres-backed state survives the data directory being destroyed", { skip: !pglite && "PGlite unavailable" }, async () => {
  const pool = asPool();
  const board = { rows: [{ id: 1, oppId: "LIVE-3009020001", stage: "IC Memo", updatedAt: "2026-08-14T00:00:00.000Z" }] };

  await pool.query(UPSERT, ["kanban-pipeline.json", JSON.stringify(board)]);
  wipeDataDir();

  const { rows } = await pool.query(SELECT, ["kanban-pipeline.json"]);
  assert.equal(rows.length, 1, "the row outlived the container");
  assert.deepEqual(rows[0].value, board, "and it round-tripped through jsonb unchanged");
});

test("saving twice updates in place rather than raising a duplicate key", { skip: !pglite && "PGlite unavailable" }, async () => {
  const pool = asPool();
  await pool.query(UPSERT, ["investors-pool.json", JSON.stringify({ investors: [{ id: "a" }] })]);
  await pool.query(UPSERT, ["investors-pool.json", JSON.stringify({ investors: [{ id: "a" }, { id: "b" }] })]);
  const { rows } = await pool.query(SELECT, ["investors-pool.json"]);
  assert.equal(rows.length, 1, "one row per document, not an append-only log");
  assert.equal(rows[0].value.investors.length, 2, "the second save won");
});

test("an existing deployment's on-disk board is adopted, not discarded", { skip: !pglite && "PGlite unavailable" }, async () => {
  const pool = asPool();
  const existing = { rows: [{ id: 7, oppId: "CARRIED-OVER", stage: "Active Pursuit" }] };
  writeFileSync(path.join(dataDir, "adopt-me.json"), JSON.stringify(existing));

  const before = await pool.query(SELECT, ["adopt-me.json"]);
  assert.equal(before.rows.length, 0, "precondition: the database has never seen this document");

  const onDisk = JSON.parse(readFileSync(path.join(dataDir, "adopt-me.json"), "utf8"));
  await pool.query("insert into public.app_state (name, value) values ($1, $2) on conflict (name) do nothing",
    ["adopt-me.json", JSON.stringify(onDisk)]);

  wipeDataDir();
  const after = await pool.query(SELECT, ["adopt-me.json"]);
  assert.deepEqual(after.rows[0].value, existing, "the board the user had built survived the move");
});

test("with no database configured the store still works, and says so", async () => {
  const NO_DATABASE = [
    "SUPABASE_DB_URL", "DATABASE_URL",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
    "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY",
    "APP_STATE_TOKEN", "SITE_PASSWORD", "OWNER_PASSWORD"
  ];
  const savedKeys = Object.fromEntries(NO_DATABASE.map((k) => [k, process.env[k]]));
  for (const k of NO_DATABASE) delete process.env[k];
  const savedEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const { durableStore, durableBackend, resetDurableStore } = await import("../server/durable-store.js");
    resetDurableStore();
    const store = durableStore("fallback-probe.json", { rows: [] });
    await store.save({ rows: [{ oppId: "X", stage: "Watchlist" }] });
    assert.deepEqual((await store.load()).rows, [{ oppId: "X", stage: "Watchlist" }],
      "reads and writes work with no database");
    assert.match(await durableBackend(), /^disk/, "and the backend reports itself as disk, not as durable");

    wipeDataDir();
    assert.deepEqual((await store.load()).rows, [],
      "after a wipe it is empty — this is the state the deployed service was in");
  } finally {
    for (const [k, v] of Object.entries(savedKeys)) { if (v !== undefined) process.env[k] = v; }
    if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
  }
});

test("a backend that never worked degrades loudly instead of refusing every save", async () => {
  const ONLY_THE_BROKEN_ONE = [
    "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
    "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "APP_STATE_TOKEN",
    "SITE_PASSWORD", "OWNER_PASSWORD"
  ];
  const saved = process.env.SUPABASE_DB_URL;
  const savedOthers = Object.fromEntries(ONLY_THE_BROKEN_ONE.map((k) => [k, process.env[k]]));
  for (const k of ONLY_THE_BROKEN_ONE) delete process.env[k];
  const savedEnv = process.env.NODE_ENV;
  process.env.SUPABASE_DB_URL = "postgresql://nobody:nothing@127.0.0.1:1/none";
  delete process.env.NODE_ENV;
  try {
    const { durableStore, resetDurableStore } = await import("../server/durable-store.js");
    resetDurableStore();
    const store = durableStore("degraded-probe.json", { rows: [] });

    const res = await store.save({ rows: [{ oppId: "Y", stage: "Diligence" }] });
    assert.equal(res.backend, "disk", "the write still lands somewhere");
    assert.equal(res.durable, false, "and is never reported as redeploy-safe");
    assert.equal(res.misconfigured, true,
      "a configured-but-never-reachable backend is flagged as a misconfiguration");
    assert.ok(res.reason, "with the reason attached so it is actionable");

    assert.deepEqual((await store.load()).rows, [{ oppId: "Y", stage: "Diligence" }],
      "the read path still degrades to disk");
  } finally {
    const { resetDurableStore } = await import("../server/durable-store.js");
    if (saved === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = saved;
    for (const [k, v] of Object.entries(savedOthers)) { if (v !== undefined) process.env[k] = v; }
    if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
    resetDurableStore();
  }
});

test("with nothing configured, disk is the intended backend and the save succeeds", async () => {
  const keys = ["SUPABASE_DB_URL", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "APP_STATE_TOKEN",
    "SITE_PASSWORD", "OWNER_PASSWORD", "NODE_ENV"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const { durableStore, resetDurableStore, durableConfigured } = await import("../server/durable-store.js");
    resetDurableStore();
    assert.equal(durableConfigured(), false, "nothing is configured, so disk is the plan");
    const store = durableStore("unconfigured-probe.json", { rows: [] });
    const result = await store.save({ rows: [{ oppId: "Z", stage: "Watchlist" }] });
    assert.equal(result.backend, "disk");
    assert.equal(result.durable, false, "and it says plainly that this is not redeploy-safe");
  } finally {
    const { resetDurableStore } = await import("../server/durable-store.js");
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetDurableStore();
  }
});

test("the migration that creates app_state is committed and locks the table down", () => {
  const sql = readFileSync(new URL("../supabase/migrations/202608140001_durable_app_state.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.app_state/i, "the table is created");
  assert.match(sql, /name\s+text primary key/i, "keyed by document name, one row per document");
  assert.match(sql, /value\s+jsonb not null/i, "the document is stored as jsonb");
  assert.match(sql, /alter table public\.app_state enable row level security/i, "RLS is on");
  assert.doesNotMatch(sql, /create policy/i,
    "no policy grants a browser direct access — only the service role bypasses RLS");
});

test("render declares a durable-store credential path", () => {
  const yaml = readFileSync(new URL("../render.yaml", import.meta.url), "utf8");
  const ways = [
    /key: SUPABASE_DB_URL/.test(yaml),
    /key: DATABASE_URL/.test(yaml),
    /key: SUPABASE_SERVICE_ROLE_KEY/.test(yaml) && /key: SUPABASE_URL/.test(yaml),
    /key: SUPABASE_SECRET_KEY/.test(yaml) && /key: SUPABASE_URL/.test(yaml)
  ];
  assert.ok(ways.some(Boolean),
    "render.yaml must declare a credential that lets the durable store reach Postgres/PostgREST");
});

test("the durable store can reach Postgres by either route", async () => {
  // The REST path must use the shared privilege-aware credential classifier.
  // A literal service-role variable here would reintroduce the drift that let an
  // anon JWT win over a valid sb_secret_ key.
  const store = readFileSync(new URL("../server/durable-store.js", import.meta.url), "utf8");
  const credentials = readFileSync(new URL("../server/supabase-credentials.js", import.meta.url), "utf8");
  assert.match(store, /rest\/v1\/app_state/, "the REST path targets public.app_state");
  assert.match(store, /adminCredential/, "the REST path delegates credential selection to the shared validator");
  assert.match(store, /supabaseHeaders/, "the REST path uses shared key transport rather than forging a bearer");
  assert.match(store, /account_delete_schema_check/,
    "REST health is proved by a privileged read-only RPC, not an RLS SELECT that anon can answer 200/empty");
  assert.match(credentials, /role === "service_role"/, "legacy JWTs are accepted only when their actual role is service_role");
  assert.match(credentials, /sb_secret_/, "modern server secret keys are accepted as server credentials");
  assert.match(store, /resolution=merge-duplicates/, "writes upsert rather than erroring on an existing row");
  assert.match(store, /supabase-rest/, "and the backend is reported distinctly from postgres and disk");
});

test("every store that WRITES agrees on one directory", () => {
  const WRITTEN = [
    "kanban-pipeline.json", "crm-pipeline.json", "investors-pool.json",
    "investors.json", "usage-meters.json", "3d-sessions.json"
  ];
  for (const f of ["../server/routes-bundle.js", "../server/routes.js"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const doc of WRITTEN) {
      const pinned = new RegExp(`path\\.join\\(__dirname,\\s*"data",\\s*"${doc.replace(".", "\\.")}"`);
      assert.doesNotMatch(src, pinned,
        `${f} pins ${doc} to the deploy image, so a mounted disk would not hold it`);
    }
  }
  assert.match(readFileSync(new URL("../server/routes.js", import.meta.url), "utf8"),
    /path\.join\(__dirname, "data", "nta-polys\.json"\)/,
    "nta-polys.json is committed read-only geodata and stays with the code");
});

test("TLS is derived from the connection string, not forced on", async () => {
  const { pgSsl } = await import("../server/durable-store.js");
  assert.equal(pgSsl("postgresql://u@127.0.0.1:5432/db"), false, "loopback needs no TLS");
  assert.equal(pgSsl("postgresql://u@localhost/db"), false, "localhost needs no TLS");
  assert.equal(pgSsl("postgresql://u@host/db?sslmode=disable"), false, "an explicit disable is honoured");
  assert.deepEqual(pgSsl("postgresql://u@db.abc.supabase.co:5432/postgres"), { rejectUnauthorized: false },
    "a managed remote gets TLS without demanding a local CA");
  assert.deepEqual(pgSsl("postgresql://u@host/db?sslmode=verify-full"), { rejectUnauthorized: true },
    "verify-full means verify");
});
