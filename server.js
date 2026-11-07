// NYC RE Market Intel — application server.
// The attached nycremarketintel-site production export is the frontend authority.
import express from "express";
import cors from "cors";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import security from "./server/security.js";
import productionFrontend, { ensureExactAssets } from "./server/production-frontend.js";
import supabaseEnv from "./server/supabase-env.js";
import productionApi, { productionIdentity } from "./server/production-api.js";
import productionPrivate from "./server/production-private.js";
import durableCost from "./server/durable-cost.js";
import productionImagery from "./server/production-imagery.js";
import productionRegulatory from "./server/production-regulatory.js";
import productionMaturity from "./server/production-maturity.js";
import productionAnalytics from "./server/production-analytics.js";
import productionDossier from "./server/production-dossier.js";
import productionDossierSourceGuard from "./server/production-dossier-source-guard.js";
import productionDistressTax from "./server/production-distress-tax.js";
import productionDistressSourceGuard from "./server/production-distress-source-guard.js";
import productionDistressComplete from "./server/production-distress-complete.js";
import productionLiveExtra from "./server/production-live-extra.js";
import productionStatus from "./server/production-status.js";
import productionOwnerSourceRegistry from "./server/production-owner-source-registry.js";
import productionPropensityValidation from "./server/production-propensity-validation.js";
import productionNta from "./server/production-nta.js";
import productionOpportunities from "./server/production-opportunities.js";
import productionAccountDelete from "./server/production-account-delete.js";
import productionTerritory from "./server/production-territory.js";
import productionTerritoryCapGuard from "./server/production-territory-cap-guard.js";
import productionPublicPipeline from "./server/production-public-pipeline.js";
import productionZipAt from "./server/production-zip-at.js";
import productionBuildingFootprints from "./server/production-building-footprints.js";
import productionLotTileSourceGuard from "./server/production-lot-tile-source-guard.js";
import parityRoutes from "./server/parity-routes.js";
import productionLiveGuard from "./server/production-live-guard.js";
import routes from "./server/routes.js";
import bundleRoutes from "./server/routes-bundle.js";
import liveRoutes, { demoProvenance } from "./server/routes-live.js";
import authRoutes, { attachUser } from "./server/auth.js";
import userData from "./server/user-data.js";
import authorityRelease from "./server/authority-release.js";
import buyerIntelligence from "./server/buyer-intelligence.js";
import climateRisk from "./server/climate-risk.js";
import marketNews from "./server/market-news.js";
import marketStadium from "./server/market-stadium.js";
import gatePipelineDelete from "./server/gate-pipeline-delete.js";
import { siteGate } from "./server/gate.js";
import { normalizeAppVariant } from "./server/owner-variant.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";

// Apply the deployment contract before the gate is instantiated. The full
// Owner build intentionally promotes SITE_PASSWORD to the owner tier; the
// later reduced user build preserves the separate SITE/OWNER credential split.
normalizeAppVariant(process.env);

// A production deployment must name its Supabase project explicitly. There is
// no legacy default anywhere in this codebase (owner directive 2026-08-18):
// with SUPABASE_URL unset, every Supabase-backed feature refuses as
// unconfigured, and the deploy gate (scripts/apply-migrations.mjs +
// scripts/verify-production-schema.mjs) fails the build outright — so this
// state should never survive a normal deploy. The banner exists for anyone who
// bypasses the gate.
if (production && !process.env.SUPABASE_URL) {
  console.error("[config] PRODUCTION MISCONFIGURATION: NODE_ENV=production with no SUPABASE_URL. " +
    "Supabase-backed features (auth, durable state, workspace) will refuse as unconfigured. " +
    "Set SUPABASE_URL and its keys; the project baked into the compiled frontend is not a fallback.");
}

if (!process.env.GOOGLE_MAPS_KEY && process.env.GOOGLE_MAPS_API_KEY) process.env.GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
if (!process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_KEY) process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_KEY;
if (!process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_ANON_KEY) process.env.SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_ANON_KEY;

// No legacy Supabase normalization: SUPABASE_URL is the deployment's one and
// only database identity (owner directive 2026-08-18). Injecting the original
// bundle's project here made every dynamic backend helper silently talk to a
// project this deployment's owner does not control whenever Render omitted the
// variable — the exact ambiguity the deploy gate now fails builds over.

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use(siteGate());

