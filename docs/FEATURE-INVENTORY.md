# NYC RE Market Intel — Feature Inventory (reconstructed from the live bundle)

This document is the reverse-engineered specification of nycremarketintel.com,
extracted by reading the production JS bundle (`index-BbnE3o5g.js`, 73,557 lines
prettified) and CSS line by line. It is the source of truth for the rebuild.

## Identity

- **Name:** NYC Dev Intelligence / NYC CRE Market Intel ("Market Intel")
- **Tagline:** "NYC multifamily + development intelligence — Manhattan, Brooklyn,
  LIC/Queens. Block-by-block coverage. Live public-record data — refreshed
  continuously, never stale."
- **Original stack:** React 18 + Vite + wouter (hash routing) + TanStack Query +
  Tailwind/shadcn + Leaflet 1.9.4 (+ rotate plugin) + MapLibre (3D beta) +
  Cesium/Google Photorealistic 3D (lab) + Supabase (auth + per-user rows) +
  Cloudflare Worker backend ("map-room") + Pinecone (similar properties) +
  drizzle schema shared client/server.
- **Design tokens (light):** background `hsl(210 45% 98%)`, foreground
  `hsl(222 47% 12%)`, primary `hsl(217 91% 55%)`, sidebar `hsl(214 48% 96%)`,
  radius .5rem, fonts Satoshi/Inter + JetBrains Mono.
- PWA-lite: manifest, apple-touch icons, theme color `#0B1220`.

## Navigation (sidebar, 232px; mobile bottom tab bar)

| Path | Label | Notes |
|---|---|---|
| `/` | Market Intel | Map room (default) |
| `/dossier` | Parcel Dossier | Address/BBL search → full record |
| `/pipeline` | Pipeline / CRM | Kanban over curated sites |
| `/live` | Live Details | Mobile AR: compass + camera + nearby lots |
| `/territory` | Territory Mastery | Territory intelligence + cold-call system |
| `/radar` | Deal Radar | Seller-propensity origination |
| `/calculator` | Deal Calculator | Underwriting + BOV/OM generator |
| `/comps` | Comps / Land Index | Live comps by strategy/borough |
| `/present` | Presentation Mode | Client tour |
| `/desk` | My Desk | Signed-in only: watchlist/pipeline/canvass |
| `/investors` | Investors | Owner-only: buy-box pool |
| `/sources` | Source Registry | Owner-only: data provenance + integrations |

Sidebar footer: auth card (email link or password via Supabase; edit display
name; delete account via `/api/account-delete`) + "Data posture" card + build
timestamp.

## Market Intel (map room)

- Leaflet map, center [40.718, -73.965] z11, rotate enabled, zoom topright.
- Base tiles proxied: `/api/mbtile/{z}/{x}/{y}` (satellite),
  `/streets/`, `/nolabels/`, `/labels/` (lot-label pane at z>=15).
- Controls: Satellite/Street toggle, Reset map, "Lot grid: on/off", **3D City**
  button, bottom-left NTA hover chip, bottom-right lot-count chip.
- **NTA overlay** (zoom >= 11): `/api/nta-polys?bbox=` → hover highlights +
  simplified name, click → load area (territory match or `/api/zip-at`).
- **Lot grid** (zoom >= 15): vector tiles `/api/lot-tiles/{z}/{x}/{y}` (z<=16),
  GeoJSON lots with {bbl,address,owner,bldgClass,zoning,units,unitsRes,yearBuilt,
  landUse,lotArea,bldgArea,builtFar,maxResidFar,maxCommFar,maxFacilFar,floors,
  assessedTotal,landmark,histDist,eDesig,splitZone,ltdHeight, non-NYC: parcelId,
  muni,county,mailAddress,mailCity,absentee,fullMarketValue,assessedLocal}.
  - Three view modes: **Land use** (12 color bands), **Air rights** (unused-bsf
    bands A5..A0/ANA), **Owner** (individual/trust/llc/corp/condo/nonprofit/gov).
  - "Owned by" filter: any / individuals+estates / LLCs+entities.
  - Band toggles + All/None; owner-name normalization; multi-lot owner flag
    "⚑ Owner holds N lots in view"; click lot = highlight same-owner lots +
    open Lot Detail flyout; dblclick → full dossier.
  - Rich hover card (portal): owner + type, class/zoning/units/year, unused bsf
    or Overbuilt/Built out + restrictions, absentee flag.
  - **CSV export** of lots in view; **Scout Report** (printable: KPIs, land-use
    mix, deepest holders, top unused-bsf).
