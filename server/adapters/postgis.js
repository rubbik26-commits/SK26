// PostGIS parcel store adapter. The warehouse is an acceleration layer over
// live NYC sources, not an independent permission to serve old data.
//
// Production requires ALL of:
//   1) POSTGIS_TRUSTED=1 (operator intends to use the warehouse);
//   2) a fresh full-document certificate;
//   3) that certificate identifies a reconciled full-snapshot UUID.
//
// If any condition fails, every RPC returns null and its caller falls back to
// the live NYC adapter. The certificate expires automatically after 36 hours.
import {
  adminCredential,
  normalizeSupabaseApiUrl,
  publicCredential,
  supabaseHeaders
} from "../supabase-credentials.js";

const POSTGIS_DISABLED_MS = 10 * 60 * 1000;
const STATUS_TTL_MS = 5 * 60 * 1000;
let disabledUntil = 0;
let statusCache = { at: 0, value: null };

const postgisOverrideUrl = () => normalizeSupabaseApiUrl(process.env.POSTGIS_SUPABASE_URL);
const baseUrl = () => postgisOverrideUrl() || normalizeSupabaseApiUrl(process.env.SUPABASE_URL);
const apiKey = () => String(
  process.env.POSTGIS_SUPABASE_KEY ||
  adminCredential() ||
  publicCredential() || ""
).trim();

// POSTGIS_SUPABASE_URL is the PostgREST/Auth API base, never the PostgreSQL
// connection URI. A copied pooler connection string may contain a password, so
// do not print the value — just explain why the override is being ignored.
if (process.env.POSTGIS_SUPABASE_URL && !postgisOverrideUrl()) {
  console.warn("[postgis] POSTGIS_SUPABASE_URL is not an HTTP(S) Supabase API URL; ignoring it and falling back to SUPABASE_URL.");
}

function credentialsConfigured() {
  return !!(baseUrl() && apiKey());
}

export function postgisConfigured() {
  if (process.env.POSTGIS_ENABLED === "0") return false;
  if (process.env.NODE_ENV === "production" && process.env.POSTGIS_TRUSTED !== "1") return false;
  if (Date.now() < disabledUntil) return false;
  return credentialsConfigured();
}

async function rawRpc(name, args = {}, { timeoutMs = 12000 } = {}) {
  if (!credentialsConfigured()) return null;
  const key = apiKey();
  try {
    const r = await fetch(`${baseUrl()}/rest/v1/rpc/${name}`, {
      method: "POST",
      // Modern sb_secret_ / sb_publishable_ credentials are API keys, not JWTs.
      // The shared header builder emits a bearer only for a real legacy
      // service_role JWT. Public PostGIS read RPCs need only the API key.
      headers: supabaseHeaders({ apiKey: key, json: true }),
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (r.status === 404) {
      disabledUntil = Date.now() + POSTGIS_DISABLED_MS;
      return null;
    }
    if (!r.ok) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } catch {
    disabledUntil = Date.now() + 60 * 1000;
    return null;
  }
}

const validFullSyncId = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));

