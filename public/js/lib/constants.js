// Client-side vocabulary: categories, colors, bands, areas — recovered from
// the original client and reorganized for the rebuilt UI.

export const NEIGHBORHOODS = ["FiDi / Lower Manhattan","Tribeca / SoHo / NoHo","Chelsea / Hudson Yards","Flatiron / NoMad","Garment District / Midtown South","Midtown East","Upper West Side (below 110)","Upper East Side (below 96)","Gowanus / Park Slope","Downtown Brooklyn / Fort Greene","Williamsburg / Greenpoint","Bushwick / Bed-Stuy","Crown Heights / Prospect Heights","LIC / Hunters Point","Astoria / Dutch Kills","Sunnyside / Woodside","Jamaica / Queens","South Brooklyn / Kensington"];

export const CATEGORIES = ["Development Site","Assemblage","Underbuilt Parcel","Active Construction","Office-to-Residential Candidate","Multifamily Candidate","On-Market Signal"];

export const SIGNALS = ["PLUTO","DOB","ACRIS","Zoning"];
export const SIGNAL_LABELS = { PLUTO: "Tax lot (PLUTO)", DOB: "Permits (DOB)", ACRIS: "Deeds & debt (ACRIS)", Zoning: "Zoning" };

export const CATEGORY_COLORS = {
  "Development Site": "#1D4ED8",
  Assemblage: "#2563EB",
  "Underbuilt Parcel": "#0EA5E9",
  "Active Construction": "#7C3AED",
  "Office-to-Residential Candidate": "#0284C7",
  "Multifamily Candidate": "#1E40AF",
  "On-Market Signal": "#0891B2"
};
export const CATEGORY_SHORT = {
  "Development Site": "Dev Site", Assemblage: "Assemblage", "Underbuilt Parcel": "Underbuilt",
  "Active Construction": "Construction", "Office-to-Residential Candidate": "O2R Candidate",
  "Multifamily Candidate": "Multifamily", "On-Market Signal": "On-Market"
};
export const RISK_COLORS = { Low: "#0284C7", Moderate: "#2563EB", Elevated: "#7C3AED", High: "#BE123C" };
export const FIT_COLORS = { Prime: "#6DAA45", Strong: "#4F98A3", Possible: "#E8AF34" };

export const scoreColor = (s) => (s >= 85 ? "#1D4ED8" : s >= 72 ? "#0284C7" : s >= 58 ? "#7C3AED" : "#64748B");

// Live-inventory asset classes (from building class letters)
export const assetClassOf = (cls) => {
  const c = (cls ?? "").toUpperCase().slice(0, 1);
  return c === "C" || c === "D" ? "multifamily" : c === "R" ? "condo" : c === "O" ? "office" : c === "H" ? "hotels" : c === "V" || c === "Z" ? "development" : "other";
};
export const ASSET_CLASS_COLORS = { multifamily: "#2563eb", condo: "#06b6d4", office: "#7c3aed", hotels: "#db2777", development: "#16a34a", other: "#94a3b8" };
export const ASSET_CLASS_LABELS = { multifamily: "Multifamily", condo: "Condo", office: "Office", hotels: "Hotel", development: "Dev / vacant", other: "Other" };

export const LAND_USE_LABELS = {
  "01": "1–2 Family", "02": "Multifamily Walk-up", "03": "Multifamily Elevator",
  "04": "Mixed Resi/Commercial", "05": "Commercial / Office", "06": "Industrial / Manufacturing",
  "07": "Transportation / Utility", "08": "Public Facility / Institution",
  "09": "Open Space / Recreation", 10: "Parking Facility", 11: "Vacant Land"
};