- **Curated markers**: score-colored dots for filtered opportunity set, tooltip,
  click → dossier side panel.
- **Filter rail** (left, 230px): area search + preset chips (Manhattan,
  Brooklyn, Queens, Midtown, Downtown/Uptown Manhattan, LIC, Astoria, Gowanus,
  Downtown BK, North Brooklyn) with drill-in sub-areas; product-type
  pre-filter; search (address/BBL/zoning); min-score slider; category checks;
  neighborhood checks; signal chips (PLUTO/DOB/ACRIS/Zoning); Adaptive-reuse
  /467-m switch.
- **Buildings mode** (area resolves to ZIPs): 3-pane layout — filters, building
  list (sort: Seller propensity ⚡ / Dev score / Lot size / Assessed value /
  Oldest first / Resi units; paging 200/pg; Export CSV/Excel incl. full-area
  fetch), live map of every tax lot (dot color = asset class from building
  class: multifamily/condo/office/hotel/dev/other), Building Detail drawer:
  justification, contacts finder, dev & zoning facts, lot & building facts,
  assessment/owner, live records drill-down (sales, permits, DOB NOW, ACRIS
  debt docs, ZAP) each exportable, official record links.
- **Address mode** (query looks like an address): `/api/address?q=` results
  with GeoSearch note.
- **Opportunities strip** (bottom): horizontal cards; empty-state copy.
- **Dossier side panel** (390px): see Parcel Dossier panel below.
- **Lot Detail flyout**: listing check (🔴 LISTED FOR SALE w/ hits), open-dossier
  CTA, absentee owner card, unused-buildable card + restrictions, ownership
  (type + portfolio counts in-view/citywide + explainer), entity filing (NY DOS),
  parcel/units/zoning-FAR/value sections; non-NYC handling.
- **3D City**: MapLibre extrusion mode (sat/day/night, lot pads + building
  volumes from `/api/bldg-tiles`, class filter) and Cesium + Google
  Photorealistic tiles (`/api/3d-session` key with daily cap; labeled lot
  markers; click → `/api/lot-at`; orbit + labels toggles; setup instructions
  when unconfigured).

## Dossier side panel (curated opportunity)

