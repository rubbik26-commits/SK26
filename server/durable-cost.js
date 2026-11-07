// Durable paid-resource metering. Supabase is the cross-restart/concurrent
// source of truth; if it is unavailable, photorealistic 3D fails closed rather
// than risking an unmetered paid request.
import { Router } from "express";
import { appStateToken, appStatePublishableKey } from "./durable-store.js";
import { adminCredential, supabaseHeaders } from "./supabase-credentials.js";

const router = Router();
const adminKey = () => adminCredential();
const supabaseUrl = () => String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const default3dCap = () => {
  const n = Number(process.env.GOOGLE_3D_DAILY_CAP || 25);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 25;
};

async function serviceRpc(name, body) {
  const secret = adminKey();
  if (!secret) return { configured: false, error: "supabase_service_key_missing" };
  try {
    const r = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: supabaseHeaders({ apiKey: secret, json: true }),
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10000)
    });
    const text = await r.text().catch(() => "");
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!r.ok) return { configured: true, error: data?.message || text.slice(0, 300) || `HTTP ${r.status}` };
    return { configured: true, data };
  } catch (e) {
    return { configured: true, error: e?.message || "quota store unavailable" };
  }
}

// Publishable-key + registered-token path. The *_tk RPCs are SECURITY DEFINER
// functions that refuse without a token registered in app_state_auth — the
// same trust model app_state_get/put already use for the kanban, which is why
// this deployment saves durably while having no service-role key. The meter
// gets the identical path so "no service key" no longer means "no spend panel".
const tokenCreds = () => {
  const key = appStatePublishableKey();
  const token = appStateToken();
  return key && token ? { key, token } : null;
};

async function tokenRpc(name, body) {
  const creds = tokenCreds();
  if (!creds) return { configured: false, error: "supabase_service_key_missing" };
  try {
    const r = await fetch(`${supabaseUrl()}/rest/v1/rpc/${name}`, {
      method: "POST",
      // Modern sb_publishable_ keys are API keys, not JWT bearer tokens. The
      // registered p_token is the RPC's authorization boundary.
      headers: supabaseHeaders({ apiKey: creds.key, json: true }),
      body: JSON.stringify({ ...(body || {}), p_token: creds.token }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await r.text().catch(() => "");
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!r.ok) return { configured: true, error: data?.message || text.slice(0, 300) || `HTTP ${r.status}` };
    return { configured: true, data };
  } catch (e) {
    return { configured: true, error: e?.message || "quota store unavailable" };
  }
}

export const usageStoreConfigured = () => !!adminKey() || !!tokenCreds();

export async function incrementDurableUsage(category, amount = 1) {
  const p_amount = Math.max(0, Math.floor(Number(amount) || 0));
  const r = adminKey()
    ? await serviceRpc("cre_increment_usage", { p_category: category, p_amount })
    : await tokenRpc("cre_usage_bump_tk", { p_category: category, p_amount });
  return { ok: !!(r.configured && !r.error), ...r };
}

function nextMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function readDurableUsage(month = new Date().toISOString().slice(0, 7)) {
  const secret = adminKey();
  if (!secret) {
    const r = await tokenRpc("cre_usage_read_tk", { p_month: month });
    if (!r.configured) return { configured: false, live: false, month, byCategory: {}, reason: "supabase_service_key_missing" };
    if (r.error) return { configured: true, live: false, month, byCategory: {}, reason: r.error };
    const byCategory = {};
    for (const row of Array.isArray(r.data?.rows) ? r.data.rows : []) {
      const c = String(row.category ?? "");
      if (!c) continue;
      byCategory[c] = (byCategory[c] ?? 0) + (Number(row.count) || 0);
    }
    return { configured: true, live: true, month, byCategory, via: "token-rpc" };
  }
  try {
    const r = await fetch(
      `${supabaseUrl()}/rest/v1/cre_usage_daily?select=category,count,usage_date&usage_date=gte.${month}-01&usage_date=lt.${nextMonth(month)}-01`,
      {
        headers: supabaseHeaders({ apiKey: secret }),
        signal: AbortSignal.timeout(10000)
      }
    );
    const text = await r.text().catch(() => "");
    if (!r.ok) return { configured: true, live: false, month, byCategory: {}, reason: text.slice(0, 200) || `HTTP ${r.status}` };
    const rows = JSON.parse(text || "[]");
    const byCategory = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const c = String(row.category ?? "");
      if (!c) continue;
      byCategory[c] = (byCategory[c] ?? 0) + (Number(row.count) || 0);
    }
    return { configured: true, live: true, month, byCategory };
  } catch (e) {
    return { configured: true, live: false, month, byCategory: {}, reason: e?.message || "usage store unavailable" };
  }
}

export async function reserve3dSession() {
  const cap = default3dCap();
  const r = adminKey()
    ? await serviceRpc("cre_reserve_3d_session", { p_cap: cap })
    : await tokenRpc("cre_reserve_3d_session_tk", { p_cap: cap });
  if (!r.configured || r.error) return { allowed: false, used: null, cap, durable: false, error: r.error || "quota store unconfigured" };
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return {
    allowed: row?.allowed === true,
    used: Number(row?.used ?? 0),
    cap: Number(row?.hard_cap ?? cap),
    durable: true
  };
}

// Measured 2026-08-19: the original answers
//   {"configured":true,"key":"<a live Google API key>","used":5,"cap":200}
// — four keys in that order. The rebuild published configured/capped/durable/key
// and no counters.
//
// NOTE FOR THE OWNER, not a code change: the original serves a WORKING Google
// API key in plaintext on this route to any visitor who has the gate password.
// That key is not copied into this repository and never will be; it should be
// rotated. This handler publishes `key` only when GOOGLE_3D_KEY is configured
// here, which is the same shape without importing that exposure.
router.get("/api/3d-session", async (_req, res) => {
  const key = String(process.env.GOOGLE_3D_KEY || "");
  if (!key) return res.json({ configured: false, key: null, used: 0, cap: 0 });
  const q = await reserve3dSession();
  if (!q.allowed) {
    // A refused reservation still reports why: a cap that has been reached and
    // a quota store that cannot be read are different facts.
    return res.json({
      configured: true, key: null, used: q.used, cap: q.cap,
      reason: q.durable ? "daily_cap_reached" : "durable_quota_unavailable"
    });
  }
  return res.json({ configured: true, key, used: q.used, cap: q.cap });
});

export default router;
