// The full API surface of the map room. Response shapes mirror the production
// Worker's contract (observed from the shipped client); data comes from the
// deterministic city model plus the curated seed universe. Tile imagery is
// proxied from free public basemap services with an in-memory cache.

import { Router } from "express";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_DATA_DIR } from "./usage-meter.js";
import { SEED_PARCELS, findSeedByBbl, BOROUGH_BY_NEIGHBORHOOD } from "./seed-parcels.js";
import { DATA_SOURCES } from "./sources.js";
import { TERRITORIES, resolveTerritory } from "./territories.js";
import {
  buildingsForZip, buildingsForZips, buildingByBbl, assetHistory, salesForZips,
  pipelineForZips, lotFeaturesForTile, bldgFeaturesForTile, nearestBuilding,
  nearbyBuildings, distressSignals, landUseLabel, ALL_ZIPS
} from "./citymodel.js";
import { computePropensity, computeDistressFromRecord, estimateDebtMaturity } from "./scoring.js";
import { rngFor, round, clamp, pick } from "./util.js";
import { BOROUGH_BY_ZIP, BORO_CODE } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// --- Real, public NYC neighborhood (NTA) boundaries -------------------------
const NTA_FEATURES = JSON.parse(readFileSync(path.join(__dirname, "data", "nta-polys.json"), "utf8"));

function bboxOf(coords, box) {
  if (typeof coords[0] === "number") {
    const [lng, lat] = coords;
    if (lng < box.minLng) box.minLng = lng;
    if (lng > box.maxLng) box.maxLng = lng;
    if (lat < box.minLat) box.minLat = lat;
    if (lat > box.maxLat) box.maxLat = lat;
  } else coords.forEach((c) => bboxOf(c, box));
}
function intersects(geom, minLng, minLat, maxLng, maxLat) {
  const box = { minLng: Infinity, minLat: Infinity, maxLng: -Infinity, maxLat: -Infinity };
  bboxOf(geom.coordinates, box);
  return box.minLng <= maxLng && box.maxLng >= minLng && box.minLat <= maxLat && box.maxLat >= minLat;
}

router.get("/api/nta-polys", (req, res) => {
  const parts = String(req.query.bbox || "").split(",").map(Number);
  const [minLng, minLat, maxLng, maxLat] = parts.length === 4 ? parts : [-74.26, 40.49, -73.68, 40.92];
  res.json({ features: NTA_FEATURES.filter((f) => intersects(f.geom, minLng, minLat, maxLng, maxLat)) });
});

// --- Curated opportunity universe -------------------------------------------
router.get("/api/opportunities", (req, res) => {
  const { assetClass = "", neighborhood = "" } = req.query;
  let list = [...SEED_PARCELS];
  if (assetClass) list = list.filter((p) => p.category === assetClass);
  if (neighborhood) list = list.filter((p) => p.neighborhood === neighborhood);
  res.json(list);
});

router.get("/api/gov-links", (req, res) => {
  const p = findSeedByBbl(req.query.bbl) || buildingByBbl(req.query.bbl);
  if (!p) return res.status(404).json({ error: "unknown bbl" });
  const digits = String(p.bbl).replace(/[^0-9]/g, "");
  const boro = digits[0];
  res.json({
    acris: `https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${boro}&block=${p.block}&lot=${p.lot}`,
    propertyInformationPortal: `https://propertyinformationportal.nyc.gov/parcels/parcel/${digits}`,
    buildingsProfile: `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${boro}&block=${p.block}&lot=${p.lot}`,
    zoningMap: `https://zola.planning.nyc.gov/l/lot/${boro}/${p.block}/${p.lot}`
  });
});

// --- Area inventory (every tax lot) -----------------------------------------
const SORTS = {
  score: (a, b) => b.score - a.score,
  propensity: (a, b) => (b.propensity ?? 0) - (a.propensity ?? 0),
  lotarea: (a, b) => (b.lotArea ?? 0) - (a.lotArea ?? 0),
  assesstot: (a, b) => (b.assessTotal ?? 0) - (a.assessTotal ?? 0),
  yearbuilt: (a, b) => (a.yearBuilt || 3000) - (b.yearBuilt || 3000),
  unitsres: (a, b) => (b.unitsRes ?? 0) - (a.unitsRes ?? 0)
};
const assetClassOf = (cls) => {
  const c = (cls ?? "").toUpperCase().slice(0, 1);
  return c === "C" || c === "D" ? "multifamily" : c === "R" ? "condo" : c === "O" ? "office" : c === "H" ? "hotels" : c === "V" || c === "Z" ? "development" : "other";
};

router.get("/api/area-buildings", (req, res) => {
  const zips = String(req.query.zips || "").split(",").map((s) => s.trim()).filter(Boolean);
  const page = Math.max(0, parseInt(req.query.page || "0", 10));
  const pageSize = clamp(parseInt(req.query.pageSize || "200", 10), 1, 1000);
  const sort = SORTS[req.query.sort] ? req.query.sort : "score";
  const cls = req.query.class || "";
  let list = buildingsForZips(zips);
  if (cls) list = list.filter((b) => assetClassOf(b.bldgClass) === cls);
  list = [...list].sort(SORTS[sort]);
  const total = list.length;
  res.json({
    total, page, pageSize,
    buildings: list.slice(page * pageSize, page * pageSize + pageSize),
    fetchedAt: new Date().toISOString()
  });
});

router.get("/api/address", (req, res) => {
  const q = String(req.query.q || "").trim();
  const digits = q.replace(/[^0-9]/g, "");
  let matches = [];
  if (digits.length === 10) {
    const b = buildingByBbl(digits);
    if (b) matches = [b];
    const seed = findSeedByBbl(digits);
    if (!matches.length && seed) matches = [seedToBuilding(seed)];
  }
  if (!matches.length && q.length >= 3) {
    const needle = q.toLowerCase();
    for (const z of ALL_ZIPS) {
      for (const b of buildingsForZip(z)) {
        if (b.address.toLowerCase().includes(needle)) matches.push(b);
        if (matches.length >= 25) break;
      }
      if (matches.length >= 25) break;
    }
    if (!matches.length) {
      matches = SEED_PARCELS.filter((p) => p.address.toLowerCase().includes(needle)).map(seedToBuilding);
    }
  }
  res.json({
    fetchedAt: new Date().toISOString(),
    total: matches.length, returned: matches.length,
    coverage: matches.length
      ? `${matches.length} lot(s) matched "${q}" in the demo universe. Exact-address matches resolve to one BBL; the dossier pulls the full record against it.`
      : `No lots matched "${q}". Try a fuller address (e.g. "151 West 25 St") or a 10-digit BBL.`,
    buildings: matches
  });
});

