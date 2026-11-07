// Per-user private workspace (audit items 14-18, 43-45): watchlist, pipeline
// with stage history, canvass log, profile + report branding, investor pool —
// every row keyed to the authenticated user and enforced server-side.
//
// IMPORTANT PARITY NOTE: the exact production frontend shipped in
// nycremarketintel-site talks to Supabase directly for account workspace data
// and calls several owner APIs without the self-hosted session cookie. The
// SQLite workspace below therefore coexists with the original API contract:
// when there is no self-hosted session, owner-tool routes fall through to the
// original-compatible routes instead of returning a false 401.
import { Router } from "express";
import { db, uid, dailyBackup } from "./db.js";
import { requireAuth, requireOwner } from "./auth.js";

const router = Router();
const j = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ------------------------------------------------------------ profile
router.get("/api/profile", requireAuth, (req, res) => {
  res.json({ email: req.user.email, display_name: req.profile.display_name, role: req.profile.role, brand: req.profile.brand });
});
router.put("/api/profile", requireAuth, (req, res) => {
  const display = String(req.body?.display_name ?? req.profile.display_name ?? "");
  const brand = req.body?.brand && typeof req.body.brand === "object" ? req.body.brand : req.profile.brand;
  db.prepare("UPDATE cre_profiles SET display_name = ?, brand_json = ?, updated_at = datetime('now') WHERE user_id = ?")
    .run(display, JSON.stringify(brand), req.user.id);
  dailyBackup();
  res.json({ display_name: display, brand });
});

// ------------------------------------------------------------ watchlist
router.get("/api/watchlist", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, bbl, address, note, created_at FROM cre_watchlist WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json({ watchlist: rows });
});
router.post("/api/watchlist", requireAuth, (req, res) => {
  const bbl = String(req.body?.bbl ?? "").replace(/[^0-9]/g, "");
  if (!bbl) return res.status(400).json({ error: "bbl_required" });
  db.prepare("INSERT INTO cre_watchlist (id, user_id, bbl, address, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, bbl) DO UPDATE SET address = excluded.address")
    .run(uid(), req.user.id, bbl, String(req.body?.address ?? ""), String(req.body?.note ?? ""));
  res.json({ ok: true });
});
router.delete("/api/watchlist/:id", requireAuth, (req, res) => {
  const r = db.prepare("DELETE FROM cre_watchlist WHERE user_id = ? AND (id = ? OR bbl = ?)").run(req.user.id, req.params.id, req.params.id);
  res.json({ ok: true, removed: r.changes });
});

