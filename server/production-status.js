// Operational truth endpoint. This is mounted before every product router so
// `/api/status` describes the source paths the running process will actually use.
import { Router } from "express";
import { durableBackend } from "./durable-store.js";
import { APP_DATA_DIR } from "./usage-meter.js";
import { liveBuilding } from "./live.js";
import {
  acrisByLot,
  dobPermitsByLot,
  dobNowByLot,
  hpdViolationsByBbl,
  ecbByLot,
  s311ByBbl,
  taxHistoryByBbl
} from "./adapters/nyc.js";
import { postgisStoreStatus } from "./adapters/postgis.js";
import { pineconeConfigured } from "./adapters/pinecone.js";
import { airtableConfigured, airtableConfiguration } from "./adapters/airtable.js";
import { googleCseConfiguration } from "./adapters/google-cse.js";
import { normalizeAppVariant, appVariant } from "./owner-variant.js";

// Module imports are evaluated before server.js constructs siteGate(). Normalize
// the explicit build variant here so the gate and every downstream router see
// one consistent owner/member contract from the first request onward.
normalizeAppVariant();

const router = Router();
const STARTED_AT = new Date().toISOString();
const HEALTH_BBL = "1003720009";

const okLive = (value) => !!value && value.live !== false;

router.get("/api/status", async (_req, res) => {
  const [
    plutoProbe,
    acrisProbe,
    dobBisProbe,
    dobNowProbe,
    hpdProbe,
    ecbProbe,
    complaintsProbe,
    taxProbe,
    backend,
    pg
  ] = await Promise.all([
    liveBuilding(HEALTH_BBL).catch(() => null),
    acrisByLot(HEALTH_BBL).catch(() => null),
    dobPermitsByLot(HEALTH_BBL).catch(() => null),
    dobNowByLot(HEALTH_BBL).catch(() => null),
    hpdViolationsByBbl(HEALTH_BBL).catch(() => null),
    ecbByLot(HEALTH_BBL).catch(() => null),
    s311ByBbl(HEALTH_BBL, 12).catch(() => null),
    taxHistoryByBbl(HEALTH_BBL).catch(() => null),
    durableBackend().catch(() => "unavailable"),
    postgisStoreStatus().catch(() => ({ configured: false, trusted: false, fresh: false, reason: "status_probe_failed" }))
  ]);

  // The control BBL is a known current parcel, so PLUTO returning no building is
  // a source-health failure rather than a legitimate no-record result. Every
  // other adapter exposes its transport/source state separately from row count;
  // live:true with zero records is healthy and must not be converted to failure.
  const coreSources = {
    pluto: !!plutoProbe,
    acris: !!(acrisProbe && acrisProbe.live !== false && Array.isArray(acrisProbe.deeds)),
    dobBis: okLive(dobBisProbe),
    dobNow: okLive(dobNowProbe),
    hpd: okLive(hpdProbe),
    ecbOath: okLive(ecbProbe),
    threeOneOne: okLive(complaintsProbe),
    dofAssessment: okLive(taxProbe)
  };
  const coreValues = Object.values(coreSources);
  const healthyCount = coreValues.filter(Boolean).length;
  const dataMode = healthyCount === coreValues.length
    ? "live"
    : healthyCount > 0 ? "degraded" : "unavailable";
  const survivesRedeploy = ["postgres", "supabase-rest", "supabase-rpc"].includes(backend);
  const variant = appVariant();
  const airtable = airtableConfiguration();
  const googleCse = googleCseConfiguration();
  const mapsConfigured = !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY);
  const threeDConfigured = !!process.env.GOOGLE_3D_KEY;
  const mapboxConfigured = !!(process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN);
  const pinecone = pineconeConfigured();
  const serper = !!process.env.SERPER_API_KEY;
  const demographics = !!process.env.CENSUS_API_KEY;

  res.json({
    dataMode,
    appVariant: variant,
    startedAt: STARTED_AT,
    persistence: {
      backend,
      survivesRedeploy,
      dataDir: APP_DATA_DIR,
      note: survivesRedeploy
        ? `Deployment-wide state is stored durably via ${backend}.`
        : "The durable production store is not reachable. Production writes fail before any ephemeral disk mutation."
    },
    gate: (() => {
      const site = process.env.SITE_PASSWORD || "";
      const owner = process.env.OWNER_PASSWORD || "";
      const ownerDistinct = !!site && !!owner && site !== owner;
      if (variant === "owner") {
        return {
          mode: "owner",
          memberConfigured: !!site,
          ownerConfigured: !!owner,
          ownerDistinct,
          ownerAccessFromSiteCredential: !!site
        };
      }
      return {
        mode: "user",
        memberConfigured: !!site,
        ownerConfigured: !!owner,
        ownerDistinct,
        ...(!!site && !!owner && !ownerDistinct
          ? { warning: "SITE_PASSWORD and OWNER_PASSWORD are identical: every member is granted the owner role. Use distinct values for a reduced user deployment." }
          : {})
      };
    })(),
    subsystems: {
      ...coreSources,
      // `socrata` no longer means "at least one Socrata request answered". It is
      // true only when every core NYC Open Data family this application treats as
      // authoritative is presently reachable on the control parcel.
      socrata: coreValues.every(Boolean),
      postgis: pg.fresh === true,
      demographics,
      streetview: mapsConfigured,
      photorealistic3d: threeDConfigured,
      mapbox: mapboxConfigured,
      pinecone,
      serper,
      googleProgrammableSearch: googleCse.configured,
      airtable: airtableConfigured()
    },
    // Non-secret release diagnostics. These values expose only whether a
    // credential/base is present and structurally valid; no key, token, host,
    // account identifier or base identifier is returned. This lets the Owner
    // release gate distinguish "missing integration configuration" from a code
    // defect without weakening the exact product API contracts.
    integrations: {
      airtable: {
        configured: airtable.configured,
        reasons: airtable.reasons
      },
      streetview: {
        configured: mapsConfigured,
        reasons: mapsConfigured ? [] : ["missing_google_maps_key"]
      },
      photorealistic3d: {
        configured: threeDConfigured,
        reasons: threeDConfigured ? [] : ["missing_google_3d_key"]
      },
      googleProgrammableSearch: {
        configured: googleCse.configured,
        reasons: googleCse.reasons
      },
      // The exact production bundle identifies the 2D basemap as Mapbox +
      // OpenStreetMap and the deployed tile proxy selects the Mapbox styles only
      // when this token exists. CARTO/Esri remain resilience fallbacks, but an
      // Owner parity certification must not mistake that fallback for exactness.
      mapbox: {
        configured: mapboxConfigured,
        reasons: mapboxConfigured ? [] : ["missing_mapbox_token"]
      },
      pinecone: { configured: pinecone, reasons: pinecone ? [] : ["pinecone_not_configured"] },
      serper: { configured: serper, reasons: serper ? [] : ["missing_serper_api_key"] },
      demographics: { configured: demographics, reasons: demographics ? [] : ["missing_census_api_key"] }
    },
    coreSources,
    postgis: pg,
    note: dataMode === "live"
      ? "All core authoritative NYC public-record source families are responding on the health-control parcel."
      : "One or more core authoritative NYC source families are unavailable. Generated/demo property facts are not substituted for a failed authoritative source."
  });
});

export default router;
