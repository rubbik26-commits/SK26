// One authority for Supabase API-key classification.
//
// Hosted Supabase currently supports two server credential forms:
//   * legacy JWT service_role keys (payload role === "service_role")
//   * modern opaque sb_secret_... keys
// Publishable/anon credentials must never be mistaken for an admin credential.
// Keep this module dependency-free so build/migration scripts and runtime code
// can use exactly the same decision without creating import cycles.

export function jwtRole(raw) {
  const value = String(raw || "").trim();
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function isSupabaseSecretKey(raw) {
  return /^sb_secret_[A-Za-z0-9_-]+$/.test(String(raw || "").trim());
}

export function isSupabasePublishableKey(raw) {
  return /^sb_publishable_[A-Za-z0-9_-]+$/.test(String(raw || "").trim());
}

export function serviceCredential(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (isSupabaseSecretKey(value)) return value;
  if (isSupabasePublishableKey(value)) return "";
  return jwtRole(value) === "service_role" ? value : "";
}

export function adminCredential(env = process.env) {
  return serviceCredential(env.SUPABASE_SERVICE_ROLE_KEY) || serviceCredential(env.SUPABASE_SECRET_KEY);
}

export function publicCredential(env = process.env) {
  return String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
}

// A Supabase REST/Auth base must be HTTP(S). Connection strings such as
// postgresql://... belong to pg, not fetch(). This deliberately rejects them
// instead of letting callers build nonsense like
// postgresql://.../rest/v1/rpc/lot_at and then silently disable the warehouse.
// Quoted values are tolerated because deployment dashboards sometimes preserve
// surrounding quotes when values are pasted from .env files.
export function normalizeSupabaseApiUrl(raw) {
  let value = String(raw || "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return "";
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return "";
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

// Supabase's modern sb_secret_ keys are API keys, not JWT bearer tokens. Legacy
// service_role keys are JWTs and may be sent in both headers. User JWTs should
// be paired with a public API key and supplied as bearerToken.
export function supabaseHeaders({ apiKey, bearerToken = "", json = false, accept = "application/json" } = {}) {
  let key = String(apiKey || "").trim();
  const bearer = String(bearerToken || "").trim();

  if (isSupabaseSecretKey(bearer)) key = bearer;

  const headers = { apikey: key, accept };
  if (json) headers["content-type"] = "application/json";

  if (bearer && !isSupabaseSecretKey(bearer) && !isSupabasePublishableKey(bearer)) {
    headers.authorization = `Bearer ${bearer}`;
  } else if (!bearer && jwtRole(key) === "service_role") {
    headers.authorization = `Bearer ${key}`;
  }

  return headers;
}
