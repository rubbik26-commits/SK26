// Shared plumbing for the NYC Open Data → PostGIS ingestion workers.
// Writes go through a validated Supabase server credential. A production
// ingestion with no --limit means the complete selected parcel universe; limits
// are opt-in development/testing controls rather than silent production truncation.
import {
  adminCredential,
  normalizeSupabaseApiUrl,
  supabaseHeaders
} from "../../server/supabase-credentials.js";

const postgisOverrideUrl = normalizeSupabaseApiUrl(process.env.POSTGIS_SUPABASE_URL);
export const SUPABASE_URL = postgisOverrideUrl || normalizeSupabaseApiUrl(process.env.SUPABASE_URL);
export const SERVICE_KEY = adminCredential();

if (process.env.POSTGIS_SUPABASE_URL && !postgisOverrideUrl) {
  // Never print the rejected value: a PostgreSQL URI normally contains a DB
  // password. The REST ingest path falls back to SUPABASE_URL instead.
  console.warn("[ingest] POSTGIS_SUPABASE_URL is not an HTTP(S) Supabase API URL; ignoring it and falling back to SUPABASE_URL.");
}

export function requireStore() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Set an HTTP(S) SUPABASE_URL (or POSTGIS_SUPABASE_URL) and a validated server credential (SUPABASE_SECRET_KEY or service_role JWT) to ingest.");
    process.exit(1);
  }
}

const headers = () => supabaseHeaders({ apiKey: SERVICE_KEY, json: true });

export async function rpc(name, args, { timeoutMs = 120000 } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST", headers: headers(), body: JSON.stringify(args),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function upsert(table, rows, onConflict) {
  if (!rows.length) return 0;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: { ...headers(), prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
  return rows.length;
}

export async function select(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: headers(), signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`${table}: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return r.json();
}

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

export const zipsOf = (a) => String(a.zips ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
export const strictComplete = (a) => a?.__strictComplete === true;
export const runTimestamp = (a) => String(a?.__runStartedAt || new Date().toISOString());

const heartbeatAt = new Map();
const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;

// A full city crawl can take far longer than one database transaction or lease
// interval. Every worker calls this while it progresses. The database extends
// the singleton lease only for its current UUID; if the process crashed long
// enough for another run to acquire the lease, the old process cannot resume
// writing/certifying and fails here instead.
export async function heartbeatFullSync(a, { force = false } = {}) {
  if (!strictComplete(a)) return { renewed: false, scoped: true };
  const syncId = String(a?.__fullSyncId || "");
  if (!/^[0-9a-f-]{36}$/i.test(syncId)) throw new Error("Strict ingest heartbeat requires a full-sync UUID.");

  const now = Date.now();
  const last = heartbeatAt.get(syncId) || 0;
  if (!force && now - last < HEARTBEAT_INTERVAL_MS) {
    return { renewed: true, throttled: true, fullSyncId: syncId };
  }

  const result = await rpc("renew_full_ingest", { p_full_sync_id: syncId });
  if (!result?.renewed || result?.fullSyncId !== syncId) {
    throw new Error(`Full ingest lease lost for ${syncId}; refusing further warehouse writes.`);
  }
  heartbeatAt.set(syncId, now);
  return result;
}

const BOROUGH_CODE = {
  MN: 1, MANHATTAN: 1, "1": 1,
  BX: 2, BRONX: 2, "2": 2,
  BK: 3, BROOKLYN: 3, "3": 3,
  QN: 4, QUEENS: 4, "4": 4,
  SI: 5, "STATEN ISLAND": 5, STATENISLAND: 5, "5": 5
};

function requestedCap(a) {
  const n = Number.parseInt(a?.limit, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

// Return exactly the parcel set selected by the current run whenever MapPLUTO
// has already supplied it. This is essential for bounded/free-form run-all
// jobs: independently selecting a second "top N" worklist would make ACRIS,
// DOB and tax process different parcels from the MapPLUTO phase.
export async function storeBbls(a, _legacyFallbackLimit = null) {
  const cap = requestedCap(a);

  if (Array.isArray(a?.__ingestedBbls)) {
    const exact = [...new Set(a.__ingestedBbls.map((b) => String(b)).filter((b) => /^[1-5]\d{9}$/.test(b)))];
    return exact.slice(0, Number.isFinite(cap) ? cap : undefined);
  }

  if (strictComplete(a) && Array.isArray(a?.__documentBbls)) {
    return a.__documentBbls;
  }

  if (a.bbls) {
    return [...new Set(String(a.bbls).split(",").map((b) => b.replace(/[^0-9]/g, "")).filter((b) => /^[1-5]\d{9}$/.test(b)))]
      .slice(0, Number.isFinite(cap) ? cap : undefined);
  }

  if (a.where) {
    throw new Error("--where requires the exact MapPLUTO BBL set from run-all; for a standalone worker use --bbls, --zips, or --borough.");
  }

  const zips = zipsOf(a);
  let borough = null;
  if (a.borough) {
    borough = BOROUGH_CODE[String(a.borough).trim().toUpperCase()] ?? null;
    if (!borough) throw new Error(`Unsupported --borough=${a.borough}; use MN/BX/BK/QN/SI or 1-5.`);
  }

  const filters = [];
  if (zips.length) filters.push(`zipcode=in.(${zips.join(",")})`);
  if (borough) filters.push(`borough=eq.${borough}`);

  // During a strict citywide refresh, stale parcel rows intentionally remain in
  // the table until end-of-run reconciliation. Document workers must use ONLY
  // the parcels MapPLUTO marked in this snapshot, never every historical row.
  if (strictComplete(a)) {
    const syncId = String(a.__fullSyncId || "");
    if (!/^[0-9a-f-]{36}$/i.test(syncId)) throw new Error("Strict document worklist requires a full-sync UUID.");
    filters.push(`full_sync_id=eq.${syncId}`);
  }

  const pageSize = 1000;
  const out = [];
  for (let offset = 0; out.length < cap; offset += pageSize) {
    await heartbeatFullSync(a);
    const take = Math.min(pageSize, cap - out.length);
    const suffix = filters.length ? `&${filters.join("&")}` : "";
    const rows = await select("parcels", `select=bbl&order=bbl.asc&limit=${take}&offset=${offset}${suffix}`);
    const bbls = (Array.isArray(rows) ? rows : []).map((r) => String(r.bbl || "")).filter((b) => /^[1-5]\d{9}$/.test(b));
    out.push(...bbls);
    if (!Array.isArray(rows) || rows.length < take) break;
  }

  const final = [...new Set(out)].slice(0, Number.isFinite(cap) ? cap : undefined);
  if (strictComplete(a)) {
    const expected = Number(a.__mapPlutoMeta?.upserted);
    if (!Number.isFinite(expected) || final.length !== expected) {
      throw new Error(`Strict document worklist mismatch: MapPLUTO snapshot=${expected}, document worklist=${final.length}`);
    }
    a.__documentBbls = final;
  }
  return final;
}

export function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