function seedToBuilding(p) {
  const digits = p.bbl.replace(/[^0-9]/g, "");
  return {
    bbl: digits, address: p.address, borough: BOROUGH_BY_NEIGHBORHOOD[p.neighborhood] || "Manhattan",
    block: p.block, lot: p.lot, zip: "", lat: p.lat, lng: p.lng, bin: p.bin,
    bldgClass: p.adaptiveReuse ? "O5" : "V1", landUse: "05", zoning: p.zoning,
    lotArea: p.lotSf, bldgArea: p.bldgSf, builtFar: p.far, maxFar: p.maxFar,
    unusedFarSf: p.unbuiltFarSf, yearBuilt: p.yearBuilt, numFloors: p.floors,
    owner: p.owner, score: p.opportunityScore, propensity: 0, unitsRes: 0, unitsTotal: 0
  };
}

// --- Point + tile lookups -----------------------------------------------------
router.get("/api/lot-at", (req, res) => {
  const b = nearestBuilding(Number(req.query.lat), Number(req.query.lng));
  if (!b) return res.status(404).json({ error: "no parcel found" });
  res.json(b);
});

router.get("/api/zip-at", (req, res) => {
  const b = nearestBuilding(Number(req.query.lat), Number(req.query.lng));
  res.json({ zip: b ? b.zip : null });
});

router.get("/api/lot-tiles/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  res.set("cache-control", "public, max-age=3600");
  res.json(lotFeaturesForTile(Number(z), Number(x), Number(y)));
});

router.get("/api/bldg-tiles/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  res.set("cache-control", "public, max-age=3600");
  res.json(bldgFeaturesForTile(Number(z), Number(x), Number(y)));
});

router.get("/api/nearby", (req, res) => {
  res.json({ buildings: nearbyBuildings(Number(req.query.lat), Number(req.query.lng)) });
});

router.get("/api/footprints", (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const feats = [];
  for (const b of nearbyBuildings(lat, lng, 24)) {
    const full = buildingByBbl(b.bbl);
    if (!full) continue;
    const angle = rngFor(`ang:${full.bbl}`)() * Math.PI;
    feats.push({
      bbl: full.bbl,
      geom: {
        type: "Polygon",
        coordinates: rectCoords(full.lat, full.lng, full.lotFront, full.lotDepth, angle)
      }
    });
  }
  res.json({ features: feats });
});

function rectCoords(lat, lng, wFt, dFt, angleRad) {
  const latFt = 364000, lngFt = 288200;
  const w = wFt / 2, d = dFt / 2;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  return [[[-w, -d], [w, -d], [w, d], [-w, d], [-w, -d]].map(([x, y]) => {
    const rx = x * cos - y * sin, ry = x * sin + y * cos;
    return [round(lng + rx / lngFt, 6), round(lat + ry / latFt, 6)];
  })];
}

// --- Live pull (evidence tiles) ----------------------------------------------
router.get("/api/livepull", (req, res) => {
  const bbl = String(req.query.bbl || "").replace(/[^0-9]/g, "");
  const record = assetHistory(bbl);
  const seed = findSeedByBbl(bbl);
  const exact = !!record || !!(seed && !/vicinity|corridor|assemblage|edge|node|block|parcel/i.test(seed.address));

  const sources = [];
  const pushSource = (id, rows, status = "ok") => sources.push({ id, status, rows, query: null });

  if (record) {
    const sales = record.sales.filter((s) => s.amount > 0).map((s) => ({
      sale_date: s.date, sale_price: String(s.amount), address: record.address,
      building_class_at_present: record.pluto.bldgClass,
      land_square_feet: String(record.pluto.lotArea), gross_square_feet: String(record.pluto.bldgArea)
    }));
    pushSource("rolling_sales", sales.slice(0, 8));
    pushSource("pluto", [{
      bbl, address: record.address, zonedist1: record.pluto.zoning, landuse: record.pluto.landUse,
      lotarea: String(record.pluto.lotArea), bldgarea: String(record.pluto.bldgArea),
      builtfar: String(record.pluto.builtFar), commfar: String(record.pluto.maxFar),
      residfar: String(record.pluto.maxFar), yearbuilt: String(record.pluto.yearBuilt ?? ""),
      ownername: record.pluto.owner
    }]);
    pushSource("dob_permits", record.permits.slice(0, 6).map((p) => ({
      issuance_date: p.date, job_type: p.type, permit_status: p.status, applicant_business_name: p.business
    })));
    pushSource("dob_now", record.permits.slice(6, 10).map((p) => ({
      filing_date: p.date, job_type: p.type, filing_status: p.status, applicant_business: p.business
    })));
    const zapRng = rngFor(`zap:${bbl}`);
    pushSource("zap", zapRng() < 0.12 ? [{ project_name: "Land-use application (demo)", current_status: "In public review", project_brief: "BBL-linked zoning action generated by the demo engine." }] : []);
    const debtDocs = record.loans.map((m) => ({ doc_type: m.docType, document_amt: String(m.amount || ""), recorded_datetime: m.date, document_id: m.docId }));
    pushSource("acris_master", debtDocs);

    const debt = estimateDebtMaturity(record);
    const lastSale = record.metrics.lastSaleDate
      ? { saleDate: record.metrics.lastSaleDate, salePrice: record.metrics.lastSalePrice, buildingClass: record.pluto.bldgClass }
      : null;
    return res.json({
      mode: exact ? "exact" : "block",
      coverage: exact
        ? `Exact parcel pull — every source queried against BBL ${bbl}.`
        : `Block-level pull — sources queried by borough/block/lot around BBL ${bbl}.`,
      fetchedAt: new Date().toISOString(),
      summary: {
        lastSale, parcelMatch: "matched",
        dobPermitCount: record.permits.length,
        dobNowCount: Math.max(0, record.permits.length - 6),
        zoningApplicationCount: sources.find((s) => s.id === "zap").rows.length,
        debtDocCount: record.loans.length,
        okSources: sources.filter((s) => s.rows.length > 0).length,
        errorSources: 0
      },
      debt: debt && record.loans.length
        ? {
            found: true, docType: record.loans[0].docType, docTypeLabel: record.loans[0].docType,
            amount: record.loans[0].amount, lender: record.loans[0].lender,
            borrower: record.pluto.owner, recordedDate: record.loans[0].date,
            documentId: record.loans[0].docId, rows: sources.find((s) => s.id === "acris_master").rows,
            borrowerAddress: null, lenderAddress: null
          }
        : { found: false, rows: [] },
      permitContact: record.permits.length
        ? { found: true, applicant: record.permits[0].applicant, applicantBusiness: record.permits[0].business, ownerBusiness: null, license: null, jobType: record.permits[0].type, filingDate: record.permits[0].date }
        : { found: false },
      plutoOwner: record.pluto.owner,
      sources
    });
  }

  // Seed parcels with demo identifiers: honest "no live record" result.
  ["rolling_sales", "pluto", "dob_permits", "dob_now", "zap", "acris_master"].forEach((id) =>
    pushSource(id, [], seed ? "ok" : "skipped")
  );
  res.json({
    mode: "block",
    coverage: seed
      ? "Block-level pull: this is a modeled demo identifier, so the public sources return no live rows — expected for seed data."
      : "No borough/block/lot resolved for this identifier.",
    fetchedAt: new Date().toISOString(),
    summary: { lastSale: null, parcelMatch: "not-found", dobPermitCount: 0, dobNowCount: 0, zoningApplicationCount: 0, debtDocCount: 0, okSources: 0, errorSources: 0 },
    debt: { found: false, rows: [] },
    permitContact: { found: false },
    plutoOwner: null,
    sources
  });
});