Header (score badge 44px, address, id · neighborhood; category/risk/conversion
badges + Live-ready|Block-level badge; "Add to Parcel Dossier →" and "Analyze
this deal →" CTAs) then sections:
1. **Investment Justification** — tier chip, thesis paragraph, "What drives the
   case" bullets, caveat (model-derived, from score/FAR/catalysts).
2. **Score Breakdown** — 6 components (Density/FAR 22, Policy catalyst 20,
   Location/liquidity 18, Execution risk 18, Conversion fit 12, Source
   confidence 10) with bars + rationale + interpretation.
3. **Live Validation Posture** — exact vs block-level explainer.
4. **Live Data Pull** — `/api/livepull` tiles: Last recorded sale, Parcel match,
   Permit activity, ZAP activity, Recorded debt; expandable evidence rows per
   tile; refresh; fetchedAt + ok/error source counts.
5. **Policy Catalysts** chips.
6. **Parcel & Land Use** facts; **Ownership** + note.
7. **Contact Targets** — owner (recorded borrower > registered owner > modeled),
   lender (mortgagee w/ amount/date/doc), architect/expeditor (permit
   applicant), broker; confidence chips + verify notes.
8. **So What — Client Call Angle** — soWhat, why-it-matters bullets, outreach
   hook, likely objection, response, recommended ask.
9. **Conversion / Development Thesis** (authored).
10. **Opportunity Qualifiers** (5).
11. **Deep Intelligence Spine** — 6 tiles (Every sale & transfer, SF & density,
    Zoning & catalysts, Build pipeline, Taxes & incentives, Regulatory & physical
    risk) with live fields + links.
12. **Risk Flags**, **Recommended next action**.
13. **Live Public Source Checks** — ACRIS/PIP/BISWEB/ZoLa links w/ what-to-check.
14. **Full Diligence Memo Framework** — 5 sections × 3 bullets.

## Parcel Dossier page (`/dossier`)

Search any address/BBL ("Search any asset. Get the whole story."), examples.
For a resolved BBL (`/api/asset-history?bbl=`):
- Header + actions: **Property report** (internal), **Investor report**
  (client-ready), **Calculator** (prefill), **Watch** (Supabase watchlist),
  **Add to Pipeline** (stage Lead), **Market report** (area), owner-only
  **Add to Obsidian** (markdown with frontmatter + [[links]]).
- Street View + Aerial images (`/api/streetview?bbl=`, `/api/staticmap?bbl=`).
- KPIs: Last sale / $-sf / hold years / comp median.
- Owner-only **CRM cross-reference** (`/api/airtable-xref`): seller matches +
  buyer fits.
- **Seller-propensity breakdown** (transparent additive model, cited datasets):
  aging structure, unused development rights (24/13), land-heavy assessment,
  individual owner, no reinvestment, small multifamily; bands High>=55,
  Elevated>=35, Watch>=18; gov/utility excluded. "How to read it" explainer.
- **Distress & debt-maturity**: est. maturity from recorded mortgage (10-yr
  assumption), HPD/DOB violations weights, hold-years; live checks: lien-sale
  (`/api/liensale`), lis pendens web search (`/api/websearch`), recorded cap
  stack review; NYSCEF/CityPay/ACRIS links.
- **Tax & regulatory cliffs** (`/api/cliffs`): J-51 burn-off, LL97 2030 penalty
  (LL84 ghg vs cap × $268/t), LL33 letter grade.
- **Transit proximity** (`/api/transit`): nearest station/lines/ft + counts.
- **Distress live records** (`/api/distress`): HPD open/heat, ECB $ due, 311
  12-mo + top categories.
- **Assemblage & air rights** (`/api/assemblage`): same-owner lots on block,
  unused sf each + combined, table.
- **Assessment & tax history** (`/api/tax-history`): year rows (market,
  assessed, taxable, est tax, YoY) + methodology.
- **Marketing check** (`/api/listingcheck`): platform search chips w/ live
  detection when Google CSE configured.
- Owner-only **Investor match** vs buy-box pool + BD angle.
- **The story** — narrative synthesis paragraphs.
- **Usage & physical**, **Sales & owner history** (deeds), **Financing
  history**, **Comparable sales nearby** (same ZIP+class, 24-mo), **Permit /
  work history**, **Owner portfolio (citywide)** (`/api/owner-portfolio`),
- **Draft outreach** (Beta) — email/letter in broker voice, angle picked from
  cliffs/debt/propensity/hold; copy button; never auto-sent.
- **Canvass log** — call/door/email/meeting/mailer + outcome + follow-up
  (Supabase `cre_canvass`).
- **Live contacts** (`/api/contacts?bbl=`): permit applicants w/ phones, LLC
  state filings (DOS id, service address), recorded debt parties, HPD contacts.
- Owner-only **Similar properties (AI)** (`/api/similar`, Pinecone).
- **Open official records**: PIP, ACRIS, BISWEB, ZoLa, PropertyShark, NY AG
  offering plans.

## Pipeline / CRM (`/pipeline`)

Kanban: Watchlist → Contacted → Diligence → Offer → Closed (server-persisted
via GET/POST/PATCH `/api/pipeline`), cards w/ score, category, next action,
Back/Advance.

## Territory Mastery (`/territory`)

Navy masthead "Know Your Market **Better Than Anyone Alive.**"; tabs:
1. **Territory Search** — "The Foundation — Own the Data. Own the Market."
   quote block; search + ~56 territory chips (bold = authored history).
2. **Area Intel** — per territory (label/borough/zips): mode toggle
   (multifamily/condo/office/hotels/development/misc), live source line,
   ↻ refresh + ▤ Market report; **The Census** stat cards (qualifying count,
   units, avg units, total lots, median & avg $/sf, 12-mo sales — clickable
   drill-downs via `/api/area-detail`), **historical deep-dive** ($/sf every ~5
   yrs + live "Now" bar; established; authored history paragraphs; growth),
   **Development Pipeline** (`/api/pipeline?zips=`: NB/foundation/demo counts,
   proposed units, sites table), **Top buildings/underbuilt sites** (ranked,
   dev-score badges), **Who Owns** (by buildings/by units + owner drill),
   **The Story** (notable story alert). Asset-history modal (images, facts,
   deeds, financing, permits) from any drill.
3. **Cold-Call System** — 5 generated hook cards (Market pulse, Trend, Story,
   Ownership, Upzoning/Operating pressure) each with data + script; Three-Call
   Sequence (W1 information, W2 comp, W3 soft ask).
4. **Weekly Cadence** — Mon–Fri operating system checklist.
Authored territories with full history: LIC, Chelsea, Harlem, Midtown,
Williamsburg, Crown Heights/Atlantic Ave (+50 more with zips/keywords/mode).

## Deal Radar (`/radar`)

Area scan → propensity-ranked lots: KPI band (lots scanned, high-propensity,
multi-lot owners, top score), **model backtest** (`/api/propensity-validation`:
% of actual 12-mo sellers scoring Elevated+ vs base rate → lift), min-propensity
slider, export call list, expandable rows (facts grid, "Why it scores N"
reasons, investor fits, Open full Dossier), owner-portfolio rollup cards,
borough → neighborhood chip browser.

## Deal Calculator (`/calculator`)

Asset classes: Multifamily/Office/Retail/Industrial/Hotel/Development. Address
→ parcel prefill + auto comp pull; URL prefill (`calcAddr/calcBbl/calcSf/...`).
**Upload rent roll / T12 / OM** (pdf.js + Tesseract OCR → NOI/GPI/opex/units/
price). **Plain-English parse** ("asking 5m, 70 LTV, 6.5 rate, 5.5 exit, 5yr
hold"). Inputs: property & income (+ADR/occupancy for hotels), debt (LTV/rate/
amort/IO), exit (cap/hold/NOI growth), costs (reserves, capex, acq %, exit %);
development mode (lot/buildable SF, hard $/SF, soft %, GDV, target profit,
land price). Outputs: NOI, cap (flags), GRM, price/unit & /SF, RevPAR, DSCR,
cash-on-cash, equity in, levered IRR (amortized balloon), equity multiple,
missing-inputs list, summary sentence; residual land value, margin on cost,
yield on cost, development spread; **sensitivity grid** (exit cap × NOI
growth); **equity waterfall** (8% pref, 20% promote). Comps textarea (pipe
format) + price notes + BOV price → **document generator**: BOV (navy/orange
brand: cover, confidentiality, TOC, About, Exec Summary, amenities, market,
comps, active listings, value page), OM ("gdoc" navy/tan Playfair style), Deck;
in-app preview modal + print-to-PDF via iframe.

## Comps / Land Index (`/comps`)

`/api/market-index`: per strategy (Multifamily/Condo/Office/Hotels/Development)
× market (Manhattan/Brooklyn/Queens) benchmark cards + recent qualifying comps
table ($/sf and zoning-adjusted $/bsf), exports.

## Live Details (`/live`)

Onboarding card → geolocation + compass + camera AR: `/api/nearby` (buildings
w/ bearing/distance), `/api/footprints` (polygons), lock-on reticle for the
building you face, nearby cards, "Pick on map" fallback (rotated Leaflet at
z19, tap footprint → dossier). Extensive permission-help copy.

## Presentation Mode (`/present`)

"CLIENT TOUR" hero + stat band (sites tracked, MF candidates, markets, 44
conversions), "Why this geography" cards, Top-5 with lens toggle (Top
conviction / Multifamily / Adaptive reuse / Density & land), data provenance
grid, validation-posture footnote.

## My Desk (`/desk`)

Signed-in: Pipeline table (stage select: Lead/Contacted/Meeting/Pitched/Under
Contract/Closed/Passed, propensity/assessed/last sale, delete), Watchlist,
Recent canvass; `/api/maturity-wall` when configured.

## Investors (`/investors`, owner-only)

Buy-box editor (asset classes ×10, boroughs ×5, price/unit ranges, notes,
contact info), save pool (`/api/investors`), used by dossier/radar matching +
markdown export.

## Source Registry (`/sources`, owner-only)

Maps usage meter (`/api/maps-usage` streetview/static vs free tier), Pinecone
status + setup steps, 12 data-source cards (name/publisher/updated/powers/
facts) incl. Comptroller conversions study, Midtown South & City of Yes,
Gowanus, OneLIC, PLUTO v26v1, DOB permits, ACRIS, rolling sales, DOB NOW, ZAP,
RLB & Turner cost indices.

## Reports (branded printables)

- **Area Investment Sales Report** (`/api/market-report?zips=`): hero w/ area
  photo (`/api/staticmap?q=`), KPIs, "What actually traded" condo-unit filter
  bar, narrative, dollar-volume bars, by-product-type table, turnover bars,
  cap-rate/GRM benchmark (borough × class assumptions; land $/BSF for dev),
  off-market propensity radar, policy watch (per asset class: Good Cause,
  HSTPA, 485-x, City of Yes, FAR-cap repeal, parking, 467-m, LL97, hotel
  permit, Midtown South), $/sf distribution histogram (SVG), price trend,
  neighborhood overview, sources footer.
- **Property / Investor report**: hero satellite, KPI band, investment signals
  (propensity + distress cards, debt maturity, lien list, J-51, LL97),
  property summary, competitive set (map + table), submarket snapshot +
  trends, owner & contacts (multi-owner note, co-op note, tap-to-dial, emails,
  HPD registration), sales history, tax & assessment; investor mode strips
  internal signals.
- **Scout Report** (map lot grid): serif Georgia print, KPI row, tables.
- **BOV / OM / Deck** from calculator.

## API surface (Worker) — 40+ endpoints

`/api/nta-polys, opportunities, area-buildings, lot-tiles/{z}/{x}/{y},
bldg-tiles/{z}/{x}/{y}, lot-at, zip-at, address, livepull, asset-history,
similar, contacts, owner-portfolio, territory, pipeline (CRM + ?zips= dev
pipeline), area-detail, market-report, market-index, staticmap, streetview,
mbtile/*, nearby, footprints, cliffs, distress, tax-history, assemblage,
transit, liensale, listing-check, listingcheck, websearch, propensity-validation,
maturity-wall, investors, airtable-xref, maps-usage, pinecone-status,
3d-session, account-delete, gov-links`.

## Client-side intelligence (all logic lives in the browser)

Scoring weights & breakdown allocator (largest-remainder rounding), tier
labels, investment justification writer, buildings-mode justification writer,
so-what/outreach generator, contact-strategy builder, evidence-tile builder,
diligence framework, seller-propensity model, distress model, debt-maturity
estimator, outreach email/letter writer w/ salutation parsing, owner-type
classifier (regex taxonomy), air-rights math + encumbrances, underwriting
engine (IRR bisection, amortization, waterfall, RLV), report HTML builders,
CSV/Excel exporters, territory resolver, ZIP resolver, NTA name simplifier.
