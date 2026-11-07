// The demo city model. A deterministic, seeded universe of ~40k synthetic tax
// lots across every covered ZIP: the same BBL always resolves to the same
// building with the same owner, sales chain, debt, permits and geometry — so
// the map grid, area inventory, dossier, reports and radar all agree.
//
// Swapping this module for live NYC Open Data adapters (PLUTO / ACRIS / DOB /
// rolling sales via Socrata) is the intended production path; the response
// shapes already match.

import {
  rngFor, pick, pickSome, clamp, round, tileToLngLat, haversineFt, bearingDeg
} from "./util.js";
import {
  ZIPS_MANHATTAN, ZIPS_BROOKLYN, ZIPS_QUEENS, ZIPS_BRONX, ZIPS_SI,
  ZIP_CENTERS, BOROUGH_BY_ZIP, BORO_CODE, STREETS, OWNER_FIRSTS, OWNER_LASTS,
  ENTITY_STEMS, ENTITY_SUFFIXES, LENDERS, ZONES_RES, ZONES_COM, ZONES_MFG,
  MAX_FAR_BY_ZONE, BLDG_CLASS_POOL, LAND_USE_BY_CLASS
} from "./constants.js";
import { computePropensity, computeDistressFromRecord } from "./scoring.js";
import { SEED_PARCELS, BOROUGH_BY_NEIGHBORHOOD } from "./seed-parcels.js";
import { assertSyntheticAllowed } from "./synthetic-guard.js";

const ZIPS_BY_BORO = {
  Manhattan: ZIPS_MANHATTAN, Brooklyn: ZIPS_BROOKLYN, Queens: ZIPS_QUEENS,
  Bronx: ZIPS_BRONX, "Staten Island": ZIPS_SI
};
export const ALL_ZIPS = Object.keys(ZIP_CENTERS);

// Each ZIP owns a distinct block range so a BBL round-trips to its ZIP.
const BLOCK_SPAN = 40;
const BLOCK_BASE = 100;
function blockBaseForZip(zip) {
  const boro = BOROUGH_BY_ZIP[zip];
  const idx = ZIPS_BY_BORO[boro].indexOf(zip);
  return BLOCK_BASE + idx * BLOCK_SPAN;
}
function zipForBlock(boroCode, block) {
  const boro = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" }[boroCode];
  if (!boro) return null;
  const idx = Math.floor((block - BLOCK_BASE) / BLOCK_SPAN);
  const list = ZIPS_BY_BORO[boro];
  return idx >= 0 && idx < list.length ? list[idx] : null;
}

const NOW = new Date("2026-08-12T00:00:00Z");
const THIS_YEAR = NOW.getUTCFullYear();

// ---------------------------------------------------------------------------
// Building generator (per ZIP, cached)
// ---------------------------------------------------------------------------
const zipCache = new Map();
const bblIndex = new Map();

function ownerFor(rng, boro) {
  const roll = rng();
  if (roll < 0.34) return `${pick(rng, OWNER_LASTS)}, ${pick(rng, OWNER_FIRSTS)}`;
  if (roll < 0.40) return `${pick(rng, OWNER_LASTS)} FAMILY TRUST`;
  if (roll < 0.44) return `${pick(rng, OWNER_LASTS)} ${pick(rng, OWNER_FIRSTS)} ESTATE OF`;
  if (roll < 0.47) return `${boro.toUpperCase().slice(0, 4)} OWNERS CORP`;
  return `${pick(rng, ENTITY_STEMS)} ${pick(rng, ENTITY_SUFFIXES)}`;
}