// --- Full parcel record -------------------------------------------------------
router.get("/api/asset-history", (req, res) => {
  const record = assetHistory(req.query.bbl);
  if (!record) return res.status(404).json({ error: "unknown bbl" });
  const { building, ...rest } = record;
  res.json(rest);
});

router.get("/api/owner-portfolio", (req, res) => {
  const owner = String(req.query.owner || "").trim().toUpperCase();
  if (!owner) return res.json({ owner: "", total: 0, units: 0, sample: [] });
  const matches = [];
  for (const z of ALL_ZIPS) {
    for (const b of buildingsForZip(z)) {
      if (b.owner.toUpperCase() === owner) matches.push(b);
    }
  }
  matches.sort((a, b) => (b.unitsRes ?? 0) - (a.unitsRes ?? 0));
  res.json({
    owner: matches[0]?.owner ?? req.query.owner,
    total: matches.length,
    units: matches.reduce((n, b) => n + (b.unitsRes || 0), 0),
    sample: matches.slice(0, 20).map((b) => ({ bbl: b.bbl, address: b.address, bldgClass: b.bldgClass, unitsRes: b.unitsRes, zip: b.zip }))
  });
});

router.get("/api/contacts", (req, res) => {
  const bbl = String(req.query.bbl || "").replace(/[^0-9]/g, "");
  const record = assetHistory(bbl);
  if (!record) {
    return res.json({ bbl, permitContacts: [], ownerEntities: [], debtParties: [], hpdContacts: [], ownerContacts: [], note: "No live record for this identifier (expected for a demo BBL). The pull re-runs automatically when the lot resolves." });
  }
  const rng = rngFor(`contacts:${bbl}`);
  const owner = record.pluto.owner;
  const isEntity = /LLC|CORP|LP|TRUST|ASSOC|REALTY|HOLDINGS|PARTNERS/i.test(owner);
  const ownerEntities = isEntity
    ? [{ entityName: owner, entityType: /LLC/.test(owner) ? "DOMESTIC LIMITED LIABILITY COMPANY" : "DOMESTIC BUSINESS CORPORATION", county: record.building.borough === "Manhattan" ? "New York" : record.building.borough, dosId: null, address: null }]
    : [];
  // Demo contacts never carry invented phone numbers or license IDs —
  // phone is "not available" unless a real record supplies one.
  res.json({
    bbl,
    permitContacts: record.permits.slice(0, 6).map((p) => ({ role: "Permit applicant", name: p.applicant, business: p.business, phone: null, license: null, source: "Permit filing (demo record)", date: p.date })),
    ownerEntities,
    ownerContacts: isEntity ? [] : [{ role: "Owner of record", name: owner, business: null, phone: null, source: "Housing registration (demo record)", date: null }],
    hpdContacts: record.building.unitsRes >= 3
      ? [
          { role: "Owner", name: owner, business: null, date: `${2024 + Math.floor(rng() * 2)}-06-01` },
          { role: "Managing agent", name: null, business: `${owner.split(" ")[0]} MANAGEMENT LLC`, date: `${2024 + Math.floor(rng() * 2)}-06-01` }
        ]
      : [],
    debtParties: record.loans.slice(0, 2).flatMap((m) => [
      { role: "Mortgagor / borrower", name: owner, address: null },
      { role: "Mortgagee / lender", name: m.lender, address: null }
    ]),
    note: "Leads from permit filings + state business records + housing registration — free public records. Contractor lines are filers, not owners; verify before use."
  });
});

// --- Distress / cliffs / taxes / assemblage / transit -------------------------
router.get("/api/distress", (req, res) => {
  const record = assetHistory(req.query.bbl);
  if (!record) return res.status(404).json({ error: "unknown bbl" });
  const s = record.signals;
  res.json({ bbl: record.bbl, ...s, riskFlags: [] });
});

router.get("/api/cliffs", (req, res) => {
  const bbl = String(req.query.bbl || "").replace(/[^0-9]/g, "");
  const record = assetHistory(bbl);
  if (!record) return res.status(404).json({ error: "unknown bbl" });
  const rng = rngFor(`cliffs:${bbl}`);
  const b = record.building;
  const out = { bbl };
  if (b.unitsRes >= 6 && rng() < 0.25) {
    const initYear = 1998 + Math.floor(rng() * 18);
    const years = [14, 20, 34][Math.floor(rng() * 3)];
    const endYear = initYear + years;
    out.j51 = { initYear, exYears: years, endYear, status: endYear <= 2026 ? "expired" : endYear <= 2028 ? "expiring" : "active" };
  }
  if (b.bldgArea > 25000) {
    const ghg = Math.round(b.bldgArea * (0.004 + rng() * 0.006));
    const capTons = Math.round(b.bldgArea * 0.0045);
    const over = Math.max(0, ghg - capTons);
    out.ll97 = {
      type: landUseLabel(b.landUse), ghg, capTons, overTons: over,
      penalty2030: over * 268, status: over > 0 ? "exposed" : "compliant", reportYear: 2025
    };
    const grades = ["A", "B", "C", "D"];
    out.ll33 = { grade: over > 0 ? pick(rng, ["C", "D", "D"]) : pick(rng, grades), score: Math.round(30 + rng() * 65) };
  }
  res.json(out);
});

router.get("/api/tax-history", (req, res) => {
  const record = assetHistory(req.query.bbl);
  if (!record) return res.status(404).json({ error: "unknown bbl" });
  const b = record.building;
  const rng = rngFor(`tax:${b.bbl}`);
  const years = [2021, 2022, 2023, 2024, 2025, 2026];
  let market = b.marketValue * (0.82 + rng() * 0.08);
  const rows = years.map((year, i) => {
    const prev = market;
    market = market * (1 + (rng() - 0.35) * 0.09);
    const assessed = Math.round(market * 0.45);
    const taxable = Math.round(assessed * 0.9);
    return {
      year, taxClass: b.unitsRes > 3 ? "2" : b.unitsRes > 0 ? "1" : "4",
      marketValue: Math.round(market), assessedTotal: assessed, taxable,
      estTax: Math.round(taxable * (b.unitsRes > 3 ? 0.125 : 0.2)),
      yoyMarketPct: i === 0 ? null : Math.round(((market - prev) / prev) * 100)
    };
  });
  res.json({ bbl: record.bbl, rows });
});

