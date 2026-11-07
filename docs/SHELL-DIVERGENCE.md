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