// ------------------------------------------------------------ pipeline (consolidated, item 16/44)
// GET /api/pipeline without ?zips= serves the signed-in user's CRM rows; the
// ?zips= development-pipeline lookup falls through to the data router.
router.get("/api/pipeline", (req, res, next) => {
  if (req.query.zips) return next();
  if (!req.user) return res.status(401).json({ error: "sign_in_required", message: "Sign in (left sidebar) to use the pipeline." });
  const rows = db.prepare("SELECT id, opp_id, bbl, address, owner, stage, propensity, assessed, last_sale, stage_history, created_at, updated_at FROM cre_pipeline WHERE user_id = ? ORDER BY created_at ASC").all(req.user.id);
  res.json({ pipeline: rows.map((r) => ({ ...r, oppId: r.opp_id, stageHistory: j(r.stage_history, []) })) });
});
router.post("/api/pipeline", (req, res, next) => {
  if (req.query.zips) return next();
  if (!req.user) return res.status(401).json({ error: "sign_in_required", message: "Sign in (left sidebar) to use the pipeline." });
  const stage = String(req.body?.stage ?? "Watchlist");
  const oppId = String(req.body?.oppId ?? "");
  const bbl = String(req.body?.bbl ?? "").replace(/[^0-9]/g, "");
  const existing = oppId
    ? db.prepare("SELECT id, stage, stage_history FROM cre_pipeline WHERE user_id = ? AND opp_id = ? AND opp_id != ''").get(req.user.id, oppId)
    : bbl ? db.prepare("SELECT id, stage, stage_history FROM cre_pipeline WHERE user_id = ? AND bbl = ? AND bbl != ''").get(req.user.id, bbl) : null;
  if (existing) {
    const history = j(existing.stage_history, []);
    if (stage !== existing.stage) history.push({ stage, at: new Date().toISOString() });
    db.prepare("UPDATE cre_pipeline SET stage = ?, stage_history = ?, updated_at = datetime('now') WHERE id = ?")
      .run(stage, JSON.stringify(history), existing.id);
    return res.json({ ok: true, id: existing.id, updated: true });
  }
  const id = uid();
  db.prepare("INSERT INTO cre_pipeline (id, user_id, opp_id, bbl, address, owner, stage, propensity, assessed, last_sale, stage_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, req.user.id, oppId, bbl, String(req.body?.address ?? ""), String(req.body?.owner ?? ""), stage,
      req.body?.propensity ?? null, req.body?.assessed ?? null, req.body?.lastSale ?? null,
      JSON.stringify([{ stage, at: new Date().toISOString() }]));
  dailyBackup();
  res.json({ ok: true, id });
});
router.patch("/api/pipeline/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT id, opp_id, stage, stage_history FROM cre_pipeline WHERE user_id = ? AND (id = ? OR opp_id = ?)").get(req.user.id, req.params.id, req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const stage = String(req.body?.stage ?? row.stage);
  const history = j(row.stage_history, []);
  if (stage !== row.stage) history.push({ stage, at: new Date().toISOString() });
  db.prepare("UPDATE cre_pipeline SET stage = ?, stage_history = ?, updated_at = datetime('now') WHERE id = ?")
    .run(stage, JSON.stringify(history), row.id);
  res.json({ ok: true, stage, stageHistory: history });
});
router.delete("/api/pipeline/:id", requireAuth, (req, res) => {
  const r = db.prepare("DELETE FROM cre_pipeline WHERE user_id = ? AND (id = ? OR opp_id = ? OR bbl = ?)").run(req.user.id, req.params.id, req.params.id, req.params.id);
  res.json({ ok: true, removed: r.changes });
});

// ------------------------------------------------------------ canvass (item 17)
router.get("/api/canvass", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, bbl, address, touch_type, note, outcome, follow_up, created_at FROM cre_canvass WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").all(req.user.id);
  res.json({ canvass: rows.map((r) => ({ id: r.id, bbl: r.bbl, address: r.address, type: r.touch_type, note: r.note, outcome: r.outcome, follow: r.follow_up, at: r.created_at })) });
});
router.post("/api/canvass", requireAuth, (req, res) => {
  const id = uid();
  db.prepare("INSERT INTO cre_canvass (id, user_id, bbl, address, touch_type, note, outcome, follow_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, req.user.id, String(req.body?.bbl ?? "").replace(/[^0-9]/g, ""), String(req.body?.address ?? ""),
      String(req.body?.type ?? "call"), String(req.body?.note ?? ""), String(req.body?.outcome ?? ""), String(req.body?.follow ?? ""));
  dailyBackup();
  res.json({ ok: true, id });
});
router.delete("/api/canvass/:id", requireAuth, (req, res) => {
  const r = db.prepare("DELETE FROM cre_canvass WHERE user_id = ? AND id = ?").run(req.user.id, req.params.id);
  res.json({ ok: true, removed: r.changes });
});