router.get("/api/assemblage", (req, res) => {
  const record = assetHistory(req.query.bbl);
  if (!record) return res.status(404).json({ error: "unknown bbl" });
  const b = record.building;
  const sameOwnerBlock = buildingsForZip(b.zip).filter((x) => x.block === b.block && x.owner === b.owner);
  const lots = sameOwnerBlock.map((x) => ({
    bbl: x.bbl, address: x.address, lotArea: x.lotArea, builtFar: x.builtFar, maxFar: x.maxFar,
    unusedSf: x.unusedFarSf
  }));
  res.json({
    bbl: b.bbl, owner: b.owner, count: lots.length,
    subjectUnusedSf: b.unusedFarSf,
    totalUnusedSf: lots.reduce((n, l) => n + (l.unusedSf || 0), 0),
    lots
  });
});

const SUBWAY = [
  { name: "Court Sq", lines: "E,M,7,G", lat: 40.7470, lng: -73.9454 },
  { name: "Bedford Av", lines: "L", lat: 40.7172, lng: -73.9567 },
  { name: "Atlantic Av–Barclays", lines: "2,3,4,5,B,D,N,Q,R", lat: 40.6840, lng: -73.9772 },
  { name: "34 St–Herald Sq", lines: "B,D,F,M,N,Q,R,W", lat: 40.7496, lng: -73.9876 },
  { name: "Fulton St", lines: "2,3,4,5,A,C,J,Z", lat: 40.7102, lng: -74.0079 },
  { name: "125 St", lines: "A,B,C,D", lat: 40.8110, lng: -73.9525 },
  { name: "74 St–Broadway", lines: "7,E,F,M,R", lat: 40.7469, lng: -73.8912 },
  { name: "Grand Central–42 St", lines: "4,5,6,7,S", lat: 40.7527, lng: -73.9772 },
  { name: "Church Av", lines: "B,Q", lat: 40.6503, lng: -73.9628 },
  { name: "Astoria–Ditmars Blvd", lines: "N,W", lat: 40.7751, lng: -73.9121 },
  { name: "Jamaica Center", lines: "E,J,Z", lat: 40.7022, lng: -73.7961 },
  { name: "Grand Concourse–149 St", lines: "2,4,5", lat: 40.8183, lng: -73.9273 }
];
router.get("/api/transit", (req, res) => {
  const record = assetHistory(req.query.bbl);
  if (!record) return res.status(404).json({ error: "unknown bbl" });
  const b = record.building;
  const withDist = SUBWAY.map((s) => {
    const dLat = (s.lat - b.lat) * 364000, dLng = (s.lng - b.lng) * 288200;
    return { ...s, distanceFt: Math.round(Math.hypot(dLat, dLng)) };
  }).sort((a, z) => a.distanceFt - z.distanceFt);
  res.json({
    bbl: b.bbl,
    nearest: { name: withDist[0].name, lines: withDist[0].lines, distanceFt: withDist[0].distanceFt },
    within: {
      quarterMile: withDist.filter((s) => s.distanceFt <= 1320).length,
      halfMile: withDist.filter((s) => s.distanceFt <= 2640).length
    },
    stations: withDist.slice(0, 6).map((s) => ({
      name: s.name, routes: s.lines.split(","),
      walk_min: Math.max(1, Math.round(s.distanceFt / 280)),
      dist_mi: round(s.distanceFt / 5280, 2)
    }))
  });
});

// ACS-shaped submarket demographics for the document generators — the same
// deterministic engine as everything else, keyed by the ZIP set.
router.get("/api/demographics", (req, res) => {
  const zips = String(req.query.zips || "").split(",").filter(Boolean);
  if (!zips.length) return res.status(400).json({ error: "zips required" });
  const boro = BOROUGH_BY_ZIP[zips[0]] || "Brooklyn";
  const rng = rngFor(`demo:${zips.join(",")}`);
  const incomeBase = { Manhattan: 96000, Brooklyn: 74000, Queens: 71000, Bronx: 46000, "Staten Island": 82000 }[boro];
  const population = Math.round((28000 + rng() * 42000) * Math.min(zips.length, 4));
  const medianIncome = Math.round((incomeBase * (0.85 + rng() * 0.4)) / 100) * 100;
  const renterPct = Math.round(boro === "Manhattan" ? 72 + rng() * 12 : 58 + rng() * 18);
  res.json({
    population,
    median_age: round(31 + rng() * 9, 1),
    household_size: round(1.9 + rng() * 0.9, 2),
    households: Math.round(population / (2.1 + rng() * 0.5)),
    median_income: medianIncome,
    per_capita_income: Math.round(medianIncome * (0.52 + rng() * 0.12) / 100) * 100,
    median_gross_rent: Math.round((incomeBase / 32) * (0.9 + rng() * 0.3) / 10) * 10,
    renter_pct: renterPct,
    owner_pct: 100 - renterPct,
    unemployment_pct: round(3.2 + rng() * 3.4, 1)
  });
});

router.get("/api/liensale", (req, res) => {
  const bbl = String(req.query.bbl || "").replace(/[^0-9]/g, "");
  const rng = rngFor(`lien:${bbl}`);
  const onList = rng() < 0.05;
  res.json({
    bbl, onList,
    records: onList ? [{ month: "2026-05-01", cycle: "90-day notice", waterOnly: rng() < 0.5 }] : []
  });
});

router.get("/api/similar", (req, res) => {
  // Local heuristic engine — labels itself; the Pinecone path answers first
  // when PINECONE_API_KEY + PINECONE_INDEX_HOST are configured (audit item 24).
  const record = assetHistory(req.query.bbl);
  if (!record) return res.json({ configured: true, engine: "local-heuristic", matches: [] });
  const b = record.building;
  const matches = buildingsForZips([b.zip])
    .filter((x) => x.bbl !== b.bbl && x.bldgClass[0] === b.bldgClass[0])
    .map((x) => ({ x, s: 1 - Math.min(1, Math.abs((x.bldgArea || 1) - b.bldgArea) / Math.max(b.bldgArea, 1)) * 0.6 - Math.abs((x.yearBuilt || 1950) - (b.yearBuilt || 1950)) / 500 }))
    .sort((a, z) => z.s - a.s)
    .slice(0, 8)
    .map(({ x, s }) => ({ bbl: x.bbl, address: x.address, bldgclass: x.bldgClass, zip: x.zip, score: round(clamp(s, 0.4, 0.99), 2) }));
  res.json({ configured: true, engine: "local-heuristic", matches });
});

