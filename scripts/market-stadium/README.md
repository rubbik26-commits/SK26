# Market Stadium data store — regeneration and staging

The unified platform's Market Stadium half reads its data from a chunk
store at `server/data/market-stadium/` (the STORE), served only through
`server/market-stadium.js` under `/api/market/*`. This note records where
the STORE comes from and how it is regenerated and re-staged. The store
is data, not code: it is never edited in place inside this repo.

## Layout — the reshard

Every file in the STORE is at most 4 MiB (4,194,304 bytes). The store
ships through the GitHub connector's snapshot pushes, whose effective
transport ceiling sits below the pre-reshard file sizes, so
`etl/reshard_store.py` re-packs the store at a per-file byte budget
(`--budget-bytes`, default 4 MiB):

- record chunks are re-packed per level (`records-<level>-NN.json`;
  the manifest lists as many as the budget takes);
- each level's geometries ship as bare-array parts
  (`geometries/<level>-NN.geojson`) under a manifest `parts` list;
- `pipeline_full.json` ships as `pipeline-meta.json` (everything
  except `footprint.jobs`) plus bare-array job parts
  (`pipeline-NN.json`);
- `buildings.json` ships as `buildings-meta.json` plus radius-list
  parts (`buildings-NN.json`);
- `lotlines.geojson` ships as `lotlines-meta.json` (the
  FeatureCollection wrapper) plus bare-array feature parts
  (`lotlines-NN.geojson`);
- the small aux JSONs (`sales.json`, `news.json`, `macro.json`,
  `meta.json`, `moneygration.json`, `evac_zones.json`) ship whole.

The reshard copies payload entry text verbatim — only file boundaries
move — and proves it in-script (a rolling SHA-256 over each dataset's
entry sequence is unchanged old vs new, and every output file is
parsed and counted). `server/market-stadium.js` reads record chunks
and every part/meta file through the same manifest verification
(byte count + SHA-256, fail-closed) and reassembles the parts in
manifest order; no endpoint's response shape changes. The legacy
single-file forms remain as router fallbacks for the pre-reshard
development build tree only — the staged STORE's manifest always
carries the parts sections.

## Source of truth

The Market Stadium ETL in the replica workspace
(`~/workspace/skyline-market-intel/etl/`) is the source of truth. The
regeneration chain (integration plan §4) is:

`build_dataset_v4.py` chain (`make_v4.py`, `prep_phase1.py`,
`prep_phase2.py`, `prep_wrluri.py`, `pull_acs2020_sf.py`) →
`build_spine.py` → `build_spine_unify.py` (the INT-1 chunker with its
graft from the core store) and the graft patchers → `reshard_store.py`,
whose output directory `~/workspace/skyline-market-intel/data/spine/store/`
is the staging source.

Growth/Forecast in the chunk store are on the ACS 2020→2023 basis over
the expanded universes. The 557 MB `places.json` monolith is an ETL
intermediate on the older 2021→2023 basis: it is **never** copied into
this repo and the server never reads it.

## Exact source paths (reshard inputs)

| Reshard input | Source |
|---|---|
| record chunks + manifest | `~/workspace/skyline-market-intel/web/src/data/spine/` |
| `geometries/{city,county,zip,tract}.geojson`, `lotlines.geojson`, `pipeline_full.json` | `~/workspace/skyline-market-intel/data/spine/` (+ `geometries/` under it) |
| `buildings.json`, `sales.json`, `news.json`, `macro.json`, `meta.json`, `moneygration.json`, `evac_zones.json` | `~/workspace/skyline-market-intel/web/src/data/` |

The ETL-side mirrors (`web/src/data/spine/`, `web/public/data/spine/`,
`web/dist/data/spine/`) keep the pre-reshard layout — they are the
standalone replica's data, not the STORE.

## Copy + verify procedure (per staging pass)

1. Run `python3 -I etl/reshard_store.py` in the replica workspace (or
   reuse its existing output after an ETL change that does not affect
   the store inputs). Its output is `data/spine/store/`.
2. Replace the STORE contents wholesale with that directory's contents
   (the layout changes across a reshard — stale files from a previous
   layout must not survive), `manifest.json` copied last.
3. Verify **every** staged file byte-for-byte: SHA-256 of the staged
   file must equal SHA-256 of the corresponding reshard-output file.
4. Verify every manifest-listed file against the staged `manifest.json`
   (SHA-256 **and** byte count) — chunks, geometry parts, pipeline /
   buildings / lotlines parts and meta files; the same check
   `server/market-stadium.js` performs on every read, answering
   `500 store_integrity` on any mismatch.
   `tests/market-stadium-data.test.mjs` performs this verification and
   pins the universes (393 / 1,311 / 23,189 / 72,331 records; geometry
   393 / 1,311 / 23,191 / 72,346 features; pipeline 82,187 jobs).
5. Record the pass in `~/workspace/evidence/b3-stage<N>.tsv`
   (`path | bytes | sha256 | source | verify`), including the staged
   manifest's own SHA-256.
6. Prove the staged store serves: run B1's API tests against the staged
   copy only —
   `MARKET_STADIUM_DATA_DIR=<abs path to server/data/market-stadium> node --test tests/market-stadium-api.test.mjs`
   must pass 19/19.
7. If the ETL is mid-run while staging, stage a coherent snapshot
   anyway (steps 1–6) and heal the delta in the next pass: re-run the
   reshard from the settled inputs, re-stage, then re-run steps 3–6.

## SHA-256 pinning rule

The STORE `manifest.json` is the pin: every chunk and part read is
verified against it before parsing, fail-closed. A staged file that
does not match its manifest entry (chunks, parts, meta files) or its
recorded source hash (all files) is a failed staging — never patch
bytes in the STORE to make a check pass; re-copy from the reshard
output, or regenerate upstream in the ETL and re-run the reshard.
