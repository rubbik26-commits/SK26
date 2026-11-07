# What the served shell adds to the original, and why

The compiled application — `assets/index-BbnE3o5g.js` and
`assets/index-shmfCHKD.css` — is byte-identical to the export in
`nycremarketintelsite_2.zip`, and a test fails the build if either drifts.

The served `public/index.html` intentionally keeps a small set of production
bridges and previously verified usability/disclosure improvements that the
untouched export (`site/index.html`) did not need. Every one is listed here.
The Owner target is the original product and data behaviour as authority,
plus the preserved responsiveness/no-overlap/touch conveniences and truthful
estimate disclosures already added during reconstruction, with Skyline
Properties branding applied separately. Those conveniences are not to be
removed merely to make the HTML shell look more like the export.

The untouched export stays mounted for byte comparison: `GET /__original-shell`
returns `site/index.html` exactly as it came out of the zip.

## Behavioural — changes what the app does

### `js/mobile-parity.js`

Deal Radar's search resolves what you type to a set of ZIPs: it parses 5-digit
ZIPs and matches known neighbourhood names. A street address matches neither, so
the query stays disabled. This shim resolves an address through `/api/address` —
the same live GeoSearch-backed endpoint the dossier uses — rewrites the field to
the resolved ZIP, and lets the page's own search run. Anything already resolved
(a ZIP, neighbourhood or borough) passes through untouched.

**This is a deliberate functional divergence and retained convenience.** It exists because “any property address must work” is a stated production requirement. Delete this file and the original address-search limitation returns.

### `js/production-auth-bridge.js`, `js/supabase-env.js`

Point the immutable bundle's auth at the Supabase project configured for this
deployment instead of forcing the project that happened to be baked into the
compiled asset. The bridge preserves the bundle's original same-origin API
request semantics; account-specific authorization is added only where the
original account flow requires it. They do not rewrite visible product copy.

### `js/buyer-intelligence.js?v=e6b20e925021`, `css/buyer-intelligence.css?v=e1cb0ec22e8c`

Add read-only, source-labelled buyerDB history to the Owner Dossier, Investors,
and Pipeline surfaces without editing the checksum-pinned application bundle.
The script calls only the owner-only `/api/buyer-intel/*` namespace, keeps the
manual investor pool and Airtable relationships separate, and removes its
enhancements when the caller is not an Owner. The stylesheet is scoped to the
inserted `lucia-buyer-intel` elements and does not change existing application
geometry or data behaviour. The query versions are derived from each file's
SHA-256 content and force refreshed clients to load the matching Manhattan
buyer/address implementation after a deploy.

### `js/market-stadium/*` and `css/market-stadium.css`

Mount the Market Stadium surface into lucia. The surface itself is a separate
build served at `/market/`; this layer is the in-lucia integration, and it is
the only part of the merge that touches the served shell.

It adds one navigation entry to lucia's existing rail pointing at `/market/`,
and attaches Market Stadium context to lucia's own pages: the market overview
(level switcher, choropleth, score card, top-10 ranking) on `#/market-stadium`,
the score model and FRED macro context, climate risk and market news on
`#/territory`, the DOF rolling-sales strip on `#/comps`, and parcel context on
`#/dossier`.

Every value comes from `/api/market/*`, `/api/climate-risk` or
`/api/market-news`. The layer reads only; it changes no lucia data, formula,
persistence or API contract, and it renders into elements it created itself.
The stylesheet is scoped under `.lucia-market-stadium` and carries the print
rules, so no `<style>` is injected. The map uses the vendored MapLibre build at
`/vendor/maplibre/maplibre-gl.js` — never a CDN.

| File | What it does |
| --- | --- |
| `css/market-stadium.css?v=b2640a6cb8a1` | Scoped presentation for the layer. Every selector is under `.lucia-market-stadium`; colours follow lucia's own custom properties. |
| `css/climate-risk.css` | Presentation for the climate-risk attachment. |
| `css/market-news.css` | Presentation for the market-news attachment. |
| `js/market-stadium/ms-api.js?v=66fa14ac5ec9` | Shared namespace, formatters, tier palette and the `/api/market/*` client. |
| `js/market-stadium/ms-geocoder.js?v=c4cb00dc7bec` | Resolves a typed address through the server's Census proxy and selects the matched geography. |
| `js/market-stadium/ms-map.js?v=227bbce46d7d` | Choropleth of the active level, using the vendored MapLibre build. |
| `js/market-stadium/ms-panels.js?v=1f82c5ce120e` | Market overview: level switcher, map, score card, top-10 ranking. |
| `js/market-stadium/ms-panels2.js?v=5e7047830b50` | Score model, category weights, FRED macro and substituted inputs. |
| `js/market-stadium/ms-panels3.js?v=223b16d10b2a` | Climate risk and market news attachments on Territory Mastery. |
| `js/market-stadium/ms-export.js?v=85e5b01db993` | Client-side CSV export of the active level's ranked rows. |
| `js/market-stadium/ms-territory.js?v=84dcda54ab08` | Market context section on Territory Mastery. |
| `js/market-stadium/ms-dossier.js?v=5055b1aa9649` | Parcel context on the Parcel Dossier. |
| `js/market-stadium/ms-comps.js?v=0953e5a21c13` | DOF rolling-sales strip on Comps. |
| `js/market-stadium/market-stadium.js?v=bcdc9abc5237` | Entry point: injects the rail entry and starts the attachments. |

## Functional — keeps existing behaviour working

### `js/vendor-local.js`, `js/pdf-local.js`

The bundle loads pdf.js, Tesseract and MapLibre from runtime CDN URLs. These
bridges rewrite those vendor URLs to the same origin and publish `window.pdfjsLib`
so document parsing and map functionality do not depend on a third-party CDN
being reachable. The pinned application bundle remains untouched.

## Usability / disclosure — preserves proven improvements without changing data logic

| File | What it does |
| --- | --- |
| `css/mobile-parity.css` | Measured presentation corrections: all bottom-nav destinations remain reachable, phone kanban columns snap one-at-a-time, the opportunity strip stays above the nav, controls keep a 40px touch-height floor, iOS inputs do not zoom/force overflow, map hint chips do not overlap, phone presentation cards keep usable address width, and long Recharts submarket labels do not clip or collide. No data, formula, persistence or API logic is changed. |
| `js/estimate-labels.js` | Marks values the API identifies as estimated so a modeled maturity/balance is not read as a contractual or recorded fact. |

These two files are intentional Owner conveniences. A future parity cleanup may
not delete them unless the replacement is separately verified to preserve the
same usability and disclosure outcomes.

## Skyline brand identity

| File | What it does |
| --- | --- |
| `css/skyline-brand.css` | Skyline Properties visual identity only: palette, typefaces, logo/chrome. Product geometry and responsive rules stay out of this file. |
| `js/skyline-name.js` | Rewrites the visible product name to Skyline Properties. Copy only; no markup, data or business logic. |

The served shell adds the `skyline` class on `<html>`, loads those two brand
files, and carries the Skyline Properties title and PWA metadata. Branding is
kept separate from the usability layer so brand work cannot accidentally add or
remove product functionality.

## The rule

`tests/reported-defects.test.mjs` enumerates every `/js/` and `/css/` injection
in `public/index.html` that is absent from `site/index.html` and fails if one is
not documented here. `tests/owner-shell-parity.test.mjs` additionally pins the
approved shell layers and their load order, while
`tests/skyline-brand-scope.test.mjs` keeps responsive geometry out of the brand
stylesheet and protects the specific mobile conveniences from accidental
removal.
