// Exact-production API compatibility layer.
// The immutable frontend authenticates directly with Supabase. The hosting
// bridge retargets those Supabase-host requests to the configured project but
// intentionally does not attach that session to ordinary same-origin /api/*
// calls: the original Owner application uses its password gate for those
// surfaces. Explicit bearer calls remain supported here for account-aware
// compatibility paths such as self-service account deletion.
import { Router } from "express";
import { airtableConfigured, crmXref } from "./adapters/airtable.js";
import { pineconeConfigured } from "./adapters/pinecone.js";
import { readDurableUsage, usageStoreConfigured } from "./durable-cost.js";
import {
  adminCredential,
  publicCredential,
  serviceCredential,
  supabaseHeaders
} from "./supabase-credentials.js";

const router = Router();
const supabaseUrl = () => String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const publishableKey = () => publicCredential();
const adminKey = () => adminCredential();
const ownerEmails = () => new Set(String(process.env.OWNER_EMAIL || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
const bearer = (req) => {
  const h = String(req.headers.authorization || "");
  return /^Bearer\s+\S+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : "";
};

async function supabaseFetch(pathname, { token = "", method = "GET", body, prefer } = {}) {
  if (!supabaseUrl() || !publishableKey()) {
    const e = new Error("Supabase is not configured on this deployment (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY).");
    e.status = 503;
    e.code = "supabase_not_configured";
    throw e;
  }

  const apiKey = serviceCredential(token) || publishableKey();
  const headers = supabaseHeaders({ apiKey, bearerToken: token, json: body !== undefined });
  if (prefer) headers.prefer = prefer;
  const r = await fetch(`${supabaseUrl()}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  const text = await r.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!r.ok) {
    const e = new Error(json?.message || json?.error_description || text.slice(0, 400) || `Supabase HTTP ${r.status}`);
    e.status = r.status; e.payload = json; throw e;
  }
  return json;
}

async function bootstrapOwnerProfile(user) {
  const email = String(user?.email || "").toLowerCase();
  if (!user?.id || !email || !ownerEmails().has(email)) return false;
  const secret = adminKey();
  if (!secret) return true;
  try {
    await supabaseFetch("/rest/v1/cre_profiles?on_conflict=id", {
      token: secret, method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: { id: user.id, display_name: user.user_metadata?.display_name || user.email || "Owner", role: "owner", updated_at: new Date().toISOString() }
    });
    return true;
  } catch {
    return true;
  }
}

const authCache = new Map();
async function productionIdentity(req) {
  const token = bearer(req);
  if (!token) return null;
  const hit = authCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.value;
  try {
    const user = await supabaseFetch("/auth/v1/user", { token });
    if (!user?.id) return null;
    let role = "user", displayName = user.email || "";
    try {
      const rows = await supabaseFetch(`/rest/v1/cre_profiles?select=display_name,role&id=eq.${encodeURIComponent(user.id)}&limit=1`, { token });
      const p = Array.isArray(rows) ? rows[0] : null;
      role = String(p?.role || "user").toLowerCase();
      displayName = p?.display_name || displayName;
    } catch {
      // Authenticated users without a readable profile remain normal users.
    }
    const bootstrappedOwner = await bootstrapOwnerProfile(user);
    if (bootstrappedOwner) role = "owner";
    const value = { id: user.id, email: user.email || "", displayName, role, token, bootstrappedOwner };
    authCache.set(token, { value, expires: Date.now() + 30000 });
    if (authCache.size > 300) authCache.clear();
    return value;
  } catch { return null; }
}
const isOwner = (u) => !!u && ["owner", "admin"].includes(String(u.role).toLowerCase());
const privateStoreToken = (u) => isOwner(u) && adminKey() ? adminKey() : u?.token || "";

async function requireUser(req, res, next) {
  const u = await productionIdentity(req);
  if (!u) return res.status(401).json({ error: "authentication_required" });
  req.productionUser = u; next();
}
async function requireOwner(req, res, next) {
  const u = await productionIdentity(req);
  if (!u) return res.status(401).json({ error: "authentication_required" });
  if (!isOwner(u)) return res.status(403).json({ error: "owner_only" });
  req.productionUser = u; next();
}

router.get("/api/pinecone-status", async (req, res) => {
  const u = await productionIdentity(req);
  const configured = pineconeConfigured();
  res.json({
    owner: isOwner(u),
    configured,
    hasKey: !!process.env.PINECONE_API_KEY,
    hasHost: !!process.env.PINECONE_INDEX_HOST,
    engine: configured ? "pinecone" : "public-record-similarity"
  });
});

router.get("/api/investors", requireOwner, async (req, res) => {
  try {
    const token = privateStoreToken(req.productionUser);
    const rows = await supabaseFetch(`/rest/v1/cre_investors?select=data&user_id=eq.${encodeURIComponent(req.productionUser.id)}&limit=1`, { token });
    const data = Array.isArray(rows) ? rows[0]?.data : null;
    return res.json({ owner: true, investors: Array.isArray(data) ? data : [] });
  } catch (e) {
    return res.status(502).json({ error: "investor_store_unavailable", message: e.message });
  }
});
router.post("/api/investors", requireOwner, async (req, res) => {
  const investors = Array.isArray(req.body?.investors) ? req.body.investors : null;
  if (!investors) return res.status(400).json({ error: "bad_payload", message: "Body must be { investors: [...] }." });
  if (investors.length > 5000) return res.status(413).json({ error: "too_many_investors" });
  const clean = investors.map((inv) => ({
    id: String(inv?.id ?? "").slice(0, 200), name: String(inv?.name ?? "").slice(0, 500),
    firm: String(inv?.firm ?? "").slice(0, 500), email: String(inv?.email ?? "").slice(0, 500),
    phone: String(inv?.phone ?? "").slice(0, 100),
    buyBox: inv?.buyBox && typeof inv.buyBox === "object" && !Array.isArray(inv.buyBox) ? inv.buyBox : {}
  }));
  try {
    const token = privateStoreToken(req.productionUser);
    if (!token) return res.status(503).json({ error: "investor_store_unconfigured" });
    await supabaseFetch("/rest/v1/cre_investors?on_conflict=user_id", {
      token, method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: { user_id: req.productionUser.id, data: clean, updated_at: new Date().toISOString() }
    });
    return res.json({ owner: true, investors: clean });
  } catch (e) {
    return res.status(502).json({ error: "investor_store_unavailable", message: e.message });
  }
});

router.get("/api/airtable-xref", requireOwner, async (req, res) => {
  if (!airtableConfigured()) return res.json({ configured: false, provenance: "unavailable", sellerMatches: [], buyerMatches: [] });
  try {
    const out = await crmXref({
      owner: String(req.query.owner ?? ""), address: String(req.query.address ?? ""),
      bbl: String(req.query.bbl ?? "").replace(/[^0-9]/g, ""),
      borough: String(req.query.borough ?? ""), assetClass: String(req.query.assetClass ?? ""),
      price: Number(req.query.price) || null
    });
    res.json({ provenance: "live", ...out });
  } catch (e) {
    res.status(502).json({ configured: true, provenance: "unavailable", error: "airtable_unavailable", message: e?.message || "Airtable request failed." });
  }
});

// Compatibility bearer path for an explicitly authenticated Owner caller. The
// exact Owner Source Registry does not send this bearer, but when one is
// supplied the response must keep the same field meanings as the gate route.
router.get("/api/maps-usage", requireOwner, async (_req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const storeConfigured = usageStoreConfigured();
  const mapsConfigured = !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY);

  if (!storeConfigured) {
    return res.json({
      configured: false,
      durable: false,
      month,
      streetview: 0,
      staticmap: 0,
      photorealistic3d: 0,
      freeStreetview: 5000,
      freeStatic: 10000,
      mapsConfigured
    });
  }

  const d = await readDurableUsage(month);
  const common = {
    configured: true,
    month,
    streetview: d.byCategory?.streetview ?? 0,
    staticmap: d.byCategory?.staticmap ?? 0,
    photorealistic3d: d.byCategory?.photorealistic3d ?? 0,
    freeStreetview: 5000,
    freeStatic: 10000,
    mapsConfigured
  };
  if (!d.live) {
    return res.status(503).json({
      ...common,
      durable: false,
      error: "usage_store_unavailable",
      message: d.reason || "The durable usage store is unavailable."
    });
  }
  return res.json({ ...common, durable: true, source: "cre_usage_daily" });
});

router.post("/api/account-delete", requireUser, async (req, res) => {
  const secret = adminKey();
  if (!secret) return res.status(503).json({ deleted: false, error: "account_delete_unconfigured", message: "Server-side Supabase admin credentials are not configured." });
  try {
    const r = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(req.productionUser.id)}`, {
      method: "DELETE",
      headers: supabaseHeaders({ apiKey: secret }),
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(502).json({ deleted: false, error: "delete_failed", message: detail.slice(0, 500) || `Supabase returned ${r.status}.` });
    }
    authCache.delete(req.productionUser.token);
    res.json({ deleted: true });
  } catch (e) {
    res.status(502).json({ deleted: false, error: "auth_provider_unavailable", message: e?.message || "Supabase request failed." });
  }
});

export { productionIdentity, requireUser, requireOwner, supabaseFetch, adminKey, supabaseUrl };
export default router;