export const LAND_USE_BANDS = [
  { key: "01", label: "One & two family", color: "#F7D96B" },
  { key: "02", label: "Multi-family walk-up", color: "#F4B942" },
  { key: "03", label: "Multi-family elevator", color: "#E8963D" },
  { key: "04", label: "Mixed residential / commercial", color: "#E8663D" },
  { key: "05", label: "Commercial / office", color: "#D6455D" },
  { key: "06", label: "Industrial / manufacturing", color: "#8E5BD1" },
  { key: "07", label: "Transportation / utility", color: "#6BA5E7" },
  { key: "08", label: "Public facility / institution", color: "#3FA796" },
  { key: "09", label: "Open space / recreation", color: "#4CAF50" },
  { key: "10", label: "Parking facility", color: "#9E9E9E" },
  { key: "11", label: "Vacant land", color: "#795548" },
  { key: "AG", label: "Agricultural", color: "#8BC34A" },
  { key: "MF", label: "Uncoded · 4+ units", color: "#2474F5" },
  { key: "OTHER", label: "Uncoded · other", color: "#8A97A6" }
];

export const AIR_BANDS = [
  { key: "A5", label: "100,000+ bsf", color: "#6A1B4D", min: 1e5, max: Infinity },
  { key: "A4", label: "25,000 – 100,000", color: "#B02A5B", min: 25e3, max: 1e5 },
  { key: "A3", label: "10,000 – 25,000", color: "#E2565E", min: 1e4, max: 25e3 },
  { key: "A2", label: "2,500 – 10,000", color: "#F49B5B", min: 2500, max: 1e4 },
  { key: "A1", label: "Under 2,500", color: "#F7DCA0", min: 1, max: 2500 },
  { key: "A0", label: "Built out / overbuilt", color: "#B9C2CC", min: 0, max: 1 },
  { key: "ANA", label: "No FAR on record", color: "#E3E7EB", min: -1, max: 0 }
];

export const OWNER_BANDS = [
  { key: "individual", label: "Individual", color: "#D6455D" },
  { key: "trust", label: "Trust / estate", color: "#E8963D" },
  { key: "llc", label: "LLC", color: "#6BA5E7" },
  { key: "corp", label: "Corp / company", color: "#8E5BD1" },
  { key: "condo", label: "Condo / co-op", color: "#3FA796" },
  { key: "nonprofit", label: "Nonprofit / religious", color: "#4CAF50" },
  { key: "gov", label: "Government", color: "#9E9E9E" },
  { key: "unknown", label: "Not on record", color: "#E3E7EB" }
];
export const OWNER_KIND_LABELS = Object.fromEntries(OWNER_BANDS.map((b) => [b.key, b.label]));
export const OWNER_KIND_NOTES = {
  individual: "Named person on the roll — estate, generational-transfer and tax-basis-reset motivations cluster here.",
  trust: "Held in trust or an estate. Settlement and beneficiary timelines drive sales more than price does.",
  llc: "Single-purpose entity — typically a deliberate investor. Sells on numbers; principals are behind the entity filing.",
  corp: "Operating company or corporation. Decision-making sits with officers, not a household.",
  condo: "Condo or co-op entity — the building is share/unit-owned, so there's no single seller to approach.",
  nonprofit: "Institution — church, school, hospital or charity. Sales need board and sometimes regulatory approval.",
  gov: "Public ownership. Disposition runs through an agency process, not a private trade.",
  unknown: "Owner name carries no entity marker — can't be classified from the roll alone."
};