// ---------------------------------------------------------------- HTTP method
// Measured 2026-08-19 against https://nycremarketintel.com across fifteen routes
// and seven methods. The original answers a per-route method allow-list, not a
// blanket GET-only rule:
//
//   route                          GET  HEAD  POST   PUT  PATCH  DEL  OPTIONS
//   /api/market-report?zips=11216  200   405   405   405    405  405      405
//   /api/territory?zips=…          200   405   405   405    405  405      405
//   /api/cliffs?bbl=…              200   405   405   405    405  405      405
//   /api/pipeline?zips=11216       200   405   405   405    405  405      405
//   /api/investors                 200   405   200   405    405  405      405
//   /api/account-delete            405   405   401   405    405  405      405
//   /healthz                       200   200   405   405    405  405      405
//   /api/status                    404   404   404   404    404  404      404
//
// So: a path that IS routed but not for this method answers
//   405 {"error":"Method not allowed"}   application/json; charset=utf-8
// with NO Allow header (measured: allow=null); /healthz answers the same status
// as text/plain "Method Not Allowed"; and a path that is not routed at all
// answers 404 {"error":"Not found"} for every method, GET included.
//
// What the rebuild answered before this guard, measured the same way:
//   non-GET on a GET-only /api route  503 (the live-source guard) or 204 (CORS)
//   HEAD on any /api route            200 — Express answers HEAD off the GET route
//   OPTIONS on any /api route         204 — the cors() preflight
//   POST /healthz                     404, and as text/html "Cannot POST /healthz"
//   any unrouted /api path            404, as text/html "Cannot GET /api/…"
//
// The allow-list is read from the app's OWN router stack rather than a hand-kept
// list, so a route added later is covered without editing this block. It is built
// once, lazily, on the first request — by then every router in this file is
// mounted.
const METHOD_GUARD_PREFIX = "/api/";
const METHOD_GUARD_PATHS = new Set(["/healthz"]);
const methodGuardScope = (p) => p.startsWith(METHOD_GUARD_PREFIX) || METHOD_GUARD_PATHS.has(p);
const notAllowed = (req, res) => {
  const body = req.path === "/healthz" ? "Method Not Allowed" : JSON.stringify({ error: "Method not allowed" });
  const type = req.path === "/healthz" ? "text/plain;charset=UTF-8" : "application/json; charset=utf-8";
  return res.status(405).set("content-type", type).set("cache-control", "no-store").end(body);
};
const notFoundJson = (res) =>
  res.status(404).set("content-type", "application/json; charset=utf-8")
    .set("cache-control", "no-store").end(JSON.stringify({ error: "Not found" }));

let routeIndex = null;
function buildRouteIndex() {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        out.push({ regexp: layer.regexp, methods: new Set(Object.keys(layer.route.methods ?? {}).map((m) => m.toUpperCase())) });
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(app._router?.stack);
  return out;
}
// Which methods this exact path is routed for, across every mounted router.
function methodsFor(pathname) {
  if (!routeIndex) routeIndex = buildRouteIndex();
  const found = new Set();
  for (const entry of routeIndex) {
    if (entry.regexp.test(pathname)) for (const m of entry.methods) found.add(m);
  }
  return found;
}

// The check runs HERE, ahead of cors(), the rate limiter and every router,
// because each of those answers first for one method or another: Express serves
// HEAD off the matching GET route, cors() answers the OPTIONS preflight, the rate
// limiter answered 429 on GET /api/account-delete, and productionLiveGuard
// answered 503 to POST/PUT/PATCH/DELETE on every authoritative route. Measured
// before this guard moved ahead of them: POST /api/market-report gave 503, GET
// /api/account-delete gave 429, OPTIONS /api/cliffs gave 204 — where the original
// gives 405 to all three.
app.use((req, res, next) => {
  if (!methodGuardScope(req.path)) return next();
  const methods = methodsFor(req.path);
  // No ROUTE layer matches — but a plain middleware still might, and one does:
  // the local-auth paths are closed in production by middleware that answers 410
  // Gone, not by a route. Answering 404 here stole that 410
  // (tests/account-store-degradation.test.mjs "no local-auth path can create a
  // session" went 410 -> 404). Unrouted paths therefore fall through, and the
  // guard at the bottom of this file — which only ever sees requests nothing
  // answered — issues the 404.
  if (!methods.size) return next();
  if (methods.has(req.method)) return next();
  // /healthz is routed for GET and Express serves HEAD from it — the original
  // does too (HEAD /healthz -> 200), so HEAD is allowed only there.
  if (req.method === "HEAD" && req.path === "/healthz") return next();
  return notAllowed(req, res);
});
app.use(compression());
app.use(express.json({ limit: "1mb" }));

