# Coverage Matrix — production frontend → this deployment

What the owner's live application does, and where each piece is served from in
this repository. The compiled production bundle is the authority: it is served
byte-identical, and this repo's job is to answer its API contract from real
records.

Two things are true of every row below and are worth stating once:

- **The compiled frontend is not reimplemented.** `index-BbnE3o5g.js` and
  `index-shmfCHKD.css` are served exactly as built, checksum pinned. Every
  route, panel, document and interaction in the "Frontend" column is the
  original code running unmodified.
- **The production data path is real records.** PostGIS (MapPLUTO, ACRIS, DOB,
  DOF, NTA) first, live NYC Open Data second. The owner's curated parcel
  records remain only as a cold-start floor for the home strip, and
  `server/production-live-guard.js` turns a failed authoritative pull into an
  explicit `live_source_unavailable` rather than a substituted fact.

## The immutable frontend

| Artifact | Where it comes from |
| --- | --- |
| `index-BbnE3o5g.js` (1.75 MB) | `server/data/production-frontend/*.part-*.b64` → `scripts/reconstruct-frontend.js` → `public/assets/`, SHA-256 `4b49749f…5f93f8` |
| `index-shmfCHKD.css` (123 KB) | Same pipeline, SHA-256 `d883de91…55124b` |
| `index.html` shell | `public/index.html` — the ZIP shell plus two same-origin scripts: `/js/supabase-env.js` then `/js/production-auth-bridge.js`, both before the bundle |
| Untouched ZIP export | `site/` stays mounted for byte comparison |
| Live verification | `GET /api/frontend-parity` reports served bytes vs pinned hashes |

No build or runtime path contacts the legacy origin. A byte that cannot be
reproduced locally fails the build and stops the server from listening.

## Routes (12 of 12)

Each route is the original compiled page; the column names the endpoints this
server answers for it.

| Route | Served by |
| --- | --- |
| `/` Market Intel | `/api/opportunities`, `/api/area-buildings`, `/api/nta-polys`, `/api/lot-at`, `/api/lot-tiles`, `/api/bldg-tiles`, `/api/footprints`, `/api/market-index` |
| `/dossier` Parcel Dossier | `/api/asset-history`, `/api/cliffs`, `/api/distress`, `/api/tax-history`, `/api/assemblage`, `/api/transit`, `/api/contacts`, `/api/liensale`, `/api/livepull`, `/api/listingcheck`, `/api/airtable-xref`, `/api/similar` |
| `/pipeline` Pipeline / CRM | `/api/pipeline` (kanban rows; `?zips=` is the DOB development feed), Supabase `cre_pipeline` for signed-in users |
| `/live` Live Details | `/api/nearby`, `/api/lot-at`, `/api/address`, `/api/streetview`, `/api/staticmap` |
| `/territory` Territory Mastery | `/api/territory`, `/api/area-detail`, `/api/demographics`, `/api/owner-portfolio` |
| `/radar` Deal Radar | `/api/area-buildings?sort=propensity`, `/api/propensity-validation` |
| `/calculator` Deal Calculator | Client-side underwriting + document generation; `/api/market-report` for context |
| `/comps` Comps / Land Index | `/api/market-index`, `/api/market-report` |
| `/present` Presentation Mode | Reuses the dossier and market endpoints |
| `/investors` Investors | `/api/investors`, `/api/pinecone-status` (owner tier) |
| `/desk` My Desk | Supabase workspace tables + `/api/maturity-wall` |
| `/sources` Source Registry | `/api/status`, `/api/sources`, `/api/maps-usage`, `/api/frontend-parity` |

## Geospatial — mock math replaced with PostGIS

The single largest change from the pre-migration state. Every question below
was previously answered by centroid arithmetic over a synthetic parcel set.

| Question | Now answered by | Fallback |
| --- | --- | --- |
| What lot did the user click? | `lot_at()` — `ST_Contains` against the real MapPLUTO polygon, with a `ST_DWithin` nearest-lot fallback (~70 m) so a sidewalk click still resolves | Live PLUTO bounding-box + nearest centroid |
| What neighborhoods are in view? | `nta_polys()` — `ST_MakeEnvelope` bounding-box query against 2020 NTA polygons | Packaged `server/data/nta-polys.json` |
| Which lots assemble with this one? | `assemblage_at()` — same owner of record **and** `ST_Touches` physical contiguity (or same block) | Live PLUTO same-owner-on-block |
| What is the opportunity universe? | `parcels_opportunities()` — unused-FAR ranked, raw PLUTO vocabulary so the production scorer applies unchanged | Live PLUTO by borough → curated records |
| Tax history / contacts | `tax_history_at()`, `parcel_contacts()` | Live DOF roll, DOB permits, ACRIS parties |

