// Same-origin Supabase configuration for the immutable bundle. The compiled
// frontend bakes in the original project's URL + publishable key; this tiny
// same-origin script exposes the deployment's configured project
// (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY) so the auth bridge can repoint the
// bundle's Supabase traffic without editing a byte of the pinned assets.
//
// The legacy values below exist ONLY so the bridge can IDENTIFY traffic aimed
// at the baked-in project. They are never served as the deployment's own
// url/publishableKey: with no environment override those fields are empty, the
// bridge changes nothing, and every server module treats Supabase as
// unconfigured — the authoritative database is an explicit choice, never a
// fallback (owner directive 2026-08-18).
import { Router } from "express";

export const LEGACY_SUPABASE_URL = "https://qrcpeskqkoyacnmjuxni.supabase.co";
export const LEGACY_PUBLISHABLE_KEY = "sb_publishable_eitMsToTW6CWahEdLEdKVA_g2165wPR";

const router = Router();
router.get("/js/supabase-env.js", (_req, res) => {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const publishableKey = String(
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || ""
  );
  res.type("application/javascript")
    .set("cache-control", "no-store")
    .send(`window.__SUPABASE_ENV__=${JSON.stringify({
      url,
      publishableKey,
      legacyUrl: LEGACY_SUPABASE_URL,
      legacyPublishableKey: LEGACY_PUBLISHABLE_KEY
    })};`);
});

export default router;