function buildBuilding(zip, i) {
  const boro = BOROUGH_BY_ZIP[zip];
  const boroCode = BORO_CODE[boro];
  const base = blockBaseForZip(zip);
  const streets = STREETS[boro];
  const rng = rngFor(`bldg:${zip}:${i}`);

  const streetIdx = i % streets.length;
  const block = base + streetIdx + Math.floor(i / streets.length) % BLOCK_SPAN;
  const lot = 1 + (i % 79);
  const bbl = `${boroCode}${String(block).padStart(5, "0")}${String(lot).padStart(4, "0")}`;

  const [clat, clng] = ZIP_CENTERS[zip];
  // Lay lots along pseudo-streets: each street is a rotated line through the
  // zip centroid; buildings step along it.
  const angle = (streetIdx / streets.length) * Math.PI + (rngFor(`street:${zip}:${streetIdx}`)() - 0.5) * 0.6;
  const along = ((i / streets.length) % BLOCK_SPAN) / BLOCK_SPAN - 0.5;
  const cross = (rng() - 0.5) * 0.004;
  const lat = clat + Math.sin(angle) * along * 0.017 + Math.cos(angle) * cross;
  const lng = clng + (Math.cos(angle) * along * 0.022 - Math.sin(angle) * cross) / Math.cos((clat * Math.PI) / 180) * 0.78;

  const bldgClass = pick(rng, BLDG_CLASS_POOL);
  const c0 = bldgClass[0];
  const landUse = LAND_USE_BY_CLASS(bldgClass);
  const zoning = c0 === "M" || c0 === "E" || c0 === "F" || c0 === "L"
    ? pick(rng, ZONES_MFG)
    : c0 === "O" || c0 === "K" || c0 === "H"
      ? pick(rng, ZONES_COM)
      : rng() < 0.72 ? pick(rng, ZONES_RES) : pick(rng, ZONES_COM);
  const maxFar = MAX_FAR_BY_ZONE[zoning] ?? 2;
  const boroFarBias = boro === "Manhattan" ? 0.85 : boro === "Brooklyn" ? 0.62 : 0.55;
  const builtFar = c0 === "V" || c0 === "Z" || c0 === "G"
    ? round(rng() * 0.3, 2)
    : round(maxFar * clamp(boroFarBias + (rng() - 0.5) * 0.7, 0.08, 1.15), 2);

  const lotFront = Math.round(18 + rng() * 60);
  const lotDepth = Math.round(80 + rng() * 60);
  const lotArea = lotFront * lotDepth;
  const bldgArea = Math.round(lotArea * builtFar);
  const numFloors = Math.max(1, Math.round(builtFar / 0.82));
  const yearBuilt = c0 === "V" || c0 === "Z" ? 0 : Math.round(1890 + rng() * 125);
  const yearAltered = yearBuilt && rng() < 0.3 ? Math.min(THIS_YEAR - 1, yearBuilt + 20 + Math.round(rng() * 70)) : 0;

  const resShare = landUse === "01" || landUse === "02" || landUse === "03" ? 0.92 : landUse === "04" ? 0.6 : 0;
  const resArea = Math.round(bldgArea * resShare);
  const comArea = bldgArea - resArea;
  const officeArea = c0 === "O" ? Math.round(comArea * 0.85) : Math.round(comArea * 0.2 * rng());
  const retailArea = Math.round(comArea * 0.25 * rng());
  const unitSize = 700 + rng() * 450;
  const unitsRes = resArea > 0 ? Math.max(landUse === "01" ? 1 : 2, Math.round(resArea / unitSize)) : 0;
  const unitsTotal = unitsRes + (comArea > 2000 ? 1 + Math.floor(rng() * 4) : 0);

  const residFar = /^R|^C[12456]/.test(zoning) ? maxFar : 0;
  const commFar = /^C|^M/.test(zoning) ? maxFar : 0;
  const facilFar = round(maxFar * 1.2, 2);
  const unusedFar = round(Math.max(0, maxFar - builtFar), 2);
  const unusedFarSf = Math.round(unusedFar * lotArea);

  const boroValue = { Manhattan: 720, Brooklyn: 420, Queens: 330, Bronx: 240, "Staten Island": 230 }[boro];
  const marketValue = Math.round((bldgArea || lotArea * 0.9) * boroValue * (0.75 + rng() * 0.6));
  const assessTotal = Math.round(marketValue * 0.45);
  const landHeavy = builtFar < maxFar * 0.4 || c0 === "V" || c0 === "G";
  const assessLand = Math.round(assessTotal * (landHeavy ? 0.72 + rng() * 0.2 : 0.25 + rng() * 0.25));

  const owner = ownerFor(rng, boro);
  const permitCount = rng() < 0.55 ? 0 : Math.ceil(rng() * 6);
  // ~30% of owners mail somewhere other than the property — the absentee flag.
  const mailAddress = rng() < 0.3
    ? `${100 + Math.floor(rng() * 8000)} ${pick(rng, ["NORTHERN BLVD","MADISON AVE","FLATBUSH AVE","QUEENS BLVD","BROADWAY","OCEAN PKWY","MAIN ST"])}, ${pick(rng, ["GREAT NECK, NY","BROOKLYN, NY","NEW YORK, NY","FLUSHING, NY","LAKEWOOD, NJ","MONSEY, NY","MIAMI, FL"])}`
    : "";

  const houseNo = 1 + Math.floor(rng() * 320) * 2 + streetIdx;
  const address = `${houseNo} ${streets[streetIdx]}`;

  const specialDistrict = rng() < 0.08 ? pick(rng, ["Special Downtown Brooklyn","Special Midtown","Hudson Square","Special LIC Mixed Use","Gowanus MX"]) : "";
  const overlay = rng() < 0.2 ? pick(rng, ["C1-3","C1-4","C2-3","C2-4"]) : "";

  const landmark = rng() < 0.03;
  const histDist = !landmark && rng() < 0.05 ? pick(rng, ["Clinton Hill HD","Greenpoint HD","SoHo-Cast Iron HD","Park Slope HD"]) : "";
  const eDesig = rng() < 0.06;
  const splitZone = rng() < 0.05;
  const ltdHeight = rng() < 0.02 ? "LH-1A" : "";

  const b = {
    bbl, address, borough: boro, block, lot, zip, lat: round(lat, 6), lng: round(lng, 6),
    bin: c0 === "V" || c0 === "Z" ? "" : `${boroCode}${String(100000 + ((block * 97 + lot * 13) % 899999)).padStart(6, "0")}`,
    bldgClass, landUse, zoning, overlay, specialDistrict,
    lotArea, bldgArea, resArea, comArea, officeArea, retailArea,
    numBldgs: 1, numFloors, unitsRes, unitsTotal, yearBuilt, yearAltered,
    builtFar, residFar, commFar, facilFar, maxFar, unusedFar, unusedFarSf,
    assessLand, assessTotal, marketValue, lotFront, lotDepth, permitCount, owner, mailAddress,
    landmark, histDist, eDesig, splitZone, ltdHeight
  };

  // Dev score: same shape as the curated model — density, basis, age, signals.
  const density = maxFar > 0 ? clamp((maxFar - builtFar) / maxFar, 0, 1) : 0;
  const scale = clamp(unusedFarSf / 120000, 0, 1);
  const age = yearBuilt ? clamp((THIS_YEAR - yearBuilt) / 120, 0, 1) : 0.5;
  const landShare = assessTotal ? assessLand / assessTotal : 0.3;
  b.score = Math.round(clamp(22 * (0.6 * density + 0.4 * scale) + 16 * age + 14 * clamp(landShare, 0, 1) + 18 * (boro === "Manhattan" ? 0.9 : boro === "Brooklyn" ? 0.75 : 0.6) + 10 * (permitCount ? 0.3 : 0.6) + 12 * rng(), 5, 99));

  const prop = computePropensity(b);
  b.propensity = prop.score;
  b.propensityWhy = prop.components.slice(0, 2).map((c) => c.label).join(" · ");

  // Recent-sale flag drives area sales aggregates + rolling-sales evidence.
  const sold = rngFor(`sold:${bbl}`)();
  if (sold < 0.045) {
    const daysAgo = Math.floor(rngFor(`solddate:${bbl}`)() * 360);
    const d = new Date(NOW.getTime() - daysAgo * 864e5);
    b.recentSale = {
      date: d.toISOString().slice(0, 10),
      price: Math.round(marketValue * (0.85 + rngFor(`soldpx:${bbl}`)() * 0.45))
    };
  }
  return b;
}

