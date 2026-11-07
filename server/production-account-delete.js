import { Router } from "express";
import { adminKey, supabaseUrl } from "./production-api.js";
import { appStateToken, appStatePublishableKey } from "./durable-store.js";
import { supabaseHeaders } from "./supabase-credentials.js";

const router = Router();
const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));

router.post("/api/account-delete", async (req, res, next) => {
  if (!hasBearer(req)) return next();
  const user = req.productionUser;
  if (!user?.id || !user?.token) return res.status(401).json({ error: "Invalid session." });

  const service = adminKey();
  if (service) {
    try {
      const r = await fetch(`${supabaseUrl()}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        // Modern sb_secret_ credentials are API keys, not JWT bearer tokens;
        // legacy service_role JWTs are valid in both headers. Use the shared
        // classifier so the first-mounted account-delete route follows the same
        // transport rules as every other privileged Supabase call.
        headers: supabaseHeaders({ apiKey: service }),
        signal: AbortSignal.timeout(10000)
      });
      const text = await r.text().catch(() => "");
      if (!r.ok) {
        return res.status(502).json({
          error: "account_delete_failed",
          message: text.slice(0, 300) || `Supabase Auth Admin returned HTTP ${r.status}.`
        });
      }
      // All cre_* workspace tables reference auth.users with ON DELETE CASCADE;
      // deleting the auth principal is the single atomic ownership root. Do not
      // issue best-effort per-table deletes with swallowed errors beforehand.
      return res.json({ deleted: true });
    } catch (e) {
      return res.status(502).json({ error: "account_delete_failed", message: e?.message || "Supabase Auth Admin is unavailable." });
    }
  }

  const key = appStatePublishableKey();
  const token = appStateToken();
  if (!key || !token) {
    return res.status(501).json({
      error: "Deletion isn't configured on this deployment yet — add SUPABASE_SECRET_KEY / a valid service-role key, or register the app-state write token."
    });
  }

  try {
    // Authorization MUST carry the caller's Supabase access token. Migration
    // 202608170003 enforces auth.uid() = p_user_id inside the database, so a
    // direct PostgREST caller cannot use the shared deployment token to delete
    // another account.
    const r = await fetch(`${supabaseUrl()}/rest/v1/rpc/cre_account_delete_tk`, {
      method: "POST",
      headers: supabaseHeaders({ apiKey: key, bearerToken: user.token, json: true }),
      body: JSON.stringify({ p_user_id: user.id, p_token: token }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await r.text().catch(() => "");
    let out = null;
    try { out = text ? JSON.parse(text) : null; } catch { out = null; }
    if (!r.ok || out?.deleted !== true) {
      return res.status(502).json({
        error: "account_delete_failed",
        message: out?.message || text.slice(0, 300) || `Self-delete RPC returned HTTP ${r.status}.`
      });
    }
    return res.json({ deleted: true });
  } catch (e) {
    return res.status(502).json({ error: "account_delete_failed", message: e?.message || "Account deletion RPC is unavailable." });
  }
});

export default router;
