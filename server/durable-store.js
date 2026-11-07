// Durable deployment-wide document storage.
//
// Production must never report or even temporarily expose a write that landed
// only on the deploy image. Local/dev environments may intentionally use disk;
// production requires Postgres, service-role PostgREST, or the guarded
// publishable-key RPC store. A disk-only production write will not survive a redeploy.
import path from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { APP_DATA_DIR } from "./usage-meter.js";
import { adminCredential, publicCredential, supabaseHeaders } from "./supabase-credentials.js";

const url = () => process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
const restUrl = () => String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = () => adminCredential();
const publishableKey = () => publicCredential();
const RPC_SALT = "lucia/app_state/v1";

function rpcToken() {
  const explicit = String(process.env.APP_STATE_TOKEN || "");
  if (explicit) return explicit;
  const seed = String(process.env.SITE_PASSWORD || process.env.OWNER_PASSWORD || "");
  if (!seed) return "";
  return createHash("sha256").update(`${RPC_SALT}:${seed}`).digest("hex");
}

// The registered app_state write token is also the credential for the
// token-gated usage-meter RPCs (cre_usage_*_tk). Exported so durable-cost.js
// can meter paid calls without a service-role key, exactly as app_state saves
// without one. The value is never logged.
export const appStateToken = () => rpcToken();
export const appStatePublishableKey = () => publishableKey();

