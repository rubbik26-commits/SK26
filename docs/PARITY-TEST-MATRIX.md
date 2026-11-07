# Parity Audit & Test Matrix

**What is served:** the owner's original compiled production frontend — byte-identical to the
`nycremarketintel-site` export and to what nycremarketintel.com serves (SHA-1
`aa89e9b7ff87189e677b94c3f8b7bcd9d855fb51`, checksum-pinned in the vendor script and hardening
tests) — backed by this repo's server answering the frontend's exact API contract with live NYC
public records. Contract source of truth: the compiled bundle's own fetch sites (params, field
names, envelopes, gates) plus response bodies captured from the running production site.

**Verification layers:** `npm test` (70 tests: golden units, API contract/permissions/failure
states, production hardening, route resolution, synthetic-data refusal, durable store, account-store
degradation, gate roles) · `npm run test:browser`, which boots the app and runs eight gating
Chromium suites — release gate, parity, features, underwriting, viewport sweep, maps/geospatial,
dossier, and advanced underwriting · `node tests/release-gate-negatives.mjs`, which proves each
gate by deliberately breaking what it guards and requiring a failure ·
(The CI workflow that previously ran these suites was removed at the owner's
direction on 2026-08-17; the deployed verification runs directly via
`node scripts/run-browser-tests.mjs <deployment-url>`.)

**Phase reports, each with its own evidence:** `docs/release/PHASE-14-MATRIX.md`,
`PHASE-15-MAPS.md` (19 pass · 0 fail · 1 blocked), `PHASE-16-DOSSIER.md`
(33 pass · 0 fail), `PHASE-17-CALCULATOR.md` (10 pass · 0 fail · 1 blocked),
`PHASE-18-VIEWPORTS.md`, and the running ledger in `VERIFICATION.md`.

**Two corrections this file previously got wrong, kept visible rather than quietly edited:**
the lot grid was drawing 1 lot per tile where the DOF tax map records 37 — `/api/lot-tiles` was
being answered by a 34,138-feature ArcGIS subset mounted one line ahead of the authoritative
DOF-backed handler — and the building-footprint dataset had been retired upstream while still
answering HTTP 200 with every row emptied. Both are fixed; both are why "you can't even click
them" was true.

**Status legend — read this before trusting a row.**

| Mark | Meaning |
| --- | --- |
| ✅ | Exercised end-to-end and the behaviour was observed. Where a figure is claimed, it was compared against the running production site. |
| ⚠ | Partly working. The gap is stated in the row. Do not read this as done. |
| ❔ | The code path exists and is wired, but has never been exercised against the production Supabase / Render deployment. Unverified. |

An earlier revision of this file marked every row ✅. That was wrong: several
rows were marked complete on the strength of the code existing rather than on
observed behaviour. The marks below were re-derived from actual runs.

## Route-by-route status

