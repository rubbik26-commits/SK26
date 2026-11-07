// Prevent the production Render deployment from silently falling through from
// a failed live/public-record adapter to the synthetic reference city model.
// The demo engine remains available for local/test use only.
import { Router } from "express";
import { staleSources } from "./adapters/socrata.js";

const router = Router();
const authoritativeLivePaths = new Set([
  "/api/address",
  "/api/asset-history",
  "/api/area-buildings",
  "/api/contacts",
  "/api/distress",
  "/api/tax-history",
  "/api/liensale",
  "/api/transit",
  "/api/cliffs",
  "/api/nearby",
  "/api/zap-live",
  "/api/maturity-wall",
  "/api/demographics",
  "/api/owner-portfolio",
  "/api/market-report",
  "/api/market-index",
  "/api/propensity-validation",
  "/api/analytics/backtest",
  "/api/livepull",
  "/api/opportunities",
  "/api/nta-polys",
  "/api/gov-links",
  "/api/lot-at",
  "/api/zip-at",
  "/api/footprints",
  "/api/assemblage",
  "/api/territory",
  "/api/area-detail",
  "/api/pipeline",
  "/api/similar",
  "/api/maps-usage",
  "/api/3d-session",
  "/api/airtable-xref",
  "/api/account-delete"
]);
const authoritativePrefixes = ["/api/lot-tiles/", "/api/bldg-tiles/"];

const productionRuntime = () =>
  process.env.ALLOW_DEMO_FALLBACK === "0" ||
  process.env.NODE_ENV === "production" ||
  process.env.RENDER === "true";

export function guardedPath(pathname) {
  return authoritativeLivePaths.has(pathname) || authoritativePrefixes.some((prefix) => pathname.startsWith(prefix));
}

router.use((req, res, next) => {
  if (!productionRuntime() || process.env.ALLOW_DEMO_FALLBACK === "1") return next();
  if (!guardedPath(req.path)) return next();

  // Reaching this middleware means every intended production owner above it
  // declined the request. This is an explicit unavailable state, never an
  // invitation to the deterministic reference city model mounted below.
  const degraded = staleSources();
  return res.status(503).json({
    provenance: "unavailable",
    error: "live_source_unavailable",
    message: "The authoritative public-record source did not return a usable live result. No synthetic fallback was used.",
    fetchedAt: new Date().toISOString(),
    ...(degraded.length ? {
      degradedSources: degraded.map((s) => ({
        dataset: s.datasetId,
        observedAt: s.observedAt,
        lastKnownAgeMs: s.lastKnownAgeMs,
        error: s.error
      })),
      note: "These NYC Open Data datasets failed their most recent fetch. lastKnownAgeMs is how old this deployment's most recent successful copy is, in milliseconds, or null if it has never held one. No cached rows are served."
    } : {})
  });
});

export default router;
