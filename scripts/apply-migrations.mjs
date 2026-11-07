// Apply versioned Supabase SQL migrations when a privileged SUPABASE_DB_URL is
// available. A generic DATABASE_URL is intentionally NOT a DDL target: the web
// service may use a separate Postgres database for durable app_state, while the
// Supabase schema contains auth.users references, PostgREST roles and RLS.
//
// Without SUPABASE_DB_URL we cannot execute DDL. Production must NAME its
// Supabase project: an omitted SUPABASE_URL fails the deploy outright rather
// than falling back to the project baked into the compiled frontend — that
// project belongs to someone else and is never a default (owner directive
// 2026-08-18).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adminCredential, publicCredential, supabaseHeaders } from "../server/supabase-credentials.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "supabase", "migrations");
const supabaseDbUrl = String(process.env.SUPABASE_DB_URL || "");
const production = process.env.NODE_ENV === "production";

const configuredProject = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
// Never trust the first non-empty variable as an admin key. A stale legacy
// SUPABASE_SERVICE_ROLE_KEY can legally be an anon JWT while a valid sb_secret_
// credential sits in SUPABASE_SECRET_KEY. The shared classifier rejects that
// low-privilege value before this deployment probe chooses a key.
const configuredKey = adminCredential() || publicCredential();

if (production && !configuredProject) {
  console.error("[migrate] FAILING THE DEPLOY: SUPABASE_URL is not set. A production deploy must name its Supabase project explicitly — the project baked into the compiled frontend is not a default.");
  process.exit(1);
}

const effectiveProject = configuredProject;
const effectiveKey = configuredKey;

function projectRefFromApiUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    const m = host.match(/^([a-z0-9]+)\.supabase\.co$/);
    return m?.[1] || "";
  } catch { return ""; }
}

function projectRefFromDbUrl(value) {
  try {
    const u = new URL(value);
    const hostMatch = u.hostname.toLowerCase().match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (hostMatch) return hostMatch[1];
    // Supavisor/pooler connection strings carry the project ref in the user:
    // postgres.<project-ref>@...pooler.supabase.com
    const user = decodeURIComponent(u.username || "").toLowerCase();
    const userMatch = user.match(/^postgres\.([a-z0-9]+)$/);
    return userMatch?.[1] || "";
  } catch { return ""; }
}

const effectiveRef = projectRefFromApiUrl(effectiveProject);