export function buildingsForZip(zip) {
  assertSyntheticAllowed("server/citymodel.js");
  if (!ZIP_CENTERS[zip]) return [];
  if (zipCache.has(zip)) return zipCache.get(zip);
  const rng = rngFor(`zipcount:${zip}`);
  const count = 190 + Math.floor(rng() * 130);
  const list = [];
  for (let i = 0; i < count; i++) {
    const b = buildBuilding(zip, i);
    list.push(b);
    bblIndex.set(b.bbl, b);
  }
  zipCache.set(zip, list);
  return list;
}

// Curated seed parcels carry real NYC BBLs that sit outside (or collide with)
// the synthetic block ranges, so they resolve first and get full building
// records of their own — the dossier, sales chain, distress and reports all
// work for them exactly like any grid lot.
const seedBuilt = new Map();
let seedParcelIdx = null;
function seedBuildingByDigits(digits) {
  if (seedBuilt.has(digits)) return seedBuilt.get(digits);
  if (!seedParcelIdx) seedParcelIdx = new Map(SEED_PARCELS.map((p) => [p.bbl.replace(/[^0-9]/g, ""), p]));
  const p = seedParcelIdx.get(digits);
  if (!p) return null;
  const b = seedToRecord(p, digits);
  seedBuilt.set(digits, b);
  return b;
}

