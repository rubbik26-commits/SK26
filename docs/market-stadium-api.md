# Market Stadium API — `/api/market/*`

The Market Stadium half of the unified platform, served by
`server/market-stadium.js` (mounted in `server.js` immediately after the
market-news router, ahead of `gatePipelineDelete`, behind the same
`siteGate` as every other `/api` route). Read-only GET throughout; a
known path with a wrong method answers **405**, an unknown
`/api/market/*` path answers **404 JSON** — the same contract the
assembled server's method guard enforces from its route index.

## The store

Data lives in a chunk store, read **only** through its `manifest.json`:

```
server/data/market-stadium/
  manifest.json            per-chunk SHA-256 + byte counts, universes
  records-city-00.json     393 records      (one chunk per level segment)
  records-county-00.json   1,311 records
  records-zip-00..11.json  23,189 records
  records-tract-00..36.json 72,331 records
  geometries/{city,county,zip,tract}.geojson
  lotlines.geojson  buildings.json  sales.json  news.json  macro.json
  meta.json  moneygration.json  pipeline_full.json  evac_zones.json
```

- Root: env `MARKET_STADIUM_DATA_DIR`, default `server/data/market-stadium/`
  (repo-relative). No other env is required (SYS-02).
- Every chunk read is verified against the manifest (byte count +
  SHA-256) before parsing; a mismatch answers `500 store_integrity`
  naming the file. A missing manifest answers `503
  market_store_unavailable` on every route.
- Chunks are read lazily per level. A slim per-level index (scores,
  tiers, categories, names, parents, CBSA) is built once per level and
  cached; full records are re-read from their chunk on demand (bounded
  LRU, 400 MB of chunk bytes). The ETL's 557 MB monolithic
  `places.json` is never read and is not part of the store.
- Development fallback (documented, not silent): auxiliary files
  (everything except the record chunks and manifest) resolve first in
  the store root, then one level up, then under a sibling
  `data/spine/` tree — which lets the router run against the Phase 1
  build tree (`web/src/data/spine` + `web/src/data` + `data/spine`)
  before B3 stages the canonical layout. The canonical layout always
  wins where both exist.
- Growth basis: the chunk store's Growth/Forecast were recomputed on
  the ACS **2020→2023** basis over the expanded universes (INT-1). The
  focus tract 36061013604 therefore serves C/G/F = **7.3 / 4.5 / 6.87**
  here — not the core build's 7.33 / 4.76 / 7.25 (same model, core
  universes) and not `places.json`'s stale 2021→2023-basis 7.30 / 1.86
  / 6.95. `data/spine/manifest.json`'s method note in the source tree
  still describes the older basis; this paragraph is the correction.
- Geometry files are bare arrays of `{geoid, geometry}` (72,346 tract
  entries — geometry coverage is a superset of the 72,331 scored
  records). The geojson route re-wraps them as a FeatureCollection.
  The shipped ZIP geometry set is the 2020-vintage ZCTA set: point
  location inside postal 10028 returns ZCTA **10128** — that is the
  shipped geometry's identifier, served as stored.

## Endpoints

All responses are JSON unless noted. Paged endpoints accept
`limit` (default 100, max 5000) and `offset` (default 0) and answer
`{total, offset, limit, results}`.

### `GET /api/market/meta` — API-01, SYS-07
Store `generated` stamp, universes per level, per-level chunk counts,
the **factor catalogue** per level (categories; factor codes by kind —
see below; raw field names), and the core build's source/vintage block
(ACS vintages, crime methodology, focus-tract rebuilt vs captured
values). `?level=city|county|zip|tract` narrows `levels` to one level.

