// Socrata (NYC Open Data) fetch core: SoQL queries with timeout, retry, an
// in-memory TTL cache and a file cache. Every caller receives { live, rows,
// error }. In production, an expired cache is retained for diagnostics only; it
// is never returned as current public-record data after the upstream source has
// failed.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.SOCRATA_CACHE_DIR || path.join(__dirname, "..", "data", "cache");
mkdirSync(CACHE_DIR, { recursive: true });

const DOMAIN = process.env.SOCRATA_DOMAIN || "https://data.cityofnewyork.us";
// Render's production blueprint names this NYC_OPEN_DATA_APP_TOKEN. Keep the
// historical SOCRATA_APP_TOKEN alias for existing/local deployments, but never
// ignore a correctly configured production token.
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || process.env.NYC_OPEN_DATA_APP_TOKEN || "";

const mem = new Map();
const MEM_TTL_MS = 10 * 60 * 1000;
const FILE_TTL_MS = 6 * 60 * 60 * 1000;

// The in-memory cache is bounded. It was not.
//
// Entries were written on every distinct query URL and never removed. The TTL
// is only consulted on READ, so an expired entry — one the read path can never
// serve again — stayed resident forever holding its full parsed row array, and
// every new tile, bbox, BBL and ZIP produced another one. soqlAll compounds it:
// it calls soql once per page, so a single exhausting pull leaves one permanent
// entry per page.
//
// Measured on this machine 2026-08-18: a freshly started server sits at 107 MB
// RSS; after 1,728 requests across 24 endpoints it reached 655 MB and never
// released. Render's starter instance has 512 MB. The live service restarted
// twice while it was being probed concurrently (/api/status startedAt moved
// 16:14:58Z -> 19:00:04Z -> 19:06:28Z) and returned 502 on 26 endpoints that
// answered 200 when probed sequentially at 3 s spacing.
//
// Eviction is behaviour-preserving, not a data change: every value placed here
// is also written to the file cache, and a memory miss falls through to
// readFileCache on the next line, returning the identical value. The only cost
// of evicting is one file read.
const MEM_MAX_ROWS = Number(process.env.SOCRATA_MEM_MAX_ROWS || 150000);
const MEM_MAX_ENTRIES = Number(process.env.SOCRATA_MEM_MAX_ENTRIES || 800);
let memRows = 0;

const memRowsOf = (value) => (Array.isArray(value?.rows) ? value.rows.length : 1);

function memDelete(url) {
  const e = mem.get(url);
  if (!e) return;
  memRows -= e.rows;
  mem.delete(url);
}

function memSet(url, value) {
  memDelete(url);
  const now = Date.now();
  // Insertion order is ascending by `at`, because every write deletes first.
  // So the expired entries are a prefix and the scan can stop at the first
  // live one rather than walking the whole map on every write.
  for (const [k, e] of mem) {
    if (now - e.at < MEM_TTL_MS) break;
    memDelete(k);
  }
  const rows = memRowsOf(value);
  mem.set(url, { at: now, rows, value });
  memRows += rows;
  // Then oldest-first until inside both budgets. Never evict the entry just
  // written — the caller is about to use it.
  while ((memRows > MEM_MAX_ROWS || mem.size > MEM_MAX_ENTRIES) && mem.size > 1) {
    const oldest = mem.keys().next().value;
    if (oldest === url) break;
    memDelete(oldest);
  }
}

// Read by the memory probe in tests; not part of the fetch contract.
export const memStats = () => ({ entries: mem.size, rows: memRows });

function cachePath(url) {
  return path.join(CACHE_DIR, crypto.createHash("sha1").update(url).digest("hex") + ".json");
}
function readFileCache(url, maxAgeMs) {
  try {
    const p = cachePath(url);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (Date.now() - j.at > maxAgeMs) return null;
    return { value: j.value, at: j.at, ageMs: Date.now() - j.at };
  } catch { return null; }
}
function writeFileCache(url, value) {
  try {
    const p = cachePath(url);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify({ at: Date.now(), value }));
    renameSync(tmp, p);
  } catch { /* cache is best-effort */ }
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { accept: "application/json" };
    if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function soql(datasetId, params = {}, { timeoutMs = 20000, ttlMs = FILE_TTL_MS, retries = 1, domain = DOMAIN } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
  const url = `${domain}/resource/${datasetId}.json?${qs}`;

  const m = mem.get(url);
  if (m && Date.now() - m.at < MEM_TTL_MS) return m.value;
  const fc = readFileCache(url, ttlMs);
  if (fc) { memSet(url, fc.value); return fc.value; }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const rows = await fetchJson(url, timeoutMs);
      if (Array.isArray(rows)) {
        const out = { live: true, rows, error: null, stale: false };
        memSet(url, out);
        writeFileCache(url, out);
        // A dataset that answers is no longer degraded; drop any standing
        // failure record so the status surface recovers on its own rather than
        // reporting an outage that has ended.
        clearStale(datasetId);
        return out;
      }
      lastErr = new Error(rows?.message || "non-array response");
    } catch (e) { lastErr = e; }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
  }

  const stale = readFileCache(url, Number.MAX_SAFE_INTEGER);
  if (stale) {
    // `stale` / `staleAgeMs` / `staleRows` were returned and nothing in the
    // application ever read them — zero references outside this directory.
    // Callers branch on `.live`, so no expired row was ever served as current
    // (the rule held), but the information that the source is DOWN and when it
    // was last seen healthy went nowhere. A user got the same bare "source
    // unavailable" whether the dataset broke ten minutes ago or last month.
    //
    // Recorded here, at the one place that observes it, so the status surface
    // and the live guard can report it without every caller having to thread a
    // field through. This is diagnostic only: staleRows are still never
    // returned as rows.
    noteStale(datasetId, stale.ageMs, lastErr);
    return {
      live: false,
      rows: [],
      error: String(lastErr?.message ?? lastErr),
      stale: true,
      staleAgeMs: stale.ageMs,
      staleRows: Array.isArray(stale.value?.rows) ? stale.value.rows : []
    };
  }
  noteStale(datasetId, null, lastErr);
  return { live: false, rows: [], error: String(lastErr?.message ?? lastErr), stale: false };
}