const allowedOrigins = new Set([
  "https://nycremarketintel.com",
  "https://www.nycremarketintel.com",
  "https://lucia-ru5s.onrender.com",
  ...String(process.env.APP_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean)
]);
app.use(cors({
  credentials: true,
  origin(origin, cb) {
    if (!origin || allowedOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(security);
app.use(supabaseEnv);

// SQLite identity/workspace is a reconstruction aid, not a production account
// system. In production it is not even loaded into the request. This prevents a
// disposable app.db or historical local session from influencing any owner or
// per-user decision.
if (!production) {
  app.use(attachUser);
} else {
  app.use((req, _res, next) => {
    req.user = null;
    req.profile = null;
    next();
  });
}

// Supabase is the production identity authority.
app.use(async (req, res, next) => {
  try {
    if (/^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ""))) {
      req.productionUser = await productionIdentity(req);
    }
  } catch (e) {
    console.warn(`[auth] Supabase identity lookup failed: ${e?.message ?? e}`);
  }
  next();
});

app.use(productionStatus);
// Owner Source Registry is an original application surface, not a Google-key
// status proxy. Its `configured` bit means the durable usage meter is active,
// exactly as the compiled Owner UI interprets it. Mount it before older layered
// handlers so sign-in state or imagery configuration cannot change that contract.
app.use(productionOwnerSourceRegistry);
// Point-to-ZIP resolution uses exact DOF tax-lot polygon containment followed by
// PLUTO attributes. No nearest-centroid parcel substitution is allowed near lot
// boundaries.
app.use(productionZipAt);
// Building polygons are exhausted from the authoritative BUILDING dataset before
// being returned as a viewport/tile FeatureCollection. The older capped handlers
// remain below for reference, but cannot silently clip a production response.
app.use(productionBuildingFootprints);
// Preserve the exact existing tax-lot tile projector, but only after proving its
// DOF and PLUTO source universes both fit within the handler's 5,000-row envelope.
// Dense/low-zoom tiles fail explicitly instead of appearing complete after a cap.
app.use(productionLotTileSourceGuard);
// The neighborhood overlay. Mounted ahead of productionLiveGuard, which lists
// /api/nta-polys among the paths it answers 503 for once every intended owner
// above it has declined — and with this router unmounted, every intended owner
// HAD declined, so production served the overlay 503 for every request. Measured
// on the deployment 2026-08-18: 503 for a real viewport bbox and for the
// citywide default alike, where the original answers 200 with 25 and 160
// features. server/production-nta.js carries the full measurement, including why
// the packaged 160-feature file turned out to be a capture of the original's
// citywide answer rather than the dataset it draws from.
app.use(productionNta);
// Opportunity parcel geography is resolved server-side against the current DCP
// NTA layer before any compatibility/demo route.
app.use(productionOpportunities);
// Account deletion is self-only at both layers: this route requires the resolved
// Supabase caller and migration 202608170003 independently enforces
// auth.uid() = p_user_id before deleting auth.users.
app.use(productionAccountDelete);
// Public /api/pipeline?zips= is DOB NOW construction intelligence, not the user
// CRM. It is sourced independently and exhaustively from DOB NOW so an unrelated
// DOF Rolling Sales outage cannot disable it. Bare /api/pipeline continues to
// fall through to the authenticated/shared workspace owners below.
app.use(productionPublicPipeline);
// Territory/Area Detail keep their existing JSON contract. The handler's PLUTO
// census is source-aggregated, while its trailing-year Rolling Sales transport
// still has a 5,000-row ceiling. The guard immediately below converts an exact
// 5,000-row result into explicit unavailable rather than publishing a possibly
// truncated count/median as complete.
app.use(productionTerritoryCapGuard);
app.use(productionTerritory);
// Both Deal Radar validation endpoints are owned here before the older bundle /
// analytics implementations so every recorded sale is paged to completion and
// both views use one evidence set.
app.use(productionPropensityValidation);
// authorityRelease is the first maturity-wall owner. Its global/gate and signed-
// in paths both use fullAcrisByLot(), require referenceStatus=live, and exclude a
// mortgage only through that mortgage's own linkedSatisfactions list. Keep that
// single cache/concurrency implementation rather than mounting a second copy.
app.use(authorityRelease);
// Read-only Owner bridge to the existing buyerDB sbi_* warehouse. It is
// mounted after identity resolution and the authority router, and before all
// compatibility fallbacks, so its new namespace has one unambiguous owner.
app.use(buyerIntelligence);
// Market Stadium: the national ACS/TIGER market-intelligence surface. Mounted
// after identity resolution and before every compatibility fallback so its
// /api/market/* namespace has one unambiguous owner. Read-only, dataset-backed,
// and explicit 503 when a file is absent rather than a fabricated value.
app.use(marketStadium);
// Climate risk (FEMA NRI) and market news (derived, or a proxied live feed).
// Both read the same shipped dataset and both report `configured:false` with a
// reason instead of inventing a number.
app.use(climateRisk);
app.use(marketNews);
app.use(gatePipelineDelete);

app.use(productionMaturity);
app.use(productionRegulatory);
// The exact Dossier handler intentionally returns empty arrays for real no-record
// cases and ACRIS-only history for retired/merged BBLs. Preflight the individual
// source states first so PLUTO/DOB/HPD/DOF outages cannot masquerade as those
// valid empty states.
app.use(productionDossierSourceGuard);
app.use(productionDossier);
// Distress analytics are calculated from exhaustive HPD + DOB Safety + legacy
// DOB + ECB/OATH + 311 evidence. The old bounded handler remains below for
// compatibility/reference, but this owner terminates every valid /api/distress
// request first; UI record arrays are still explicitly capped at 100 after the
// complete counts/score have been calculated.
app.use(productionDistressComplete);
app.use(productionDistressSourceGuard);
app.use(productionDistressTax);
app.use(bundleRoutes);

app.use(productionFrontend);
app.use(productionApi);
app.use(productionPrivate);
app.use(durableCost);
app.use(productionAnalytics);

app.use(productionImagery);
app.use(productionLiveExtra);
app.use(parityRoutes);
app.use(liveRoutes);

// Local account/workspace endpoints are not mounted in production at all.
if (!production) {
  app.use(authRoutes);
  app.use(userData);
}

// Never replace a failed authoritative production pull with invented facts.
app.use(productionLiveGuard);
app.use(demoProvenance);
app.use(routes);

// The other half of the method contract (the note beside siteGate() carries the
// measurement). Anything under /api/ or /healthz that reaches this point was not
// answered by a route: either the path is routed for a DIFFERENT method, which
// the original reports as 405, or it is not routed at all, which it reports as
// 404 {"error":"Not found"} rather than Express's default HTML page.
app.use((req, res, next) => {
  if (!methodGuardScope(req.path)) return next();
  const methods = methodsFor(req.path);
  if (!methods.size) return notFoundJson(res);
  if (methods.has(req.method)) return next();
  return notAllowed(req, res);
});

const noStoreHtml = {
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
  }
};
app.use(express.static(path.join(__dirname, "public"), { ...noStoreHtml, index: "index.html" }));
app.use(express.static(path.join(__dirname, "site"), { ...noStoreHtml, index: false }));

app.get("/__original-shell", (_req, res) => {
  res.type("html").set("Cache-Control", "no-store")
    .sendFile(path.join(__dirname, "site", "index.html"));
});

// The compiled frontend routes on real paths, not hashes: /dossier, /radar,
// /desk and the rest are client-side routes with no file behind them. Any GET
// that is not an API call, not an immutable asset and not a request for a file
// on disk must return the app shell, so a deep link, a shared URL or a plain
// refresh lands on the page the SPA would render instead of a 404.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/assets/")) return next();
  if (/\.[A-Za-z0-9]{1,8}$/.test(req.path)) return next();
  if (!req.accepts("html")) return next();
  res.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "public", "index.html"));
});

// Fail fast: the immutable production frontend must be reproducible from local
// repository bytes before the server accepts a single request.
try {
  const assetSources = ensureExactAssets();
  console.log("Exact production frontend verified:", assetSources);
} catch (e) {
  console.error(`FATAL: ${e?.message || e}`);
  console.error("Run `node scripts/reconstruct-frontend.js` to rebuild public/assets from the committed chunks.");
  process.exit(1);
}

const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`NYC RE Market Intel running at http://localhost:${PORT}`);
});