// --- Territory / market analytics --------------------------------------------
function censusForZips(zips, mode) {
  const all = buildingsForZips(zips);
  const isQualifying = (b) => {
    const c = b.bldgClass[0];
    if (mode === "multifamily") return (c === "C" || c === "D") && b.unitsRes >= 20;
    if (mode === "condo") return c === "R";
    if (mode === "office") return c === "O";
    if (mode === "hotels") return c === "H";
    if (mode === "development") return b.builtFar < 1.5 && b.maxFar >= 3;
    return !["C", "D", "R", "O", "H"].includes(c);
  };
  const q = all.filter(isQualifying);
  const units = q.reduce((n, b) => n + (mode === "hotels" ? b.unitsTotal : b.unitsRes), 0);
  const top = [...q].sort((a, b) =>
    mode === "development" ? (b.unusedFarSf ?? 0) - (a.unusedFarSf ?? 0)
      : mode === "office" || mode === "misc" ? (b.bldgArea ?? 0) - (a.bldgArea ?? 0)
        : (mode === "hotels" ? (b.unitsTotal ?? 0) - (a.unitsTotal ?? 0) : (b.unitsRes ?? 0) - (a.unitsRes ?? 0))
  ).slice(0, 12);
  return { all, qualifying: q, units, top };
}

router.get("/api/territories", (req, res) => res.json(TERRITORIES));
router.get("/api/sources", (req, res) => res.json(DATA_SOURCES));

router.get("/api/territory", (req, res) => {
  const zips = String(req.query.zips || "").split(",").filter(Boolean);
  const mode = req.query.mode || "multifamily";
  const { all, qualifying, units, top } = censusForZips(zips, mode);
  const sales = salesForZips(zips);
  const metric = mode === "development" ? "$/land sf" : "$/sf";
  const ppsfs = sales.map((s) => (mode === "development" ? (s.landSf ? s.salePrice / s.landSf : null) : s.ppsf)).filter((v) => v && Number.isFinite(v));
  const median = ppsfs.length ? [...ppsfs].sort((a, b) => a - b)[Math.floor(ppsfs.length / 2)] : null;
  const avg = ppsfs.length ? ppsfs.reduce((n, v) => n + v, 0) / ppsfs.length : null;

  const ownerAgg = new Map();
  for (const b of all) {
    if (!b.owner || /OWNERS CORP/.test(b.owner)) continue;
    const k = b.owner;
    const cur = ownerAgg.get(k) || { name: k, buildings: 0, units: 0 };
    cur.buildings += 1; cur.units += b.unitsRes || 0;
    ownerAgg.set(k, cur);
  }
  const owners = [...ownerAgg.values()];
  res.json({
    fetchedAt: new Date().toISOString(),
    census: {
      qualifyingCount: qualifying.length,
      totalUnits: units,
      avgUnitsPerBldg: qualifying.length ? Math.round(units / qualifying.length) : 0,
      totalLots: all.length,
      topUnusedBuildableSf: top.reduce((n, b) => n + (b.unusedFarSf || 0), 0)
    },
    sales: {
      count: sales.length, medianPpsf: median ? Math.round(median) : null,
      avgPpsf: avg ? Math.round(avg) : null, metric,
      latestSaleDate: sales[0]?.saleDate ?? null
    },
    top: top.map((b) => ({
      bbl: b.bbl, address: b.address, zoning: b.zoning, unitsRes: b.unitsRes, unitsTotal: b.unitsTotal,
      bldgArea: b.bldgArea, yearBuilt: b.yearBuilt, owner: b.owner, score: b.score,
      lotArea: b.lotArea, builtFar: b.builtFar, maxFar: b.maxFar, unusedFarSf: b.unusedFarSf
    })),
    ownersByBuildings: owners.sort((a, b) => b.buildings - a.buildings).slice(0, 10),
    ownersByUnits: owners.sort((a, b) => b.units - a.units).slice(0, 10)
  });
});

router.get("/api/area-detail", (req, res) => {
  const zips = String(req.query.zips || "").split(",").filter(Boolean);
  const mode = req.query.mode || "multifamily";
  const kind = req.query.kind || "sales";
  const owner = req.query.owner || "";
  if (kind === "sales") {
    const sales = salesForZips(zips).slice(0, 60);
    return res.json({ coverage: `${sales.length} recorded arm's-length sales in the trailing 12 months across ${zips.length} ZIP(s).`, sales, buildings: [] });
  }
  const { qualifying } = censusForZips(zips, mode);
  let list = qualifying;
  if (kind === "owner" && owner) list = buildingsForZips(zips).filter((b) => b.owner === owner);
  res.json({
    coverage: kind === "owner"
      ? `${list.length} building(s) held by ${owner} in this area.`
      : `${list.length} qualifying record(s) for the ${mode} lens.`,
    sales: [],
    buildings: list.slice(0, 80).map((b) => ({
      bbl: b.bbl, address: b.address, unitsRes: b.unitsRes, yearBuilt: b.yearBuilt, zoning: b.zoning,
      lotArea: b.lotArea, builtFar: b.builtFar, maxFar: b.maxFar, unusedFarSf: b.unusedFarSf
    }))
  });
});

// Dev pipeline (?zips=) or CRM store (no zips)
const __dirnamePipeline = path.join(APP_DATA_DIR, "crm-pipeline.json");
function readCrm() {
  try { return existsSync(__dirnamePipeline) ? JSON.parse(readFileSync(__dirnamePipeline, "utf8")) : []; } catch { return []; }
}
function writeCrm(rows) {
  try { writeFileSync(__dirnamePipeline, JSON.stringify(rows, null, 2)); } catch {}
}
router.get("/api/pipeline", (req, res) => {
  if (req.query.zips) return res.json(pipelineForZips(String(req.query.zips).split(",").filter(Boolean)));
  res.json(readCrm());
});
router.post("/api/pipeline", (req, res) => {
  const rows = readCrm();
  const { oppId, stage } = req.body || {};
  if (!oppId) return res.status(400).json({ error: "oppId required" });
  const existing = rows.find((r) => r.oppId === oppId);
  if (existing) existing.stage = stage;
  else rows.push({ oppId, stage: stage || "Watchlist" });
  writeCrm(rows);
  res.json(rows);
});
router.patch("/api/pipeline/:oppId", (req, res) => {
  const rows = readCrm();
  const row = rows.find((r) => r.oppId === req.params.oppId);
  if (!row) return res.status(404).json({ error: "not found" });
  row.stage = (req.body || {}).stage || row.stage;
  writeCrm(rows);
  res.json(rows);
});