function nearestZip(lat, lng) {
  let best = null, bd = Infinity;
  for (const z of ALL_ZIPS) {
    const d = haversineFt(lat, lng, ZIP_CENTERS[z][0], ZIP_CENTERS[z][1]);
    if (d < bd) { bd = d; best = z; }
  }
  return best;
}

function seedToRecord(p, digits) {
  const rng = rngFor(`seedb:${digits}`);
  const boro = BOROUGH_BY_NEIGHBORHOOD[p.neighborhood] || "Manhattan";
  const zip = nearestZip(p.lat, p.lng);
  const bldgClass = p.adaptiveReuse
    ? "O5"
    : p.far < 0.6
      ? (/parking|taxpayer|surface/i.test(p.landUse || "") ? "G7" : "V1")
      : p.category === "Multifamily Candidate" || p.category === "Active Construction"
        ? (p.floors >= 7 ? "D1" : "C7")
        : p.far < p.maxFar * 0.5 ? "K4" : "O6";
  const landUse = LAND_USE_BY_CLASS(bldgClass);
  const lotArea = p.lotSf, bldgArea = p.bldgSf;
  const resShare = landUse === "02" || landUse === "03" ? 0.9 : landUse === "04" ? 0.55 : 0;
  const resArea = Math.round(bldgArea * resShare);
  const comArea = bldgArea - resArea;
  const unitsRes = resArea ? Math.max(2, Math.round(resArea / (750 + rng() * 350))) : 0;
  const boroValue = { Manhattan: 720, Brooklyn: 420, Queens: 330, Bronx: 240, "Staten Island": 230 }[boro];
  const marketValue = Math.round((bldgArea || lotArea * 0.9) * boroValue * (0.85 + rng() * 0.4));
  const assessTotal = Math.round(marketValue * 0.45);
  const landHeavy = p.far < p.maxFar * 0.4;
  const assessLand = Math.round(assessTotal * (landHeavy ? 0.78 : 0.3 + rng() * 0.2));
  const unusedFar = round(Math.max(0, p.maxFar - p.far), 2);
  const b = {
    bbl: digits, address: p.address, borough: boro, block: p.block, lot: p.lot, zip,
    lat: p.lat, lng: p.lng, bin: p.bin && p.bin !== "0000000" ? p.bin : "",
    bldgClass, landUse, zoning: p.zoning, overlay: "", specialDistrict: "",
    lotArea, bldgArea, resArea, comArea,
    officeArea: bldgClass[0] === "O" ? Math.round(comArea * 0.85) : 0,
    retailArea: Math.round(comArea * 0.15),
    numBldgs: 1, numFloors: p.floors || 1, unitsRes,
    unitsTotal: unitsRes + (comArea > 2000 ? 1 : 0),
    yearBuilt: p.yearBuilt || 0, yearAltered: 0,
    builtFar: p.far,
    residFar: /^R|^C[12456]|MX|MIH/.test(p.zoning) ? p.maxFar : 0,
    commFar: /^C|^M/.test(p.zoning) ? p.maxFar : 0,
    facilFar: round(p.maxFar * 1.2, 2),
    maxFar: p.maxFar, unusedFar,
    unusedFarSf: p.unbuiltFarSf ?? Math.round(unusedFar * lotArea),
    assessLand, assessTotal, marketValue,
    lotFront: Math.max(18, Math.round(lotArea / 100)), lotDepth: 100,
    permitCount: p.category === "Active Construction" ? 4 : Math.floor(rng() * 3),
    owner: p.owner, mailAddress: "", landmark: false, histDist: "",
    eDesig: /environmental|remediation/i.test((p.riskFlags || []).join(" ")),
    splitZone: false, ltdHeight: "",
    score: p.opportunityScore, seedId: p.id
  };
  const prop = computePropensity(b);
  b.propensity = prop.score;
  b.propensityWhy = prop.components.slice(0, 2).map((c) => c.label).join(" · ");
  const sold = rngFor(`sold:${digits}`)();
  if (p.category === "On-Market Signal" || sold < 0.045) {
    const daysAgo = Math.floor(rngFor(`solddate:${digits}`)() * 360);
    const d = new Date(NOW.getTime() - daysAgo * 864e5);
    b.recentSale = { date: d.toISOString().slice(0, 10), price: Math.round(marketValue * (0.85 + rngFor(`soldpx:${digits}`)() * 0.45)) };
  }
  return b;
}