export async function postgisStoreStatus({ force = false } = {}) {
  if (!postgisConfigured()) {
    return {
      configured: credentialsConfigured(),
      trusted: process.env.NODE_ENV !== "production" || process.env.POSTGIS_TRUSTED === "1",
      fresh: false,
      reason: process.env.POSTGIS_ENABLED === "0"
        ? "disabled"
        : process.env.NODE_ENV === "production" && process.env.POSTGIS_TRUSTED !== "1"
          ? "not_operator_trusted"
          : "unconfigured"
    };
  }
  if (process.env.NODE_ENV !== "production") {
    return { configured: true, trusted: true, fresh: true, reason: "non_production" };
  }
  if (!force && statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;

  const raw = await rawRpc("postgis_store_status", {}, { timeoutMs: 10000 });
  const reconciled = raw?.scope?.reconciled === true;
  const fullSyncId = raw?.scope?.fullSyncId || null;
  const validSnapshot = reconciled && validFullSyncId(fullSyncId);
  const value = raw && typeof raw === "object"
    ? {
        configured: true,
        trusted: true,
        ...raw,
        reconciled,
        fullSyncId,
        fresh: raw.fresh === true && raw.fullDocuments === true && validSnapshot,
        ...(validSnapshot ? {} : { reason: raw.reason || "certificate_not_reconciled_snapshot" })
      }
    : { configured: true, trusted: true, fresh: false, reason: "ingest_certificate_unavailable" };
  statusCache = { at: Date.now(), value };
  return value;
}

async function rpc(name, args = {}, options = {}) {
  if (!postgisConfigured()) return null;
  if (process.env.NODE_ENV === "production") {
    const status = await postgisStoreStatus();
    if (!status.fresh) return null;
  }
  return rawRpc(name, args, options);
}

// A parcels row (attrs = raw PLUTO vocabulary) → the raw-row shape consumed by
// plutoRowToBuilding and opportunity mappers. Preserve the lot_at resolution
// marker so the HTTP layer can disclose nearest-fallback clicks.
export function parcelRowToPlutoRow(row) {
  if (!row) return null;
  const attrs = row.attrs && typeof row.attrs === "object" ? row.attrs : {};
  return {
    bbl: row.bbl,
    address: row.address ?? attrs.address,
    zipcode: row.zipcode ?? attrs.zipcode,
    block: row.block ?? attrs.block,
    lot: row.lot ?? attrs.lot,
    lotarea: row.lot_area ?? attrs.lotarea,
    bldgarea: row.bldg_area ?? attrs.bldgarea,
    builtfar: row.built_far ?? attrs.builtfar,
    residfar: row.resid_far ?? attrs.residfar,
    commfar: row.comm_far ?? attrs.commfar,
    facilfar: attrs.facilfar,
    landuse: row.land_use ?? attrs.landuse,
    bldgclass: row.bldg_class ?? attrs.bldgclass,
    zonedist1: row.zoning ?? attrs.zonedist1,
    ownername: row.owner_name ?? attrs.ownername,
    unitsres: row.units_res ?? attrs.unitsres,
    unitstotal: row.units_total ?? attrs.unitstotal,
    yearbuilt: row.year_built ?? attrs.yearbuilt,
    numfloors: row.num_floors ?? attrs.numfloors,
    assessland: row.assess_land ?? attrs.assessland,
    assesstot: row.assess_total ?? attrs.assesstot,
    latitude: row.lat ?? attrs.latitude,
    longitude: row.lng ?? attrs.longitude,
    resolution_hit: row.hit ?? null,
    ...Object.fromEntries(Object.entries(attrs).filter(([k]) => !/^the_geom/.test(k)))
  };
}

export async function pgLotAt(lat, lng) {
  const row = await rpc("lot_at", { p_lng: lng, p_lat: lat });
  return row || null;
}

export async function pgNtaPolys(minLng, minLat, maxLng, maxLat) {
  const features = await rpc("nta_polys", {
    min_lng: minLng, min_lat: minLat, max_lng: maxLng, max_lat: maxLat
  });
  return Array.isArray(features) ? { features } : null;
}

export async function pgAssemblage(bbl) {
  const out = await rpc("assemblage_at", { p_bbl: String(bbl) });
  return out && typeof out === "object" ? out : null;
}

export async function pgOpportunityRows(zips = null, limit = 160) {
  const rows = await rpc("parcels_opportunities", {
    p_zips: Array.isArray(zips) && zips.length ? zips : null,
    p_limit: limit
  });
  return Array.isArray(rows) && rows.length ? rows : null;
}

export async function pgTaxHistory(bbl) {
  const rows = await rpc("tax_history_at", { p_bbl: String(bbl) });
  return Array.isArray(rows) && rows.length ? rows : null;
}

export async function pgContacts(bbl) {
  const out = await rpc("parcel_contacts", { p_bbl: String(bbl) });
  if (!out || typeof out !== "object") return null;
  const permitContacts = Array.isArray(out.permitContacts) ? out.permitContacts : [];
  const debtParties = Array.isArray(out.debtParties) ? out.debtParties.map((p) => ({
    name: p.name ?? p.party_name ?? "—",
    role: String(p.party_type ?? p.role ?? "") === "1" ? "Borrower / Sponsor"
      : String(p.party_type ?? p.role ?? "") === "2" ? "Lender / mortgagee"
      : (p.role ?? "Recorded party"),
    address: p.address ?? [p.address_1, p.address_2, p.city, p.state, p.zip].filter(Boolean).join(", "),
    source: "Recorded mortgage parties (PostGIS store)"
  })) : [];
  if (!permitContacts.length && !debtParties.length) return null;
  return { permitContacts, debtParties };
}