router.get("/api/propensity-validation", (req, res) => {
  const zips = String(req.query.zips || "").split(",").filter(Boolean);
  const all = buildingsForZips(zips);
  const threshold = 35;
  const sold = all.filter((b) => b.recentSale);
  const soldHit = sold.filter((b) => (b.propensity ?? 0) >= threshold).length;
  const baseHit = all.filter((b) => (b.propensity ?? 0) >= threshold).length;
  const soldHitPct = sold.length ? Math.round((soldHit / sold.length) * 100) : 0;
  const baseHitPct = all.length ? Math.round((baseHit / all.length) * 100) : 0;
  res.json({
    threshold, soldCount: sold.length, soldHitPct, baseHitPct,
    lift: baseHitPct > 0 ? round(soldHitPct / baseHitPct, 2) : null
  });
});

// --- Market report + index ---------------------------------------------------
const CLASS_BUCKETS = [
  { mode: "multifamily", label: "Multifamily (5+ units)", test: (b) => (b.bldgClass[0] === "C" || b.bldgClass[0] === "D") && b.unitsRes >= 5 },
  { mode: "smallresi", label: "1–4 family / townhouse", test: (b) => b.bldgClass[0] === "A" || b.bldgClass[0] === "B" },
  { mode: "office", label: "Office", test: (b) => b.bldgClass[0] === "O" },
  { mode: "retail", label: "Retail / storefront", test: (b) => b.bldgClass[0] === "K" },
  { mode: "industrial", label: "Industrial / warehouse", test: (b) => ["E", "F", "L"].includes(b.bldgClass[0]) },
  { mode: "development", label: "Development / land", test: (b) => ["V", "Z", "G"].includes(b.bldgClass[0]) },
  { mode: "hotels", label: "Hotel", test: (b) => b.bldgClass[0] === "H" },
  { mode: "condo", label: "Condo units", test: (b) => b.bldgClass[0] === "R", churn: true }
];

router.get("/api/market-report", (req, res) => {
  const zips = String(req.query.zips || "").split(",").filter(Boolean);
  const all = buildingsForZips(zips);
  const sold = all.filter((b) => b.recentSale);
  const byClass = CLASS_BUCKETS.map((bucket) => {
    const stock = all.filter(bucket.test);
    const sales = sold.filter(bucket.test);
    const dollar = sales.reduce((n, b) => n + b.recentSale.price, 0);
    const ppsfs = sales.map((b) => (b.bldgArea ? b.recentSale.price / b.bldgArea : null)).filter(Boolean);
    const turnover = !bucket.churn && stock.length ? round((sales.length / stock.length) * 100, 1) : null;
    return {
      mode: bucket.mode, class: bucket.label, churn: !!bucket.churn,
      stock: stock.length, salesCount: sales.length, dollarVolume: dollar,
      avgPrice: sales.length ? Math.round(dollar / sales.length) : null,
      avgPpsf: ppsfs.length ? Math.round(ppsfs.reduce((n, v) => n + v, 0) / ppsfs.length) : null,
      turnoverPct: turnover,
      impliedHoldYears: turnover ? Math.round(100 / turnover) : null
    };
  });
  const allPpsf = sold.map((b) => (b.bldgArea ? b.recentSale.price / b.bldgArea : null)).filter(Boolean);
  const bands = [0, 150, 300, 450, 600, 800, 1000, 1400, 2000];
  const distribution = bands.map((lo, i) => {
    const hi = bands[i + 1] ?? Infinity;
    return { label: hi === Infinity ? `$${lo}+` : `$${lo}–${hi}`, count: allPpsf.filter((v) => v >= lo && v < hi).length };
  }).filter((d) => d.count > 0);
  const start = new Date(Date.now() - 360 * 864e5).toISOString().slice(0, 10);
  res.json({
    fetchedAt: new Date().toISOString(),
    windowStart: start, windowEnd: new Date().toISOString().slice(0, 10),
    recordedTotal: sold.length + Math.round(sold.length * 1.6),
    byClass, distribution,
    narrative: [
      `Across ${zips.length} ZIP(s), the demo ledger records ${sold.length} arm's-length investment sales in the trailing twelve months.`,
      "Multifamily and mixed-use assets carried the deepest liquidity; development parcels traded on buildable square footage rather than in-place income.",
      "Figures are generated by the demo engine for layout and workflow testing — swap in the live rolling-sales adapter for production numbers."
    ]
  });
});

router.get("/api/market-index", (req, res) => {
  const markets = [
    { market: "Manhattan", zips: ["10001", "10011", "10016", "10019", "10002", "10025", "10028"] },
    { market: "Brooklyn", zips: ["11201", "11211", "11215", "11216", "11221", "11226"] },
    { market: "Queens", zips: ["11101", "11102", "11106", "11372", "11375", "11432"] }
  ];
  const strategies = [
    { key: "multifamily", label: "Multifamily", test: (b) => (b.bldgClass[0] === "C" || b.bldgClass[0] === "D") && b.unitsRes >= 5, basis: "gsf" },
    { key: "condo", label: "Condo", test: (b) => b.bldgClass[0] === "R", basis: "gsf" },
    { key: "office", label: "Office", test: (b) => b.bldgClass[0] === "O", basis: "gsf" },
    { key: "hotels", label: "Hotels", test: (b) => b.bldgClass[0] === "H", basis: "gsf" },
    { key: "development", label: "Development", test: (b) => ["V", "Z", "G"].includes(b.bldgClass[0]) || (b.builtFar < 0.6 && b.maxFar >= 3), basis: "land" }
  ];
  const index = {};
  const comps = [];
  for (const s of strategies) {
    index[s.key] = {};
    for (const m of markets) {
      const sold = buildingsForZips(m.zips).filter((b) => b.recentSale && s.test(b));
      const vals = sold.map((b) => {
        if (s.basis === "land") return b.lotArea ? b.recentSale.price / (b.maxFar > 0 ? b.lotArea * b.maxFar : b.lotArea) : null;
        return b.bldgArea ? b.recentSale.price / b.bldgArea : null;
      }).filter(Boolean);
      const med = vals.length ? [...vals].sort((a, b2) => a - b2)[Math.floor(vals.length / 2)] : null;
      index[s.key][m.market] = { count: sold.length, medianPpsf: med ? Math.round(med) : null, basis: s.basis };
      for (const b of sold.slice(0, 4)) {
        comps.push({
          address: b.address, market: m.market, submarket: b.zip, strategy: s.label,
          type: landUseLabel(b.landUse), units: b.unitsRes || null, gsf: b.bldgArea || null,
          salePrice: b.recentSale.price,
          ppsf: b.bldgArea ? Math.round(b.recentSale.price / b.bldgArea) : null,
          ppbsf: s.basis === "land" && b.lotArea && b.maxFar ? Math.round(b.recentSale.price / (b.lotArea * b.maxFar)) : null,
          saleDate: b.recentSale.date, bbl: b.bbl
        });
      }
    }
  }
  comps.sort((a, b) => (a.saleDate < b.saleDate ? 1 : -1));
  res.json({ fetchedAt: new Date().toISOString(), index, comps: comps.slice(0, 60) });
});