export function buildingByBbl(bbl) {
  assertSyntheticAllowed("server/citymodel.js");
  const digits = String(bbl || "").replace(/[^0-9]/g, "");
  if (digits.length !== 10) return null;
  const seeded = seedBuildingByDigits(digits);
  if (seeded) return seeded;
  if (bblIndex.has(digits)) return bblIndex.get(digits);
  const boroCode = digits[0];
  const block = parseInt(digits.slice(1, 6), 10);
  const zip = zipForBlock(Number(boroCode), block);
  if (!zip) return null;
  buildingsForZip(zip);
  return bblIndex.get(digits) || null;
}

export function allBuildingsNear(lat, lng, radiusZips = 2) {
  assertSyntheticAllowed("server/citymodel.js");
  // ZIPs whose centroid is within ~2.5km of the point.
  const near = ALL_ZIPS
    .map((z) => ({ z, d: haversineFt(lat, lng, ZIP_CENTERS[z][0], ZIP_CENTERS[z][1]) }))
    .filter((x) => x.d < 9000 * radiusZips)
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  return near.flatMap((x) => buildingsForZip(x.z));
}

// ---------------------------------------------------------------------------
// Geometry: lot + building footprints derived from the point universe
// ---------------------------------------------------------------------------
function rectAround(lat, lng, wFt, dFt, angleRad) {
  const latFt = 364000, lngFt = 288200; // ft per degree at NYC latitude
  const w = wFt / 2, d = dFt / 2;
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  const pts = [[-w, -d], [w, -d], [w, d], [-w, d], [-w, -d]].map(([x, y]) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return [round(lng + rx / lngFt, 6), round(lat + ry / latFt, 6)];
  });
  return [pts];
}

export function lotFeaturesForTile(z, x, y) {
  assertSyntheticAllowed("server/citymodel.js");
  const a = tileToLngLat(x, y, z);
  const b = tileToLngLat(x + 1, y + 1, z);
  const minLng = Math.min(a.lng, b.lng), maxLng = Math.max(a.lng, b.lng);
  const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat);
  const cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
  const feats = [];
  for (const bl of allBuildingsNear(cLat, cLng)) {
    if (bl.lat < minLat || bl.lat > maxLat || bl.lng < minLng || bl.lng > maxLng) continue;
    const angle = rngFor(`ang:${bl.bbl}`)() * Math.PI;
    feats.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: rectAround(bl.lat, bl.lng, bl.lotFront, bl.lotDepth, angle) },
      properties: {
        bbl: bl.bbl, address: bl.address, owner: bl.owner, bldgClass: bl.bldgClass,
        zoning: bl.zoning, units: bl.unitsTotal, unitsRes: bl.unitsRes,
        yearBuilt: bl.yearBuilt || undefined, landUse: bl.landUse,
        lotArea: bl.lotArea, bldgArea: bl.bldgArea, builtFar: bl.builtFar,
        maxResidFar: bl.residFar || undefined, maxCommFar: bl.commFar || undefined,
        maxFacilFar: bl.facilFar || undefined, floors: bl.numFloors,
        assessedTotal: bl.assessTotal,
        landmark: bl.landmark || undefined, histDist: bl.histDist || undefined,
        eDesig: bl.eDesig || undefined, splitZone: bl.splitZone || undefined,
        ltdHeight: bl.ltdHeight || undefined
      }
    });
  }
  return { type: "FeatureCollection", features: feats };
}

