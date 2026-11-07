import { pathToFileURL } from "node:url";

const DEFAULT_CONTROL_PLANE_URL = "https://buyerdb.netlify.app";
const DEFAULT_JOB = "full_refresh";
const DEFAULT_TIMEOUT_MS = 25_000;
const ALLOWED_JOBS = new Set([
  "acris_refresh",
  "traded_refresh",
  "crexi_refresh",
  "rolling_sales",
  "phase2_enrichment",
  "dos_enrich",
  "property_owner_refresh",
  "full_refresh"
]);

function enabled(value) {
  return String(value ?? "").trim() === "1";
}

function cleanString(value, maxLength = 200) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= maxLength ? cleaned : null;
}

function refreshOptions(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return {};
  if (value.length > 10_000) throw new Error("BUYERDB_REFRESH_OPTIONS is too large");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BUYERDB_REFRESH_OPTIONS must be valid JSON");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("BUYERDB_REFRESH_OPTIONS must be a JSON object");
  }
  return parsed;
}

function controlPlaneEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_CONTROL_PLANE_URL));
  } catch {
    throw new Error("BUYERDB_CONTROL_PLANE_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("BUYERDB_CONTROL_PLANE_URL must use HTTPS");
  }
  url.username = "";
  url.password = "";
  url.pathname = "/api/scrapers/run";
  url.search = "";
  url.hash = "";
  return url;
}

function safeRun(value) {
  if (!value || typeof value !== "object") return null;
  const job = cleanString(value.job, 80);
  const runId = cleanString(value.runId ?? value.run_id, 100);
  const status = cleanString(value.status, 40);
  if (!job && !runId && !status) return null;
  return { job, runId, status };
}

function safeAcceptedPayload(payload) {
  const run = safeRun(payload);
  const runs = Array.isArray(payload?.runs)
    ? payload.runs.map(safeRun).filter(Boolean).slice(0, ALLOWED_JOBS.size)
    : [];
  return {
    accepted: payload?.ok !== false,
    runId: run?.runId ?? null,
    runs
  };
}

/**
 * Submit one canonical buyerDB refresh request.
 *
 * The dispatcher intentionally does not write to Supabase. buyerDB's existing
 * control plane creates one auditable sbi_source_runs row per job and applies
 * its existing active-run de-duplication before any worker can mutate data.
 */
export async function dispatchBuyerDbRefresh({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!enabled(env.BUYERDB_REFRESH_ENABLED)) {
    return {
      ok: true,
      skipped: true,
      reason: "BUYERDB_REFRESH_ENABLED is not 1"
    };
  }

  const secret = cleanString(env.BUYERDB_SCRAPER_TRIGGER_SECRET, 4_096);
  if (!secret) throw new Error("BUYERDB_SCRAPER_TRIGGER_SECRET is required when refresh is enabled");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const job = cleanString(env.BUYERDB_REFRESH_JOB, 80) || DEFAULT_JOB;
  if (!ALLOWED_JOBS.has(job)) throw new Error(`Unsupported BUYERDB_REFRESH_JOB: ${job}`);
  const options = refreshOptions(env.BUYERDB_REFRESH_OPTIONS);
  const endpoint = controlPlaneEndpoint(env.BUYERDB_CONTROL_PLANE_URL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-scraper-trigger-secret": secret
      },
      body: JSON.stringify({ job, options }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    // Do not echo the upstream response. It can contain operational details,
    // and the only actionable public fact is the HTTP status.
    throw new Error(`buyerDB control plane rejected the request (${response.status})`);
  }

  return {
    ok: true,
    skipped: false,
    job,
    endpoint: endpoint.origin,
    httpStatus: response.status,
    ...safeAcceptedPayload(payload)
  };
}

export async function main() {
  try {
    const result = await dispatchBuyerDbRefresh();
    console.log(JSON.stringify({ event: "buyerdb_refresh_dispatch", ...result }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "buyerdb_refresh_dispatch",
      ok: false,
      error: error?.message || "buyerDB refresh dispatch failed"
    }));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) await main();