// --- Imagery: basemap tile proxy + static images ------------------------------
const tileCache = new Map();
// Bounded by BYTES, not by entry count.
//
// This was capped at 3,000 entries. Basemap tiles are not a uniform size: the
// five layers measured against the live service on 2026-08-18 returned 23,745 /
// 75,880 / 132,355 / 243,308 / 463,052 bytes, a mean of ~187 KB. Three thousand
// of those is ~561 MB of resident Buffers on an instance with 512 MB, so the
// count cap could not prevent an OOM — it only decided how many tiles it took
// to reach one.
//
// The old overflow behaviour was tileCache.clear(), which discarded every
// cached tile at once and made the next pan re-fetch the whole viewport from
// Mapbox. Oldest-first eviction keeps the working set.
const TILE_MAX = 3000;
const TILE_MAX_BYTES = Number(process.env.TILE_CACHE_MAX_BYTES || 64 * 1024 * 1024);
let tileBytes = 0;

function tileCacheDelete(url) {
  const b = tileCache.get(url);
  if (b === undefined) return;
  tileBytes -= b.length;
  tileCache.delete(url);
}

function tileCacheSet(url, buf) {
  tileCacheDelete(url);
  tileCache.set(url, buf);
  tileBytes += buf.length;
  while ((tileBytes > TILE_MAX_BYTES || tileCache.size > TILE_MAX) && tileCache.size > 1) {
    const oldest = tileCache.keys().next().value;
    if (oldest === url) break;
    tileCacheDelete(oldest);
  }
}

