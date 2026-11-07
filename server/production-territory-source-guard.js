// Territory/Area Detail intentionally cap analysis at 6,000 highest-scoring
// lots and disclose that sampling. A source failure before reaching that sample
// size is different: it must be unavailable, not labelled as an intentional
// sample. This preflight validates the same page traversal without changing the
// existing successful response contract.
import { Router } from "express";
import { liveAreaBuildings } from "./live.js";

const router = Router();
const PAGE = 1000;
const MAX_LOTS = 6000;
const zipsFrom = (v) => [...new Set(String(v ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];

async function validateAreaTraversal(zips) {
  const first = await liveAreaBuildings(zips, { page: 0, pageSize: PAGE, sort: "score" }).catch(() => null);
  if (!first?.buildings) return { ok: false, reason: "pluto_first_page_unavailable" };

  const total = Number(first.total) || first.buildings.length;
  const want = Math.min(total, MAX_LOTS);
  const seen = new Set(first.buildings.map((b) => b.bbl).filter(Boolean));
  let count = first.buildings.length;

  for (let page = 1; count < want; page++) {
    const next = await liveAreaBuildings(zips, { page, pageSize: PAGE, sort: "score" }).catch(() => null);
    if (!next?.buildings) return { ok: false, reason: "pluto_page_unavailable", page, count, want, total };
    if (!next.buildings.length) return { ok: false, reason: "pluto_pagination_ended_early", page, count, want, total };

    let added = 0;
    for (const b of next.buildings) {
      if (b.bbl && seen.has(b.bbl)) continue;
      if (b.bbl) seen.add(b.bbl);
      count++;
      added++;
    }
    if (!added) return { ok: false, reason: "pluto_pagination_repeated_page", page, count, want, total };
  }
  return { ok: true, total, analyzed: count, sampled: total > MAX_LOTS };
}

async function guard(req, res, next) {
  const zips = zipsFrom(req.query.zips);
  if (!zips.length) return next(); // existing route owns its exact 400 contract
  const checked = await validateAreaTraversal(zips);
  if (!checked.ok) {
    return res.status(503).json({
      provenance: "unavailable",
      error: "territory_source_incomplete",
      message: "The PLUTO pages required for this territory analysis could not be traversed completely. A source failure is not reported as intentional sampling.",
      detail: checked
    });
  }
  return next();
}

router.get("/api/territory", guard);
router.get("/api/area-detail", guard);

export { validateAreaTraversal };
export default router;
