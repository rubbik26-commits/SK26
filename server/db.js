// Account database — real, per-user storage for the private workspace. Uses
// Node's built-in SQLite in WAL mode. APP_DATA_DIR may point to a Render
// persistent disk so accounts/workspace state survives deploys and restarts.
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_DATA_DIR } from "./usage-meter.js";

const DATA_DIR = APP_DATA_DIR;
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DB_PATH = path.join(DATA_DIR, "app.db");

// node:sqlite ships unflagged only from Node 22.13 (22.12 still requires
// --experimental-sqlite), and the store also needs a
// writable data directory. Neither is guaranteed on every host: a service
// without the NODE_VERSION pin, or with a read-only/ absent disk mount, would
// otherwise throw here — at import time, before a single route is mounted —
// and take the entire deployment down at boot with no health check ever
// answered. This legacy local account store is not worth that: Supabase is the
// durable workspace in production, so when SQLite cannot open, the app logs it
// plainly, serves everything else, and the local-account routes report
// unavailable instead of the process dying.
function openLocalStore() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const { DatabaseSync } = await_import_sqlite();
    const handle = new DatabaseSync(DB_PATH);
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA foreign_keys = ON");
    return handle;
  } catch (e) {
    console.warn(
      `[db] local SQLite account store unavailable (${e?.message || e}). ` +
      "Serving without it — the Supabase workspace remains authoritative. " +
      "Node 22.13+ and a writable APP_DATA_DIR enable it."
    );
    return null;
  }
}

// Synchronous require of a built-in, so the module keeps its synchronous
// export shape; process.getBuiltinModule exists from Node 22.3 and returns
// undefined for a module this runtime does not have.
function await_import_sqlite() {
  if (process.env.DISABLE_LOCAL_SQLITE === "1") throw new Error("disabled by DISABLE_LOCAL_SQLITE");
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod?.DatabaseSync) throw new Error("node:sqlite is not available in this Node runtime (needs 22.13+; 22.12 requires --experimental-sqlite)");
  return mod;
}

// Stand-in with the same call surface (exec / prepare → run|get|all) so no
// caller needs a null check. Reads come back empty and writes are refused with
// a clear error the routes turn into an honest response.
function unavailableStore() {
  const fail = () => { throw new Error("local account store unavailable on this deployment"); };
  return {
    unavailable: true,
    exec() { /* schema setup is a no-op without a store */ },
    prepare() {
      return { run: fail, get: () => undefined, all: () => [], iterate: () => [] };
    },
    close() {}
  };
}

const handle = openLocalStore();
export const sqliteAvailable = handle !== null;
export const db = handle ?? unavailableStore();

db.exec(`
CREATE TABLE IF NOT EXISTS cre_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cre_profiles (
  user_id TEXT PRIMARY KEY REFERENCES cre_users(id) ON DELETE CASCADE,
  display_name TEXT DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  brand_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cre_watchlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cre_users(id) ON DELETE CASCADE,
  bbl TEXT NOT NULL,
  address TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, bbl)
);
CREATE TABLE IF NOT EXISTS cre_pipeline (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cre_users(id) ON DELETE CASCADE,
  bbl TEXT DEFAULT '',
  opp_id TEXT DEFAULT '',
  address TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'Watchlist',
  propensity INTEGER,
  assessed REAL,
  last_sale REAL,
  stage_history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cre_canvass (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cre_users(id) ON DELETE CASCADE,
  bbl TEXT DEFAULT '',
  address TEXT DEFAULT '',
  touch_type TEXT NOT NULL DEFAULT 'call',
  note TEXT DEFAULT '',
  outcome TEXT DEFAULT '',
  follow_up TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cre_investors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cre_users(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  firm TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  buybox_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cre_users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_watch_user ON cre_watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_pipe_user ON cre_pipeline(user_id);
CREATE INDEX IF NOT EXISTS idx_canvass_user ON cre_canvass(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

export const uid = () => crypto.randomBytes(12).toString("hex");
export const token = () => crypto.randomBytes(32).toString("hex");

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored ?? "").split(":");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  } catch { return false; }
}

export function dailyBackup() {
  if (!sqliteAvailable) return;
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `app-${stamp}.db`);
    if (!existsSync(dest) && existsSync(DB_PATH)) copyFileSync(DB_PATH, dest);
  } catch { /* backups must never block startup */ }
}
dailyBackup();

export function purgeExpiredSessions() {
  if (!sqliteAvailable) return;
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM magic_links WHERE expires_at < datetime('now')").run();
}
purgeExpiredSessions();