### `GET /api/market/records/:level` — API-02
The level's scores summary: one row per geography with `geoid, name,
parent, cbsa, cbsa_name, pop, score_c/g/f, tier_c/g/f, cat_C/G/F`
(11 category scores per kind), `msa_scores` and `msa_cat_C/G/F`
(compared-to-MSA basis; null where the basis does not apply — city
records, and geographies outside a CBSA), crime and climate fields.
Parameters: `sort=c|g|f` (default `c`, descending), `cbsa=`, `parent=`
(case-insensitive), `q=` (name substring / geoid prefix), `min_score=`,
`min_pop=`. Each row carries `rank`: its position in the **full**
level ordering for the chosen sort. Ranks never renumber under a
filter (CTL-09's contract at API level).

### `GET /api/market/record/:level/:geoid` — API-04 + API-05
The full stored record (scores, categories, per-factor scores for all
three kinds, `raw`, `growth`, `series` 2019–2023, `dists`, crime and
climate fields), plus an envelope: `stats` (the record's `raw` block —
the Stats payload, served inline per the replica's contract, API-05),
`scores`, `tiers`, `categories`, `msa_scores`, `msa_categories`.
Unknown geoid → `404 unknown_geoid`.

### `GET /api/market/scores?level=&code=&kind=` — API-03
One factor's percentile scores across a whole level, sorted
descending: `[{geoid, name, score}]`. `kind` is `c` (default), `g` or
`f`. Stored codes: Current uses the base code (`con001`); Growth and
Forecast twins carry the suffix in storage (`con001g`, `con001f`).
Pass the base code with `kind=g|f` and the route resolves the twin; a
suffixed code passed directly is honoured as-is. Unknown code →
`404 unknown_code` with the level's known code list.

### `GET /api/market/factors/:code/meta` — API-12
Per-level, per-kind bounds over the factor's stored scores:
`{min, max, count, total}` (count = non-null scores). Drives the
Factors explorer's range sliders. `?level=` narrows to one level (the
all-level form scans every chunk of every level once, then caches).
Unknown code at every level → 404. For a code whose served input
differs from the standalone replica's same-named factor, the response
also carries a `description` naming the input actually served (today:
`hdem002` — population density in this national store, not the core
store's Census PEP net migration; see the factor dictionary).

### `GET /api/market/search?q=&level=&limit=`
Cross-level search by exact geoid, geoid prefix, or name substring
(case-insensitive). Rows are the records-route summary shape plus
`level` and `match` (`geoid` | `geoid_prefix` | `name`). Default
limit 25, max 200.

### `GET /api/market/locate?lng=&lat=` — API-06 (register form)
Point-in-polygon against the shipped geometries, coarsest-last:
`{levels: {tract, zip, county, city}, resolved}` — each entry
`{geoid, name}` or null. A point outside coverage answers
`resolved: false` with that stated (SRH-04's contract at API level).

### `GET /api/market/geocode?q=` — SRH-01..04
Server-side cascade, in order:
1. **Bare ZIP** — a 5-digit query resolves to the ZIP record, with the
   geometry bbox centre as coordinates.
2. **Buildings index** — a query matching a stored building address
   (the 12,005-lot focus set) resolves to that lot's coordinates + BBL,
   located to all four levels.
3. **Place name** — an exact name match in the record indexes.
4. **External legs** — NYC GeoSearch (Planning Labs), the U.S. Census
   Geocoder (which also returns tract/county directly), Nominatim
   (US-restricted), Photon. Each hit is validated against US bounds
   and located to all four levels; per-leg outcomes are returned in
   `legs` whenever the external cascade ran.

No US-bounded match → `404 no_match` with the leg outcomes and an
explicit message. Nothing is selected on failure — there is no result
to silently keep (SRH-04). Bare partial addresses need no
country/state/ZIP: legs 2–4 carry them.

### `GET /api/market/geojson/:level` — API-06 (plan form)
The level's geometry as a GeoJSON **FeatureCollection**
(`properties.geoid`, `properties.name`), `application/geo+json`,
built once per level and cached. Feature counts: city 393, county
1,311, ZIP 23,191, tract 72,346 (geometry coverage, see store notes).

### `GET /api/market/buildings` — API-07
The focus property set: `{focus, total, total_in_store: 12005,
dof_join, dob_join, tier_derivation, results}`. Filters: `bbox=w,s,e,n`,
or `lat=&lng=&radius_mi=`, or `bbl=`. BBLs are stored in PLUTO float
form (`1015707501.00000000`); all BBL matching in this API normalizes
to the first ten digits.

### `GET /api/market/parcel/:bbl` — API-09 (register form)
The full property card for one BBL from the focus set: PLUTO fields,
DOF join values, the ACRIS deed block, the DOB aggregate, the
propensity inputs and the building tier. The focus lot (427 East 90th
St, BBL 1015707501) carries deed CRFN 2022000431216 and 19 DOB jobs.
DOF note (PROP-02): 11,840 of 12,005 lots carry DOF values from the
FY2018/19 final roll (NYC Open Data `yjxr-fw8i`, the latest the source
publishes); `dof_taxes` is null everywhere because the roll publishes
no tax-bill field — the reason is recorded in the file's `dof_join`
metadata. The focus lot is absent from the 2018/19 roll (its condo
billing lot postdates it) — null by source fact, not by omission.

### Propensity — reconciliation with lucia's own contract (INT-01)

`/api/market/parcel/:bbl` returns a Market Stadium propensity score
and band computed by the replica build's port of lucia's own
`computePropensity` (`server/scoring.js`). The band scale is identical
on both sides — High ≥ 55, Elevated ≥ 35, Watch ≥ 18, else Low — and
`PROPENSITY_THRESHOLD` (35, `server/area-buildings.js`) is the same
Elevated cutoff that `/api/propensity-validation` tests against. One
component differs by data availability: lucia's production scorer
evaluates the "No reinvestment" component (+6) from live DOB permit
counts, while the Market Stadium property file carries no permit
counts, so that component is not evaluated here and the dossier panel
labels the value "Seller propensity — Market Stadium band". The two
scores are never merged; lucia's own propensity surfaces and the
`/api/propensity-validation` contract are unchanged by this
integration, whose `soldCount` rule remains unrecovered in its own
file and is not built on here.

### `GET /api/market/tiles/parcel/:z/:x/:y.mvt` — API-10
Parcel polygons as Mapbox Vector Tiles (layer `parcels`, string
property `bbl`, also the feature id), generated in-process from
`lotlines.geojson` (11,969 of 12,005 lots; 36 lots have no MapPLUTO
polygon in source). Rings are clipped to the tile extent plus a
256-unit buffer and quantized to extent 4096. `z` 10–18. This is the
static-store equivalent of the plan architecture's PostGIS
`ST_AsMVT` shape (replica `sql/001`); the equivalence is contractual
(layer name, property, geometry), not byte-level.
`application/vnd.mapbox-vector-tile`.

### `GET /api/market/sales` — API-08 (plan form)
DOF Rolling Calendar Sales: the file's own aggregates
(`building_sales`: 45 whole-building rows; `all_cd_sales`: all 1,971
rows — uncapped, file window 2025-10-01→2026-09-30 at build time) and
a filtered view with recomputed `{count, avg_price, by_class}`.
Filters: `months=` (window back from the file's latest sale date),
`zip=`, `class=`. Rows carry the ACRIS partial-interest join
(1,875/1,971 matched; `partial_interest` + `partial_interest_pct`,
SAL-03). The register's bbox parameter is **not** servable from this
file — rows carry no coordinates — and is not approximated.

### `GET /api/market/rent/:geoid` — API-09 (plan form), REN-01
Rent comps for one geography from its record's stored raw values:
`median_rent, rent_all, rent_studio, rent_1br, rent_2br, rent_3br`,
sourced from **ACS 2023 5-year tables B25031/B25064** and labelled as
such in the response. Level resolution: 11-digit geoid → tract;
otherwise ZIP, then county, then city (`?level=` overrides). A bedroom
cell the ACS suppresses in source answers null — the honest empty
state (PNL-07's residue). **Listing leg (REN-02/REN-03): not served.**
No listing feed (RentCast or equivalent) exists without the owner's
API key; the response states `listing_feed.status: "unavailable"`
with the reason instead of estimating listing values.

### `GET /api/market/news` — API-11 (NEW rows)
The Market Stadium news file (publisher RSS pipeline: PincusCo, The
Real Deal NY + national, Bisnow NY, Google News incl. `site:traded.co`
— Traded publishes no RSS, measured 404/525 in Phase 1). Every story
carries the fixed extraction schema (headline, url, source, published,
kind, sentiment, amount, where, who, deal, deal_type in the plan's
enum, address/buyer/seller entities, tract join where a NYC street
address resolved, `matched_owner`). Filters: `sentiment=`, `since=`,
`tract=`, `kind=`. The response includes the corpus sentiment tallies.
`matched_owner` is computed against the buildings store at ETL time;
the Phase 1 window measured 0 matches — none is fabricated (NEW-05).
This surface coexists with the Territory headlines at `/api/news`
(B0) — different panel, different contract, both ship.

### `GET /api/market/macro` — API-11 (MAC rows)
The FRED series file as stored (7 series with label, unit, latest
observation, year-over-year change, full point history), regenerated
by the ETL refresh. Series metadata ships in the file (MAC-02).

### `GET /api/market/pipeline` — CAP-01
Construction pipeline over NYC DOB NOW job filings: stage counts for
the focus footprint (planning 28,243 / underway 17,007 / completed
35,932 / deferred 145 / abandoned 860 = 82,187 jobs, full history),
the citywide universe counts when the full-history file is served,
the stage mapping (the source has no "bidding" stage — absent, not
zero), and paged job rows. Filter: `stage=`. The response names which
file it served (`pipeline_full.json` full history, or the
`pipeline.json` client extract whose in-file window note states its
≥2023-01-01 table window).

### `GET /api/market/moneygration` — CAP-02
IRS Statistics of Income county-to-county migration flows (2022–2023)
for the 150 core counties, as stored: per-county inflow/outflow totals
and top partners. `?fips=` returns one county or `404 unknown_county`.

## Factor dictionary (served codes)

Codes are the plan's Step 2/3 factors. Current codes are the base
form; Growth/Forecast twins append `g`/`f`. Public-source substitutes
for the original's proprietary inputs are labelled here and in the UI
— never presented as the original input.

| Category | Codes | Stored input (public source) |
|---|---|---|
| Connectivity | con001, con002, con003 | EPA SLD v3 NatWalkInd; FAA ACAIS CY2024 enplanement gravity index (the plan's BTS T-100 input is **not obtainable** — DAT-13; no surface claims BTS); EPA SLD D4B050 |
| Economy | eco001, eco002, eco004 | BEA CAINC1 GDP per capita; ACS B23025 employed; ACS B23025 unemployment (plan input BLS LAUS **blocked at source**, 403 evidence in the ETL tree — labelled fallback) |
| Housing Demand | hdem001, hdem002, hdem003 | ACS B01003 population; population density for hdem002 in the served national store (ACS 2023 B01003 population ÷ land area in sq mi from the Census TIGER2024 geometries — build_spine.py:488,579; the standalone replica's core tri-state store scores hdem002 from Census PEP net migration instead, which PEP does not publish for tracts/ZIPs nationally); ACS B07001 moved-in share |
| Housing Supply | hsup005, hsup006, hsup007, hou006 | HUD SOCDS permits 2020–2022 + NYC DOB (plan input Census BPS county tables discontinued); ACS B25002 vacancy (inverse); ACS B25001 units |
| Housing Value | hval001 | ACS B25077 median home value |
| Human Capital | hcap001, hcap002, hcap003, hcap004, hcap007 | ACS B19013 / B19001 / B15001 (bachelor's+ share, age 25–44) / B15003 / B19301 |
| Innovation | tal037p, tal038p, tal058p, tal060p, tal063p | LODES8 WAC 2021 composites (the stored codes carry the `p` suffix) |
| Land Regulation | reg001 (in category scores) | Wharton WRLURI 2018. County/CBSA carry real variation (117 / 289 distinct values); tract/ZIP hold a single value by source fact — NYC's five borough counties returned no 2018 survey (exhaustive scan in Phase 1), so there is no borough-level variation to serve |
| Safety | saf001, saf002 | NYPD Complaint Data 2025 (NYC tracts/ZIPs); state UCR county totals — NY DCJS 2024, NJ UCR 2023, PA UCR 2024. Plan input FBI CDE is **blocked** beyond the tri-state (API returns 403 API_KEY_MISSING; the free data.gov key is the owner's signup). CBSAs carry safety only where every member county has a series (31 of 393). City-level `factor_scores` omits the Safety codes for the same reason |
| Talent | tal020, tal030, tal035, tal045 | ACS B23025 / C24030 sector shares |
| Tax | tax001 | ACS effective rate (median real-estate taxes ÷ median value, B25103 + B25077, inverse); 510 core tracts null in source |

Scoring model: PERCENT_RANK × 10 with midrank ties, computed per level
over that level's full universe; categories are factor means; the
market score is the category mean; tiers derive from the score. The
growth twin is the same model on the 2020→2023 basis; the forecast
twin is the winsorized trend projection documented in the replica's
`docs/scoring_model.md`. An independent recompute of this model over
the shipped data reproduces the served focus-tract and NY-MSA scores
digit-for-digit (VAL-01; the recompute lives in the Phase 4 test, not
in production code).

## What is not served, and why (recorded, not stubbed)

- **API-13 — the dynamic (Supabase `mi` schema) form of this
  contract.** The replica's `sql/001–003` define it (PostGIS tables +
  PostgREST RPCs mirroring these route shapes). It is **blocked**:
  GAP-15 — the `mi` schema decision and credentials are the owner's,
  and the docs name three different Supabase projects as production
  (integration plan §7); no project is treated as authoritative until
  he decides. The static-store form above is the shipped
  implementation of the same contract; the route handlers are the seam
  if the dynamic form is later approved.
- **API-14 — captured-frontend context.** The original product's
  account/billing/agent surfaces (Auth0, favorites, layers,
  notifications, Stripe, the Marty agent endpoints) are their SaaS
  infrastructure, recorded in the requirements register as context —
  not rebuild scope under the plan, and no code here imitates them.
- **CAP-06 — Marty AI chat.** The replication plan explicitly defers
  it ("clone the panels first"). No substitute chatbot is shipped.
- **DAT-13 — BTS T-100.** Not obtainable from public bulk sources
  (measured 404s; download links are session-generated; evidence in
  the replica's `data/raw/evidence/`). The connectivity factors ship
  on FAA ACAIS + EPA SLD inputs, labelled in the dictionary above.
- **DAT-26 — the captured county dictionary (`fipsmap.json`).** A
  captured file, used in Phase 1 only as the GEO-05 diff basis: its
  values match the shipped parents; their records carry no
  CBSA-assignment field. Never a build source (SYS-04).
- **DAT-28 — the captured bikeshare/e-scooter file.** No plan step
  builds on it; no destination, recorded here for completeness.
- **SCR-10 / GAP-10 — exact-score parity with the original.** The
  original's weights and vendor feed are server-side; the plan itself
  records that its exact scores cannot be copied. This API serves the
  replica model's own scores, labelled as such in `/api/market/meta`'s
  provenance block.

## Deployment (SYS-03)

No new service, port, or migration. The router mounts inside the
existing `server.js` process; the Render build is unchanged. Env names
only: `MARKET_STADIUM_DATA_DIR` (optional), plus the gate's existing
`SITE_PASSWORD` / `OWNER_PASSWORD` which this router inherits by mount
position. The store adds ≈0.93 GB to the deployment payload — the
recorded cost of the only gate-compatible, non-blocked storage option
(integration plan §4, §9 hazard 12).
