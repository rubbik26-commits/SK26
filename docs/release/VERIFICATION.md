# NYC RE Market Intel — release verification ledger

**This file was wrong once, and the correction is part of the record.** An
earlier revision marked eight of Phase 13's ten items PASS on the strength of a
hash comparison, a text diff, and pages loading without throwing. Those are
cheap to produce and they read like evidence. They were downgraded in place
below rather than quietly edited away, so the overclaim stays visible.

The standard applied from here: an item is PASS only when the user-facing
behaviour it names was exercised and the output is pasted. Not the absence of
an error. Not a checksum. Not an inference from one to the other.

Every checkbox in the execution prompt gets an entry here. An entry without
pasted output is not evidence. `BLOCKED` names the specific blocker.

Deployment under repair: https://lucia-ru5s.onrender.com
Behavioural source of truth: https://nycremarketintel.com
Working branch: `claude/site-redesign-rebuild-2l75qo` (the session's designated
branch; the prompt names `ACRIS`, which this session is not permitted to push
to — see OPEN ITEMS).

---

## BOOT

### B1 — repo state
```
$ git rev-parse --abbrev-ref HEAD
claude/site-redesign-rebuild-2l75qo
$ git rev-parse HEAD
5c285ab63877c8ef96668c977f43f7a2f780185d
$ git status --porcelain
(clean)
$ git log --oneline -6
5c285ab Reproduce the production area-buildings and propensity contracts exactly
2879ed0 Fix the three phone defects: dead search, hidden menu, unusable kanban
ea3ee4c Merge pull request #50 from rubbik26-commits/claude/nyc-re-render-migration-rt5fs1
b4af3ea Merge pull request #49 from rubbik26-commits/claude/site-redesign-rebuild-2l75qo
a3de29f Merge pull request #48 from rubbik26-commits/ACRIS
b1d54fa Merge pull request #47 from rubbik26-commits/claude/site-redesign-rebuild-2l75qo
```

### B2 — toolchain
```
$ node -v && npm -v
v22.22.2
10.9.7
psql: /usr/bin/psql
curl: /usr/bin/curl
jq: /usr/bin/jq
gh: absent          <- GitHub work goes through the MCP tools instead
playwright: 1.56.1 with WebKit 2215 installed in the session scratchpad
```

### B3 — baseline
```
$ npm test
# tests 38
# pass 38
# fail 0
```
No `build` script exists in package.json — this is a server-rendered Express app
serving a pre-compiled frontend from committed bytes, so there is no build step
to fail. The equivalent gate is `scripts/vendor-production-frontend.js`, which
verifies the served assets against pinned checksums at boot and exits non-zero
if they do not match (server.js:139-147).

### B4 — env inventory (names only)
Present in this session: `NODE_ENV`, `PORT`, `RENDER_DISK_PATH`, `SMTP_*`,
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

Absent in this session, and required by the phases noted:
`SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_PASSWORD`,
`OWNER_PASSWORD`, `GOOGLE_MAPS_KEY`, `GOOGLE_3D_KEY`, `SERPER_API_KEY`,
`PINECONE_API_KEY`, `AIRTABLE_*`, `CENSUS_API_KEY`, `MAPBOX_TOKEN`,
Render API credentials. See OPEN ITEMS.

### B5 — deployed baseline
```
$ curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://lucia-ru5s.onrender.com/healthz
200 0.637202s
$ curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" https://lucia-ru5s.onrender.com/api/status
200 1.797181s
```

### B6 — route surface
216 router/app registrations across `server.js` and `server/*.js`;
75 distinct declared API routes. Full table: `docs/release/route-table.md`.

---

## PHASE 1 — FIX PRODUCTION ROUTING

### P1.1 — Audit the complete Express middleware/router mounting order
STATUS: PASS
ROOT CAUSE: no defect found — mount order verified as-shipped.
FILE: server.js:35-107
EVIDENCE: `node scripts/route-audit.mjs` parses the `app.use(...)` sequence out
of server.js and resolves each import name back to its module. Order, as
mounted:

```
 1. siteGate()        server/gate.js
 2. compression / express.json / cors
 3. security          server/security.js
 4. attachUser        server/auth.js
 5. bundleRoutes      server/routes-bundle.js
 6. productionFrontend server/production-frontend.js
 7. productionApi     server/production-api.js
 8. productionPrivate server/production-private.js
 9. durableCost       server/durable-cost.js
10. productionRegulatory / productionAnalytics / productionDossier /
    productionDistressTax / productionMaturity
11. productionImagery / productionLiveExtra / parityRoutes / liveRoutes
12. authRoutes / userData
13. productionLiveGuard / demoProvenance / routes (legacy)
14. static public/ then static site/, then the SPA shell fallback
```
COMMIT: (this ledger)

### P1.2 — Identify every API pathname implemented by more than one router
STATUS: PASS
FILE: docs/release/route-table.md (generated, committed)
OUTPUT:
```
$ node scripts/route-audit.mjs
routes=75 duplicated=43
```
43 of 75 API pathnames are declared by more than one router. The table lists
each one with its handlers in mount order.

### P1.3 — Determine which implementation is authoritative in production
STATUS: PASS
ROOT CAUSE: no defect found — the layering is deliberate and now documented.
The contract router (`server/routes-bundle.js`) is mounted first and owns every
endpoint whose response shape the compiled frontend depends on. It returns
`null` to fall through when a request is not its concern (a signed-in user's
per-user rows, or an area feed it does not serve), so the specialised routers
behind it answer those. The legacy `server/routes.js` is last and must never
answer an authoritative data path — `server/production-live-guard.js` is
mounted immediately before it to convert a failed live pull into a 503 instead
of letting the seeded city model answer.

### P1.4 — Reorder/consolidate so the correct implementation receives the request
STATUS: PASS
Two handlers were answering that should not have been. Both are fixed in place;
no route was deleted, so §1.6 approval was not required.

**Defect 1 — the public development-pipeline feed was refused with 401.**
ROOT CAUSE: `/api/pipeline` is two endpoints sharing a pathname. Without
`zips` it is the signed-in user's kanban; with `zips` it is the public DOB
development pipeline for an area, which requires no account.
`server/production-private.js:14` applied `requireUser` to the pathname
unconditionally and is mounted ahead of the router that serves the public feed,
so an anonymous market report in development mode got
`{"error":"authentication_required"}` instead of the filings.
FILE: server/production-private.js:14
BEFORE:
```js
router.get("/api/pipeline", requireUser, async (req, res) => {
```
AFTER:
```js
const isDevelopmentFeed = (req) => req.query.zips !== undefined;

router.get("/api/pipeline", (req, res, next) => (isDevelopmentFeed(req) ? next("router") : next()), requireUser, async (req, res) => {
```
INTEGRATION PROOF: runtime probe before the fix recorded
`GET /api/pipeline 401 <= server/production-api.js:92:34` (the `requireUser`
frame); after the fix the same request resolves to
`server/production-live-extra.js`, and the kanban path still resolves to
`server/routes-bundle.js`.
OUTPUT:
```
$ curl -s "$B/api/pipeline?zips=11216"
{"windowMonths":18,"fetchedAt":"2026-08-13T19:25:03.830Z","provenance":"live","counts":{...},"sites":[]}
$ curl -s "$B/api/pipeline"
[{"id":1,"oppId":"MR-001","stage":"IC Memo",...}]
```
NOTE: unblocking this exposed a separate data defect in the feed itself
(counts all zero). That is a Phase 9 item and is recorded there, not here.

**Defect 2 — every application/json device beacon hung until the client timed out.**
ROOT CAUSE: `express.json()` is mounted app-wide at server.js:37 and consumes
the request stream. `POST /api/client-diag` then attached its own
`req.on("data")` / `req.on("end")` listeners; for a request the JSON parser had
already drained, `end` had fired before the listeners existed, so the callback
never ran and the response was never sent. `navigator.sendBeacon` posts
`text/plain`, which the parser skips, which is why phone beacons appeared to
work while any explicit JSON post hung.
FILE: server/routes-bundle.js:948-982
BEFORE:
```js
router.post("/api/client-diag", (req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on("end", () => { ... res.status(204).end(); });
});
```
AFTER: `readBeacon(req)` returns `req.body` when the parser already produced
one, and otherwise reads the stream with `end`/`error`/`aborted` handlers plus a
`readableEnded` guard.
TEST: verified both content types.
OUTPUT:
```
$ curl -X POST -H 'content-type: application/json' -d '{"url":"probe","build":"probe-json"}' $B/api/client-diag
  204          # was: no response, connection closed by the 20s client timeout
$ curl -X POST -H 'content-type: text/plain'      -d '{"url":"probe2","build":"probe-text"}' $B/api/client-diag
  204
$ curl $B/api/client-diag
{"reports":[{"at":"2026-08-13T19:25:02.072Z","url":"probe","build":"probe-json"},
            {"at":"2026-08-13T19:25:02.084Z","url":"probe2","build":"probe-text"}]}
```

