// Source-integrity preflight for Dossier surfaces whose exact success handlers
// intentionally use empty arrays/nulls for real "no record" cases. The adapters
// are called with the same query shapes the success path uses, so Socrata cache
// makes this inexpensive after the first pull.
import { Router } from "express";
import {
  plutoByBbl, plutoByZips, rollingSalesByLot, rollingSalesByZips,
  dobPermitsByLot, dobNowByLot, hpdViolationsByBbl, hpdContactsByBbl,
  taxHistoryByBbl, acrisByLot
} from "./adapters/nyc.js";

const router = Router();
const cleanBbl = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return /^[1-5]\d{9}$/.test(d) ? d : "";
};

function unavailable(res, surface, missing) {
  return res.status(503).json({
    provenance: "unavailable",
    error: `${surface}_sources_partial`,
    message: "One or more official sources required by this Dossier surface are unavailable. Missing sources are not represented as empty records.",
    missingSources: missing
  });
}

router.get("/api/asset-history", async (req, res, next) => {
  const bbl = cleanBbl(req.query.bbl);
  if (!bbl) return next(); // exact handler owns its 400 contract

  const pluto = await plutoByBbl(bbl).catch((e) => ({ live: false, rows: [], error: e?.message || String(e) }));
  if (!pluto.live) return unavailable(res, "asset_history", [{ source: "PLUTO", error: pluto.error || "unavailable" }]);

  // A live PLUTO response with zero rows is a real no-current-parcel condition
  // (retired/merged/non-PLUTO BBL). The exact Dossier handler deliberately
  // serves ACRIS-only history for that case, so do not require parcel-dependent
  // sources that have no current parcel to join to.
  if (!pluto.rows?.length) return next();

  const zip = String(pluto.rows[0]?.zipcode || "").trim();
  const checks = await Promise.all([
    rollingSalesByLot(bbl).catch((e) => ({ live: false, error: e?.message })),
    dobPermitsByLot(bbl).catch((e) => ({ live: false, error: e?.message })),
    dobNowByLot(bbl).catch((e) => ({ live: false, error: e?.message })),
    hpdViolationsByBbl(bbl).catch((e) => ({ live: false, error: e?.message })),
    taxHistoryByBbl(bbl).catch((e) => ({ live: false, error: e?.message })),
    zip ? plutoByZips([zip], { limit: 800 }).catch((e) => ({ live: false, error: e?.message })) : Promise.resolve({ live: true }),
    zip ? rollingSalesByZips([zip], { limit: 220 }).catch((e) => ({ live: false, error: e?.message })) : Promise.resolve({ live: true })
  ]);
  const names = [
    "DOF Rolling Sales (parcel history)",
    "DOB Permit Issuance",
    "DOB NOW filings",
    "HPD Violations",
    "DOF Assessment Roll",
    "PLUTO peer set",
    "DOF Rolling Sales (comps)"
  ];
  const missing = checks.map((x, i) => !x?.live ? { source: names[i], error: x?.error || "unavailable" } : null).filter(Boolean);
  if (missing.length) return unavailable(res, "asset_history", missing);
  return next();
});

router.get("/api/contacts", async (req, res, next) => {
  const bbl = cleanBbl(req.query.bbl);
  if (!bbl) return next();

  const [permits, hpd, acris] = await Promise.all([
    dobPermitsByLot(bbl).catch((e) => ({ live: false, error: e?.message })),
    hpdContactsByBbl(bbl).catch((e) => ({ live: false, error: e?.message })),
    acrisByLot(bbl).catch((e) => ({ live: false, error: e?.message }))
  ]);
  const missing = [
    !permits?.live ? { source: "DOB Permit Issuance", error: permits?.error || "unavailable" } : null,
    !hpd?.live ? { source: "HPD Registration Contacts", error: hpd?.error || "unavailable" } : null,
    !acris?.live ? { source: "ACRIS recorded parties", error: acris?.error || "unavailable" } : null
  ].filter(Boolean);
  // These three sources are unconditional evidence families in liveContacts().
  // If one failed, an empty permit/hpd/debt array would otherwise be
  // indistinguishable from a factual "no record" result, so fail before the
  // exact success handler runs.
  if (missing.length) return unavailable(res, "contacts", missing);

  // NYS DOS is conditional: it is queried only when a recorded owner-business
  // name produces a registry search term. We therefore cannot preflight it
  // without duplicating the exact handler's term-selection logic. Instead,
  // preserve the success payload and promote top-level provenance to `partial`
  // if any nested source reports an error. This keeps real contacts visible
  // while making "registry unavailable" impossible to misread as "no entity".
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === "object" && body.provenance === "live" && Array.isArray(body.sources)) {
      const failed = body.sources.filter((s) => s?.status === "error");
      if (failed.length) {
        body = {
          ...body,
          provenance: "partial",
          missingSources: failed.map((s) => ({
            source: s.label || s.id || "contact source",
            error: s.error || "unavailable"
          }))
        };
      }
    }
    return json(body);
  };
  return next();
});

export default router;