// DDL requires a privileged Supabase connection string. In local/test mode, no
// Supabase configuration still means "skip". In production the explicit
// SUPABASE_URL target must at least be reachable and already contain the
// bootstrap RPC before verify-production-schema.mjs performs the exhaustive
// schema/reconciliation check.
if (!supabaseDbUrl) {
  if (!configuredProject && !configuredKey) {
    console.log("[migrate] no database configured in non-production — skipping DDL.");
    process.exit(0);
  }

  if (!effectiveProject || !effectiveKey) {
    console.error("[migrate] FAILING THE DEPLOY: a production Supabase target is effective but no matching API key is available.");
    process.exit(1);
  }

  // Probe every object the running service needs, not just one.
  //
  // Verifying app_state_get alone proved that ONE function of the durable-state
  // migration had been applied. A project with that function and nothing else —
  // a partially applied migration set, or the app_state migration applied
  // without the workspace schema, which is exactly the state the user's project
  // was found in — passed the gate and deployed. The kanban then wrote to
  // app_state successfully while /api/pipeline, /api/maturity-wall and the
  // owner spend panel all failed against tables that did not exist.
  //
  // Each entry names a real dependency and how it is reached. A 404 or PGRST202
  // means the object is absent; PGRST203 (overload ambiguity) still proves it
  // exists. Tables are probed with a zero-row select so RLS cannot mask absence
  // as emptiness — PostgREST answers 404 for an unknown relation either way.
  const REQUIRED = [
    {
      name: "public.app_state_get",
      probe: "/rest/v1/rpc/app_state_get",
      body: { p_name: "__migrate_probe__", p_token: "__probe__" },
      why: "durable shared state (kanban, investors) read path"
    },
    {
      name: "public.app_state_put",
      probe: "/rest/v1/rpc/app_state_put",
      body: { p_name: "__migrate_probe__", p_value: {}, p_token: "__probe__" },
      why: "durable shared state write path — a read-only store loses every save on redeploy"
    },
    { name: "public.cre_pipeline", table: "cre_pipeline", why: "signed-in kanban rows" },
    { name: "public.cre_watchlist", table: "cre_watchlist", why: "signed-in watchlist" },
    { name: "public.cre_investors", table: "cre_investors", why: "owner investor book" },
    { name: "public.cre_usage_daily", table: "cre_usage_daily", why: "paid-resource meter the spend panel reads" },
    { name: "public.cre_quota_daily", table: "cre_quota_daily", why: "3D session hard cap" },
    { name: "public.cre_profiles", table: "cre_profiles", why: "role/owner resolution" }
  ];

  const missing = [];
  for (const required of REQUIRED) {
    // Functions are probed by RPC POST; tables by a zero-row select, which is
    // the cheapest request that still distinguishes "relation does not exist"
    // (404 / PGRST205) from "exists but RLS returns nothing" (200, empty).
    const url = required.table
      ? `${effectiveProject}/rest/v1/${required.table}?select=1&limit=0`
      : `${effectiveProject}${required.probe}`;
    const init = required.table
      ? { method: "GET" }
      : { method: "POST", body: JSON.stringify(required.body) };
    try {
      const res = await fetch(url, {
        ...init,
        headers: supabaseHeaders({ apiKey: effectiveKey, json: !required.table }),
        signal: AbortSignal.timeout(15000)
      });
      const text = await res.text().catch(() => "");
      if (res.status === 404 || /PGRST202|PGRST205/.test(text)) {
        missing.push(`${required.name} (${required.why})`);
        continue;
      }
      if (/invalid api key|PGRST301|JWSError|invalid claim/i.test(text)) {
        console.error(`[migrate] FAILING THE DEPLOY: ${effectiveProject} rejected the configured API key.`);
        console.error(`[migrate] ${text.slice(0, 200)}`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`[migrate] FAILING THE DEPLOY: could not reach ${effectiveProject}: ${e.message}`);
      process.exit(1);
    }
  }

  if (missing.length) {
    console.error(
      `[migrate] FAILING THE DEPLOY: ${effectiveProject} is the runtime Supabase target but required schema is missing.\n` +
      `[migrate] missing:\n${missing.map((m) => `[migrate]   - ${m}`).join("\n")}\n` +
      `[migrate] DDL cannot be applied without SUPABASE_DB_URL.\n` +
      `[migrate] Provide that project's privileged Supabase connection URI or apply every file in supabase/migrations to this exact project.`
    );
    process.exit(1);
  }

  console.log(`[migrate] no SUPABASE_DB_URL; ${effectiveProject} is reachable and the bootstrap schema exists. Exhaustive schema verification runs next.`);
  process.exit(0);
}

// Before connecting, prove the privileged URI belongs to the API project the
// app will use. If a Supabase URI cannot reveal its ref in production, fail
// instead of risking DDL against an unrelated database.
const dbRef = projectRefFromDbUrl(supabaseDbUrl);
if (production) {
  if (!effectiveRef) {
    console.error(`[migrate] FAILING THE DEPLOY: cannot derive a Supabase project ref from ${effectiveProject}.`);
    process.exit(1);
  }
  if (!dbRef) {
    console.error("[migrate] FAILING THE DEPLOY: SUPABASE_DB_URL does not expose a verifiable Supabase project ref; refusing unproven DDL target.");
    process.exit(1);
  }
  if (dbRef !== effectiveRef) {
    console.error(`[migrate] FAILING THE DEPLOY: SUPABASE_DB_URL targets ${dbRef}, but runtime SUPABASE_URL targets ${effectiveRef}. No migration was executed.`);
    process.exit(1);
  }
}

let pg;
try {
  ({ default: pg } = await import("pg"));
} catch {
  console.error("[migrate] the 'pg' package is not installed. Install with `npm install --include=dev`.");
  process.exit(1);
}

const { pgSsl } = await import("../server/durable-store.js");
const client = new pg.Client({ connectionString: supabaseDbUrl, ssl: pgSsl(supabaseDbUrl) });
await client.connect();

await client.query(`
  create table if not exists public.schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )
`);

const applied = new Set(
  (await client.query("select name from public.schema_migrations")).rows.map((r) => r.name)
);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
let ran = 0;

for (const file of files) {
  if (applied.has(file)) {
    console.log(`[migrate] ${file} — already applied`);
    continue;
  }
  const sql = readFileSync(path.join(dir, file), "utf8");
  process.stdout.write(`[migrate] ${file} — applying… `);
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into public.schema_migrations (name) values ($1)", [file]);
    await client.query("commit");
    ran += 1;
    console.log("ok");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.log("FAILED");
    console.error(`[migrate] ${file} rolled back: ${e.message}`);
    await client.end();
    process.exit(1);
  }
}

const { rows } = await client.query(`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_name like 'cre_%'
  order by table_name
`);
console.log(`[migrate] ${ran} applied this run, ${files.length} total. cre_* tables present: ${rows.map((r) => r.table_name).join(", ") || "(none)"}`);
await client.end();
