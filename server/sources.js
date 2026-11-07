// Source Registry content — every entry links to the actual public record or
// authoritative planning/cost source used by the application. No blank source
// URLs: a user can leave the app and inspect the underlying authority directly.

export const DATA_SOURCES = [
  {
    name: "Office-to-Residential Conversions in NYC: Economics & Fiscal Estimates",
    publisher: "Office of the New York City Comptroller",
    url: "https://comptroller.nyc.gov/reports/office-to-residential-conversions-in-nyc-economics-and-fiscal-estimates/",
    updated: "Published July 17, 2025",
    powers: "Adaptive Reuse / 467-m layer, conversion thesis, comps benchmarks",
    facts: [
      "44 completed, ongoing, and potential conversions as of Q1 2025 — 15.2M gross sf and approximately 17,400 apartments.",
      "The report identifies 12.2M gsf in Manhattan south of 59th Street containing approximately 14,500 apartments that could start renovation by the end of June 2026 and qualify for 467-m Phase 1.",
      "467-m requires 25% income-restricted apartments averaging 80% of AMI and provides property-tax exemptions whose duration depends on project start timing and location."
    ]
  },
  {
    name: "Midtown South Mixed-Use Plan & City of Yes",
    publisher: "NYC Department of City Planning / NYC Zoning Resolution",
    url: "https://zr.planning.nyc.gov/recently-adopted/midtown-south-mixed-use-plan-n-250186-zrm",
    updated: "Midtown South adopted August 14, 2025; City of Yes approved December 5, 2024",
    powers: "Zoning/plan context layer, neighborhood catalysts, policy badges",
    facts: [
      "The Midtown South Mixed-Use Plan created a new mixed-use zoning framework intended to support housing growth, including office-to-residential conversions and new development.",
      "City of Yes for Housing Opportunity modernized citywide zoning rules to enable additional housing and made office and other non-residential conversions easier."
    ]
  },
  {
    name: "Gowanus Neighborhood Plan",
    publisher: "NYC Department of City Planning / NYC Zoning Resolution",
    url: "https://zoningresolution.planning.nyc.gov/recently-adopted/gowanus-neighborhood-plan-n-210178-zrk",
    updated: "Adopted November 23, 2021",
    powers: "Brooklyn multifamily / MIH catalyst layer, Gowanus pipeline context",
    facts: [
      "Approved November 23, 2021 as a framework for housing, jobs, open space, resiliency, and canal-area infrastructure.",
      "Used here as the public planning context behind the Gowanus / Park Slope multifamily watchlist."
    ]
  },
  {
    name: "OneLIC Neighborhood Plan",
    publisher: "NYC Department of City Planning / New York City Council",
    url: "https://council.nyc.gov/press/2025/11/12/3008/",
    updated: "Approved November 12, 2025",
    powers: "LIC / Queens multifamily catalyst layer, waterfront and mixed-use planning context",
    facts: [
      "The approved OneLIC plan is expected to enable approximately 14,700 new homes, including 4,350 permanently affordable homes.",
      "Used here as the planning catalyst behind the LIC / Hunters Point and Queens multifamily watchlist."
    ]
  },
  {
    name: "Citywide tax-lot land use records (PLUTO)",
    publisher: "NYC Department of City Planning / NYC Open Data",
    url: "https://data.cityofnewyork.us/resource/64uk-42ks",
    updated: "Current NYC Open Data feed",
    powers: "Parcel identifiers (BBL), lot/building sf, FAR, year built, floors, zoning, land use",
    facts: [
      "Public tax-lot-level land-use and geographic data covering tax lots citywide.",
      "The application queries the live 64uk-42ks feed and does not substitute generated property facts when the source is unavailable."
    ]
  },
  {
    name: "City permit issuance records",
    publisher: "NYC Department of Buildings / NYC Open Data",
    url: "https://data.cityofnewyork.us/resource/ipu4-2q9a",
    updated: "Daily",
    powers: "Active Construction signal, permit life-cycle work types (NB/ALT/DEM)",
    facts: [
      "DOB Permit Issuance is a public citywide permit dataset used for legacy permit activity.",
      "Current DOB NOW filings are queried separately so an unavailable permit source is never treated as zero permits."
    ]
  },
  {
    name: "Recorded property documents (deeds & mortgages)",
    publisher: "NYC Department of Finance / Office of the City Register",
    url: "https://www.nyc.gov/site/finance/property/acris.page",
    updated: "Ongoing",
    powers: "Ownership/party records, deeds, mortgages, satisfactions, assignments and financing history",
    facts: [
      "ACRIS provides recorded property documents including deeds, mortgages, assignments and satisfactions for Manhattan, Queens, the Bronx and Brooklyn.",
      "Owner names come from the live PLUTO ownername field (owner of record) and recorded ACRIS parties.",
      "An owner of record is frequently an LLC and is not, by itself, a resolved beneficial-ownership graph."
    ]
  },
  {
    name: "Citywide recorded sales (rolling calendar)",
    publisher: "NYC Department of Finance",
    url: "https://www.nyc.gov/site/finance/property/property-rolling-sales-data.page",
    updated: "Rolling 12-month files / current Open Data feed",
    powers: "Sale price, sale date, building class, land sf, gross sf, unit counts and market validation",
    facts: [
      "Department of Finance rolling sales files cover properties sold during the latest 12-month period and include neighborhood, building type and square-footage fields.",
      "The application uses recorded sales to calculate transaction timing and price metrics; a failed sales source is reported unavailable rather than converted to zero sales."
    ]
  },
  {
    name: "DOB NOW: Build — Job Application Filings",
    publisher: "NYC Department of Buildings / NYC Open Data",
    url: "https://data.cityofnewyork.us/Housing-Development/DOB-NOW-Build-Job-Application-Filings/w9ak-ipjd/data",
    updated: "Daily",
    powers: "Build pipeline, proposed work, units, square footage, filing status, and professional/applicant signals",
    facts: [
      "Public DOB NOW job-filing data used alongside permit issuance for development-pipeline and active-construction analysis."
    ]
  },
  {
    name: "Zoning Application Portal (ZAP) — Project Data",
    publisher: "NYC Department of City Planning / NYC Open Data",
    url: "https://data.cityofnewyork.us/City-Government/Zoning-Application-Portal-ZAP-Project-Data/hgx4-8ukb",
    updated: "Current NYC Open Data feed",
    powers: "Land-use applications, project status, project descriptions and zoning-review context",
    facts: [
      "DCP ZAP project data covers land-use applications from filing/noticing through completion and is used to connect parcels with public-review activity."
    ]
  },
  {
    name: "RLB Construction Cost Calculator and Quarterly Cost Reports",
    publisher: "Rider Levett Bucknall",
    url: "https://www.rlb.com/americas/insight/rlb-construction-cost-report-north-america-q2-2026/",
    updated: "Quarterly — Q2 2026 report published June 24, 2026",
    powers: "Construction-cost benchmarking and escalation context",
    facts: [
      "Used only as an external benchmark layer; property underwriting should replace generalized ranges with project-specific bids and verified internal comps where available."
    ]
  },
  {
    name: "Turner Building Cost Index",
    publisher: "Turner Construction",
    url: "https://www.turnerconstruction.com/cost-index",
    updated: "Quarterly",
    powers: "Construction-cost trend and escalation index cross-check",
    facts: [
      "Used as an independent trend check for labor, material, productivity and market-competition pressure in construction costs."
    ]
  }
];
