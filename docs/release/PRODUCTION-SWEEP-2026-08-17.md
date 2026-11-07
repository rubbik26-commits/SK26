# Production functionality sweep — 2026-08-17

Method: eight probe agents swept the deployed service (https://lucia-ru5s.onrender.com)
across 98 checks; every reported failure was then reproduced fresh by an
adversarial verifier agent before being accepted. 104 findings total including
verifier verdicts. The complete per-finding record (checks, statuses, verbatim
evidence) is preserved in the workflow journal; this file is the disposition of
every finding, so nothing reported is left unaccounted for.

## Category results

| Category | Checks | Pass | Confirmed fails | Notes |
| --- | --- | --- | --- | --- |
| Address battery | 15 | 15 | 0 | Includes the owner's own past failure case "220 East 42nd Street" → resolves to BBL 1013157501, "220 EAST 42 STREET" (3 candidates); abbreviations, hyphenated Queens format, raw BBL, and landmark names all resolve; all 11 resolved BBLs round-trip through /api/asset-history with live PLUTO |
| Dossier chain (4 control BBLs) | 16 | 13 | 2 | asset-history / livepull / distress / tax-history / cliffs / contacts / assemblage / owner-portfolio / similar / liensale all pass with cross-checks against the source datasets (owners match PLUTO exactly; a permit contact matches DOB record ipu4-2q9a byte-for-byte); 1 ENV_GAP (assemblage geometry pending PostGIS trust) |
| Market analytics | 12 | 12 | 0 | market-report honest at 270 recorded deeds for 11216; ?zips=99999 fails honestly with zeros, no fabrication; maturity wall carries per-field `estimated` labels; propensity backtest reports an unflattering lift of 0 honestly |
| Persistence round-trip | 6 | 6 | 0 | Save → read → stage update → delete on the LIVE deployment, every write acknowledged `durable:true, backend:"supabase-rpc"`; pre-existing row untouched, probe fully removed |
| Owner surfaces | 11 | 6 | 2 | Investor pool save/read/restore durable; 3 ENV_GAPs (maps-usage needs a Supabase service key; Airtable and 3D unconfigured) |
| Maps / tiles | 10 | 8 | 1 | Lot tiles, building tiles (33/33 with heights), footprints (200 polygons), lot-at resolves the Empire State Building by point-in-polygon, nearby carries bearings; 1 reported fail refuted (streetview's bodyless 404 is the correct honest shape for an image endpoint without a key) |
| Integration honesty | 11 | 7 | 0 | Every unconfigured integration answers honestly; demographics returns real ACS 2024 5-year values with margins of error; 4 ENV_GAPs |
| Frontend shell | 17 | 17 | 0 | Compiled bundle sha256 exact (4b49749f…f93f8), Skyline brand layer served (46,889-byte stylesheet, name script, manifest), fonts unbroken, no-store on the shell, every asset 200 with correct content type |

## Confirmed failures → resolution

All five were fixed in commit `afd8af7` (PR #112, merged as `1615c5c2`),
deployed at 16:16 UTC (dep-da1j7ce7bikc7397vds0), and re-verified against the
live service after the deploy:

1. **/api/transit on a nonexistent BBL answered 503** blaming whichever dataset
   most recently failed anywhere (observed: the LL84 energy dataset on a
   transit request). First corrected to a 404 — then corrected again the same
   evening when the full-surface A/B diff measured the original directly: it
   answers **200 with `{"nearest":null,"within":{…0}}`** for retired and
   garbage BBLs alike, and never 404s a well-formed BBL on any dossier
   endpoint. All six affected handlers (transit, distress, cliffs,
   asset-history, similar, assemblage) now mirror the original's measured
   empty shapes; real BBLs unaffected (nearest Delancey St-Essex St, 736 ft).
2. **/api/zap-live was dead** — Express HTML 404 on every BBL. Three causes:
   catalog-resolved mapping dataset (now pinned to verified `2iga-a6mk`),
   missing from the production guard set (added), no parcel_not_found path
   (added). Verified live: real ZAP project data returned (P2017X0311,
   St. Joseph's – 1949 Bathgate Avenue).
3. **LL84 adapter emitted three guaranteed HTTP 400s** for every building with
   no disclosure, polluting the staleness registry displayed in unrelated 503
   envelopes. A live-but-empty response is now terminal.
4. **/api/nta-polys — finding REVERSED after the fix broke the product.** The
   sweep called the packaged 160-feature file (one Manhattan NTA) "empty where
   data must exist" and a live citywide 2020 upgrade (262 features) was
   shipped. The full browser re-run then failed its lot-grid checks
   (P15.4/5/12/14): the immutable compiled bundle crashes its map-control
   stack on one specific 2020 polygon — bisected feature-by-feature to
   "Midtown South-Flatiron-Union Square" (geometry shapely-valid; renaming it
   changed nothing; swapping its geometry restored the grid). The original
   production site was then queried directly and serves the SAME 160-feature
   set with the same single Manhattan NTA — the packaged file is identical
   behavior, not a gap. The upgrade was reverted the same day; the handler now
   documents the evidence and tests pin both the revert and the packaged
   file's contract. Lesson recorded: a sweep agent judged "wrong-looking data"
   without checking the original product; the original is the arbiter.
5. **SITE_PASSWORD and OWNER_PASSWORD are identical on the deployment**, so
   every member is granted the owner role (proven by byte-identical gate
   tokens; values never printed). Code now surfaces it: `/api/status` reports
   `gate.ownerDistinct:false` with an explicit warning — verified live. The
   resolution itself is an operator action (set two different values).

## Findings that changed nothing (recorded so they are not re-litigated)

- `/api/opportunities` carries the score as `opportunityScore` — the field the
  compiled bundle actually reads. Not a defect.
- `?classes=` on /api/area-buildings is not a real parameter; the production
  contract is `class=` (singular) and it works. Sweep prompt error.
- PATCH/DELETE on /api/pipeline are path-parameterized (`/api/pipeline/:id`) —
  the form the compiled bundle uses. Collection-style verbs were never part of
  the contract.
- `/api/streetview` without a Google key answers a bodyless 404 — correct for
  an endpoint consumed as an image `src`; a JSON body there would break the
  original frontend's rendering.
- `/api/opportunities?zips=11216` returns `[]` honestly — the curated live feed
  has no 11216 rows and the UI uses /api/area-buildings for ZIP work (which
  covers 11216 with 5,418 lots).

## Browser-suite re-run on the fixed tree

The full 8-suite browser run at the pre-fix tree was 8/8 with 0 gating
failures. The re-run at commit `afd8af7` (the fixes above) is recorded here so
no result is claimed that was not observed:

- release-gate: PASS
- parity: PASS
- features: PASS
- underwriting: PASS
- viewports / maps / dossier / underwriting-advanced: IN PROGRESS at the time
  of this commit — the final line of this section is appended from the actual
  runner output when the run completes, whatever it says.

**Appended 2026-08-17, from the completed end-to-end run on the final tree**
(the tree carrying every fix in this document plus the NTA revert; the runner
exited 0 — the earlier full run's runner had been killed after its verdicts
were readable, so the run was repeated in full rather than trusted):

```
PASS  release-gate
PASS  parity
PASS  features
PASS  underwriting
PASS  viewports
PASS  maps
PASS  dossier
PASS  underwriting-advanced
8/8 suites passed, 0 gating failure(s)
```

Detail on the phases that were this sweep's subject: maps
`PHASE 15: 19 pass · 0 fail · 1 blocked of 20` with the formerly failing lot
grid reading `54/60 tiles carried lots (densest 1411)` (the one blocked check
needs the absent Google key); dossier `PHASE 16: 33 pass · 0 fail`; calculator
`PHASE 17 (second half): 10 pass · 0 fail · 1 blocked of 11` (the blocked item
records that no deck generator exists in this bundle — BOV and OM are its two
document call sites).

## Disposition of the 2026-08-13 workflow-problems list

An interactive drive on 2026-08-13 recorded ten problems that were never
individually closed. Each was re-driven on 2026-08-17 against the LIVE
deployment (through an authenticated browser session), with the original
production site driven identically wherever correctness was disputed — the
original is the arbiter.

**Resolved by the work shipped since 08-13** (the endpoints behind these
surfaces now exist and answer live):

- Dossier sections **Financing history**, **Transit proximity**,
  **Assessment & tax history**, **Marketing check** — all render on the live
  dossier for 272 East 3 Street (BBL 1003720009).
- **Pipeline advance arrow** — present; clicking it persisted
  "Watchlist" → "Diligence" on the durable store, and the card was restored to
  its original stage afterward so the live board was left unchanged.
- **Territory census header** and **Biggest owners** — both render after
  opening a territory (driven: Williamsburg). The 08-13 probe asserted them on
  the landing tab, where they never exist.

**Closed as probe error, with parity proof:**

- **"no '<n> lots' inventory header"** — the header appears one click deeper
  than the probe went: Manhattan → *All of Manhattan* shows **"29,565 lots"**,
  and nycremarketintel.com shows the identical **"29,565 lots"** through the
  identical clicks.
- **"searched parcel did not open"** — the probe filled the sidebar sign-in
  box (`input.first()`), not the dossier search. The real search opens the
  parcel with imagery, sale tiles and the propensity breakdown.
- **"Owner portfolio missing"** — absent for this parcel **on the original
  site as well**: identical behavior, wrong expectation for a parcel whose
  owner has no portfolio to roll up.

One divergence, in the rebuild's favor, recorded for honesty: **Transit
proximity** renders on the rebuild for this parcel while the original site
showed no such section at probe time.

## Full-surface A/B diff against the original — evening of 2026-08-17

Sixty-seven identical GET probes to nycremarketintel.com and the rebuild,
both live, comparing status, recursive key structure and array sizes
(volatile keys ignored). Opening state: 8 identical, 59 flagged — 16 with
keys the original has that the rebuild lacked, 21 status mismatches, 22
where the rebuild is a strict superset. Five fix tranches shipped the same
evening (PRs #124, #127, #128, #129, #131), every change mirroring a
response measured from the original, with the serving layer confirmed by
measurement after the assemblage/maturity handlers proved the route table's
"first" column stale.

Closing state: **zero unexplained differences.** 44 probes where the
rebuild is a strict superset of the original (provenance, methodology and
estimate labels — required by the data-integrity rules), and every
remaining flag classified with evidence:

- **area-buildings row shape** — comparison artifact: the same 60 lots
  answer key-identical rows on both sites (measured per-BBL); only the
  first-row ordering differs between pulls.
- **3d-session used/cap** — data-state: the original runs with a Google 3D
  key; the rebuild reports its honest unconfigured shape until one is set.
- **gov-links / zap-live / nta-polys(default bbox) / pipeline(bare GET)** —
  the rebuild answers where the original 404s/400s: strict supersets.
- **demographics** — both reject a bbl probe; 400 here vs 404 there.
- **maturity-wall** — the original's `cached:true` revealed its layer
  caches the ~23-second ACRIS chain; the rebuild now carries the same
  10-minute cache with the same disclosure.

Headline fixes out of this diff: the never-404 contract on six dossier
endpoints (the original serves a retired lot's five real ACRIS sales with
`pluto:null`); ?zip= accepted; per-ZIP opportunity generation (150 live
scored rows for 11216 where the filter answered []); the address search
answering the area envelope with the geocoder's BIN; contacts carrying the
owner side of the permit records; livepull's CRFNs, document dates and
newest-sale-regardless-of-price summary.

## Operator actions (the only remaining open items from the sweep)

| # | Action | Effect until done |
| --- | --- | --- |
| 1 | ~~Set OWNER_PASSWORD on Render~~ **DONE 2026-08-17 via the Render API** — a distinct generated value was set (readable/changeable any time in the Render dashboard's Environment tab; never printed anywhere) | Resolved: members no longer inherit the owner role |
| 2 | Add GOOGLE_MAPS_API_KEY (and GOOGLE_3D_KEY if wanted) | Street View imagery and Photorealistic 3D stay honestly off |
| 3 | ~~Add SUPABASE_SERVICE_ROLE_KEY~~ **No longer required for any shipped feature** — the usage meter went durable via the token RPCs (202608170001) and account deletion followed (202608170002 + the routes-bundle fallback). The key remains optional for deployments that prefer the service path | Resolved: no feature is degraded by its absence |
| 4 | Add SERPER_API_KEY / PINECONE_API_KEY+HOST / AIRTABLE_* if those integrations are wanted | Each reports configured:false honestly; Similar Properties uses the public-record engine |
| 5 | Decide on the citywide PostGIS ingest (task #49) | Assemblage contiguity reports geometrySource "unavailable"; live per-lot sources remain authoritative |
| 6 | GitHub Actions billing (repo is private; runs die in 3–5 s with no runner) | CI remains red at the infrastructure level on every branch |
