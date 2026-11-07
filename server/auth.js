// Self-hosted authentication plus compatibility with the exact production
// frontend's Supabase account lifecycle.
import { Router } from "express";
import path from "node:path";
import { readFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db, sqliteAvailable, uid, token, hashPassword, verifyPassword, purgeExpiredSessions } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = "cre_session";
const SESSION_DAYS = 30;

// No legacy default: an unset SUPABASE_URL means Supabase auth is not
// configured for this deployment, and every path below says so instead of
// silently talking to the project baked into the compiled frontend.
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(req, res, value, maxAgeSec) {
  const attrs = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSec}`];
  const forwarded = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  if (process.env.NODE_ENV === "production" || forwarded === "https") attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

export function attachUser(req, res, next) {
  req.user = null;
  req.profile = null;
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (tok) {
    const row = db.prepare(
      `SELECT u.id, u.email, p.display_name, p.role, p.brand_json
       FROM sessions s JOIN cre_users u ON u.id = s.user_id
       LEFT JOIN cre_profiles p ON p.user_id = u.id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    ).get(tok);
    if (row) {
      req.user = { id: row.id, email: row.email };
      req.profile = {
        display_name: row.display_name ?? "",
        role: row.role ?? "user",
        brand: safeJson(row.brand_json)
      };
      req.sessionToken = tok;
    }
  }
  next();
}
const safeJson = (s) => { try { return JSON.parse(s ?? "{}"); } catch { return {}; } };

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "sign_in_required", message: "Sign in (left sidebar) to use this." });
  next();
}
export function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "sign_in_required", message: "Sign in (left sidebar) to use this." });
  if (!["owner", "admin"].includes(req.profile?.role)) {
    return res.status(403).json({ error: "owner_only", message: "This page is private to the account owner." });
  }
  next();
}

// ------------------------------------------------------------ role assignment
// Owner comes from the allowlist. Never from being first.
//
// THE ESCALATION THIS CLOSES
// This returned "owner" whenever cre_users was empty, regardless of the email
// address. That role is written to req.profile.role, and routes-bundle's
// isOwner() trusts req.profile.role as an owner signal — so whoever reached
// POST /api/auth/signup first became an owner without OWNER_PASSWORD and
// without appearing on the OWNER_EMAIL allowlist.
//
// On Render's free plan the SQLite file lives in the deploy image and is
// recreated empty on every deploy, restart and cold start. "First user" was
// therefore not a one-time installation moment: it recurred every time the
// container was replaced. Any visitor who had passed the site-password gate
// could take owner on the next cold start.
//
// Local SQLite is a workshop/development identity store, never an implicit
// production authority. The historical empty-database convenience now has to be
// opted into explicitly with LOCAL_FIRST_USER_OWNER=1, and remains disabled in
// NODE_ENV=production regardless.
function roleForNewUser(email) {
  const ownerEmail = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
  if (ownerEmail && email.toLowerCase() === ownerEmail) return "owner";
  if (process.env.NODE_ENV !== "production" && process.env.LOCAL_FIRST_USER_OWNER === "1") {
    const count = db.prepare("SELECT count(*) AS n FROM cre_users").get().n;
    if (count === 0) return "owner";
  }
  return "user";
}

function createSession(req, res, userId) {
  const tok = token();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .run(tok, userId, `+${SESSION_DAYS} days`);
  setSessionCookie(req, res, tok, SESSION_DAYS * 86400);
}

function publicUser(req) {
  return req.user
    ? { signedIn: true, email: req.user.email, display_name: req.profile.display_name, role: req.profile.role, brand: req.profile.brand }
    : { signedIn: false };
}

function importLegacyStores(userId) {
  const imports = [
    { file: path.join(__dirname, "data", "crm-pipeline.json"), kind: "pipeline" },
    { file: path.join(__dirname, "data", "investors.json"), kind: "investors" }
  ];
  for (const { file, kind } of imports) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (kind === "pipeline" && Array.isArray(raw)) {
        const ins = db.prepare(
          "INSERT INTO cre_pipeline (id, user_id, opp_id, bbl, address, stage, stage_history) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        for (const r of raw) {
          ins.run(uid(), userId, String(r.oppId ?? r.id ?? ""), String(r.bbl ?? ""), String(r.address ?? ""), String(r.stage ?? "Watchlist"), JSON.stringify([{ stage: r.stage ?? "Watchlist", at: new Date().toISOString(), via: "legacy-import" }]));
        }
      }
      if (kind === "investors" && Array.isArray(raw?.investors)) {
        const ins = db.prepare(
          "INSERT INTO cre_investors (id, user_id, name, firm, email, phone, buybox_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        for (const inv of raw.investors) {
          ins.run(inv.id || uid(), userId, inv.name ?? "", inv.firm ?? "", inv.email ?? "", inv.phone ?? "", JSON.stringify(inv.buyBox ?? {}));
        }
      }
      renameSync(file, file + ".imported");
    } catch { /* legacy import is best-effort */ }
  }
}