async function rpc(fn, args) {
  const key = publishableKey();
  const r = await fetch(`${restUrl()}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: supabaseHeaders({ apiKey: key, json: true }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(12000)
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    const e = new Error(text.slice(0, 300) || `Supabase RPC HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function restQuery(pathname, { method = "GET", body, prefer } = {}) {
  const key = serviceKey();
  const headers = supabaseHeaders({ apiKey: key, json: body !== undefined });
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${restUrl()}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) {
    const e = new Error(text.slice(0, 300) || `Supabase HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export function pgSsl(connectionString) {
  const raw = String(connectionString || "");
  const mode = raw.match(/[?&]sslmode=([a-z-]+)/i)?.[1]?.toLowerCase();
  if (mode === "disable") return false;
  if (mode === "verify-ca" || mode === "verify-full") return { rejectUnauthorized: true };
  if (mode) return { rejectUnauthorized: false };
  let host = "";
  try { host = new URL(raw).hostname; } catch { /* unparseable: treat as remote */ }
  if (/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host)) return false;
  return { rejectUnauthorized: false };
}

let poolPromise = null;
let disabledReason = "";

async function pool() {
  if (disabledReason) return null;
  if (!url()) { disabledReason = "no SUPABASE_DB_URL/DATABASE_URL"; return null; }
  if (!poolPromise) {
    poolPromise = (async () => {
      const { default: pg } = await import("pg");
      const conn = url();
      const p = new pg.Pool({
        connectionString: conn,
        ssl: pgSsl(conn),
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000
      });
      // Kept idempotent for local/direct-Postgres use. Production deployment
      // still runs the committed migrations and release_schema_check first.
      await p.query(`
        create table if not exists public.app_state (
          name text primary key,
          value jsonb not null,
          updated_at timestamptz not null default now()
        )
      `);
      return p;
    })().catch((e) => {
      disabledReason = e?.message || "database unavailable";
      console.warn(`[durable-store] Postgres unavailable: ${disabledReason}`);
      return null;
    });
  }
  return poolPromise;
}

let restOk = null;
async function restAvailable() {
  if (restOk !== null) return restOk;
  if (!restUrl() || !serviceKey()) { restOk = false; return false; }
  try {
    // A SELECT on an RLS-protected table is not a privilege probe: an anon key
    // can legitimately receive HTTP 200 with zero visible rows and be mistaken
    // for a usable admin backend. account_delete_schema_check() is read-only and
    // intentionally executable only by the privileged server role, so success
    // proves this credential can cross the same elevated boundary required by
    // durable writes without mutating any application state.
    await restQuery("/rest/v1/rpc/account_delete_schema_check", { method: "POST", body: {} });
    restOk = true;
  } catch (e) {
    restOk = false;
    console.warn(`[durable-store] privileged PostgREST unavailable (${e.status || "?"}): ${e.message}` +
      (e.status === 404 ? " — account_delete_schema_check is not installed; apply the committed migrations" : ""));
  }
  return restOk;
}

export function durableConfigured() {
  return Boolean(url() || (restUrl() && serviceKey()) || (publishableKey() && rpcToken()));
}

let rpcOk = null;
let rpcReason = "";
let everWorked = false;
let warnedMisconfigured = false;

async function rpcAvailable() {
  if (rpcOk !== null) return rpcOk;
  const key = publishableKey();
  const token = rpcToken();
  if (!key) { rpcOk = false; rpcReason = "no SUPABASE_PUBLISHABLE_KEY"; return false; }
  if (!token) { rpcOk = false; rpcReason = "no SITE_PASSWORD/OWNER_PASSWORD/APP_STATE_TOKEN to derive the write token"; return false; }

  // The hardened migration deliberately keeps registration CLOSED by default.
  // First prove this deployment's token is already registered. Only an explicit
  // operator action may attempt first registration: open the bounded window with
  // app_state_open_bootstrap() using privileged SQL, then set
  // APP_STATE_BOOTSTRAP=1 for exactly one deployment. The app never silently
  // races public clients for "first caller wins" ownership.
  try {
    await rpc("app_state_get", { p_name: "__probe__", p_token: token });
    rpcOk = true;
    rpcReason = "registered";
    console.log("[durable-store] Supabase RPC state store active (registered token)");
    return true;
  } catch (probeError) {
    if (process.env.APP_STATE_BOOTSTRAP !== "1") {
      rpcOk = false;
      rpcReason = `${probeError.status || "?"}: token not registered or RPC unavailable; explicit operator bootstrap required`;
      console.warn(`[durable-store] Supabase RPC unavailable (${rpcReason})`);
      return false;
    }
    try {
      const status = await rpc("app_state_bootstrap", { p_token: token, p_label: "lucia web service" });
      await rpc("app_state_get", { p_name: "__probe__", p_token: token });
      rpcOk = true;
      rpcReason = String(status ?? "").replace(/"/g, "") || "registered";
      console.log(`[durable-store] Supabase RPC state store active (${rpcReason}); remove APP_STATE_BOOTSTRAP after this deploy`);
      return true;
    } catch (bootstrapError) {
      rpcOk = false;
      rpcReason = `${bootstrapError.status || "?"}: ${bootstrapError.message}`;
      console.warn(`[durable-store] Supabase RPC bootstrap failed (${rpcReason}). The operator window must be opened first and APP_STATE_BOOTSTRAP removed after registration.`);
      return false;
    }
  }
}

export async function durableBackend() {
  const p = await pool();
  if (p) return "postgres";
  if (await restAvailable()) return "supabase-rest";
  if (await rpcAvailable()) return "supabase-rpc";
  const reasons = [disabledReason, restOk === false ? "no usable service-role PostgREST path" : "", rpcReason]
    .filter(Boolean).join("; ");
  return `disk (${reasons || "unconfigured"})`;
}

export function resetDurableStore() {
  poolPromise = null;
  disabledReason = "";
  restOk = null;
  rpcOk = null;
  rpcReason = "";
  everWorked = false;
  warnedMisconfigured = false;
}

function durableWriteError(name) {
  const reason = disabledReason || rpcReason || "no durable backend is reachable";
  const err = new Error(
    `Production durable storage is unavailable (${reason}); "${name}" was NOT written to ephemeral disk.`
  );
  err.code = "durable_write_failed";
  err.backend = "unavailable";
  return err;
}

export function durableStore(name, fallback) {
  mkdirSync(APP_DATA_DIR, { recursive: true });
  const file = path.join(APP_DATA_DIR, name);

  const readDisk = () => {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  };
  const writeDisk = (value) => {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  };

  return {
    async load() {
      const p = await pool();
      if (p) {
        try {
          const { rows } = await p.query("select value from public.app_state where name = $1", [name]);
          if (rows.length) return rows[0].value;
          const onDisk = readDisk();
          if (onDisk) {
            await p.query(
              "insert into public.app_state (name, value) values ($1, $2) on conflict (name) do nothing",
              [name, JSON.stringify(onDisk)]
            );
            return onDisk;
          }
          return structuredClone(fallback);
        } catch (e) {
          console.warn(`[durable-store] read ${name} failed, using last local snapshot: ${e.message}`);
        }
      }

      if (await restAvailable()) {
        try {
          const rows = await restQuery(`/rest/v1/app_state?select=value&name=eq.${encodeURIComponent(name)}&limit=1`);
          if (Array.isArray(rows) && rows.length) return rows[0].value;
          const onDisk = readDisk();
          if (onDisk) {
            await restQuery("/rest/v1/app_state", {
              method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
              body: { name, value: onDisk }
            }).catch(() => {});
            return onDisk;
          }
          return structuredClone(fallback);
        } catch (e) {
          console.warn(`[durable-store] REST read ${name} failed, using last local snapshot: ${e.message}`);
        }
      }

      if (await rpcAvailable()) {
        try {
          const token = rpcToken();
          const v = await rpc("app_state_get", { p_name: name, p_token: token });
          if (v !== null && v !== undefined) return v;
          const onDisk = readDisk();
          if (onDisk) {
            const adopted = await rpc("app_state_adopt", { p_name: name, p_value: onDisk, p_token: token });
            return adopted ?? onDisk;
          }
          return structuredClone(fallback);
        } catch (e) {
          console.warn(`[durable-store] RPC read ${name} failed, using last local snapshot: ${e.message}`);
        }
      }
      return readDisk() ?? structuredClone(fallback);
    },

    async save(value) {
      const p = await pool();
      if (p) {
        try {
          await p.query(
            `insert into public.app_state (name, value, updated_at) values ($1, $2, now())
             on conflict (name) do update set value = excluded.value, updated_at = now()`,
            [name, JSON.stringify(value)]
          );
          try { writeDisk(value); } catch { /* durable row already succeeded */ }
          everWorked = true;
          return { backend: "postgres", durable: true };
        } catch (e) {
          console.warn(`[durable-store] Postgres write ${name} failed: ${e.message}`);
        }
      }

      if (await restAvailable()) {
        try {
          await restQuery("/rest/v1/app_state?on_conflict=name", {
            method: "POST",
            prefer: "resolution=merge-duplicates,return=minimal",
            body: { name, value, updated_at: new Date().toISOString() }
          });
          try { writeDisk(value); } catch { /* durable row already succeeded */ }
          everWorked = true;
          return { backend: "supabase-rest", durable: true };
        } catch (e) {
          console.warn(`[durable-store] REST write ${name} failed: ${e.message}`);
        }
      }

      if (await rpcAvailable()) {
        try {
          await rpc("app_state_put", { p_name: name, p_value: value, p_token: rpcToken() });
          try { writeDisk(value); } catch { /* durable row already succeeded */ }
          everWorked = true;
          return { backend: "supabase-rpc", durable: true };
        } catch (e) {
          console.warn(`[durable-store] RPC write ${name} failed: ${e.message}`);
        }
      }

      // Production never mutates ephemeral disk on a failed durable write: the
      // strict routes refuse durable:false saves, and writing disk first let a
      // rejected card reappear on reload until the next redeploy. A deployment
      // that declared a direct Postgres backend (SUPABASE_DB_URL/DATABASE_URL)
      // fails closed outright, as does any backend that has already proven
      // itself. A half-configured or unconfigured deployment instead reports
      // durable:false with nothing written, so the route can answer
      // durable_storage_required — setting two variables of three must not be
      // worse than setting none, and there is no disk echo to contradict the 503.
      if (process.env.NODE_ENV === "production") {
        if ((durableConfigured() && everWorked) || url()) throw durableWriteError(name);
        return {
          backend: "unavailable",
          durable: false,
          ...(durableConfigured() ? { misconfigured: true, reason: disabledReason || rpcReason || "unknown" } : {})
        };
      }

      // Outside production, a backend that HAS worked and then stops is an
      // outage: a user would otherwise be told a lost save succeeded, so throw
      // before the local snapshot changes. A backend that has never connected is
      // a development misconfiguration and may degrade loudly to disk.
      if (durableConfigured() && everWorked) throw durableWriteError(name);

      // Nothing configured, or configured but never reachable in local/dev:
      // disk is where this save is going. Keep the reconstruction workflow
      // usable and make the degradation explicit.
      writeDisk(value);
      if (durableConfigured() && !warnedMisconfigured) {
        warnedMisconfigured = true;
        console.warn(
          `[durable-store] MISCONFIGURED: durable storage is configured but has never been reachable ` +
          `(${disabledReason || rpcReason || "unknown"}). This save is disk-only and not redeploy-safe.`
        );
      }
      // The outage throw is intentionally above writeDisk(). One rule, stated
      // once, at the point where it decides, so a rejected save can never mutate
      // the local snapshot first.
      return {
        backend: "disk",
        durable: false,
        ...(durableConfigured() ? { misconfigured: true, reason: disabledReason || rpcReason || "unknown" } : {})
      };
    }
  };
}