const BAD_OWNER_RE = /^(UNAVAILABLE|UNAVAILABLE OWNER|UNKNOWN|OWNER UNKNOWN|UNKNOWN OWNER|NA|N A|NONE|NO OWNER|NOT AVAILABLE|WITHHELD|PRIVATE OWNER|VARIOUS|VARIOUS OWNERS|MULTIPLE|MULTIPLE OWNERS|TBD)$/;
export function ownerUnavailable(name) {
  const t = (name || "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  return !t || BAD_OWNER_RE.test(t);
}
export function classifyOwner(name) {
  const t = (name || "").trim();
  if (!t || ownerUnavailable(t)) return "unknown";
  const r = t.toUpperCase();
  if (/\b(CITY OF NEW YORK|NYC|N\.?Y\.?C|DEPT|DEPARTMENT|STATE OF|PEOPLE OF|COUNTY OF|TOWN OF|VILLAGE OF|AUTHORITY|NYCHA|MTA|PORT AUTHORITY|TRANSIT|BOARD OF EDUCATION|UNITED STATES|FEDERAL|MUNICIPAL|PUBLIC ADMINISTRATOR)\b/.test(r)) return "gov";
  if (/\b(CONDOMINIUM|CONDO|OWNERS CORP|TENANTS CORP|APARTMENT CORP|HOUSING CORP|MUTUAL HOUSING|HOMEOWNERS)\b/.test(r)) return "condo";
  if (/\b(TRUST|TRUSTS|TRUSTEE|TRUSTEES|ESTATE OF|REVOCABLE|IRREVOCABLE|LIVING TRUST)\b/.test(r)) return "trust";
  if (/\b(L\.?L\.?C\.?|LLC)\b/.test(r)) return "llc";
  if (/\b(CHURCH|SYNAGOGUE|TEMPLE|MOSQUE|PARISH|CONGREGATION|CATHEDRAL|MINISTR\w*|DIOCESE|ARCHDIOCESE|SOCIETY|FOUNDATION|CHARIT\w*|MUSEUM|HOSPITAL|UNIVERSITY|COLLEGE|ACADEMY|SCHOOL|LIBRARY|YMCA|YWCA|MISSION)\b/.test(r)) return "nonprofit";
  if (/\b(INC|CORP|CORPORATION|COMPANY|CO|LTD|LIMITED|L\.?P\.?|LLP|PARTNERS|PARTNERSHIP|REALTY|PROPERTIES|PROPERTY|HOLDINGS|HOLDING|ENTERPRISES|ASSOCIATES|ASSOCIATION|GROUP|MANAGEMENT|DEVELOPMENT|EQUITIES|CAPITAL|INVESTORS|INVESTMENT\w*|VENTURES|FUND)\b/.test(r)
    || /(DEVELOP|REALT|PROPERT|HOLDING|MANAG|INVEST|EQUIT|CAPITAL|VENTUR|ENTERPRIS|ASSOCIAT|PARTNER|HOUSING|APARTMENT|TOWERS|PLAZA|GARDENS|ESTATES|BUILDER|CONSTRUCT|CONTRACT|LEASING|RENTAL|HOTEL|MOTEL|CENTER|CENTRE|STORAGE|INDUSTR|MANUFACTUR|SERVICES|LAUNDR|GARAGE|MARKET)/.test(r)) return "corp";
  return /,/.test(t) ? "individual" : "unknown";
}
export const normalizeOwner = (name) => (ownerUnavailable(name) ? "" : (name || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));

// Air-rights math with encumbrances
export function airRights(p) {
  const maxFar = Math.max(p.maxResidFar ?? 0, p.maxCommFar ?? 0, p.maxFacilFar ?? 0, p.maxFar ?? 0);
  const lot = p.lotArea ?? 0, bldg = p.bldgArea ?? 0;
  const enc = [];
  if (p.landmark) enc.push("Individual landmark");
  if (p.histDist) enc.push(`Historic district: ${p.histDist}`);
  if (p.eDesig) enc.push("E-designation (environmental)");
  if (p.splitZone) enc.push("Split zoning lot");
  if (p.ltdHeight) enc.push(`Limited height district ${p.ltdHeight}`);
  if (!maxFar || !lot) return { maxFar, unusedBsf: null, overbuilt: false, encumbered: enc };
  const diff = maxFar * lot - bldg;
  return { maxFar, unusedBsf: Math.max(0, Math.round(diff)), overbuilt: diff < 0, encumbered: enc };
}
export function airBandOf(p) {
  const a = airRights(p);
  if (a.unusedBsf === null) return "ANA";
  return AIR_BANDS.find((b) => a.unusedBsf >= b.min && a.unusedBsf < b.max)?.key ?? "A0";
}
export function landUseBandOf(p) {
  if (p.landUse && LAND_USE_BANDS.some((b) => b.key === p.landUse)) return p.landUse;
  return (p.units ?? p.unitsTotal ?? 0) >= 4 ? "MF" : "OTHER";
}

// Area → ZIP resolution (borough presets + keyword matching)
export const ZIPS_MANHATTAN = ["10001","10002","10003","10004","10005","10006","10007","10009","10010","10011","10012","10013","10014","10016","10017","10018","10019","10020","10021","10022","10023","10024","10025","10028","10036","10038","10044","10065","10069","10075","10128","10280","10282"];
export const ZIPS_BROOKLYN = ["11201","11203","11204","11205","11206","11207","11208","11209","11210","11211","11212","11213","11214","11215","11216","11217","11218","11219","11220","11221","11222","11223","11224","11225","11226","11228","11229","11230","11231","11232","11233","11234","11235","11236","11237","11238","11239","11249","11251"];
export const ZIPS_QUEENS = ["11004","11101","11102","11103","11104","11105","11106","11109","11354","11355","11356","11357","11358","11360","11361","11362","11363","11364","11365","11366","11367","11368","11369","11370","11372","11373","11374","11375","11377","11378","11379","11385","11411","11412","11413","11414","11415","11416","11417","11418","11419","11420","11421","11422","11423","11426","11427","11428","11429","11432","11433","11434","11435","11436","11691","11692","11693","11694","11697"];

export const AREA_PRESETS = [
  { label: "Manhattan (below 96th E / 106th W)", keywords: ["manhattan","manhattan core","below 96","new york county","nyc manhattan"], zips: ZIPS_MANHATTAN },
  { label: "Brooklyn", keywords: ["brooklyn","bk","bklyn","kings county"], zips: ZIPS_BROOKLYN },
  { label: "Queens", keywords: ["queens","qns","queens county"], zips: ZIPS_QUEENS },
  { label: "Midtown", keywords: ["midtown","garment","hudson yards","nomad","flatiron","midtown east","midtown south"], zips: ["10001","10010","10016","10017","10018","10019","10020","10022","10036"] },
  { label: "Downtown Manhattan", keywords: ["downtown manhattan","lower manhattan","fidi","financial district","tribeca","soho","noho"], zips: ["10004","10005","10006","10007","10013","10038","10280","10282"] },
  { label: "Williamsburg / Greenpoint", keywords: ["williamsburg","greenpoint","north brooklyn"], zips: ["11211","11222","11249","11206"] },
  { label: "Downtown Brooklyn", keywords: ["downtown brooklyn","fort greene","boerum"], zips: ["11201","11217","11205"] },
  { label: "LIC / Astoria", keywords: ["lic","long island city","hunters point","astoria","dutch kills"], zips: ["11101","11109","11106","11102","11103","11105"] }
];

export function resolveAreaToZips(q) {
  const zips = Array.from(new Set((String(q).match(/\b\d{5}\b/g) ?? [])));
  if (zips.length) return { zips, label: `ZIP ${zips.join(", ")}` };
  const t = String(q || "").trim().toLowerCase();
  if (!t) return { zips: [], label: "" };
  const labels = [], set = new Set();
  for (const p of AREA_PRESETS) {
    if (p.keywords.some((k) => t === k || t.includes(k) || k.includes(t))) {
      labels.push(p.label);
      p.zips.forEach((z) => set.add(z));
    }
  }
  return { zips: [...set], label: labels.join(" + ") };
}

export const BORO_BY_CODE = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" };
export const boroughOfBbl = (bbl) => BORO_BY_CODE[String(bbl || "")[0]] ?? null;

export function govLinks(digitsBbl, block, lot) {
  const boro = String(digitsBbl)[0];
  return {
    acris: `https://a836-acris.nyc.gov/bblsearch/bblsearch.asp?borough=${boro}&block=${block}&lot=${lot}`,
    propPortal: `https://propertyinformationportal.nyc.gov/parcels/parcel/${digitsBbl}`,
    bisweb: `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${boro}&block=${block}&lot=${lot}`,
    zola: `https://zola.planning.nyc.gov/l/lot/${boro}/${block}/${lot}`
  };
}

export const SORT_OPTIONS = [
  { value: "propensity", label: "Seller propensity ⚡" },
  { value: "score", label: "Dev score" },
  { value: "lotarea", label: "Lot size" },
  { value: "assesstot", label: "Assessed value" },
  { value: "yearbuilt", label: "Oldest first" },
  { value: "unitsres", label: "Resi units" }
];
