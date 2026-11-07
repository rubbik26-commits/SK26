// Complete ACRIS document + party + cross-reference timeline for one tax lot.
// Uses official NYC DOF ACRIS Real Property datasets. Unlike the original
// reconstruction, parties and cross-references are pulled for the full document
// set instead of only the newest deed/mortgage. Authority calculations exhaust
// each source; a safety ceiling fails closed instead of silently truncating a
// document-heavy property.
import { soqlAll, escSoql } from "./socrata.js";
import { DS, parseBbl } from "./nyc.js";

const ACRIS_REFERENCES = "pwkr-dpni"; // NYC ACRIS - Real Property References
const MASTER_FIELDS = "document_id,doc_type,document_date,document_amt,recorded_datetime,crfn";
const PARTY_FIELDS = "document_id,party_type,name,address_1,address_2,city,state,zip";
const REF_FIELDS = "document_id,reference_by_crfn_,reference_by_doc_id,reference_by_reel_year,reference_by_reel_borough,reference_by_reel_nbr,reference_by_reel_page,good_through_date";
const DEED_RE = /DEED|BARGAIN|CONVEY/i;
const MORTGAGE_RE = /MTGE|MORTGAGE|MTG/i;
const ASSIGN_RE = /ASST|ASSIGN/i;
const SAT_RE = /SAT|SATISFACTION|RELEASE/i;
const MODIFY_RE = /AGMT|CONSOLID|MODIF|SPREADER|EXTENSION|CORRECTION/i;

