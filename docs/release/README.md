# Release evidence — authority and freshness rules

This directory contains generated verification snapshots from different points in the reconstruction. A generated Markdown file is evidence of **the run that produced it**, not a permanent statement about the current branch or deployment.

## Source of truth

Release decisions must use, in this order:

1. the current code on the candidate branch;
2. the current live Supabase schema/log/advisor state;
3. a fresh successful `npm test` run for that exact commit;
4. a fresh successful `npm run test:browser` run for that exact commit;
5. a fresh `P20_CERTIFY=1` deployed-service run for the exact deployed commit.

A historical Markdown report never overrides newer code or newer runtime evidence.

## Generated snapshots in this directory

- `PHASE-14-MATRIX.md` — historical page-by-page run. The checked-in snapshot contains one Dossier drawer failure from an older harness. The current `tests/browser/phase14-matrix.cjs` has since corrected that record-selection/navigation measurement and the matrix is now part of the standard gating browser runner. Do not relabel the old result as PASS; regenerate it from a real run.
- `PHASE-15-MAPS.md` — historical map/geospatial run.
- `PHASE-16-DOSSIER.md` — historical Dossier source-truth run.
- `PHASE-17-CALCULATOR.md` — historical calculator/document run. Its Deck item documents that no reachable Deck generator exists in the immutable original bundle; that is not permission to invent a new feature under an exact-parity requirement.
- `PHASE-18-VIEWPORTS.md` — historical viewport sweep.
- `PHASE-20-PRODUCTION.md` — explicitly superseded historical production run. Current `tests/browser/production-verify.cjs` supports fail-closed certification: `P20_CERTIFY=1` makes BLOCKED a release failure and can accept real Supabase-user and cross-instance persistence evidence.
- `PRODUCTION-SWEEP-2026-08-17.md` / `VERIFICATION.md` — historical sweeps. Useful as evidence of what was tested at that time, not as unconditional current PASS declarations.
- `route-table.md` — historical declaration inventory. Runtime route probes are the authority for which handler actually commits a response because Express routers may match and call `next()`.
- `runtime-writes.md` — current persistence architecture plus the historical defect context.

## Current non-negotiable release rule

A release is **not certified** when any required verification is `FAIL` or `BLOCKED`. In particular, a real Render restart/redeploy persistence proof cannot be replaced with a source-code assertion, a local disk test, or a statement that the configured backend *should* survive. The two-run marker path in `tests/browser/production-verify.cjs` exists specifically so the external control-plane action can be verified rather than assumed.

Likewise, an unrecovered original behavior is not filled with a plausible substitute. Current known exact-parity unknowns remain explicit until evidence recovers the rule; returning `null`, an explicit unavailable state, or a documented superset is preferable to fabricated precision.
