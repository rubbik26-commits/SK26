# Parity status — 2026-08-20

Measured with `scratchpad/ab-full.mjs`, the 46-probe A/B differ, against
https://nycremarketintel.com with the owner gate on both sides.

    ===== 39 identical, 7 differing of 46 =====

A probe counts as identical only when the whole response body matches byte for
byte after volatile fields are removed, and a field is called volatile only
after calling the SAME side twice and seeing it move — never by assumption.
The rebuild is warmed before each comparison, because the original has been
serving for months and discloses cache state (`cached: true`, a frozen
`checked`) that a freshly restarted rebuild cannot on its first call.

## Identical (39)

opportunities (bare / multifamily / development) · area-buildings (score,
page 1) · address · area-detail (sales, owners, buildings) · pipeline ·
asset-history (MN, BK) · contacts BK · cliffs · distress · tax-history (MN, BK,
QN) · assemblage · transit · liensale · owner-portfolio · listingcheck ·
websearch · territory (multifamily, office) · market-report · market-index ·
maturity-wall · nearby · livepull · footprints · lot-tiles · bldg-tiles ·
nta-polys · zip-at · the 400 bodies · the unrouted 404.

## Differing (7), and why

### Environment, not code (4)

These differ because this deployment is configured differently from the
original, and matching them would mean degrading a working surface.

| Probe | Original | Rebuild | Cause |
|---|---|---|---|
| `similar` | `configured:false`, 0 matches | `configured:true`, 8 matches | Pinecone is configured here and not there |
| `pinecone-status` | `configured:false` | `configured:true` | same |
| `3d-session` | `configured:true`, a key, cap 200 | `configured:false`, null, 0 | the original holds a `GOOGLE_3D_KEY`; this environment does not |
| `maps-usage` | streetview 36, staticmap 155 | 0, 82 | live usage counters — state, not contract |

**Security, unchanged since first reported:** the original serves a live Google
API key in plaintext from `/api/3d-session` to any gated visitor. It should be
rotated. It has never been copied into this repo; presence and scope only were
ever checked.

### Measured limits, recorded rather than guessed (3)

**`contacts` on the deepest-permit lots.** Down to one key — which mortgage the
debt block reads. Both sides issue the byte-identical query (the original
publishes it in its own `sources[0]`), but `issuance_date` is a TEXT column, so
`DESC` sorts lexicographically over this lot's 3,402 permits and 12 of them
carry no date at all. Measured: **2 distinct 50-row windows across 5 identical
requests**. Nine of twelve probed lots are byte-identical; the three that are
not are the ones with the deepest permit history. See the note in
`server/live.js` above `permitContacts`.

**`listing-check.checked`.** The original's value is frozen across calls — it is
its cache-creation stamp, not a clock read. The rebuild caches identically and
freezes its own. The absolute values cannot agree.

**`propensity-validation.soldCount`.** The envelope, key order, `baseCount`
500, `threshold` 35, the 400 body and the lift rules all match. `soldCount` does
not. About 250 combinations were swept (window lengths 335-390 days, window end
dates 0-120 days back, seven price floors, five join targets); the best scored
3 of 8 ZIPs, and two ZIPs are unreachable by any single rule — 11216's target
of 161 EXCEEDS its 157 candidates while 10314's 294 sits far below its 476. I
do not know the exact cause of this yet. See the note in
`server/production-propensity-validation.js`.

## Deliberate divergences, on the record

- `/api/transit` and `/api/assemblage` return empty everywhere on the original;
  its sources appear to be down. The rebuild returns real answers and was NOT
  degraded to match.
- `/api/investors` answers 200 to EVERY HTTP method on the original; the rebuild
  registers GET and POST. `POST /api/pipeline` is 405 on the original — matching
  it would disable the kanban writes. `/api/status`, `/api/auth/signup`,
  `/api/user/saved` and `/api/account/delete` are 404 on the original but served
  here. All four are the owner's call, not an engineering one.

## Operator items

- No `GOOGLE_MAPS_API_KEY` in this environment, so Street View answers 503. The
  Mapbox token is present and `/api/staticmap` is fine.
- `AIRTABLE_API_KEY` and `AIRTABLE_BASE_ID` are present but both fail Airtable's
  PAT/base-id format check (verified by presence only).
- `SERPER_API_KEY` returns HTTP 403.
- Render is running a DUPLICATE service, `lucia-9hpv`, alongside the live
  `lucia-ru5s`. It fails every build because a blueprint replica receives none
  of the `sync: false` secrets. `render.yaml` declares one web service; the
  duplicate came from creating a second Blueprint instead of syncing the
  existing one. Delete the service AND its Blueprint instance.

## Not yet done

- Mobile responsiveness / overlap / blockers — the scanner is written
  (`scratchpad/mobile-scan.cjs`: overflow, `elementFromPoint` overlap,
  off-screen/covered controls, sub-44px tap targets, clipped text, across 13
  routes x 6 widths) and has not yet been run to a fix.
- The eight browser suites — running at the time of writing.