// One-time import of a browser-local desk into the account (item 45 —
// cloud is the source of truth; the browser copy becomes a cache).
router.post("/api/desk-import", requireAuth, (req, res) => {
  const d = req.body ?? {};
  let imported = 0;
  for (const w of Array.isArray(d.watchlist) ? d.watchlist : []) {
    const bbl = String(w.bbl ?? "").replace(/[^0-9]/g, "");
    if (!bbl) continue;
    db.prepare("INSERT INTO cre_watchlist (id, user_id, bbl, address) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, bbl) DO NOTHING")
      .run(uid(), req.user.id, bbl, String(w.address ?? ""));
    imported++;
  }
  for (const p of Array.isArray(d.pipeline) ? d.pipeline : []) {
    const exists = db.prepare("SELECT id FROM cre_pipeline WHERE user_id = ? AND bbl = ? AND bbl != ''").get(req.user.id, String(p.bbl ?? ""));
    if (exists) continue;
    db.prepare("INSERT INTO cre_pipeline (id, user_id, bbl, address, owner, stage, propensity, assessed, last_sale, stage_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uid(), req.user.id, String(p.bbl ?? ""), String(p.address ?? ""), String(p.owner ?? ""), String(p.stage ?? "Lead"), p.propensity ?? null, p.assessed ?? null, p.lastSale ?? null, JSON.stringify([{ stage: p.stage ?? "Lead", at: new Date().toISOString(), via: "browser-import" }]));
    imported++;
  }
  for (const c of Array.isArray(d.canvass) ? d.canvass : []) {
    db.prepare("INSERT INTO cre_canvass (id, user_id, bbl, address, touch_type, note, outcome, follow_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(uid(), req.user.id, String(c.bbl ?? ""), String(c.address ?? ""), String(c.type ?? "call"), String(c.note ?? ""), String(c.outcome ?? ""), String(c.follow ?? ""), c.at ? new Date(c.at).toISOString() : new Date().toISOString());
    imported++;
  }
  if (d.brand && typeof d.brand === "object") {
    db.prepare("UPDATE cre_profiles SET brand_json = ?, updated_at = datetime('now') WHERE user_id = ?").run(JSON.stringify(d.brand), req.user.id);
  }
  if (d.name && !req.profile.display_name) {
    db.prepare("UPDATE cre_profiles SET display_name = ? WHERE user_id = ?").run(String(d.name), req.user.id);
  }
  dailyBackup();
  res.json({ ok: true, imported });
});

// ------------------------------------------------------------ investors
// The self-hosted reconstruction uses a per-user SQLite pool. The exact
// production frontend does not send that cookie for /api/investors, so an
// anonymous-to-this-server request must skip this route and reach the original
// compatible owner API later in the stack.
function selfHostedOwnerOrOriginal(req, res, next) {
  if (!req.user) return next("route");
  return requireOwner(req, res, next);
}

router.get("/api/investors", selfHostedOwnerOrOriginal, (req, res) => {
  const rows = db.prepare("SELECT id, name, firm, email, phone, buybox_json FROM cre_investors WHERE user_id = ? ORDER BY created_at ASC").all(req.user.id);
  res.json({ investors: rows.map((r) => ({ id: r.id, name: r.name, firm: r.firm, email: r.email, phone: r.phone, buyBox: j(r.buybox_json, {}) })) });
});
router.post("/api/investors", selfHostedOwnerOrOriginal, (req, res) => {
  const investors = Array.isArray(req.body?.investors) ? req.body.investors : null;
  if (!investors) return res.status(400).json({ error: "bad_payload", message: "Body must be { investors: [...] }." });
  const del = db.prepare("DELETE FROM cre_investors WHERE user_id = ?");
  const ins = db.prepare("INSERT INTO cre_investors (id, user_id, name, firm, email, phone, buybox_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    del.run(req.user.id);
    for (const inv of investors) {
      ins.run(String(inv.id || uid()), req.user.id, String(inv.name ?? ""), String(inv.firm ?? ""), String(inv.email ?? ""), String(inv.phone ?? ""), JSON.stringify(inv.buyBox ?? {}));
    }
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "save_failed", message: "Pool not saved — nothing was changed." });
  }
  dailyBackup();
  res.json({ ok: true, count: investors.length });
});

// ------------------------------------------------------------ owner-tool compatibility
function selfHostedOwnerGateOrOriginal(req, res, next) {
  if (!req.user) return next("route");
  if (!["owner", "admin"].includes(req.profile?.role)) {
    return res.status(403).json({ error: "owner_only", message: "This page is private to the account owner." });
  }
  return next("route");
}
router.get("/api/sources", selfHostedOwnerGateOrOriginal);
router.get("/api/airtable-xref", selfHostedOwnerGateOrOriginal);
router.get("/api/pinecone-status", selfHostedOwnerGateOrOriginal);
router.get("/api/maps-usage", selfHostedOwnerGateOrOriginal);

export default router;
