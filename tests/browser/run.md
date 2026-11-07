Browser suites. All require Playwright + Chromium (`npx playwright install
chromium` locally; on the managed image Chromium is at `/opt/pw-browsers/chromium`
and can be overridden with `CHROMIUM_PATH`).

Run all of them against a server this script boots for you:

    npm run test:browser

That runs the three gating suites in order and exits non-zero if any fails.
There is no non-gating tier — `parity-browser.cjs` and `features-browser.cjs`
used to be carried as "stale" because they drove DOM ids (`#opp-cards`,
`#cc-doc`, `#dk`, `#dz-obsidian`) from the earlier hand-rebuilt UI that appear
nowhere in the shipped bundle. Both are now written against the bundle's own
`data-testid` surface and its rendered copy.

**The application is hash-routed.** `http://host/pipeline` does not open
Pipeline: the router normalises the empty hash to `#/`, renders Market Intel and
leaves the URL at `/pipeline#/`. Every suite here addresses routes as
`http://host/?cachebust#/route`. A suite that gets this wrong still sees twelve
pages mount successfully and reports twelve passing routes — that defect was
live in the release gate until it was found by rewriting these suites.

Chrome's `innerText` returns *rendered* text, so a heading carrying
`text-transform: uppercase` reads back uppercased. Match route markers
case-insensitively.

## Release gate (run before every deploy)

    SITE_PASSWORD=… npm start                          # server on :5175
    SITE_PASSWORD=… npm run test:release-gate          # or pass a base URL

Checks: all 12 application routes load and render **their own** content (each
route must produce a marker only that route renders); the auth bridge puts a
real `Authorization: Bearer` on the wire for a private `/api/` call and the
server enforces it; the served asset bytes match the pinned production SHA-256
hashes; `/api/cliffs` returns safe `Number` primitives for every LL97/J-51
metric the dossier formats; and the mutations, exports and document generators
are exercised rather than counted.

The script authenticates through the login form, so it exercises the same gate
path a person does.

## Parity suite

    node tests/browser/parity-browser.cjs [baseUrl]

Route identity for all 13 routes including the 404 — and a fingerprint check
requiring 13 distinct rendered bodies, so "every route renders the same page"
cannot pass again. Sidebar navigation actually navigating (and coming back).
The opportunity strip and the kanban scrolling. The phone layout at 390×844:
every tab on screen, at most two rows, nothing clipped, no horizontal body
scroll, a kanban column sized for the viewport, and a usable Deal Radar search —
the three complaints that started this work, as regression checks.

## Features suite

    node tests/browser/features-browser.cjs [baseUrl]

Dossier on a live parcel with its report actions and owner-gated panels;
calculator maths checked against derived figures (NOI, cap rate, DSCR) rather
than rendered placeholders; the OM and BOV generators; comps rows and both
exports; presentation lenses re-ranking the deck; the source registry; territory
search; and the investor Obsidian note.

Note the two document-delivery mechanisms — the dossier's Property/Investor/
Market reports use `window.open`, while the calculator's OM/BOV render into a
full-screen in-page overlay (`div.fixed.inset-0.z-[9999]`) that prints through a
hidden iframe. A test that waits for a popup will miss the second entirely.

## Phase 14 matrix

    node tests/browser/phase14-matrix.cjs [baseUrl] [--md docs/release/PHASE-14-MATRIX.md]

13 routes × 13 dimensions (load, api, buttons, filters, search, drawers, nav,
mutations, exports, empty, error, refresh, deeplink). Cells are `PASS`, `FAIL`
or `n/a`, and `n/a` is derived from the rendered DOM — a route is blank for
exports because it renders no export control, never because the script decided
it shouldn't have one. The summary reports exercised cells separately from `n/a`
cells so shrinking coverage is visible.

## Screenshots

Screenshots land in `tests/browser/shots/`. The production ZIP is a compiled SPA
whose private backend is not included, so pixel comparison against a live
original remains a manual step wherever the original deployment is reachable.
