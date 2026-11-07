// Preflight the complete evidence set used by the production distress score.
// The existing handler is intentionally left unchanged on success so its
// response shape and calculations remain the observed production contract.
// This guard only prevents a missing official source from being converted into
// a factual zero before that handler runs.
import { Router } from "express";
import { hpdViolationsByBbl, s311ByBbl } from "./adapters/nyc.js";
import { dobViolationsByLot } from "./adapters/dob-violations.js";

const router = Router();
const bblOf = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return /^[1-5]\d{9}$/.test(d) ? d : "";
};

router.get("/api/distress", async (req, res, next) => {
  const bbl = bblOf(req.query.bbl);
  if (!bbl) return next(); // existing handler owns the exact invalid-BBL body

  const [hpd, dob, complaints] = await Promise.all([
    hpdViolationsByBbl(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) })),
    dobViolationsByLot(bbl).catch((e) => ({ live: false, safety: [], legacy: [], ecb: [], error: e?.message || String(e) })),
    s311ByBbl(bbl, 12).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }))
  ]);

  const dobStatus = dob?.sourceStatus || {};
  const missing = [
    !hpd?.live ? { source: "HPD violations", error: hpd?.error || "unavailable" } : null,
    dobStatus.safety !== "live" ? { source: "DOB Safety Violations", error: dob?.error || "unavailable" } : null,
    dobStatus.legacy !== "live" ? { source: "DOB Violations (BIS)", error: dob?.error || "unavailable" } : null,
    dobStatus.ecb !== "live" ? { source: "DOB ECB/OATH", error: dob?.error || "unavailable" } : null,
    !complaints?.live ? { source: "NYC 311", error: complaints?.error || "unavailable" } : null
  ].filter(Boolean);

  if (missing.length) {
    return res.status(503).json({
      provenance: "unavailable",
      error: "distress_sources_partial",
      message: "The complete official evidence set required for the distress score is not available. Missing sources are not treated as zero activity.",
      missingSources: missing,
      sourceStatus: {
        hpd: hpd?.live ? "live" : "unavailable",
        dobSafety: dobStatus.safety || "unavailable",
        dobLegacy: dobStatus.legacy || "unavailable",
        ecb: dobStatus.ecb || "unavailable",
        threeOneOne: complaints?.live ? "live" : "unavailable"
      }
    });
  }

  return next();
});

export default router;
