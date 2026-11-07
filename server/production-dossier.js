// Production Dossier truth layer: complete ACRIS parties/timelines and owner
// portfolio resolution keyed the way the immutable production frontend calls it.
import { Router } from "express";
import { liveAssetHistory, liveContacts, liveBuilding, liveComps } from "./live.js";
import { fullAcrisByLot } from "./adapters/acris-full.js";
import { soql, escSoql } from "./adapters/socrata.js";
import { DS, plutoRowToBuilding } from "./adapters/nyc.js";
import { assetHistoryContract } from "./asset-history-contract.js";

const router = Router();
const cleanBbl = (v) => {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return d.length === 10 ? d : "";
};
const day = (v) => v ? String(v).slice(0, 10) : null;
const uniq = (xs) => [...new Set(xs.filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];

// Rebuilt 2026-08-19 from the original's own published sources[] array — see
// server/asset-history-contract.js for the eight verbatim queries and the row
// contracts they feed. The rebuild was publishing eighteen keys where the
// original publishes twelve, was missing sources[] entirely, and every array
// row carried extra fields (sales 13 keys vs 6, loans 13 vs 5, permits 6 vs 4).
router.get("/api/asset-history", async (req, res) => {
  const bbl = cleanBbl(req.query.bbl);
  if (!bbl) return res.status(400).json({ error: "invalid_bbl" });
  try {
    const out = await assetHistoryContract(bbl);
    if (!out) return res.status(400).json({ error: "invalid_bbl" });
    // A source that did not answer is reported as such in sources[] and must
    // not be served as an empty record.
    const down = out.sources.filter((s) => s.status !== "ok").map((s) => ({ source: s.label, endpoint: s.endpoint }));
    if (down.length) {
      return res.status(503).json({
        provenance: "unavailable",
        error: "asset_history_sources_partial",
        message: "One or more official sources required by this Dossier surface are unavailable. Missing sources are not represented as empty records.",
        missingSources: down
      });
    }
    return res.json(out);
  } catch (e) {
    return res.status(502).json({ provenance: "unavailable", error: "asset_history_failed", message: e?.message || "Asset history could not be assembled." });
  }
});

router.get("/api/contacts", async (req, res) => {
  const bbl = cleanBbl(req.query.bbl);
  // Measured 2026-08-19: GET /api/contacts answers
  //   400 {"error":"Provide a bbl, bin, or borough+block+lot."}
  if (!bbl) return res.status(400).json({ error: "Provide a bbl, bin, or borough+block+lot." });
  try {
    const base = await liveContacts(bbl);
    if (!base) return res.status(503).json({ provenance: "unavailable", error: "contact_sources_unavailable" });
    // Envelope keys mirror the original's contacts response exactly (measured
    // 2026-08-18 for BBL 1008350041 and 3011370001): bbl, fetchedAt,
    // permitContacts, ownerContacts, hpdContacts, ownerNames, ownerEntities,
    // debtParties, note, sources.
    //
    // debtParties, the note and sources come from liveContacts now. This handler
    // used to build its own debtParties from the whole financing timeline — 40
    // rows labelled "modification — recorded party 1" where the original
    // publishes the two counterparties of the current mortgage, "Borrower /
    // owner (ACRIS)" and "Lender (ACRIS)" — and to overwrite the note with a
    // sentence about what the panel does NOT do, replacing the one that tells a
    // broker what each source is for.
    // fetchedAt FIRST and no provenance. Measured 2026-08-19: the original's
    // key order is fetchedAt, bbl, permitContacts, ownerContacts, hpdContacts,
    // ownerNames, ownerEntities, debtParties, note, sources.
    res.json({
      fetchedAt: new Date().toISOString(),
      bbl,
      permitContacts: base.permitContacts ?? [],
      ownerContacts: base.ownerContacts ?? [],
      hpdContacts: base.hpdContacts ?? [],
      ownerNames: base.ownerNames ?? [],
      ownerEntities: base.ownerEntities ?? [],
      debtParties: base.debtParties ?? [],
      note: base.note,
      sources: base.sources ?? []
    });
  } catch (e) {
    res.status(502).json({ provenance: "unavailable", error: "contacts_unavailable", message: e?.message || "Public contact sources unavailable." });
  }
});

// The production frontend asks by owner name, not by BBL. Resolve exactly and
// return the complete count plus a bounded sample for the UI.
router.get("/api/owner-portfolio", async (req, res) => {
  const owner = String(req.query.owner ?? "").trim();
  if (!owner) return res.status(400).json({ error: "owner_required" });
  try {
    const where = `ownername='${escSoql(owner)}'`;
    const [countR, rowsR] = await Promise.all([
      soql(DS.pluto, { $select: "count(bbl) as n,sum(unitsres) as units", $where: where }, { ttlMs: 30 * 60 * 1000 }),
      soql(DS.pluto, { $select: "bbl,address,borough,block,lot,zipcode,bldgclass,landuse,unitsres,unitstotal,lotarea,bldgarea,builtfar,residfar,commfar,facilfar,yearbuilt,latitude,longitude,ownername,assessland,assesstot", $where: where, $limit: 500, $order: "bldgarea DESC" }, { ttlMs: 30 * 60 * 1000 })
    ]);
    if (!countR.live || !rowsR.live) return res.status(503).json({ provenance: "unavailable", error: "pluto_owner_portfolio_unavailable" });
    const total = Number(countR.rows?.[0]?.n || 0);
    const units = Number(countR.rows?.[0]?.units || 0);
    const sample = (rowsR.rows || []).map((r) => {
      const b = plutoRowToBuilding(r);
      return {
        bbl: b.bbl, address: b.address, bldgClass: b.bldgClass, unitsRes: b.unitsRes,
        unitsTotal: b.unitsTotal, zip: b.zip, bldgArea: b.bldgArea, lotArea: b.lotArea,
        builtFar: b.builtFar, maxFar: b.maxFar, unusedFarSf: b.unusedFarSf,
        yearBuilt: b.yearBuilt, lat: b.lat, lng: b.lng
      };
    });
    // Measured 2026-08-19 on ?owner=EMPIRE STATE REALTY OP LP: the original's
    // envelope is exactly {owner, total, units, sample} in that order. The
    // rebuild also published provenance, truncated, matching and source.
    res.json({ owner, total, units, sample });
  } catch (e) {
    res.status(502).json({ provenance: "unavailable", error: "owner_portfolio_unavailable", message: e?.message || "Owner portfolio lookup failed." });
  }
});

export default router;