Schema: `supabase/migrations/202608130003_postgis_geospatial.sql` —
`parcels` (BBL primary key, `geometry(MultiPolygon,4326)`, GiST), `acris_docs`,
`dob_filings`, `tax_bills`, `ntas`. RLS on all five: public NYC records are
world-readable, writes only through the service role. Ingestion
(`ingest_parcels`, `ingest_ntas`) is `service_role` only and normalizes GeoJSON
in SQL.

Adapter: `server/adapters/postgis.js` over PostgREST RPC — no additional
driver dependency. When the store is unconfigured or unreachable it returns
null and the endpoint falls through to the live path, so behavior is identical
either way.

## Ingestion

| Worker | Source | Target |
| --- | --- | --- |
| `scripts/ingest/mappluto.js` | DCP MapPLUTO FeatureServer (lot polygons + attributes) | `parcels` |
| `scripts/ingest/nta.js` | Socrata `9nt8-h7nd` | `ntas` |
| `scripts/ingest/acris.js` | ACRIS legals → master → parties | `acris_docs` |
| `scripts/ingest/dob.js` | DOB NOW `w9ak-ipjd`, DOB permits `ipu4-2q9a` | `dob_filings` |
| `scripts/ingest/tax.js` | DOF PVAD `8y4t-faws` | `tax_bills` |
| `scripts/ingest/run-all.js` | All of the above, bounded by `--zips` / `--borough` / `--limit` | — |

## Contract fixes made during the migration

| Symptom in the UI | Cause | Fix |
| --- | --- | --- |
| Dossier crashed on parcels with energy data | `/api/cliffs` emitted `undefined` for `exYears`/`initYear`/`endYear` and could emit non-numbers for the LL97 figures, which the template passes straight to `.toLocaleString()` | `safeJ51` / `safeLl97` in `server/routes-bundle.js` emit the exact keys as safe `Number` primitives; a genuinely absent record stays `null` so the UI hides the row |
| LL97 / LL33 never rendered for any building | Both LL84 adapters queried `bbl_10_digits`, which does not exist on the current disclosure — every lookup returned zero rows | Query `nyc_borough_block_and_lot` against the consolidated 2023-present vintage (`5zyy-y8am`) |
| Maturity wall panel absent | `configured` was derived from whether any loan qualified, so an answered ACRIS pull with no qualifying debt looked unconfigured | `liveMaturityWall` reports whether the source answered; the route only reports unconfigured on a real source failure |
| "Model validation" panel absent | Thin sales overlap returned a null lift | Wider live windows plus a per-ZIP cache |

## Security and deployment

| Concern | Where |
| --- | --- |
| Global password wall | `server/gate.js` — protects everything but `/assets/*` and `/healthz`; accepts the `ndi_gate` cookie, the legacy `site_access` cookie, or HTTP Basic auth; `/api/*` gets 401 JSON, pages get the form |
| Owner tier | `OWNER_PASSWORD` → `gateRole()` → `/api/pinecone-status.owner`, gating Investors, Source Registry, CRM xref |
| Session propagation | `public/js/production-auth-bridge.js` attaches the Supabase access token to same-origin `/api/*` calls |
| Supabase project decoupling | `/js/supabase-env.js` + the same bridge rewrite the bundle's baked-in project and publishable key |
| Paid-resource metering | `server/durable-cost.js` + `cre_reserve_3d_session` — 3D fails closed when the durable counter is unreachable |
| Deployment blueprint | `render.yaml` — build, start, `/healthz`, full env contract |

## Deliberate design decisions

| Decision | Why |
| --- | --- |
| Serve the compiled bundle rather than a reimplementation | Behavioral, visual and contractual parity with the running site is the requirement; a rewrite cannot prove parity |
| Chunk set as the canonical asset source | Git handles 20 KB text parts well, and it makes the build hermetic — the deploy owes nothing to the legacy host |
| PostGIS reached over PostgREST RPC | No new runtime dependency, and the same credentials already used for auth; spatial predicates stay in SQL where the GiST indexes are |
| PostGIS first, live Socrata second | The store is authoritative for geometry but need not be complete; an unseeded deployment behaves exactly as before |
| Curated parcels retained | Cold-start floor only, so the home strip cannot render empty; never used to answer a parcel-specific question |
| No generic LL97 limit invented in `/api/production-regulatory` | The applicable limit is building- and use-specific; the regulatory endpoint publishes only what DOB and LL84 actually report. The dossier's `/api/cliffs` estimate is separately labeled as an estimate, matching the original UI's wording |