// ------------------------------------------------------- staleness registry
// Bounded: one entry per dataset id, most recent observation wins. Datasets are
// a fixed known set, so this cannot grow without bound.
const staleObservations = new Map();

function noteStale(datasetId, ageMs, err) {
  staleObservations.set(String(datasetId), {
    datasetId: String(datasetId),
    observedAt: new Date().toISOString(),
    lastKnownAgeMs: Number.isFinite(ageMs) ? ageMs : null,
    hasCachedCopy: Number.isFinite(ageMs),
    error: String(err?.message ?? err ?? "unknown").slice(0, 200)
  });
}

/** Datasets whose most recent fetch failed, newest first. Diagnostic only. */
export function staleSources({ withinMs = 15 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - withinMs;
  return [...staleObservations.values()]
    .filter((s) => Date.parse(s.observedAt) >= cutoff)
    .sort((a, z) => Date.parse(z.observedAt) - Date.parse(a.observedAt));
}

/** Clears a dataset's failure record once it answers again. */
export function clearStale(datasetId) {
  staleObservations.delete(String(datasetId));
}

// Exhaust a Socrata result set without silently treating a page-size ceiling as
// completeness. This is for ingestion/authority work, not UI endpoints whose
// observed contract intentionally returns a bounded page.
//
// maxRows is a safety fuse, not an arbitrary truncation. If the result lands
// exactly on that ceiling, one extra row is probed: zero proves exact
// exhaustion; any returned row proves the result exceeds the fuse and the
// function fails with NO partial authoritative rows.
export async function soqlAll(datasetId, params = {}, {
  pageSize = 1000,
  maxRows = 100000,
  timeoutMs = 30000,
  ttlMs = FILE_TTL_MS,
  retries = 1,
  domain = DOMAIN
} = {}) {
  const size = Math.max(1, Math.min(50000, Number(pageSize) || 1000));
  const ceiling = Math.max(size, Number(maxRows) || 100000);
  const requested = Number.parseInt(params.$limit, 10);
  const requestedLimit = Number.isFinite(requested) && requested >= 0 ? requested : Infinity;
  const initialOffset = Math.max(0, Number.parseInt(params.$offset, 10) || 0);
  const base = { ...params };
  delete base.$limit;
  delete base.$offset;

  const rows = [];
  let offset = initialOffset;
  for (;;) {
    // An explicit caller limit defines the requested result set. Reaching it is
    // complete by contract; certifying adapters intentionally omit $limit.
    if (rows.length >= requestedLimit) {
      return { live: true, rows, error: null, stale: false, complete: true, pagesComplete: true };
    }

    if (rows.length >= ceiling) {
      // Exactly at the safety fuse is ambiguous. Probe one row beyond the
      // collected set instead of guessing whether the source has more data.
      const probe = await soql(datasetId, { ...base, $limit: 1, $offset: offset }, {
        timeoutMs, ttlMs, retries, domain
      });
      if (!probe.live) {
        return {
          ...probe,
          rows: [],
          complete: false,
          rowsFetchedBeforeAbort: rows.length,
          error: probe.error || `Could not prove Socrata exhaustion at ${ceiling} rows for ${datasetId}`
        };
      }
      if ((probe.rows || []).length === 0) {
        return {
          live: true,
          rows,
          error: null,
          stale: false,
          complete: true,
          pagesComplete: true,
          exactSafetyCeiling: true
        };
      }
      return {
        live: false,
        rows: [],
        error: `Socrata result exceeded ${ceiling} row safety ceiling for ${datasetId}; refusing partial data`,
        stale: false,
        complete: false,
        rowsFetchedBeforeAbort: rows.length
      };
    }

    const take = Math.min(size, requestedLimit - rows.length, ceiling - rows.length);
    const r = await soql(datasetId, { ...base, $limit: take, $offset: offset }, {
      timeoutMs, ttlMs, retries, domain
    });
    if (!r.live) {
      return {
        ...r,
        rows: [],
        complete: false,
        rowsFetchedBeforeAbort: rows.length
      };
    }

    const page = Array.isArray(r.rows) ? r.rows : [];
    rows.push(...page);
    offset += page.length;

    if (page.length < take) {
      return { live: true, rows, error: null, stale: false, complete: true, pagesComplete: true };
    }
    if (page.length === 0) {
      return { live: true, rows, error: null, stale: false, complete: true, pagesComplete: true };
    }
  }
}

export async function resolveDataset(query, matcher) {
  const key = `catalog:${query}`;
  const cached = readFileCache(key, 7 * 24 * 60 * 60 * 1000);
  if (cached) return cached.value;
  try {
    const url = `https://api.us.socrata.com/api/catalog/v1?domains=data.cityofnewyork.us&only=dataset&limit=12&q=${encodeURIComponent(query)}`;
    const j = await fetchJson(url, 15000);
    const results = (j.results ?? []).map((r) => r.resource).filter(Boolean);
    const hit = (matcher ? results.find(matcher) : results[0]) ?? null;
    const value = hit ? { id: hit.id, name: hit.name } : null;
    if (value) writeFileCache(key, value);
    return value;
  } catch { return null; }
}

export const escSoql = (s) => String(s ?? "").replace(/'/g, "''");