export function bldgFeaturesForTile(z, x, y) {
  assertSyntheticAllowed("server/citymodel.js");
  const lots = lotFeaturesForTile(z, x, y);
  return {
    type: "FeatureCollection",
    features: lots.features
      .filter((f) => (f.properties.bldgArea || 0) > 0)
      .map((f) => {
        const bl = bblIndex.get(f.properties.bbl);
        const angle = rngFor(`ang:${bl.bbl}`)() * Math.PI;
        return {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: rectAround(bl.lat, bl.lng, bl.lotFront * 0.85, bl.lotDepth * 0.7, angle)
          },
          properties: { bbl: bl.bbl, h: Math.max(4, bl.numFloors * 3.3), lu: bl.landUse, addr: bl.address }
        };
      })
  };
}

// ---------------------------------------------------------------------------
// Per-parcel record: sales chain, loans, permits, comps, assessment
// ---------------------------------------------------------------------------
function dateYearsAgo(rngv, minY, maxY) {
  const yearsAgo = minY + rngv * (maxY - minY);
  const d = new Date(NOW.getTime() - yearsAgo * 365.25 * 864e5);
  return d.toISOString().slice(0, 10);
}

export function assetHistory(bbl) {
  assertSyntheticAllowed("server/citymodel.js");
  const b = buildingByBbl(bbl);
  if (!b) return null;
  const rng = rngFor(`hist:${b.bbl}`);
  const deedCount = 1 + Math.floor(rng() * 4);
  const sales = [];
  let holdBase = b.recentSale ? 0.2 : 2 + rng() * 22;
  let px = b.recentSale ? b.recentSale.price : Math.round(b.marketValue * (0.5 + rng() * 0.4));
  let curOwner = b.owner;
  for (let i = 0; i < deedCount; i++) {
    const date = i === 0 && b.recentSale ? b.recentSale.date : dateYearsAgo(rng(), holdBase, holdBase + 9);
    const prior = ownerFor(rngFor(`prior:${b.bbl}:${i}`), b.borough);
    sales.push({
      date, amount: i === 0 ? px : Math.round(px * (0.45 + rng() * 0.4)),
      grantor: prior, grantee: curOwner,
      docId: `FT_${b.bbl}${i}`
    });
    curOwner = prior;
    holdBase += 6 + rng() * 12;
    px = Math.round(px * (0.5 + rng() * 0.35));
  }
  const loans = [];
  if (rng() < 0.72 && sales.length) {
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const sale = sales[Math.min(i, sales.length - 1)];
      loans.push({
        date: sale.date,
        amount: Math.round((sale.amount || b.marketValue * 0.6) * (0.55 + rng() * 0.2)),
        docType: i === 0 && rng() < 0.85 ? "MORTGAGE" : pick(rng, ["MORTGAGE","AGREEMENT","ASSIGNMENT, MORTGAGE"]),
        lender: pick(rng, LENDERS),
        docId: `FT_M_${b.bbl}${i}`
      });
    }
    if (rng() < 0.25) {
      loans.push({ date: dateYearsAgo(rng(), 0.5, 4), amount: 0, docType: "SATISFACTION OF MORTGAGE", lender: loans[0].lender, docId: `FT_S_${b.bbl}` });
    }
  }
  const permits = [];
  for (let i = 0; i < b.permitCount; i++) {
    const pr = rngFor(`permit:${b.bbl}:${i}`);
    permits.push({
      date: dateYearsAgo(pr(), 0.1, 12),
      type: pick(pr, ["ALT2 — renovation","ALT1 — major alteration","NB — new building","DM — demolition","EW — equipment work","PL — plumbing"]),
      status: pick(pr, ["ISSUED","APPROVED","IN PROCESS","SIGNED OFF"]),
      applicant: `${pick(pr, OWNER_LASTS)} ${pick(pr, ["ENGINEERING PC","ARCHITECT PLLC","CONSULTING PE","DESIGN GROUP"])}`,
      phone: null, // demo engine never fabricates a phone number (data honesty)
      business: `${pick(pr, ENTITY_STEMS)} ${pick(pr, ["CONTRACTING CORP","BUILDERS LLC","CONSTRUCTION INC"])}`
    });
  }
  permits.sort((a, z2) => (a.date < z2.date ? 1 : -1));

  const comps = buildingsForZip(b.zip)
    .filter((x) => x.bbl !== b.bbl && x.recentSale && x.bldgClass[0] === b.bldgClass[0])
    .slice(0, 8)
    .map((x) => ({
      date: x.recentSale.date, address: x.address, bldgClass: x.bldgClass,
      price: x.recentSale.price,
      ppsf: x.bldgArea ? Math.round(x.recentSale.price / x.bldgArea) : null,
      bbl: x.bbl
    }));

  const competitiveSet = buildingsForZip(b.zip)
    .filter((x) => x.bbl !== b.bbl && x.bldgClass[0] === b.bldgClass[0])
    .map((x) => ({ ...x, distFt: haversineFt(b.lat, b.lng, x.lat, x.lng) }))
    .sort((a, z2) => a.distFt - z2.distFt)
    .slice(0, 5)
    .map((x) => ({
      address: x.address, distanceMi: round(x.distFt / 5280, 2), yearBuilt: x.yearBuilt,
      yearAlter1: x.yearAltered || null, numFloors: x.numFloors, bldgArea: x.bldgArea,
      units: x.unitsTotal, lat: x.lat, lng: x.lng, bbl: x.bbl
    }));

  const last = sales[0];
  const metrics = last
    ? {
        lastSalePrice: last.amount || null,
        lastSaleDate: last.date,
        lastSalePpsf: last.amount && b.bldgArea ? Math.round(last.amount / b.bldgArea) : null,
        holdYears: Math.max(0, Math.round((NOW - new Date(last.date)) / (365.25 * 864e5)))
      }
    : { lastSalePrice: null, lastSaleDate: null, lastSalePpsf: null, holdYears: null };

  return {
    bbl: b.bbl,
    address: b.address,
    pluto: {
      zip: b.zip, owner: b.owner, mailAddress: b.mailAddress || null, zoning: b.zoning, bldgClass: b.bldgClass,
      landUse: landUseLabel(b.landUse), yearBuilt: b.yearBuilt || null,
      yearAlter1: b.yearAltered || null, yearAlter2: null,
      unitsRes: b.unitsRes, unitsTotal: b.unitsTotal, lotArea: b.lotArea,
      bldgArea: b.bldgArea, builtFar: b.builtFar, maxFar: b.maxFar,
      numFloors: b.numFloors, lat: b.lat, lng: b.lng, neighborhood: null
    },
    metrics, sales, loans, permits, comps, competitiveSet,
    assessment: {
      assessTotal: b.assessTotal, assessLand: b.assessLand,
      assessImprovements: b.assessTotal - b.assessLand,
      exemptTotal: Math.round(b.assessTotal * (rngFor(`ex:${b.bbl}`)() < 0.2 ? 0.1 : 0))
    },
    signals: distressSignals(b),
    building: b
  };
}