| Surface | Data path | Verified by | Status |
| --- | --- | --- | --- |
| Market Intel (home): map, markers, filters, area drill, strip | `/api/opportunities` — live PLUTO feed, 150 parcels, original field vocabulary, production-fitted scoring; curated seeds only if every Socrata pull fails | workflows + suite | ✅ live |
| Opportunity dossier drawer + Live Data Pull | `/api/livepull` — raw Socrata rows per source (rolling sales, PLUTO, DOB, DOB NOW, ZAP, ACRIS legals/master/parties), query-URL transparency, exact/corridor modes, debt + permit-contact blocks | workflows | ✅ live |
| Area inventory ("every building in…") | `/api/area-buildings` — live PLUTO, bundle sort keys, class groups, `pageSize` envelope; ghost condo-billing rows excluded | workflows | ✅ live |
| Building drill-down (Live Records) | `/api/livepull` by building row | workflows | ✅ live |
| Lot grid / building tiles / mbtile basemaps | `/api/lot-tiles` `/api/bldg-tiles` `/api/mbtile/*` | route sweep + curl | ✅ |
| Parcel Dossier page (search → full record) | `/api/address` (live PLUTO search) + `/api/asset-history` (ACRIS deeds/mortgages + DOF + permits + comps) + transit/cliffs/distress/liensale/assemblage/tax-history/owner-portfolio in the bundle's exact shapes | workflows | ✅ live |
| Marketing check / listing check / websearch | `/api/listingcheck` `/api/listing-check` `/api/websearch` — Serper-backed when `SERPER_API_KEY` set; honest off-states with the one-click platform searches otherwise | workflows + suite | ✅ (key optional) |
| Pipeline / CRM kanban | `/api/pipeline` — signed-in rows in Supabase `cre_pipeline`; requests with no bearer use the durable store (`public.app_state`, disk fallback) | workflows + suite + `tests/durable-store.test.mjs` | ⚠ signed-in path unverified (no credentials). The no-account tier now survives a redeploy when `SUPABASE_DB_URL` is set — proven end-to-end: row written, `APP_DATA_DIR` deleted, server restarted, row still served. Without that variable it is still disk-only, and `/api/status.persistence.survivesRedeploy` says so |
| Development pipeline (report section) | `/api/pipeline?zips=` — live DOB NOW filings by `postcode`, counts aggregated over a 36-month window | curl vs production | ✅ live — byte-identical to production for 11216: counts {234, 89, 39, 5524}, 60 sites, identical first row and coverage sentence |
| Live Details (AR nearby) | `/api/nearby` (+`bearing`), `/api/footprints` | curl | ✅ (footprint polygons pending a resolvable city dataset) |
| Territory Mastery | `/api/territory` — live census/sales/top/owners | workflows | ✅ live |
| Deal Radar | `/api/area-buildings` + `/api/propensity-validation` (`lift/soldCount/soldHitPct/baseHitPct/threshold`) | workflows | ✅ live |
| Deal Calculator | client-side engine (bundle) | route sweep | ✅ |
| Comps / Land Index | `/api/market-index` — live rolling-sales submarkets for Manhattan/Brooklyn/Queens + comps with `landSf` | workflows | ✅ live |
| Market report | `/api/market-report` — nine classes from DOF `building_class_category`, per-class PLUTO stock | curl vs production | ⚠ 7 of 9 class rows byte-exact vs production, plus `recordedTotal`, the window and all three narrative sentences. Open: Development/land stock returns null (rule not recovered), residential-condo row is one sale short, prior-period comparisons are not calculated |
| Presentation Mode | static bundle content | route sweep | ✅ |
| My Desk / watchlist / canvass / profiles | Supabase (`qrcpeskqkoyacnmjuxni`) direct from the bundle — `cre_profiles/cre_watchlist/cre_pipeline/cre_canvass` | bundle contract extraction only | ❔ never exercised against the production database — no credentials in this environment |
| Sign in (magic link + password) | Supabase auth, baked-in publishable key | bundle contract extraction | ✅ (unchanged from production) |
| Account deletion | `POST /api/account-delete` with Supabase bearer → verify + service-role cascade | suite (off-state only) | ❔ the refusal path is tested; the deletion itself and its isolation between accounts have never been run |
| Owner mode (Investors, Source Registry, xref, similar) | `/api/pinecone-status.owner` from the owner-tier gate password (`OWNER_PASSWORD`); soft-gated envelopes, never 401 | workflows + suite | ✅ |
| Investor pool | `/api/investors` — signed-in book in Supabase `cre_investors`; requests with no bearer use the durable store (`public.app_state`, disk fallback) | workflows + suite + `tests/durable-store.test.mjs` | ⚠ signed-in path unverified (no credentials). The no-account tier now survives a redeploy when `SUPABASE_DB_URL` is set — proven end-to-end alongside the kanban |
| CRM cross-reference | `/api/airtable-xref` — `sellerMatches/buyerMatches` when `AIRTABLE_*` set | suite (off-state) | ✅ (key optional) |
| Similar properties (AI) | `/api/similar` — Pinecone when configured, otherwise the live-PLUTO public-record similarity engine | exercised with Pinecone unset | ✅ — 8 real comps returned on BBL 1000160010, engine `public-record-similarity`. Previously this answered `{configured:false}` and disabled the feature |
| Street View / aerial imagery | `/api/streetview` `/api/staticmap` — Google when `GOOGLE_MAPS_KEY` set; `<img onError>` hides otherwise (bundle behavior) | route sweep | ✅ (key optional) |
| Photorealistic 3D | `/api/3d-session` — fail-closed durable quota (Supabase-backed) | suite (fail-closed path) | ❔ the refusal is tested; the quota has never been exercised against the production database, at or past its cap |
| Maps usage meters | `/api/maps-usage` — signed-in owners read the durable `cre_usage_daily` counters that gate spend | workflows | ❔ routing to the durable reader is proven; the counter values have never been read from the production database |
| Maturity wall | `/api/maturity-wall` — live ACRIS mortgages; maturity and balance are modelled and labelled as such at both the API and the UI | curl | ⚠ the signed-in gap in this row is closed — `server/production-private.js` now returns `configured:true` with rows built from the user's own pipeline parcels by the same estimator the anonymous wall uses, each carrying per-field estimate flags. Still ⚠ because ACRIS publishes the mortgage document, not its terms: rate is null unless the record carries one, and maturity is accurate to the year |
| Site gate | `/__gate` — same form/cookie/401 state as production; `SITE_PASSWORD` (+ owner tier) | curl parity probes, `tests/gate-role.test.mjs` | ✅ role resolution pinned for all four credential forms: no gate ⇒ owner (private/local), gate + no credential ⇒ anon, site password ⇒ member never owner, owner password ⇒ owner |
| 404 page | bundle router | route sweep, `parity-browser.cjs` | ✅ |
| Hash routing | the bundle is a hash-routed SPA — `/pipeline` renders Market Intel, `#/pipeline` renders Pipeline | `parity-browser.cjs` fingerprints, `phase14-matrix.cjs` deeplink column | ✅ 13 routes produce 13 distinct rendered bodies; the release gate used to address them by path and so loaded one page twelve times |

## Honesty & fallback rules

- Live pulls fall back to the owner's own curated universe (never invented records); per-parcel
  evidence endpoints return their sections empty/hidden rather than fabricating rows.
- Key-gated subsystems (Serper, Pinecone, Airtable, Google imagery/3D, Census, SMTP) report
  `configured:false` states with the bundle's own off-state copy until their env keys are set —
  the full list lives in `render.yaml`.

## Deployment

`render.yaml` pins Node (`node:sqlite` needs ≥22.12), sets the health check, and enumerates the
env-var surface. The compiled frontend is committed (`site/` + vendored `public/assets/`) so
builds are hermetic. On Render's free plan the durable state that matters (accounts, watchlist,
pipeline, canvass, 3D quota) lives in Supabase; local JSON/SQLite stores reset on redeploy
unless a paid disk is mounted.
