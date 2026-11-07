// Gate-only Pipeline deletion. The exact compiled UI does not currently expose
// this control, but release verification and administrative cleanup need a real
// mutation instead of leaving synthetic probe rows in the shared board.
import { Router } from "express";
import { durableStore } from "./durable-store.js";

const router = Router();
const store = durableStore("kanban-pipeline.json", { rows: [] });
const hasBearer = (req) => /^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""));

router.delete("/api/pipeline/:oppId", async (req, res, next) => {
  if (hasBearer(req)) return next();
  const oppId = String(req.params.oppId ?? "").trim().slice(0, 160);
  if (!oppId) return res.status(400).json({ error: "invalid_pipeline_record" });
  try {
    const state = await store.load();
    const rows = Array.isArray(state?.rows) ? state.rows : [];
    const filtered = rows.filter((r) => String(r?.oppId) !== oppId);
    if (filtered.length === rows.length) return res.status(204).end();
    const write = await store.save({ ...state, rows: filtered });
    if (process.env.NODE_ENV === "production" && write?.durable === false) {
      return res.status(503).json({
        error: "durable_storage_required",
        durable: false,
        backend: write?.backend || "disk",
        message: "The pipeline card was not reported deleted because the durable production store is unavailable."
      });
    }
    return res.status(204).end();
  } catch (e) {
    return res.status(503).json({
      error: e?.code || "pipeline_delete_failed",
      durable: false,
      message: e?.message || "The pipeline card could not be deleted from the durable store."
    });
  }
});

export default router;
