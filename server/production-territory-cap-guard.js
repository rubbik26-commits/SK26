// Integrity guard for the remaining 5,000-row Rolling Sales envelope inside
// production-territory.js.
//
// The Territory handler deliberately preserves the original response/query
// contract and currently requests at most 5,000 trailing-year sales. Any result
// shorter than that cap is demonstrably exhausted by that request. A result of
// exactly 5,000 is ambiguous: it may be the complete set or it may be a clipped
// prefix. Publishing it as a complete count/median would turn "unknown" into a
// factual number, so production fails closed at the ceiling until/unless the
// handler itself is converted to an exhaustive traversal.
import { Router } from "express";

const router = Router();
export const TERRITORY_SALES_CAP = 5000;

export function territoryResponseHitsSalesCap(pathname, query = {}, body = null) {
  if (pathname === "/api/territory") {
    return Number(body?.sales?.count) === TERRITORY_SALES_CAP;
  }
  if (pathname === "/api/area-detail") {
    const kind = String(query.kind || "sales");
    return kind === "sales" && Array.isArray(body?.sales) && body.sales.length === TERRITORY_SALES_CAP;
  }
  return false;
}

function installJsonGuard(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (!territoryResponseHitsSalesCap(req.path, req.query, body)) return original(body);
    res.status(503);
    return original({
      provenance: "unavailable",
      error: "rolling_sales_possible_truncation",
      message: `The authoritative Rolling Sales query reached its ${TERRITORY_SALES_CAP.toLocaleString("en-US")}-row transport ceiling. The result is not published as complete because exhaustion cannot be proven.`,
      cap: TERRITORY_SALES_CAP
    });
  };
  return next();
}

router.get("/api/territory", installJsonGuard);
router.get("/api/area-detail", installJsonGuard);

export default router;