const day = (v) => v ? String(v).slice(0, 10) : null;
const amount = (v) => {
  const n = Number(String(v ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const partyName = (p) => String(p?.name ?? "").trim();

export function classifyAcrisDoc(type) {
  const s = String(type ?? "").toUpperCase();
  if (SAT_RE.test(s)) return "satisfaction";
  if (ASSIGN_RE.test(s)) return "assignment";
  if (MORTGAGE_RE.test(s)) return "mortgage";
  if (MODIFY_RE.test(s)) return "modification";
  if (DEED_RE.test(s)) return "deed";
  return "other";
}

async function exhaust(dataset, params, { maxRows = 100000, pageSize = 5000 } = {}) {
  const r = await soqlAll(dataset, params, {
    pageSize,
    maxRows,
    timeoutMs: 40000,
    ttlMs: 30 * 60 * 1000,
    retries: 2
  });
  return r.live && r.complete === true
    ? r
    : { ...r, live: false, complete: false, rows: [], error: r.error || `Incomplete ACRIS source ${dataset}` };
}

async function fetchParties(ids) {
  const parties = {};
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const list = chunk.map((id) => `'${escSoql(id)}'`).join(",");
    const r = await exhaust(DS.acrisParties, {
      $select: PARTY_FIELDS,
      $where: `document_id in(${list})`,
      $order: "document_id ASC,party_type ASC,name ASC"
    }, { maxRows: 50000, pageSize: 5000 });
    if (!r.live) return { live: false, parties: {}, error: r.error || "ACRIS party source unavailable" };
    for (const row of r.rows ?? []) {
      const id = String(row.document_id ?? "");
      if (!id) continue;
      (parties[id] ||= []).push(row);
    }
  }
  return { live: true, complete: true, parties };
}

async function fetchReferences(ids) {
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 35) {
    const chunk = ids.slice(i, i + 35);
    const list = chunk.map((id) => `'${escSoql(id)}'`).join(",");
    // A cross-reference can be returned with our document in either the base
    // DOCUMENT ID or the REFERENCE BY DOC ID position. Exhaust both directions.
    for (const where of [`document_id in(${list})`, `reference_by_doc_id in(${list})`]) {
      const r = await exhaust(ACRIS_REFERENCES, {
        $select: REF_FIELDS,
        $where: where,
        $order: "document_id ASC,reference_by_doc_id ASC,reference_by_crfn_ ASC"
      }, { maxRows: 50000, pageSize: 5000 });
      if (!r.live) return { live: false, rows: [], error: r.error || "ACRIS reference source unavailable" };
      for (const row of r.rows ?? []) {
        const key = [row.document_id, row.reference_by_doc_id, row.reference_by_crfn_, row.reference_by_reel_year, row.reference_by_reel_nbr, row.reference_by_reel_page].join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    }
  }
  return { live: true, complete: true, rows };
}

export async function fullAcrisByLot(bbl) {
  const p = parseBbl(bbl);
  if (!p) return { live: false, error: "invalid bbl", documents: [], parties: {}, references: [] };

  const legals = await exhaust(DS.acrisLegals, {
    $select: "document_id",
    $where: `borough='${p.boro}' AND block='${p.block}' AND lot='${p.lot}'`,
    $order: "document_id ASC"
  }, { maxRows: 100000, pageSize: 5000 });
  if (!legals.live) return { live: false, error: legals.error || "ACRIS legal source unavailable", documents: [], parties: {}, references: [] };

  const ids = [...new Set((legals.rows ?? []).map((r) => String(r.document_id ?? "")).filter(Boolean))];
  if (!ids.length) return {
    live: true, provenance: "live", bbl: p.digits, documents: [], parties: {}, references: [], deeds: [], debtDocuments: [],
    referenceStatus: "live", referenceError: null,
    ownershipTimeline: [], financingTimeline: [], currentDebtInference: { amount: null, confidence: "unknown", valueType: "unavailable", basis: "No recorded ACRIS debt documents returned." },
    source: "NYC ACRIS Real Property Master/Legals/Parties/References",
    retrievedAt: new Date().toISOString()
  };

  const documents = [];
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const list = chunk.map((id) => `'${escSoql(id)}'`).join(",");
    const r = await exhaust(DS.acrisMaster, {
      $select: MASTER_FIELDS,
      $where: `document_id in(${list})`,
      $order: "document_id ASC"
    }, { maxRows: 5000, pageSize: 1000 });
    if (!r.live) return { live: false, error: r.error || "ACRIS master source unavailable", documents: [], parties: {}, references: [] };
    documents.push(...(r.rows ?? []));
  }

  const [partyResult, referenceResult] = await Promise.all([fetchParties(ids), fetchReferences(ids)]);
  if (!partyResult.live) return { live: false, error: partyResult.error, documents: [], parties: {}, references: [] };
  // Cross references materially improve lien/debt resolution, but an upstream
  // outage must not erase otherwise valid ACRIS documents/parties. Keep their
  // availability explicit so callers know whether payoff-state linking is safe.
  const references = referenceResult.live ? referenceResult.rows : [];
  const referenceAvailable = referenceResult.live;

  const normalized = documents
    .map((d) => ({
      ...d,
      kind: classifyAcrisDoc(d.doc_type),
      date: day(d.document_date || d.recorded_datetime),
      recordedDate: day(d.recorded_datetime),
      amount: amount(d.document_amt),
      parties: partyResult.parties[d.document_id] ?? [],
      referencesFrom: references.filter((r) => String(r.reference_by_doc_id || "") === String(d.document_id || "")),
      referencesTo: references.filter((r) => String(r.document_id || "") === String(d.document_id || ""))
    }))
    .sort((a, b) => String(b.recorded_datetime ?? b.document_date ?? "").localeCompare(String(a.recorded_datetime ?? a.document_date ?? "")));

  const byId = new Map(normalized.map((d) => [String(d.document_id), d]));
  const referencedBy = new Map();
  for (const r of references) {
    const base = String(r.document_id || "");
    const refBy = String(r.reference_by_doc_id || "");
    if (!base || !refBy) continue;
    (referencedBy.get(base) || referencedBy.set(base, []).get(base)).push(refBy);
  }

  const ownershipTimeline = normalized.filter((d) => d.kind === "deed").map((d) => ({
    documentId: d.document_id,
    crfn: d.crfn || null,
    documentType: d.doc_type,
    documentDate: day(d.document_date),
    recordedDate: day(d.recorded_datetime),
    amount: d.amount,
    grantors: d.parties.filter((x) => String(x.party_type) === "1").map(partyName).filter(Boolean),
    grantees: d.parties.filter((x) => String(x.party_type) === "2").map(partyName).filter(Boolean),
    source: "NYC ACRIS"
  }));

  const financingTimeline = normalized
    .filter((d) => ["mortgage", "assignment", "modification", "satisfaction"].includes(d.kind))
    .map((d) => {
      const refs = referencedBy.get(String(d.document_id)) || [];
      const referringDocs = refs.map((id) => byId.get(id)).filter(Boolean);
      const linkedSatisfactions = referringDocs.filter((x) => x.kind === "satisfaction").map((x) => x.document_id);
      const linkedAssignments = referringDocs.filter((x) => x.kind === "assignment").map((x) => x.document_id);
      const linkedModifications = referringDocs.filter((x) => x.kind === "modification").map((x) => x.document_id);
      return {
        documentId: d.document_id,
        crfn: d.crfn || null,
        kind: d.kind,
        documentType: d.doc_type,
        documentDate: day(d.document_date),
        recordedDate: day(d.recorded_datetime),
        amount: d.amount,
        party1: d.parties.filter((x) => String(x.party_type) === "1").map(partyName).filter(Boolean),
        party2: d.parties.filter((x) => String(x.party_type) === "2").map(partyName).filter(Boolean),
        parties: d.parties.map((p) => ({
          type: String(p.party_type ?? ""), name: partyName(p),
          address: [p.address_1, p.address_2, p.city, p.state, p.zip].filter(Boolean).join(", ") || null
        })),
        linkedSatisfactions,
        linkedAssignments,
        linkedModifications,
        referenceStatus: referenceAvailable ? "live" : "unavailable",
        source: "NYC ACRIS"
      };
    });

  const mortgageAmounts = financingTimeline.filter((d) => d.kind === "mortgage" && d.amount > 0);
  const unsatisfied = referenceAvailable ? mortgageAmounts.filter((m) => !m.linkedSatisfactions?.length) : [];
  const recentMortgage = mortgageAmounts[0] ?? null;
  let currentDebtInference;
  if (!recentMortgage) {
    currentDebtInference = { amount: null, confidence: "unknown", valueType: "unavailable", basis: "No recorded mortgage amount returned." };
  } else if (!referenceAvailable) {
    currentDebtInference = {
      amount: null, confidence: "unknown", valueType: "unavailable",
      basis: "ACRIS cross-reference records were unavailable, so satisfaction status could not be linked safely."
    };
  } else {
    const recordedPrincipal = unsatisfied.reduce((sum, m) => sum + (m.amount || 0), 0);
    currentDebtInference = {
      amount: recordedPrincipal || null,
      confidence: "medium",
      valueType: "modeled estimate",
      basis: "Sum of recorded mortgage document amounts for mortgages that did not have a linked satisfaction/release in the ACRIS cross-reference records returned. This is not a payoff balance and may overstate or understate current debt because modifications, consolidations, amortization and unrecorded events are not principal-balance statements.",
      activeMortgageDocumentIds: unsatisfied.map((m) => m.documentId),
      satisfiedMortgageDocumentIds: mortgageAmounts.filter((m) => m.linkedSatisfactions?.length).map((m) => m.documentId)
    };
  }

  return {
    live: true,
    provenance: "live",
    bbl: p.digits,
    documents: normalized,
    parties: partyResult.parties,
    references,
    referenceStatus: referenceAvailable ? "live" : "unavailable",
    referenceError: referenceAvailable ? null : referenceResult.error,
    deeds: normalized.filter((d) => d.kind === "deed"),
    debtDocuments: normalized.filter((d) => ["mortgage", "assignment", "modification", "satisfaction"].includes(d.kind)),
    ownershipTimeline,
    financingTimeline,
    currentDebtInference,
    source: "NYC ACRIS Real Property Master/Legals/Parties/References",
    retrievedAt: new Date().toISOString()
  };
}