export function landUseLabel(code) {
  return {
    "01": "1–2 Family", "02": "Multifamily Walk-up", "03": "Multifamily Elevator",
    "04": "Mixed Resi/Commercial", "05": "Commercial / Office", "06": "Industrial / Manufacturing",
    "07": "Transportation / Utility", "08": "Public Facility / Institution",
    "09": "Open Space / Recreation", 10: "Parking Facility", 11: "Vacant Land"
  }[code] ?? code;
}

export function distressSignals(b) {
  const rng = rngFor(`distress:${b.bbl}`);
  const stressed = rng() < 0.2;
  const hpdOpen = b.unitsRes >= 3 ? Math.floor(rng() * (stressed ? 80 : 12)) : 0;
  const dob = Math.floor(rng() * (stressed ? 40 : 8));
  return {
    hpdViolations: hpdOpen,
    dobViolations: dob,
    hpd: { open: hpdOpen, total: hpdOpen + Math.floor(rng() * 60), heatOpen: stressed ? Math.floor(rng() * 8) : 0 },
    ecb: { balanceDue: dob > 10 ? Math.round(rng() * 90000) : Math.round(rng() * 4000), unresolved: Math.floor(dob / 3) },
    threeOneOne: {
      total12mo: Math.floor(rng() * (stressed ? 40 : 8)),
      heatHotWater12mo: stressed ? Math.floor(rng() * 10) : 0,
      topCategories: stressed
        ? [{ type: "HEAT/HOT WATER", n: 6 + Math.floor(rng() * 8) }, { type: "PLUMBING", n: 2 + Math.floor(rng() * 5) }, { type: "PAINT/PLASTER", n: 1 + Math.floor(rng() * 4) }]
        : [{ type: "NOISE - RESIDENTIAL", n: Math.floor(rng() * 4) }]
    }
  };
}