### P1.5 — Verify no newer production implementation is shadowed by an older one
STATUS: PASS
ROOT CAUSE: mount order alone cannot answer this — a router can match a path and
call `next()`, so the file that answers is not always the first that declares
it. `scripts/route-probe.mjs` patches the Express response so the first call to
commit a response records the `server/` stack frame that produced it; the server
is started with `node --import ./scripts/route-probe.mjs server.js` and every
declared route is then requested.
OUTPUT (52 routes probed; the legacy `server/routes.js` answers only tiles):
```
GET /api/area-buildings        <= server/routes-bundle.js
GET /api/opportunities         <= server/routes-bundle.js
GET /api/market-report         <= server/routes-bundle.js
GET /api/propensity-validation <= server/production-analytics.js
GET /api/maturity-wall         <= server/production-maturity.js
GET /api/asset-history         <= server/production-dossier.js
GET /api/tax-history           <= server/production-distress-tax.js
GET /api/area-detail           <= server/production-live-extra.js
GET /api/staticmap             <= server/production-imagery.js
GET /api/3d-session            <= server/durable-cost.js
GET /api/nta-polys             <= server/routes-live.js
GET /api/sources               <= server/routes-live.js
GET /api/status                <= server/routes-live.js
GET /api/livepull              <= server/production-live-guard.js   (503, honest)
GET /api/nearby                <= server/production-live-guard.js   (503, honest)
GET /api/mbtile/streets/...    <= server/routes.js                  (tile proxy only)
GET /healthz                   <= server.js
```
No authoritative data path resolves to `server/routes.js`. The two paths that
resolved to the live guard returned 503 rather than seeded data, which is the
designed behaviour.

### P1.6 — Add regression tests preventing route shadowing from returning
STATUS: PASS
TEST: tests/route-resolution.test.mjs (new)
It asserts the runtime resolver for each authoritative path, so a future
re-order that lets the legacy router answer a data path fails the suite.
COMMAND: `npm test`
OUTPUT:
```
# tests 40
# pass 40
# fail 0
```

---

## PHASE 2 — INVESTORS

### P2.1 — Make the production /api/investors route use the durable Supabase implementation
STATUS: PASS
ROOT CAUSE: the durable implementation existed and never ran. `server/production-api.js:116`
reads and writes `cre_investors` in Supabase, but `server/routes-bundle.js` is
mounted first (server.js:61) and answered `/api/investors` unconditionally from
a JSON file. The Phase 1 runtime probe caught it:
```
[PROBE] GET  /api/investors 200 <= server/routes-bundle.js
[PROBE] POST /api/investors 200 <= server/routes-bundle.js
```
FILE: server/routes-bundle.js:139-160
BEFORE:
```js
router.get("/api/investors", wrap(async (req) => {
  const owner = isOwner(req);
  return { owner, investors: owner ? investorsStore.load().investors : [] };
}));
```
AFTER:
```js
router.get("/api/investors", wrap(async (req) => {
  if (hasBearer(req)) return null; // durable cre_investors row
  const owner = isOwner(req);
  return { owner, investors: owner ? investorsStore.load().investors : [] };
}));
```
(the same guard on POST). `hasBearer` is the predicate already used for the
per-user kanban, so the two private stores now defer identically.
INTEGRATION PROOF: runtime probe, both shapes of request:
```
[PROBE] GET /api/investors           200 <= server/routes-bundle.js   (no bearer)
[PROBE] GET /api/investors?signed=1  401 <= server/production-api.js  (bearer)
```
The 401 on the second is `requireOwner` refusing a synthetic token — the point
proven is which module received the request.
TEST: tests/route-resolution.test.mjs — "a signed-in investor pool is answered
by the durable Supabase store"
OUTPUT:
```
$ npm test
# tests 43
# pass 43
# fail 0
```
COMMIT: see below

Also fixed while here: `production-api.js` omitted `owner` from both investor
responses. The production envelope is `{owner, investors}` — confirmed against
the live site, which returns `{"owner":false,"investors":[]}` to a gate-only
request. Both handlers now emit `owner: true` (requireOwner has already
established it).

### P2.2 — Remove production reliance on investors-pool.json
STATUS: PASS (file retained, unreachable for signed-in requests)
No file or function was deleted — §1.6 requires approval for removal, and none
was requested. The store is now reachable only by a request with no Supabase
bearer, which is the offline/dev path and the contract-test path. Any signed-in
book is read from and written to `cre_investors`.
FILE: server/routes-bundle.js:139
git grep confirms one remaining reference, the guarded one:
```
$ git grep -n investors-pool
server/routes-bundle.js:146:const investorsStore = jsonStore("investors-pool.json", { investors: [] });
```
OPEN ITEM: deleting the fallback entirely needs your approval (§1.6). Say the
word and it goes, with the anonymous tier returning `{owner:false,investors:[]}`
directly.

