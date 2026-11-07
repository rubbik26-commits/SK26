-- Final authority-release security hardening.
--
-- 1. set_updated_at() is a trigger helper. Pin its object lookup so a caller
--    cannot influence resolution through a mutable role/session search_path.
-- 2. release_schema_check() is a privileged deployment-verification RPC. The
--    runtime verifier now requires a validated server credential, so anonymous
--    EXECUTE is no longer needed and needlessly exposes schema metadata.
--
-- The public PostGIS read RPCs (lot_at, assemblage_at, parcels_opportunities,
-- postgis_store_status) intentionally retain anon EXECUTE. They are the
-- publishable-key read surface for authoritative public parcel data when a
-- reconciled PostGIS warehouse is explicitly marked trusted.

alter function public.set_updated_at()
  set search_path = public, pg_temp;

revoke execute on function public.release_schema_check() from anon;
