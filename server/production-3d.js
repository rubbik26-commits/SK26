// Production 3D session gate. It is mounted before the legacy router so the
// Google Photorealistic key is never released without first recording the
// grant. APP_DATA_DIR should be a Render persistent-disk mount in production.
import { Router } from "express";
import path from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { APP_DATA_DIR, bumpUsage } from "./usage-meter.js";

const router = Router();
const statePath = path.join(APP_DATA_DIR, "3d-sessions.json");
let gate = Promise.resolve();

function readState() {
  try { return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { day: "", used: 0 }; }
  catch { return { day: "", used: 0 }; }
}
function writeState(s) {
  const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, statePath);
}
function capValue() {
  const n = Number(process.env.GOOGLE_3D_DAILY_CAP || 25);
  return Number.isFinite(n) ? Math.max(0, Math.min(10000, Math.floor(n))) : 25;
}

router.get("/api/3d-session", (req, res) => {
  gate = gate.then(async () => {
    const key = String(process.env.GOOGLE_3D_KEY || "");
    const cap = capValue();
    if (!key || cap <= 0) {
      return res.json({ configured: !!key, capped: cap <= 0, used: 0, cap, key: null });
    }

    const today = new Date().toISOString().slice(0, 10);
    const s = readState();
    if (s.day !== today) { s.day = today; s.used = 0; }
    s.used = Math.max(0, Number(s.used || 0));
    if (s.used >= cap) {
      return res.json({ configured: true, capped: true, used: s.used, cap, key: null });
    }

    // Persist before exposing the billable key. Failure is fail-closed.
    s.used += 1;
    try { writeState(s); }
    catch {
      return res.status(503).json({
        configured: true, capped: true, used: Math.max(0, s.used - 1), cap, key: null,
        error: "quota_persistence_failed"
      });
    }
    await bumpUsage("photorealistic3d");
    return res.json({ configured: true, capped: false, used: s.used, cap, key });
  }).catch(() => {
    if (!res.headersSent) res.status(503).json({ configured: true, capped: true, key: null, error: "quota_gate_failed" });
  });
});

export default router;