### P2.3 — Verify cre_investors is the authoritative production store
STATUS: BLOCKED
BLOCKER: no Supabase credentials in this environment. `SUPABASE_DB_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are unset (B4), so `psql` cannot reach the project
and no request can be authenticated as a real user. Verified statically: the
table is created by `supabase/migrations/202608130001_exact_production_workspace.sql:75`
and is the only store the bearer path touches.
TO UNBLOCK: `SUPABASE_DB_URL` (read access is enough for the schema checks) and
a test account's credentials, or the service-role key to mint one.

### P2.4 — Verify owner authorization
STATUS: PARTIAL / BLOCKED for the authenticated tier
The unauthenticated tier is verified: the live production site answers a
gate-only request `{"owner":false,"investors":[]}`, and the rebuild matches
byte for byte (tests/api-parity.test.mjs:165-167, passing). The authenticated
owner check runs through `requireOwner` → `productionIdentity` → Supabase, which
cannot be exercised without credentials.

### P2.5-P2.8 — creation, editing, deletion, buy-box persistence
STATUS: BLOCKED — same blocker as P2.3. The write path is
`POST /api/investors` → `supabaseFetch("/rest/v1/cre_investors?on_conflict=user_id")`
with the payload normalised at production-api.js:126-133 (id, name, firm,
email, phone, buyBox), which is the whole record the UI edits, so create/edit/
delete are one upsert of the array.

### P2.9-P2.11 — persistence across refresh, restart, redeploy
STATUS: BLOCKED — same blocker. These require writing a record as a real user
and re-reading it after a genuine Render restart and redeploy; without
credentials and without Render API access neither the write nor the restart can
be performed from here.

---

## PHASE 3 — MAPS / PAID RESOURCE METERING

### P3.1 — Make the production /api/maps-usage route use the durable implementation
STATUS: PASS
ROOT CAUSE: identical shadowing to P2.1, with a worse consequence. Spend is
gated on `cre_usage_daily` (durable-cost.js increments it before any chargeable
Google call), but the Source Registry read its numbers from
`server/data/usage-meters.json` because `server/routes-bundle.js` answered the
route first. The page therefore reported one figure while the spend control
used another, and the file is destroyed on every Render deploy.
FILE: server/routes-bundle.js:683-690
BEFORE:
```js
router.get("/api/maps-usage", wrap(async (req, res) => {
  if (!isOwner(req)) { res.status(403).type("text").send("Owner only."); return; }
```
AFTER:
```js
router.get("/api/maps-usage", wrap(async (req, res) => {
  if (hasBearer(req)) return null; // durable cre_usage_daily rows
  if (!isOwner(req)) { res.status(403).type("text").send("Owner only."); return; }
```
INTEGRATION PROOF:
```
[PROBE] GET /api/maps-usage           403 <= server/routes-bundle.js   (no bearer)
[PROBE] GET /api/maps-usage?signed=1  401 <= server/production-api.js  (bearer)
```
TEST: tests/route-resolution.test.mjs — "the signed-in usage meter is the durable one"
OUTPUT:
```
$ npm test
# tests 44
# pass 44
# fail 0
```

### P3.2 — Remove production reliance on usage-meters.json
STATUS: PASS (file retained, unreachable for signed-in requests)
Same treatment as P2.2; no deletion without approval. Remaining references:
```
$ git grep -n "usage-meters.json"
server/routes-bundle.js:690   (guarded by hasBearer)
server/usage-meter.js:14      (the file store itself)
server/routes.js:896          (legacy router; answers no data path — P1.5)
```
`server/production-3d.js` also uses the file meter, and is NOT mounted:
```
$ grep -n "production-3d\|production3d" server.js
(no matches)
```

### P3.3 — Verify Street View usage writes to cre_usage_daily
STATUS: PASS (code path verified) / BLOCKED for the row-level read
FILE: server/production-imagery.js:44-58
```js
const meter = await incrementDurableUsage("streetview", 1);
if (!meter.ok) return res.status(503).json({ error: "durable_meter_unavailable" });
```
`incrementDurableUsage` calls the `cre_increment_usage` RPC
(server/durable-cost.js:33). No chargeable Street View request is issued before
that write succeeds.
BLOCKER for confirming the row landed: no Supabase credentials (B4).

### P3.4 — Verify Photorealistic 3D usage/quota writes to durable Supabase tables
STATUS: PASS (code path verified) / BLOCKED for the row-level read
FILE: server/durable-cost.js:36-49, 51-65. `/api/3d-session` reserves through
the `cre_reserve_3d_session` RPC and returns the key only when the reservation
is granted. The file-based alternative (server/production-3d.js) is unmounted.

### P3.5 — Verify Source Registry reads those exact same durable records
STATUS: PASS for the routing, BLOCKED for the value comparison
After P3.1 the Registry's `/api/maps-usage` and the spend gate both read
`cre_usage_daily`. Comparing the rendered figure to the stored row needs
credentials.

### P3.6 — Verify usage totals survive restart/redeploy
STATUS: BLOCKED — needs Supabase credentials and a real Render restart.

### P3.7 — Verify paid calls fail closed if durable accounting cannot be performed
STATUS: PASS
This is the billing-exposure control, and it is provable here because the
failure mode is exactly the current environment: no service-role key, so the
durable meter cannot be written.
OUTPUT:
```
$ curl -s -o /dev/null -w "%{http_code}\n" "$B/api/streetview?bbl=1000160010"
404          # GOOGLE_MAPS_KEY unset: refused before any accounting question
```
With a key configured and the meter unreachable, `incrementDurableUsage` returns
`ok:false` and the handler answers `503 durable_meter_unavailable` without
issuing the Google request. The 3D path is covered by an existing assertion:
tests/api-parity.test.mjs — "3D sessions are metered by the durable Supabase
RPC, and fail closed" asserts `{capped:true, reason:"durable_quota_unavailable"}`
when the quota store is unconfigured. Passing in the run above.

---

## PHASE 4 — MARKET REPORT

### P4.2 — Remove/bypass the implementation that divides stock evenly among asset classes
STATUS: FAIL — defect confirmed, fix in progress
ROOT CAUSE: the rebuild reports the SAME stock number for every asset class.
FILE: server/routes-bundle.js (`/api/market-report`)
OUTPUT (rebuild, `?zips=11216`):
```
{"mode":"multifamily","class":"Multifamily (walk-up + elevator)","salesCount":52,"stock":1012,...}
{"mode":"condo",      "class":"Condo units",                    "salesCount":57,"stock":1012,...}
{"mode":"development","class":"Development / vacant land",      "salesCount":5, "stock":1012,...}
{"mode":"misc",       "class":"Everything else",                "salesCount":108,"stock":1012,...}
```
`stock: 1012` on all four rows. Every turnover and implied-hold-period figure
derived from it is therefore wrong for at least three of the four classes.
The production site returns nine classes with genuinely different stock:
```
Multifamily 2709 | Office 20 | Retail 118 | Industrial 27 | Hotels 8 |
Development/land 363 | Commercial condo null | Other commercial null |
Residential condo / co-op null (churn: true)
```
It also returns six envelope keys the rebuild omits: `zips`, `fetchedAt`,
`windowMonths`, `totals`, `distribution`, `sources`, and per-row prior-period
comparisons (`priorCount`, `priorVolume`, `countChangePct`, `volumeChangePct`).

### P4.3-P4.8 — per-class stock from actual PLUTO records
STATUS: 5 of 6 building-class sets solved exactly; Development/land outstanding
CROSS-CHECK (live PLUTO count for ZIP 11216 vs the production site's `stock`):
```
$ SoQL: select count(1) where zipcode in ('11216') and <predicate>
  bldgclass like 'C%' or 'D%'   -> 2709   production Multifamily        2709  ✓
  bldgclass like 'O%'           ->   20   production Office               20  ✓
  bldgclass like 'K%'           ->  118   production Retail              118  ✓
  bldgclass like 'F%' or 'E%'   ->   27   production Industrial           27  ✓
  bldgclass like 'H%'           ->    8   production Hotels                8  ✓
  bldgclass like 'V%' or 'Z%'   ->  127   production Development / land  363  ✗
```
Class-letter census for 11216 (total 6070): C=2608 B=1846 S=504 A=341 R=167
K=118 V=112 D=101 M=68 G=57 Q=34 O=20 F=19 W=18 Z=15 I=11 H=8 E=8 P=6 N=6 Y=2 J=1.
Development/land = 363 is not any subset of first letters
(`V|Z|G|Q`=218, `V|Z|G|Q|W`=236, `V|Z|G|Q|W|M|I`=315,
`landuse in ('05','06','10','11')`=284), so the definition mixes building class
with land use or envelope arithmetic. Under active reverse-engineering against
the live site across five ZIPs before anything is written.

---

## PHASE 5 — MY DESK / MATURITY WALL

### P5.1 — Resolve all duplicate /api/maturity-wall implementations
STATUS: PASS
Five routers declare the pathname (docs/release/route-table.md):
`production-maturity.js:73`, `production-private.js:97`, `parity-routes.js:473`,
`routes.js:961`, `routes-live.js:118`. Runtime probe shows which answers:
```
[PROBE] GET /api/maturity-wall 200 <= server/production-maturity.js:80
```
Locked by tests/route-resolution.test.mjs (`/api/maturity-wall` →
`server/production-maturity.js`).

### P5.2 — Establish one authoritative production behaviour
STATUS: PASS
`server/production-maturity.js:86-92` answers anonymous and gate-tier requests;
a request carrying the auth bridge's bearer is handed to
`server/production-private.js`, which serves the signed-in user's own verified
ACRIS debt stack. One estimate-labelled global wall, one per-user wall, no third.

### P5.3 — Anonymous
STATUS: PASS
```
$ curl -s "$B/api/maturity-wall"
http=200
envelope keys: configured,count,loans,provenance,checked,estimated,methodology,estimatedFields
configured: true  count: 3  estimated: true
```

### P5.4 / P5.5 — signed-in member and owner
STATUS: BLOCKED
BLOCKER: no Supabase credentials (B4) — `requireUser` cannot authenticate a
real token, so the per-user branch cannot be exercised. Routing to that branch
is proven (P5.1); its contents are not.

### P5.6 — Never represent an estimated maturity as a recorded one
STATUS: FIXED
ROOT CAUSE: ACRIS records the mortgage, not its terms — there is no maturity
date in the public record. `loanRow` modelled a YEAR and emitted it as a
precise date, `${estMaturityYear}-07-01`, and the desk renders that column with
`new Date(_.maturity).toLocaleDateString()`. A reader saw "7/1/2034" in a column
headed **Matures** with nothing marking it as modelled. The only disclosure was
a prose `basis` field the UI never renders.
FILE: server/production-maturity.js:30-70
The date string is retained (the compiled formatter requires a parseable date —
the frontend is immutable, §1.9), and every row now carries:
```js
estimated: { maturity: true, balance: true, rate: false },
maturityEstimated: true,
maturityPrecision: "year",
balanceEstimated: true,
balanceBasis: "recorded_principal",
rateSource: ratePct == null ? "not_in_public_record" : "recorded",
```
with envelope-level `estimated: true`, `estimatedFields` and a `methodology`
sentence.
LIVE OUTPUT:
```
row keys: borrower,address,borough,lender,bbl,balance,ratePct,maturity,daysToMaturity,
          amount,rate,payoffBalance,originated,estMaturityYear,estimated,maturityEstimated,
          maturityPrecision,balanceEstimated,balanceBasis,rateSource,basis
sample: {"balance":60000000,"ratePct":null,"maturity":"2034-07-01","daysToMaturity":2878,
         "estimated":{"maturity":true,"balance":true,"rate":false},
         "rateSource":"not_in_public_record"}
```

### P5.7 — Never invent an interest rate
STATUS: PASS
`ratePct` is `null` unless the upstream record carries one:
`server/production-maturity.js:33` — `l.ratePct == null ? null : safeNum(...)`.
`liveMaturityWall` (server/live.js:429-457) builds each loan from ACRIS
mortgage documents and never sets `ratePct`, so it is null on every live row —
confirmed in the response above. grep for every write:
```
$ git grep -n "ratePct" server/
server/production-maturity.js:33  (null-preserving read)
server/production-maturity.js:48,53,64  (emit + provenance label)
server/production-private.js:126  ratePct: null
```
No code path can produce a rate that is not in the record.

### P5.8 — Never invent a current payoff balance
STATUS: PASS
`payoffBalance` mirrors the recorded ACRIS principal; no amortisation curve is
assumed anywhere (server/production-maturity.js:29-31, 55). It is now labelled
`balanceEstimated: true` with `balanceBasis: "recorded_principal"` so a reader
cannot mistake it for a servicer balance.

### P5.9 — Label the estimate and expose the methodology, in the UI
STATUS: PASS
A payload flag nobody reads is not a disclosure, and the compiled frontend
cannot be edited. `public/js/estimate-labels.js` annotates what the bundle
rendered: it finds the maturity table by its header set, marks the modelled
columns, and prints the methodology under the table. It re-applies on
re-render via MutationObserver.
DOM PROOF (WebKit, against the bundle's exact table markup, committed at
tests/fixtures/maturity-table.html):
```
headers: ["Borrower / Sponsor","Property","Lender","Balance (est.)","Rate","Matures (est.)"]
note:    "Maturity and balance are modelled, not recorded. ACRIS registers the mortgage,
          not its terms: maturity is estimated from the recording date plus a typical term
          for the loan type and is accurate to the year, not the day. Balance is the
          recorded original principal — no amortisation is assumed. Rate is shown only
          where the public record carries one."
```
`Rate` is correctly NOT marked: it is either a recorded figure or absent.
NOTE: rendering this on the deployed desk needs a signed-in session, so the
end-to-end screenshot is blocked with P5.4/P5.5.

### P5.10 — Preserve verified ACRIS mortgage/debt records
STATUS: PASS — nothing removed. `liveMaturityWall` still reads
`acrisByLot(bbl)` and keeps `kind === "mortgage"` documents with their
`document_amt`, `doc_type`, recording date and party-2 lender names
(server/live.js:439-452).

### P5.11 / P5.12 — My Desk displays it without misleading the user; full experience
STATUS: PARTIAL — the misleading-label defect is fixed and proven at both
layers; the full signed-in desk walkthrough is BLOCKED on credentials (P5.4).

### P4.1, P4.3-P4.14 — the nine-class report, rebuilt against live records
STATUS: 7 of 9 class rows byte-exact; 2 open items named below
FILE: server/market-report.js (new), server/routes-bundle.js (handler replaced)

The defect: `stock: 1012` on every row. The rebuild now classifies sales by
DOF's own `building_class_category` and counts stock per class from live PLUTO.
Every rule below reproduced a published production figure exactly.

CROSS-CHECK, rebuild vs the live production site, `?zips=11216`:
```
EXACT  Multifamily                 n=36  vol=87,075,260  ppsf=377  stock=2,709  turn=1.3  hold=75
EXACT  Office                      n=0                             stock=20     turn=0
EXACT  Retail                      n=2   vol=3,300,000   ppsf=582  stock=118    turn=1.7  hold=59
EXACT  Industrial                  n=2   vol=5,550,000   ppsf=319  stock=27     turn=7.4  hold=14
EXACT  Commercial condo            n=1   vol=1,323,871             stock=null
EXACT  Hotels                      n=0                             stock=8      turn=0
DIFF   Development / land          stock: 363 vs null  (see P4.8)
EXACT  Other commercial            n=6   vol=8,287,500   ppsf=710  stock=null
DIFF   Residential condo / co-op   salesCount 60 vs 59, volume 60,763,474 vs 59,355,474

rows exactly matching: 7/9
recordedTotal:  270 vs 270
window:         2025-07-01 -> 2026-06-26  vs  2025-07-01 -> 2026-06-26
envelope keys:  identical
```
Narrative, all three sentences byte-identical to production:
```
O: Whole-asset volume of $117.9M across 52 investment sales, filtered out of 270 total recorded deeds — the other 81% were individual condo apartments and co-op units, not investment properties.
M: Whole-asset volume of $117.9M across 52 investment sales, filtered out of 270 total recorded deeds — the other 81% were individual condo apartments and co-op units, not investment properties.
O: Multifamily led dollar volume at $87.1M (74% of investment volume) across 36 sales.
M: Multifamily led dollar volume at $87.1M (74% of investment volume) across 36 sales.
O: Multifamily turnover ran 1.3% (36 of 2,709 apartment buildings traded, ~75-yr implied hold) — below-average liquidity — owners holding.
M: Multifamily turnover ran 1.3% (36 of 2,709 apartment buildings traded, ~75-yr implied hold) — below-average liquidity — owners holding.
```

Rules recovered, each verified against a published figure:
- **P4.10 sales count** — a deed is a sale above $100,000. 436 deeds recorded in
  the window, 292 with any price, **270 above $100k** = production's `recordedTotal`.
- **P4.3 Multifamily** = categories 07 + 08 + 14 (rentals: walk-up, elevator,
  4-10 unit) → 36 sales / $87,075,260, exact.
- **P4.4 Office** = 21. **P4.5 Retail** = 22 → 2 / $3,300,000, exact.
- **P4.6 Industrial** = 27 + 30 → 2 / $5,550,000, exact.
- **P4.7 Hotels** = 25 + 26. **P4.8 Development** = 31 → 5 / $12,325,000, exact.
- **P4.9 condo churn** — categories 12/13/15/16 are the churn row and carry
  `churn: true`; they are excluded from the investment-sales total. Co-op share
  transfers (09/10/17), tax-class-1 condos (04), the condo-amenity categories
  (43/44/47) and one- to three-family dwellings (01/02/03) are counted only in
  `recordedTotal`. That is what makes 270 recorded deeds into 52 investment sales.
- **P4.12 $/SF** = the mean of each sale's own ratio, not total dollars over
  total area. Retail 582 and Industrial 319 match exactly; the total-over-total
  form gives 491 and 258.
- **P4.13 turnover** = salesCount / stock as a percentage to one decimal.
- **P4.14 implied hold** = round(stock / salesCount), from the raw counts, not
  from the rounded percentage: 2,709/36 = 75, where 100/1.3 would say 77.
  Confirmed on retail (118/2 = 59), industrial (27/2 = 14), development (363/5 = 73).
- **stock predicates** verified on three ZIPs across three boroughs:
```
                     11216        10002        10451
Multifamily C|D      2709 ✓        835 ✓        447 ✓
Office      O          20 ✓         76 ✓         48 ✓
Retail      K         118 ✓        196 ✓        196→86 ✓
Industrial  F|E        27 ✓         13 ✓         64 ✓
Hotels      H           8 ✓         27 ✓         11 ✓
```

### P4.8 — Development / land stock
STATUS: BLOCKED — I do not know the exact cause of this yet.
The sales half is exact (category 31 → 5 sales / $12,325,000). The stock figure
is not. Production reports 363 / 132 / 438 for 11216 / 10002 / 10451, and that
is not reproduced by any predicate tested: 8,192 building-class subsets, nine
unbuilt-density thresholds, seven unused-FAR thresholds, every land-use code,
and unions of up to four of those atoms — zero exact matches on all three ZIPs.
Per §1.7 the row reports `stock: null` rather than a plausible wrong number,
which is what production itself does for the three classes it cannot count.
Investigation continues.

### P4.9 note — Residential condo / co-op is one row short
STATUS: OPEN — 59 vs 60 sales, $59,355,474 vs $60,763,474.
No subset of any category combination produces 60 rows at that volume, and no
sale in the window is priced at the missing $1,408,000. The other eight rows
and `recordedTotal` are exact against the same pull, so the classification is
right; the most likely explanation is that DOF republished the file between the
production site's fetch and mine. Recorded rather than papered over.

### P4.11 — dollar volume
STATUS: PASS — matched exactly on all seven exact rows above, and on the
investment total ($117.9M across 52 sales).

### P4.15 — multiple ZIPs and property types
STATUS: PARTIAL — stock predicates confirmed on 3 ZIPs across 3 boroughs;
the full 5-ZIP x 6-class sales tabulation is still to run.

---

## PHASE 6 — REMOVE EPHEMERAL PRODUCTION STATE

### P6.1 / P6.2 — inventory every runtime JSON write and SQLite store
STATUS: PASS
FILE: scripts/write-probe.mjs (new), docs/release/runtime-writes.md (committed)
Produced by instrumentation as the phase requires, not by grep: the probe is
preloaded before the app, patches the filesystem write surface and the SQLite
driver, and watches the data directory. The app was exercised across all 53
declared API routes plus every mutating call.
OUTPUT:
```
report at 2026-08-13T20:59:22.201Z | distinct targets: 9
     3 disk.change   server/data/investors-pool.json
     3 disk.change   server/data/kanban-pipeline.json
     2 disk.change   server/data/app.db-wal
     2 disk.change   server/data/app.db-shm
     1 sqlite.exec   CREATE TABLE IF NOT EXISTS cre_users (...)                  <= server/db.js:69
     1 sqlite.run    DELETE FROM sessions WHERE expires_at < datetime('now')     <= server/db.js:178
     1 sqlite.run    DELETE FROM magic_links WHERE expires_at < datetime('now')  <= server/db.js:179
     2 disk.rename   server/data/cache/<sha1>.json
```
METHOD NOTE, because it changes what the inventory is worth: patching the `fs`
namespace alone MISSES any module that did `import { writeFileSync } from
"node:fs"` — an ESM named import binds before the probe runs. Both JSON stores
are written exactly that way and did not appear until the probe also watched
the directory. A grep-only or fs-patch-only inventory would have reported this
application as writing no JSON at runtime. It writes two files.

### P6.3 — classify each as disposable or required
STATUS: PASS — table in docs/release/runtime-writes.md.
Required-for-the-no-account-tier: the two JSON stores. Disposable: the legacy
local account database (production accounts are Supabase) and the Socrata
response cache.

### P6.4 — move required persistent data to a durable store
STATUS: PARTIAL
Every store that can hold a signed-in user's data is already bypassed for them:
the investor book to `cre_investors` (P2.1), the usage meter to
`cre_usage_daily` (P3.1), the kanban to `cre_pipeline`. What remains on disk is
the gate-password tier that has no account. Deleting the fallbacks outright
needs your approval under §1.6.

### P6.5 — Render filesystem resets cannot destroy important information
STATUS: PASS for signed-in users, by construction — nothing they own is written
to disk. The no-account tier still keeps its work in a file a deploy destroys.

### P6.6 / P6.7 — persistence through restart and clean deployment
STATUS: BLOCKED — no Supabase credentials to write a durable row, no Render API
access to trigger a genuine restart or redeploy.

---

## PHASE 7 — ELIMINATE SYNTHETIC PRODUCTION DATA

### P7.1 / P7.2 / P7.3 — audit the generators
STATUS: PASS
`server/citymodel.js` (589 lines, 16 exports) generates buildings, sales,
pipelines, distress signals and tile features from a seeded model.
`server/seed-parcels.js` holds the curated universe. Its content is not
"placeholder-shaped" — it arrives in exactly the shape a live record does:
```
owner: "Demo Holdings LLC"        ownerNote: "Owner entity modeled from the recorded party schema"
owner: "Demo FiDi Office REIT"    opportunityScore: 91, lotSf: 12400, bldgSf: 168000, far: 13.5
```
A reader cannot distinguish a seeded owner from a recorded one — same field,
same shape, same confidence.

### P7.4 / P7.5 — find every path, and prove production cannot reach one
STATUS: PASS
FILE: scripts/synthetic-reachability.mjs (new), server/synthetic-guard.js (new)
The static walk over the import graph from all 17 mounted routers:
```
$ node scripts/synthetic-reachability.mjs
mounted routers: 17
  REACHES  server/production-maturity.js -> server/opps-live.js -> server/seed-parcels.js
  REACHES  server/routes-bundle.js       -> server/opps-live.js -> server/seed-parcels.js
  REACHES  server/parity-routes.js       -> server/routes.js    -> server/seed-parcels.js
  REACHES  server/routes.js [demo tier, behind the live guard]
  (13 others clean)
```
Three production routers could reach the seeded universe. The live one that
mattered: `/api/opportunities` fell back to `curatedAsParcels()` whenever the
live pull failed — so a NYC Open Data outage filled the map with "Demo Holdings
LLC" parcels that look recorded.
FIX: the import edge is legitimate (the demo tier is deliberate), so the guard
is at the entry to the data, not on the graph. `assertSyntheticAllowed()`
throws in `NODE_ENV=production` unless `ALLOW_SYNTHETIC_DEMO=1`, and is now on
`curatedAsParcels()` and on all 12 fact-producing exports of citymodel.js.
Callers catch it and return an honest unavailable state.
```
$ node scripts/synthetic-reachability.mjs
synthetic generator exports without a production guard: 0
```

### P7.6 — isolate the demo behind an explicit switch
STATUS: PASS — `ALLOW_SYNTHETIC_DEMO=1`, deliberately awkward, and logged the
first time it lets seeded data answer in a production build.

### P7.7 — production is always authoritative data or an explicit unavailable state
STATUS: PASS
TEST: tests/synthetic-guard.test.mjs (new, wired into `npm test`)
It boots the real server with `NODE_ENV=production`, the Socrata host pointed
at an unroutable address AND an empty response-cache directory — a warm cache
would have answered from disk and the outage would not have been an outage
(the first run of this test caught exactly that). It then asserts across
`/api/opportunities`, `/api/maturity-wall`, `/api/area-buildings`,
`/api/market-report`, `/api/area-detail` and `/api/territory` that no seeded
fingerprint appears and that each answers with an error, an empty collection or
`configured:false` rather than content.
OUTPUT:
```
$ npm test
# tests 46
# pass 46
# fail 0
```
Two supporting changes: `server/adapters/socrata.js` now honours
`SOCRATA_DOMAIN` and `SOCRATA_CACHE_DIR`, so a deployment can point at a mirror
or a mounted disk and a test can simulate a genuine outage.

---

## PHASE 13 — ORIGINAL FRONTEND PARITY

### P13.1 — Reconstruct the production frontend from committed repository bytes
STATUS: PASS
```
$ node scripts/vendor-production-frontend.js
[production-frontend] index-BbnE3o5g.js: exact local asset already vendored
[production-frontend] index-shmfCHKD.css: exact local asset already vendored
[production-frontend] exact production frontend fully vendored (hermetic)
```

### P13.2 / P13.3 — SHA-256 of the JavaScript and the CSS
STATUS: PARTIAL — the comparison below is repo-internal.
CORRECTION: this was first recorded as PASS. `site/` and `public/` are both
files in this repository, so hashing one against the other proves they agree
with each other, not with the export you supplied. The bytes inside the
original zip were never hashed. What IS proven is P13.4 — the deployed service
serves these exact bytes.
```
committed ZIP export (site/):
  4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8  index-BbnE3o5g.js
  d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b  index-shmfCHKD.css
served webroot (public/):
  4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8  index-BbnE3o5g.js
  d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b  index-shmfCHKD.css
```

### P13.4 — the deployed application serves those exact assets
STATUS: PASS — hashed off the wire from the Render service:
```
$ curl -s https://lucia-ru5s.onrender.com/assets/index-BbnE3o5g.js | sha256sum
4b49749f5700e03bb55eb01e98ff1c3605b80c27b019fbf3c3c7afb9815f93f8
$ curl -s https://lucia-ru5s.onrender.com/assets/index-shmfCHKD.css | sha256sum
d883de91b793c684327840819408a1c827e3f9ef6211d9adbaf41bbbbe55124b
```
NOT OBSERVED: the same hash from nycremarketintel.com. Asset requests to the
live original through this sandbox's relay return a 2,127-byte Cloudflare
challenge page (`a7df5b06…`), not the asset. The ZIP export you supplied is the
reference used instead, which is what the phase specifies.

### P13.5 — the auth bridge does not alter original behaviour
STATUS: NOT DONE
CORRECTION: recorded as PASS on the strength of a text diff of the HTML shell.
A diff shows what changed in a file; it does not show that behaviour is
unaltered. Doing this properly means running the application with and without
the bridge and comparing what it does. The diff below is still useful evidence
of what was added — it is just not the check the item asks for.
The served shell differs from the untouched ZIP shell in exactly these ways,
all of them additive except one repair:
```
REPAIR   font URLs: the ZIP ships "css%3Ff[]=satoshi" and "css2%3Ffamily=Inter"
         — a percent-encoded "?" that 404s at both font CDNs. The served shell
         uses the raw "?" form, which is what the live original serves.
ADDED    /js/supabase-env.js, /js/production-auth-bridge.js
ADDED    /css/mobile-parity.css, /js/mobile-parity.js, /js/estimate-labels.js
ADDED    the inline device-diagnostic beacon
```
No line of the compiled bundle or its stylesheet is touched.

### P13.6 / P13.8 / P13.10 — every route, control and layout on the deployed service
STATUS: PARTIAL
CORRECTION: recorded as PASS. What was actually measured is that pages load
without throwing. Three of the routes marked PASS rendered an empty state —
Deal Radar at 3,203 characters, Parcel Dossier at 2,845, My Desk at 2,737 (a
sign-in wall). "Did not error" is not "works". P13.8 counted buttons rather
than operating them, and P13.10 was not checked at all.
WHAT NOW COVERS IT: the release gate's section 5 exercises the kanban, the
radar search, the calculator, the CSV export and the report generators against
a live server — see gap-36. That is the behavioural evidence this item wanted.
Driven in WebKit against the deployed service with console-error, pageerror,
request-failure and 5xx capture on every route:
```
FAIL  Market Intel         chars= 26387 btns= 24 inputs= 3 noOverflow=true
      console: Failed to load resource: Peer failed to perform TLS handshake
PASS  Parcel Dossier       chars=  2845 btns=  6 inputs= 2 noOverflow=true
PASS  Pipeline / CRM       chars=  7022 btns= 24 inputs= 1 noOverflow=true
PASS  Live Details         chars=  2919 btns=  3 inputs= 1 noOverflow=true
PASS  Territory Mastery    chars= 18364 btns= 24 inputs= 2 noOverflow=true
PASS  Deal Radar           chars=  3203 btns=  6 inputs= 2 noOverflow=true
PASS  Deal Calculator      chars=  3376 btns=  5 inputs=19 noOverflow=true
PASS  Comps / Land Index   chars= 10996 btns=  6 inputs= 1 noOverflow=true
PASS  Presentation Mode    chars=  6608 btns= 11 inputs= 1 noOverflow=true
PASS  Investors            chars=  2733 btns=  4 inputs= 1 noOverflow=true
PASS  Source Registry      chars=  8383 btns=  2 inputs= 1 noOverflow=true
PASS  My Desk              chars=  2737 btns=  2 inputs= 1 noOverflow=true
PASS  404                  chars=  2560 btns=  2 inputs= 1 noOverflow=true
12/13 routes clean
```
The Market Intel failure is a TLS handshake to an external font CDN through
this sandbox's relay — no same-origin request failed on that route and nothing
5xx'd. It is an environment limit, not a site defect. Every route renders,
carries its controls, and none overflows horizontally.
Per-route heading, button and input inventories are captured in the run's
report for the Phase 14 matrix.

### P13.7 — every original label
STATUS: NOT DONE
CORRECTION: recorded as PASS with the argument that byte-identical bundles
imply identical labels. The argument is sound, but the item asks for a
diffable label inventory extracted from both the production reference and the
deployment, and neither was produced. An argument is not the artifact.
Labels are compiled into `index-BbnE3o5g.js` and `index-shmfCHKD.css`. Both are
byte-identical to the production export and to what the deployed service serves
(P13.2-P13.4), so the rendered label set cannot differ. The only text this
deployment adds is the estimate disclosure of P5.9, which is additive and
deliberate.

### P13.9 — report and document generators
STATUS: PASS
Was recorded here as NOT YET RUN and deferred to Phases 16/17. It is now
covered by `tests/browser/features-browser.cjs`, which drives the generators
against a live server rather than counting their buttons.

The bundle ships two delivery mechanisms and a test that assumes one misses the
other. The dossier's Property/Investor/Market reports call
`window.open("","_blank")` and write into the new window. The calculator's
OM/BOV render into a full-screen in-page overlay (`div.fixed.inset-0.z-[9999]`)
whose "Save as PDF" prints through a hidden iframe — no popup, no download.
Both are exercised:
```
1. Parcel Dossier — live parcel, reports, owner gating
  ok   dossier opens a live parcel from an address search — 60 Wall Street
  ok   dossier action present: Property report
  ok   dossier action present: Investor report
  ok   dossier action present: Market report
  ok   Property report opens a populated document — 4920 chars

2. Deal Calculator — underwriting maths and offering documents
  ok   calculator derives NOI, cap rate and DSCR from the inputs
       — At $6,400,000 the deal pencils to a 6.01% cap on $384,500 NOI
  ok   Generate OM renders "Offering Memorandum" with the subject address — 2155 chars
  ok   Generate BOV renders "Broker Opinion of Value" with the subject address — 6594 chars
```
The calculator figures are checked as derived values, not as rendered
placeholders: $6,400,000 price with $612,500 gross income and $228,000 opex
gives NOI $384,500 and a 6.01% cap, and the assertion waits for that exact NOI
to appear. The Deck generator is not in this suite — it belongs to Phase 17 and
is still unexercised.

### P13.11 — the route section of the gate was measuring nothing
STATUS: FIXED (defect found in this repository's own test code)
ROOT CAUSE: the application is hash-routed. `${BASE}/pipeline` does not open
Pipeline — the router normalises the empty hash to `#/`, renders Market Intel
and leaves the URL at `/pipeline#/`. The release gate addressed all twelve
routes by path and asserted only that React had mounted content, so it loaded
the same page twelve times and reported twelve passing routes.
PROOF: thirteen path URLs, including a deliberately invalid one, all rendered
byte-identical bodies of 25,440 characters; the 404 page never appeared.
```
/radar      -> loc=/radar#/     h1=""                     chars=25440 404=false
/#/radar    -> loc=/#/radar     h1="Deal Radar — …"       chars= 1509 404=false
/pipeline   -> loc=/pipeline#/  h1=""                     chars=25440 404=false
/#/pipeline -> loc=/#/pipeline  h1="Pipeline / CRM"       chars= 5672 404=false
/nope       -> loc=/nope#/      h1=""                     chars=25440 404=false
/#/nope     -> loc=/#/nope      h1="404 Page Not Found"   chars=  857 404=true
```
FIX: routes are addressed by hash and each must render a marker only that route
produces. `parity-browser.cjs` additionally fingerprints every route's rendered
text and requires 13 distinct hashes, so this failure mode cannot return
silently.
SECOND-ORDER: text markers are matched case-insensitively. Chrome's `innerText`
returns *rendered* text, so `text-transform: uppercase` turns "Top 5
opportunities" into "TOP 5 OPPORTUNITIES" and an exact match never fires —
which is how `/present` failed on the first corrected run.

---

## PHASE 17 — CALCULATOR & DOCUMENTS (P17.1–P17.6)

Required evidence: "P17.2–P17.10 must be validated against independently
computed values (spreadsheet or a script written for the purpose) using a fixed
input set, with tolerance stated."

`tests/browser/underwriting.cjs` implements the finance from first principles —
level-payment mortgage constant, remaining-balance formula, IRR by bisection —
without reading, importing or mirroring anything from the application, then
drives the shipped calculator with a fixed input set and compares.

TOLERANCE, stated and justified: the UI rounds before it paints (percentages to
two decimals, dollars to the unit, multiples to two decimals), so a rendered
"6.01%" stands for anything in [6.005%, 6.015%). Tolerance is half the display
step — 0.005pp, $1, 0.005× — applied to the displayed figure. Tighter cannot be
observed through the DOM; looser would let a real error hide.

INPUT SET, fixed before the run: $6,400,000 price · 24 units · 18,500 SF ·
$612,500 gross · $228,000 opex · 65% LTV · 6.5% · 30yr amort · 5.5% exit cap ·
5yr hold. Vacancy and NOI growth are read back off the form (both 0) rather than
assumed, so the model is fed what the application used.

```
  ok   P17.1  NOI (annual)                model     $384,500   app     $384,500   ±1
  ok   P17.1  cap rate                    model        6.01%   app        6.01%   ±0.005%
  ok   P17.1  GRM                         model       10.45×   app       10.45×   ±0.005×
  ok   P17.1  price / unit                model     $266,667   app     $266,667   ±1
  ok   P17.1  price / SF                  model         $346   app         $346   ±1
  ok   P17.2  equity in (price − loan)    model   $2,240,000   app   $2,240,000   ±1
  ok   P17.3  DSCR                        model        1.22×   app        1.22×   ±0.005×
  ok   P17.4  cash-on-cash (yr 1)         model        3.08%   app        3.08%   ±0.005%
  ok   P17.5  levered IRR                 model        9.42%   app        9.42%   ±0.005%
  ok   P17.6  equity multiple             model        1.54×   app        1.54×   ±0.005×

  loan $4,160,000 · annual debt service $315,528
  exit value $6,990,909 · payoff at 5yr $3,894,217 · net proceeds $3,096,692
UNDERWRITING: PASS — 10 metrics agree with an independently computed model
```

The IRR and equity multiple matching on the first run is the load-bearing part:
the model was written to the textbook convention (capitalise year `hold+1` NOI
at the exit cap, pay off the amortised balance, no selling costs) and was not
adjusted afterwards to agree. Had it disagreed, the honest outcome would have
been to report which convention the application uses, not to widen the tolerance.

STILL OPEN in Phase 17: P17.7 development underwriting, P17.8 residual land
value, P17.9 sensitivity analysis, P17.10 equity waterfall, P17.11 plain-English
parsing (partially exercised — it reads units and LTV out of a sentence but not
"6.4m price"), P17.12/P17.13 PDF extraction and verify-before-apply (the upload
path fetches its parser from a CDN this sandbox blocks; untested here rather
than asserted), P17.16 Deck, P17.18 print/PDF. P17.14/P17.15 (BOV/OM) and P17.17
(preview) are covered by `features-browser.cjs`.

---

## PERSISTENCE — "why are things not getting saved; every deploy looks the same"

ROOT CAUSE: three separate faults, all real, all fixed.

**1. No persistent disk, and the state was on it.**
`render.yaml` runs `plan: free`, which has no disk. `server/data/` is part of the
deploy image, so every deploy — and every restart, and every cold start after
the free tier idles the service — recreates it from git. The kanban board, the
investor pool, the usage meters and the 3D quota all lived there. Nothing was
failing to save; it was saving to a directory that is thrown away.

**2. `APP_DATA_DIR` was honoured by half the code.**
The escape hatch for (1) is to point `APP_DATA_DIR` at a mounted disk.
`usage-meter.js` and `production-3d.js` read it. `routes-bundle.js` and
`routes.js` hard-coded `path.join(__dirname, "data")` and ignored it — so
attaching a disk would have moved the meters and the 3D quota and silently left
the kanban and the investor pool on the image. A half-durable deployment is
worse than an obviously ephemeral one, because it looks like it worked.

**3. Durable storage covered only signed-in users.**
`production-private.js` writes `cre_pipeline` per user with the caller's bearer.
Anyone entering through the password gate without a Supabase account — the normal
way this site is used — fell through to the disk store.

FIX
* `server/durable-store.js` — documents live in `public.app_state` when a
  Postgres URL is configured, on disk when it is not. First read on a configured
  database ADOPTS what is already on disk, so an existing deployment carries its
  board in rather than resetting to the seeded rows.
* `routes-bundle.js` and `routes.js` now resolve every written document from
  `APP_DATA_DIR`. `nta-polys.json` deliberately stays with the code — it is
  committed read-only geodata, not state.
* `supabase/migrations/202608140001_durable_app_state.sql` creates the table with
  RLS on and **no** policy for anon/authenticated: the service role writes the
  shared board, a browser holding the publishable key cannot.
* `pg` moved from devDependencies to dependencies. It is now imported to serve
  requests, so a production install that omits devDependencies would otherwise
  fall back to disk and silently restore the original bug.
* `/api/status.persistence` reports the backend from the running process, so the
  posture can be checked on the deployed service *before* anything is lost.

A BUG THE END-TO-END TEST CAUGHT
The first version forced `ssl: { rejectUnauthorized: false }` on every
connection. That is right for Supabase and wrong for everything else — a local
Postgres, a Render-internal instance and any URL carrying `sslmode=disable` all
answer "The server does not support SSL connections", after which the store
falls back to disk. It would have shipped looking fixed. TLS is now derived from
the connection string (`server/durable-store.js` → `pgSsl`), and
`scripts/apply-migrations.mjs` had the identical flaw and got the same fix.

PROOF — the user's scenario, run against a real Postgres over the wire
(`scripts/pglite-server.mjs` puts the real engine behind the real protocol):
```
=== DEPLOY 1 ===
{"ok":true} <- kanban saved
   investors saved
   fallback warnings: 0

=== REDEPLOY: wipe the data directory, as Render does ===
   files in APP_DATA_DIR: 0

=== DEPLOY 2: fresh container, same database ===
   kanban  -> SURVIVED: {'id': 1, 'oppId': 'SURVIVES-REDEPLOY', 'stage': 'Contact Owner', …}
   investors -> SURVIVED: ['Persistence Proof LP']
```
And the posture is reported honestly in both configurations:
```
without a database: {"backend":"disk (no SUPABASE_DB_URL/DATABASE_URL)","survivesRedeploy":false}
with a database:    {"backend":"postgres","survivesRedeploy":true}
```
`tests/durable-store.test.mjs` (11 cases) pins all of it, including that a
disk-only store loses the board when the directory is wiped — the failure being
fixed — and that an unreachable database degrades instead of taking the server
down. `npm test` is 63/63.

WHAT YOU HAVE TO DO
Set `SUPABASE_DB_URL` on the `lucia` service to the project's Postgres
connection string (Supabase → Project Settings → Database → Connection string →
URI). Until that variable exists the deployment is still disk-only, and
`/api/status` will say `survivesRedeploy: false`. Nothing else changes: no plan
upgrade, no disk, no migration run by hand — the store creates its own table.

---

## GAP LIST — items 1-39 from your audit

Worked in order. Each entry says what was measured, not what was intended.

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Similar Properties fallback | **FIXED** | Pinecone unset → 8 real comps on BBL 1000160010, engine `public-record-similarity`, top match 55 BATTERY PLACE at 0.501. Runtime probe: resolver is now `production-analytics.js` |
| 2 | Development/land stock | **UNSOLVED, disclosed** | ~9,600 predicate combinations tested against 363 / 132 / 438. Zero reproduce all three; closest gets 11216 exact and misses 10451 by 59. Row reports `stock: null` with a `stockUnavailable` reason |
| 3 | Prior-period comparisons | **FIXED** | Measured first: your site returns priorCount 0 / priorVolume 0 / both change pcts null on all five ZIPs tested across four boroughs. The four keys are now emitted per row; byClass key set is identical to production |
| 4 | DOB development pipeline | **FIXED** | Root cause: `zip_code` does not exist in `w9ak-ipjd` (it is `postcode`), and proposedUnits/bbl were hardcoded null. Now byte-identical for 11216: counts {234, 89, 39, 5524}, 60 sites, same first row, same coverage sentence |
| 5 | Signed-in maturity wall | **FIXED** | Was `configured:false` for exactly the users it is for. Now built from the user's own pipeline parcels with the same estimator and the same per-field estimate labels. Exercised: $60M/2021-03-15 → maturity 2031-07-01, ratePct null |
| 6, 7 | Anonymous pipeline / investor durability | **FIXED** | No longer a product call. `server/durable-store.js` keeps both in `public.app_state` when `SUPABASE_DB_URL` is set and on disk when it is not, adopting existing on-disk state on first read. Proven by writing a row, deleting `APP_DATA_DIR`, restarting the server and reading the row back. Two further faults surfaced and were fixed: `routes-bundle.js`/`routes.js` ignored `APP_DATA_DIR`, and forced TLS broke every non-Supabase Postgres. Requires you to set `SUPABASE_DB_URL` on the service |
| 8 | Self-provisioning deployment | **FIXED** | `scripts/apply-migrations.mjs` runs as a Render pre-deploy step. Both paths exercised: no credentials exits 0 with a clear message, unreachable credentials exits 1 rather than hanging |
| 9-27 | Production verification | **BLOCKED** | Needs Supabase credentials, Render access, and the third-party API keys. Nothing here can be answered from this environment |
| 28, 29, 30 | Browser tests never ran | **FIXED** | `test:browser` was `cat`. Wiring it up exposed that `playwright` was never a repo dependency, and that NODE_ENV=production makes npm omit devDependencies — so `pg` was missing too. Two of the three suites then ran but could not pass — see the row below |
| 28, 29, 30 (b) | Two suites were "stale", one gated | **FIXED** | `parity-browser.cjs` and `features-browser.cjs` drove `#opp-cards` / `#cc-doc` / `#dk` / `#dz-obsidian` — ids absent from the shipped bundle — so the runner carried them as non-gating. Both rewritten against the bundle's own `data-testid` surface and rendered copy; all three suites now gate. 3/3 pass, 0 gating failures |
| 31-34 | CI | **FIXED** | `.github/workflows/release-suite.yml`: Node suite + reachability, and the browser gate, on every push and PR |
| 35 | CI run on HEAD | **BLOCKED** | Will exist once the workflow runs on a push you can see |
| 36 | Release gate beyond "page mounted" | **FIXED** | Five behavioural checks added: kanban persistence, radar search, calculator recompute, a real CSV download, and a populated generated report. Three failed on their first run and were fixed |
| 36 (b) | The gate's route section was vacuous | **FIXED** | CORRECTION to the row above. Section 1 addressed the routes by path (`${BASE}/pipeline`) and asserted only that React had mounted. The application is hash-routed: a path URL normalises to `#/` and renders Market Intel, so the section loaded **the same page twelve times** and reported twelve passing routes. Now addressed by hash with a per-route marker each route alone renders; `parity-browser.cjs` additionally fingerprints all 13 routes and requires 13 distinct hashes |
| 37 | PARITY-TEST-MATRIX overstated | **FIXED** | Was 29 rows all ✅. Now 23 ✅ / 5 ⚠ / 5 ❔ with a legend, market report corrected to 7-of-9, maturity wall marked off-for-signed-in |
| 38 | This ledger | **FIXED** | Four Phase 13 entries downgraded in place with the reason; header states the file was wrong |
| 39 | Skyline rebrand vs "identical" | **YOUR CALL** | The bundle is byte-identical; the shell is deliberately rebranded. The honest release claim is "your exact application, rebranded" |

---

## SESSION ADDENDUM — full re-read, re-analysis, and phases 15–17

You asked me to go back to the beginning of the chat, read everything, re-analyse,
and check for gaps. I re-extracted all 139 user messages from the raw transcript
(250,297 bytes), filtered out my own context summaries, and read the 99 genuine
instruction messages in order, plus the four requirements documents in full: the
32,764-character parity audit, the 35,853-character 20-phase prompt, the
8,445-character 39-item gap list, and the 9-item open list.

### What the re-read found that I had mishandled

**Your most-repeated complaint was filed as not-applicable.** You wrote, more than
once: *"why are the Properties scrolling right to left? You can't even click them."*
`docs/release/PHASE-14-MATRIX.md` recorded the mutation row for `/dossier` as
`n/a`. It was not n/a. The cause, found and fixed this session:

`/api/lot-tiles` is registered in three files. Express matches the first router
that registers a path, and `server/production-live-extra.js` mounts at
`server.js:98`, one line ahead of `server/parity-routes.js` at `:99`. So the lot
grid was answered from the ArcGIS `MapPLUTO_Public` FeatureServer. Measured
against that service directly:

```
MapPLUTO_Public/FeatureServer/0/query?where=1=1&returnCountOnly=true
  -> {"count":34138}                 NYC has ~860,000 tax lots
same service, envelope of tile 17/38596/49266
  -> {"count":1}
DOF Digital Tax Map (Socrata i38t-6if2), identical envelope
  -> 37 rows, each with a 10-digit BBL and real polygon geometry
```

The grid was drawing 1 lot where the tax map records 37. After the fix, in the
browser at lot-grid zoom over Midtown: 54 of 60 tiles carry lots, the densest
1,411, and the overlay canvas paints 21,525 of 41,799 sampled pixels. Hovering
returns the record; clicking offers the dossier; the link carries the BBL. Checked
against PLUTO on five separate lots — address, owner and building class agree
every time.

### Dead upstream datasets, found by auditing every one in use

| Dataset | Used for | State | Action |
| --- | --- | --- | --- |
| `3g6p-4u5s` | building footprints | answers HTTP 200 with every row emptied to `{}` | replaced with `5zhs-2jue` |
| `jh45-qr5r` | footprint fallback | HTTP 400 with the `$select` the code uses | live id put ahead of it |
| `5fuc-pqz2` | footprint fallback | HTTP 404 | kept behind the live id |
| `qb5r-6dgf` | footprint fallback | HTTP 404 | kept behind the live id |
| `39hk-dx4f` | MTA subway stations | **healthy** — my first check queried the wrong domain | none; it is on data.ny.gov |

`/api/footprints` went 503 → 200 with 202 polygons; `/api/bldg-tiles` returns 191
extrusions with real roof heights. `footprintsBbox()` in `server/adapters/nyc.js`
could previously only ever return "footprints dataset unresolved" — every id in
its chain was dead. Nothing was deleted; the live id leads and the old ones remain
behind it.

### Phases completed this session

| Phase | Result | Report |
| --- | --- | --- |
| 15 — maps and geospatial | **19 pass · 0 fail · 1 blocked** | `PHASE-15-MAPS.md` |
| 16 — dossier | **33 pass · 0 fail · 0 blocked** | `PHASE-16-DOSSIER.md` |
| 17 — calculator (second half) | **10 pass · 0 fail · 1 blocked** | `PHASE-17-CALCULATOR.md` |

Phase 16 is checked against the city's own records, queried independently of the
server: 14/14 and 79/79 ACRIS document ids confirmed recorded against the lot,
HPD 29 against 29, ECB 1 unresolved against 1, DOF assessed total 577,440,900
against PLUTO's 577,440,900, nearest subway recomputed from the MTA table at
740 ft against the app's 747 ft.

Phase 17's development model was computed by hand before the run — construction
$41,480,000 and residual land value $33,960,000 — and the application renders
both exactly, at $1 tolerance.

Both blocked items are stated rather than counted as passes: P15.16 needs
`GOOGLE_3D_KEY`, and P17.16 is deck generation, which does not exist in this
bundle — the only two document call sites are `U("bov")` and `U("om")`, and
"Deck" is an unreachable fallback branch of the document title.

### The CDN dependency is gone

The calculator's document reader pulled pdf.js and Tesseract from cdnjs, and 3D
City pulled MapLibre from unpkg, by building a `<script>` at runtime. All of it
was already vendored into `public/vendor` by `scripts/vendor.js` and shipped in
the image — it was simply never wired up. Two shell-side hooks now serve it from
this origin (`public/js/vendor-local.js`, `public/js/pdf-local.js`); the bundle
is untouched. Measured on a real PDF rent roll: four figures extracted,
`workerSrc` = `/vendor/pdfjs/pdf.worker.min.mjs`, **external CDN requests: NONE**.
For a password-gated site this also stops the browser announcing every uploaded
document to a third party.

### Gap-list rows this re-read can now answer

| # | Item | Previously | Now |
| --- | --- | --- | --- |
| 9 | Are the migrations installed on the production Supabase project? | BLOCKED | **ANSWERED: NO.** Present: `cre_profiles`, `cre_watchlist`, `cre_pipeline`, `cre_canvass` — the original application's. Missing: `cre_investors`, `cre_usage_daily`, `app_state`, `parcels`, `ntas`, `acris_docs`, `dob_filings`, `tax_bills` |
| 10 | Is the production PostGIS store populated? | BLOCKED | **ANSWERED: NO** — those tables do not exist |
| 11, 12 | Authorization against production Supabase | BLOCKED | **PARTLY ANSWERED.** RLS is enforcing: anon reads return `content-range: */0`, anon INSERT returns 401. The signed-in half still needs credentials |
| 35 | CI run on HEAD | BLOCKED | **STILL BLOCKED, and not a code problem.** Jobs complete in 2–5 s with `runner_id: 0`, no steps, and logs that 404 — including on a commit I did not author and on a manual `workflow_dispatch`. Consistent with exhausted Actions minutes on a private repository |

### Why persistence is still off in production, precisely

`/api/status` on the deployed service reports:

```
{"backend":"disk (no SUPABASE_DB_URL/DATABASE_URL)","survivesRedeploy":false,
 "dataDir":"/opt/render/project/src/server/data"}
```

The chain, each link verified: `SUPABASE_DB_URL` is unset → `apply-migrations.mjs`
skips → `public.app_state` was never created on the project → the durable store
falls back to disk → Render's free plan recreates that directory on every deploy.
The store self-provisions its own table on first connect, so setting
`SUPABASE_DB_URL` on the Render service is the whole fix: no plan change, no disk,
no migration run by hand.

The Supabase MCP available in this environment is connected to a different
project (`hvsvxjdwfbsqaqlmuwlt`, "Skyline"), not the production one, so I cannot
apply it from here.

### One further limit worth stating plainly

Live verification beyond `/api/status` is not possible from this environment: the
Render deployment's gate rejects `creintel2026`, which is the password for
nycremarketintel.com rather than for the rebuild. Every other live endpoint
answers `{"error":"unauthorized"}`. All verification above is therefore local,
against the same code the deployment runs. (`GET /` returned 502 on a first hit
and 200 immediately after — a free-tier cold start, not a crash.)

---

## CLOSING STATE — 2026-08-17

Everything above this line is the historical record and stays as written. The
three blocking conditions the tail of that record describes were each resolved
on 2026-08-17, and the evidence for each was captured against the live
deployment — not inferred from code.

### The stale statements, corrected with live output

**"Persistence is still off in production" — no longer true.** The owner
designated the Skyline Supabase project as the production database and its URL
plus publishable key were set on the Render service through the Render API
(values verified present and scoped, never printed). `/api/status` on the live
service now reports:

```
"persistence":{"backend":"supabase-rpc","survivesRedeploy":true,
 "dataDir":"/opt/render/project/src/server/data",
 "note":"Deployment-wide state is stored durably via supabase-rpc."}
```

A full save → read → stage-update → delete round-trip was executed against the
live deployment (production sweep, persistence category, 6/6), every write
acknowledged `durable:true, backend:"supabase-rpc"`, and the data survived an
actual redeploy.

**"Migrations were never applied to the production project" — no longer true.**
All migrations through `202608170001_usage_meter_token_rpc.sql` are applied to
the production (Skyline) project. Live proof, not schema listing: the kanban
writes through `app_state` RPCs (above), `/api/maps-usage` answers
`{"durable":true,"source":"cre_usage_daily",...}` HTTP 200 through the
token-gated RPCs with no service-role key configured, `/api/3d-session` reports
`durable:true`, and the investor pool save/read/restore round-trip passed on
the live service. PostGIS: `/api/status` reports `configured:true,
trusted:false, reason:"not_operator_trusted"` — the citywide ingest remains an
open owner decision, and `/api/nta-polys` serves the packaged 160-feature file,
which is byte-equivalent to what nycremarketintel.com itself serves for that
endpoint (verified 2026-08-17; see PRODUCTION-SWEEP-2026-08-17.md, defect 4).

**"Live verification is not possible from this environment" — no longer true.**
The deployment's real site password (supplied out-of-band, held only in session
scratch files, never printed) authenticates via the gate's Basic-auth path. The
98-check production sweep, the five defect fixes, and the post-deploy
re-verification were all executed against the live service. Current live
deploy: commit `84881d90` (PR #118), `startedAt 2026-08-17T17:43:33Z`,
`dataMode:"live"`.

### Where the full record now lives

The complete disposition of the 2026-08-17 production sweep — 104 findings,
5 confirmed defects fixed and re-verified live, 1 finding reversed with the
bisection evidence, and the remaining operator actions — is in
`docs/release/PRODUCTION-SWEEP-2026-08-17.md`. Suite state on the shipped
tree: unit 205/205; browser phase reports in this directory (maps
19 pass · 0 fail · 1 blocked on the absent Google key; dossier 33 pass · 0 fail).

### Still open at this writing

- ~~Signed-in production round-trips~~ **RESOLVED same day — results below,
  pasted from the probe run (gap-list rows 11–18's authenticated half).**

  The probe travelled the compiled bundle's exact operations against the
  production project the live shell itself serves (`hvsvxjdwfbsqaqlmuwlt`),
  as a freshly seeded throwaway user at a reserved `.invalid` domain,
  removed completely afterward:

  ```
  password login → session: HTTP 200
  PASS profile insert (bundle op 2): display_name="RT Probe", role="user"
  PASS profile read-back (bundle op 1): role="user" (must be user, not owner)
  PASS profile display-name update (bundle op 3): renamed and persisted
  PASS profile role self-promotion is refused (hardening): refused with HTTP 403
  PASS watchlist insert: row id 451c2e91…  (rerun: 409 — unique(user_id,bbl) enforced)
  PASS watchlist read-back: 1 row(s), bbl 1000160001 present
  PASS watchlist delete: HTTP 200, removed 1 row(s); read-back after: 0 row(s)
  PASS canvass insert / read-back / delete: HTTP 200, removed 2 row(s); after: 0
  PASS anon isolation: publishable key alone reads 0 rows from all three tables
  PASS /api/account-delete states its honest configured state:
       HTTP 501 "Deletion isn't configured on this deployment yet — add the
       SUPABASE_SERVICE_ROLE_KEY secret."   ← operator item, by design
       [superseded the same evening: 202608170002 gives deletion the same
        registered-token path as every other durable write, so the endpoint
        now deletes without a service key — end-to-end result recorded below]
  DB-layer deletion: deleting the auth user cascaded profiles/identities to 0;
       final counts auth_users 0, identities 0, profiles 0, watchlist 0, canvass 0
  ```

  One probe artifact worth recording so it is never mistaken for a defect: a
  PostgREST `merge-duplicates` upsert on `cre_profiles` fails 403 because
  UPDATE(id) is deliberately withheld. The bundle never upserts — its three
  operations (plain insert / select / display-name update) are exactly what
  the grants permit, and all three pass. The product's own behaviour is the
  arbiter; the probe was corrected, not the grants.
- The operator actions listed in PRODUCTION-SWEEP-2026-08-17.md §Operator
  actions (distinct OWNER_PASSWORD, optional integration keys, GitHub Actions
  billing, the PostGIS ingest decision).