function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  return m?.[1] || null;
}
async function supabaseUser(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${accessToken}`
    }
  });
  if (!r.ok) return null;
  return r.json();
}
async function supabaseAdminDelete(userId) {
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL) {
    const e = new Error("SUPABASE_URL is not configured on this server.");
    e.code = "supabase_admin_unconfigured";
    throw e;
  }
  if (!service) {
    const e = new Error("SUPABASE_SERVICE_ROLE_KEY is not configured on this server.");
    e.code = "supabase_admin_unconfigured";
    throw e;
  }
  const headers = { apikey: service, authorization: `Bearer ${service}` };

  const profileDelete = await fetch(`${SUPABASE_URL}/rest/v1/cre_profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: "DELETE", headers: { ...headers, Prefer: "return=minimal" }
  });
  if (!profileDelete.ok && profileDelete.status >= 500) {
    throw new Error(`Supabase profile cleanup failed (${profileDelete.status}).`);
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Supabase account deletion failed (${r.status})${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
}

const router = Router();

const STORE_REQUIRED = /^\/api\/(auth\/(signup|login|magic)|account-delete)\b/;
router.use((req, res, next) => {
  if (sqliteAvailable || !STORE_REQUIRED.test(req.path)) return next();
  return res.status(503).json({
    error: "account_store_unavailable",
    message: "Local accounts are unavailable on this deployment — the account database could not be opened. The Supabase workspace remains authoritative; sign in there instead."
  });
});

router.get("/api/auth/me", (req, res) => res.json(publicUser(req)));

router.post("/api/auth/signup", (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const display = String(req.body?.display_name ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_email", message: "Enter a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "weak_password", message: "Password must be at least 8 characters." });
  if (db.prepare("SELECT id FROM cre_users WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "exists", message: "An account with that email already exists — sign in instead." });
  }
  const id = uid();
  const role = roleForNewUser(email);
  db.prepare("INSERT INTO cre_users (id, email, password_hash) VALUES (?, ?, ?)").run(id, email, hashPassword(password));
  db.prepare("INSERT INTO cre_profiles (user_id, display_name, role) VALUES (?, ?, ?)").run(id, display, role);
  if (role === "owner") importLegacyStores(id);
  createSession(req, res, id);
  req.user = { id, email };
  req.profile = { display_name: display, role, brand: {} };
  res.json(publicUser(req));
});

router.post("/api/auth/login", (req, res) => {
  purgeExpiredSessions();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const user = db.prepare("SELECT id, email, password_hash FROM cre_users WHERE email = ?").get(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "bad_credentials", message: "Email or password is incorrect." });
  }
  createSession(req, res, user.id);
  const p = db.prepare("SELECT display_name, role, brand_json FROM cre_profiles WHERE user_id = ?").get(user.id);
  req.user = { id: user.id, email: user.email };
  req.profile = { display_name: p?.display_name ?? "", role: p?.role ?? "user", brand: safeJson(p?.brand_json) };
  res.json(publicUser(req));
});

router.post("/api/auth/magic", (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "bad_email", message: "Enter a valid email." });
  return res.status(501).json({
    sent: false,
    configured: false,
    error: "self_hosted_magic_not_configured",
    message: "The production frontend uses Supabase magic-link authentication directly."
  });
});

router.get("/api/auth/magic/:token", (req, res) => {
  const row = db.prepare("SELECT token, email FROM magic_links WHERE token = ? AND used = 0 AND expires_at > datetime('now')").get(req.params.token);
  if (!row) return res.status(400).json({ error: "invalid_link", message: "That sign-in link is invalid or expired." });
  db.prepare("UPDATE magic_links SET used = 1 WHERE token = ?").run(row.token);
  let user = db.prepare("SELECT id FROM cre_users WHERE email = ?").get(row.email);
  if (!user) {
    const id = uid();
    const role = roleForNewUser(row.email);
    db.prepare("INSERT INTO cre_users (id, email, password_hash) VALUES (?, ?, NULL)").run(id, row.email);
    db.prepare("INSERT INTO cre_profiles (user_id, role) VALUES (?, ?)").run(id, role);
    if (role === "owner") importLegacyStores(id);
    user = { id };
  }
  createSession(req, res, user.id);
  res.redirect("/#/desk");
});

router.post("/api/auth/logout", (req, res) => {
  const tok = parseCookies(req)[SESSION_COOKIE];
  if (tok) db.prepare("DELETE FROM sessions WHERE token = ?").run(tok);
  setSessionCookie(req, res, "", 0);
  res.json({ signedOut: true });
});

router.post("/api/account-delete", async (req, res) => {
  const bearer = bearerToken(req);
  if (bearer) {
    try {
      const user = await supabaseUser(bearer);
      if (!user?.id) return res.status(401).json({ error: "invalid_session" });
      await supabaseAdminDelete(user.id);
      return res.json({ deleted: true, message: "Account deleted." });
    } catch (e) {
      const status = e?.code === "supabase_admin_unconfigured" ? 503 : 500;
      return res.status(status).json({ error: e?.code || "delete_failed", message: e?.message || "Deletion failed." });
    }
  }

  if (!req.user) return res.status(401).json({ error: "sign_in_required", message: "Sign in to delete your account." });
  try {
    db.prepare("DELETE FROM cre_users WHERE id = ?").run(req.user.id);
    setSessionCookie(req, res, "", 0);
    return res.json({ deleted: true, message: "Account and every private record attached to it were permanently deleted." });
  } catch {
    return res.status(500).json({ error: "delete_failed", message: "Deletion failed — nothing was removed. Try again." });
  }
});

export default router;