export function distressFor(bbl) {
  assertSyntheticAllowed("server/citymodel.js");
  const h = assetHistory(bbl);
  if (!h) return null;
  return computeDistressFromRecord(h);
}

// ---------------------------------------------------------------------------
// Aggregates: sales / census / owners / pipeline per ZIP set
// ---------------------------------------------------------------------------
export function buildingsForZips(zips) {
  assertSyntheticAllowed("server/citymodel.js");
  return zips.flatMap((z) => buildingsForZip(z));
}

export function salesForZips(zips) {
  assertSyntheticAllowed("server/citymodel.js");
  return buildingsForZips(zips)
    .filter((b) => b.recentSale)
    .map((b) => ({
      bbl: b.bbl, address: b.address, saleDate: b.recentSale.date, salePrice: b.recentSale.price,
      bldgClass: b.bldgClass, gsf: b.bldgArea, landSf: b.lotArea, units: b.unitsTotal, zip: b.zip,
      ppsf: b.bldgArea ? Math.round(b.recentSale.price / b.bldgArea) : null
    }))
    .sort((a, b) => (a.saleDate < b.saleDate ? 1 : -1));
}

export function pipelineForZips(zips) {
  assertSyntheticAllowed("server/citymodel.js");
  const sites = [];
  for (const b of buildingsForZips(zips)) {
    const rng = rngFor(`pipe:${b.bbl}`);
    if (rng() < 0.035) {
      const kind = pick(rng, ["New Building", "New Building", "Foundation", "Demolition"]);
      const daysAgo = Math.floor(rng() * 900);
      sites.push({
        bbl: b.bbl, address: b.address,
        filingDate: new Date(NOW.getTime() - daysAgo * 864e5).toISOString().slice(0, 10),
        kind,
        proposedUnits: kind === "New Building" ? Math.max(4, Math.round((b.unusedFarSf || b.lotArea * 4) / 850)) : null,
        applicant: `${pick(rng, OWNER_LASTS)} ${pick(rng, ["ARCHITECT PLLC", "ENGINEERING PC", "DESIGN GROUP"])}`,
        status: pick(rng, ["FILED", "APPROVED", "PERMIT ISSUED", "IN PROCESS"])
      });
    }
  }
  sites.sort((a, b) => (a.filingDate < b.filingDate ? 1 : -1));
  return {
    windowMonths: 36,
    fetchedAt: new Date().toISOString(),
    counts: {
      newBuilding: sites.filter((s) => s.kind === "New Building").length,
      foundation: sites.filter((s) => s.kind === "Foundation").length,
      demolition: sites.filter((s) => s.kind === "Demolition").length,
      proposedUnits: sites.reduce((n, s) => n + (s.proposedUnits || 0), 0)
    },
    sites: sites.slice(0, 40)
  };
}

export function nearestBuilding(lat, lng) {
  assertSyntheticAllowed("server/citymodel.js");
  let best = null, bestD = Infinity;
  for (const b of allBuildingsNear(lat, lng)) {
    const d = (b.lat - lat) ** 2 + (b.lng - lng) ** 2;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

export function nearbyBuildings(lat, lng, limit = 14) {
  assertSyntheticAllowed("server/citymodel.js");
  return allBuildingsNear(lat, lng)
    .map((b) => ({ b, d: haversineFt(lat, lng, b.lat, b.lng) }))
    .filter((x) => x.d < 1400)
    .sort((a, z) => a.d - z.d)
    .slice(0, limit)
    .map(({ b, d }) => ({
      bbl: b.bbl, address: b.address, bldgClass: b.bldgClass, units: b.unitsTotal,
      yearBuilt: b.yearBuilt || null, lat: b.lat, lng: b.lng,
      distanceFt: d, bearing: bearingDeg(lat, lng, b.lat, b.lng)
    }));
}

export { NOW, THIS_YEAR };