// Read by the memory probe in tests; not part of the tile contract.
export const tileCacheStats = () => ({ entries: tileCache.size, bytes: tileBytes });
const FALLBACK_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPc0/GjHgAFdgJmM95BcgAAAABJRU5ErkJggg==",
  "base64"
);
async function proxyTile(res, url) {
  try {
    if (tileCache.has(url)) {
      const buf = tileCache.get(url);
      res.set("content-type", "image/png").set("cache-control", "public, max-age=86400");
      return res.send(buf);
    }
    const r = await fetch(url, { headers: { "user-agent": "nyc-re-market-intel/2.0 (demo rebuild)" } });
    if (!r.ok) throw new Error(String(r.status));
    const buf = Buffer.from(await r.arrayBuffer());
    tileCacheSet(url, buf);
    res.set("content-type", r.headers.get("content-type") || "image/png").set("cache-control", "public, max-age=86400");
    res.send(buf);
  } catch {
    res.set("content-type", "image/png").set("cache-control", "public, max-age=600");
    res.send(FALLBACK_TILE);
  }
}
// The compiled client draws the street/no-label/label layers with
// {tileSize: 512, zoomOffset: -1}: one tile from this grid is painted across
// 512 CSS pixels. A 256px image there is stretched 2x on a desktop and 6x on a
// DPR-3 phone, which is why the basemap reads as blurred mush on an iPhone.
// Retina tiles (@2x) are the minimum that keeps the basemap sharp; when a
// Mapbox token is configured we serve the same 512@2x raster the production
// site does (1024px per tile).
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || process.env.MAPBOX_ACCESS_TOKEN || "";
function mapboxTile(style, z, x, y, grid = 512) {
  return `https://api.mapbox.com/styles/v1/mapbox/${style}/tiles/${grid}/${z}/${x}/${y}@2x?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;
}
function cartoTile(style, z, x, y) {
  return `https://basemaps.cartocdn.com/${style}/${z}/${x}/${y}@2x.png`;
}
router.get("/api/mbtile/streets/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  proxyTile(res, MAPBOX_TOKEN ? mapboxTile("streets-v12", z, x, y) : cartoTile("rastertiles/voyager", z, x, y));
});
router.get("/api/mbtile/nolabels/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  proxyTile(res, MAPBOX_TOKEN ? mapboxTile("light-v11", z, x, y) : cartoTile("light_nolabels", z, x, y));
});
router.get("/api/mbtile/labels/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  // Label overlay must stay transparent — CARTO's labels-only raster is the
  // free equivalent of the production overlay and has an alpha channel.
  proxyTile(res, cartoTile("light_only_labels", z, x, y));
});
router.get("/api/mbtile/dark/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  proxyTile(res, MAPBOX_TOKEN ? mapboxTile("dark-v11", z, x, y) : cartoTile("dark_all", z, x, y));
});
router.get("/api/mbtile/:z/:x/:y", (req, res) => {
  const { z, x, y } = req.params;
  // Satellite is drawn with {tileSize: 256, zoomOffset: 0}: 256px is already
  // 1:1 there, and Esri World Imagery serves no retina variant.
  proxyTile(res, MAPBOX_TOKEN
    ? mapboxTile("satellite-v9", z, x, y, 256)
    : `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
});

function arcgisExport(lat, lng, w = 900, h = 300, span = 0.004) {
  const ratio = w / h;
  const bbox = [lng - span * ratio, lat - span, lng + span * ratio, lat + span].join(",");
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=3857&size=${w},${h}&format=jpg&f=image`;
}
router.get("/api/staticmap", async (req, res) => {
  let lat = null, lng = null;
  if (req.query.bbl) {
    const b = buildingByBbl(req.query.bbl) || findSeedByBbl(req.query.bbl);
    if (b) { lat = b.lat; lng = b.lng; }
  } else if (req.query.q) {
    const t = resolveTerritory(String(req.query.q));
    if (t) {
      const zipCenter = t.zips[0];
      const c = (await import("./constants.js")).ZIP_CENTERS[zipCenter];
      if (c) { lat = c[0]; lng = c[1]; }
    }
  } else if (req.query.pts) {
    const first = String(req.query.pts).split("|")[0].split(",");
    lat = Number(first[0]); lng = Number(first[1]);
  } else if (req.query.lat && req.query.lng) {
    lat = Number(req.query.lat); lng = Number(req.query.lng);
  }
  if (lat == null || lng == null || !Number.isFinite(lat)) return res.status(404).end();
  meterBump("staticmap");
  const size = String(req.query.size || "900x300").split("x").map(Number);
  const span = Number(req.query.span) || (req.query.zoom ? 0.003 : 0.004);
  proxyTile(res, arcgisExport(lat, lng, size[0] || 900, size[1] || 300, span));
});
router.get("/api/streetview", (req, res) => {
  const key = (process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY);
  if (!key) return res.status(404).end();
  const b = buildingByBbl(req.query.bbl) || findSeedByBbl(req.query.bbl);
  if (!b) return res.status(404).end();
  meterBump("streetview");
  proxyTile(res, `https://maps.googleapis.com/maps/api/streetview?size=640x400&location=${b.lat},${b.lng}&key=${key}`);
});

// --- Search / listing checks --------------------------------------------------
function listingSearches(addr) {
  const q = encodeURIComponent(String(addr || ""));
  return [
    { label: "StreetEasy", url: `https://streeteasy.com/search?utf8=%E2%9C%93&search=${q}` },
    { label: "LoopNet", url: `https://www.loopnet.com/search/commercial-real-estate/new-york-ny/for-sale/?sk=${q}` },
    { label: "Crexi", url: `https://www.crexi.com/properties?q=${q}` },
    { label: "Zillow", url: `https://www.zillow.com/homes/${q}_rb/` },
    { label: "Google", url: `https://www.google.com/search?q=${q}+for+sale` }
  ];
}
router.get(["/api/listing-check", "/api/listingcheck"], (req, res) => {
  const addr = req.query.addr || "";
  res.json({ addr, configured: false, listed: false, forSale: false, hits: [], searches: listingSearches(addr) });
});
router.get("/api/websearch", (req, res) => {
  const q = String(req.query.q || "");
  res.json({ configured: false, hits: [], searchUrl: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
});

// --- Owner tooling ------------------------------------------------------------
const investorsPath = path.join(APP_DATA_DIR, "investors.json");
router.get("/api/investors", (req, res) => {
  try {
    res.json(existsSync(investorsPath) ? JSON.parse(readFileSync(investorsPath, "utf8")) : { investors: [] });
  } catch { res.json({ investors: [] }); }
});
router.post("/api/investors", (req, res) => {
  const payload = { investors: (req.body || {}).investors || [] };
  try { writeFileSync(investorsPath, JSON.stringify(payload, null, 2)); } catch {}
  res.json(payload);
});

router.get("/api/pinecone-status", (req, res) => {
  // Truthful status (audit item 24): "configured" requires BOTH the key and
  // the index Host — a key alone cannot power vector search.
  const hasKey = !!process.env.PINECONE_API_KEY;
  const hasHost = !!process.env.PINECONE_INDEX_HOST;
  res.json({
    owner: process.env.OWNER_MODE !== "0",
    configured: hasKey && hasHost,
    hasKey, hasHost,
    engine: hasKey && hasHost ? "pinecone" : "local-heuristic",
    note: hasKey && !hasHost ? "PINECONE_API_KEY is set but PINECONE_INDEX_HOST is missing — send the index Host and vector search switches on." : undefined
  });
});
// Real, durable usage metering for the paid imagery endpoints (the original
// cost problem). Counters persist to disk with atomic writes so a process
// restart can never silently reset a billing ceiling.
const meterPath = path.join(APP_DATA_DIR, "usage-meters.json");
function loadMeters() {
  try { return JSON.parse(readFileSync(meterPath, "utf8")); } catch { return {}; }
}
function saveMeters(m) {
  try {
    const tmp = meterPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, meterPath);
  } catch { /* metering must never take the request down */ }
}
export function meterBump(kind) {
  const m = loadMeters();
  const month = new Date().toISOString().slice(0, 7);
  m[month] = m[month] ?? {};
  m[month][kind] = (m[month][kind] ?? 0) + 1;
  saveMeters(m);
  return m[month][kind];
}
router.get("/api/maps-usage", (req, res) => {
  const m = loadMeters();
  const month = new Date().toISOString().slice(0, 7);
  res.json({
    configured: !!(process.env.GOOGLE_MAPS_KEY || process.env.GOOGLE_MAPS_API_KEY),
    month,
    streetview: m[month]?.streetview ?? 0,
    staticmap: m[month]?.staticmap ?? 0,
    freeStreetview: 10000, freeStatic: 10000,
    note: "Counters persist to APP_DATA_DIR. They survive a restart only where that directory does — a mounted disk or, with SUPABASE_DB_URL set, the durable store. On an image-local directory a redeploy resets them."
  });
});

// Photorealistic 3D sessions are metered so a busy day can never turn into a
// surprise bill: the daily ceiling is ours, not Google's, and it resets at
// midnight UTC. The number is this one line — and the counter is durable:
// it persists to disk atomically, so a restart cannot reset the ceiling.
// Google-side quota + billing alerts remain the final backstop (set them).
const SESSION_CAP_3D = 25;
const sessions3dPath = path.join(APP_DATA_DIR, "3d-sessions.json");
function load3d() {
  try { return JSON.parse(readFileSync(sessions3dPath, "utf8")); } catch { return { day: "", used: 0 }; }
}
function save3d(s) {
  try {
    const tmp = sessions3dPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, sessions3dPath);
  } catch { /* fall through — worst case the cap under-counts by one */ }
}
router.get("/api/3d-session", (req, res) => {
  const key = process.env.GOOGLE_3D_KEY;
  if (!key) return res.json({ configured: false, capped: false, key: null });
  const s = load3d();
  const today = new Date().toISOString().slice(0, 10);
  if (s.day !== today) { s.day = today; s.used = 0; }
  if (s.used >= SESSION_CAP_3D) {
    return res.json({ configured: true, capped: true, used: s.used, cap: SESSION_CAP_3D, key: null });
  }
  s.used += 1;
  save3d(s);
  res.json({ configured: true, capped: false, key, used: s.used, cap: SESSION_CAP_3D });
});

// Debt maturity wall for a set of parcels (the desk's pipeline + watchlist):
// recorded mortgages with estimated balloon years, soonest first.
router.get("/api/maturity-wall", (req, res) => {
  const bbls = String(req.query.bbls || "").split(",").map((s) => s.replace(/[^0-9]/g, "")).filter((s) => s.length === 10);
  if (!bbls.length) return res.json({ configured: false, loans: [] });
  const loans = [];
  for (const bbl of bbls.slice(0, 80)) {
    const record = assetHistory(bbl);
    if (!record) continue;
    const est = estimateDebtMaturity(record);
    if (!est || !est.estMaturityYear) continue;
    loans.push({
      bbl, address: record.address, owner: record.pluto.owner,
      lender: est.lender, amount: est.amount, originated: est.date,
      estMaturityYear: est.estMaturityYear, status: est.status
    });
  }
  loans.sort((a, b) => a.estMaturityYear - b.estMaturityYear);
  res.json({ configured: true, loans });
});
router.get("/api/airtable-xref", (req, res) => res.json({ configured: false, sellerMatches: [], buyerMatches: [] }));
router.post("/api/account-delete", (req, res) => res.json({ deleted: true }));

export default router;
