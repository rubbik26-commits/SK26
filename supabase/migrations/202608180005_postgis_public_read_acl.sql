-- Complete the runtime PostGIS publishable-key read contract.
--
-- server/adapters/postgis.js uses a publishable key for seven read-only RPCs
-- over public NYC records. Earlier hardening preserved anon EXECUTE for only
-- four of them, leaving NTA polygons, tax history and parcel contacts returning
-- 401 from an otherwise healthy warehouse. Keep the whole read surface explicit
-- and make deployment verification fail if any grant is removed later.

grant execute on function public.lot_at(double precision, double precision) to anon;
grant execute on function public.nta_polys(double precision, double precision, double precision, double precision) to anon;
grant execute on function public.assemblage_at(text) to anon;
grant execute on function public.parcels_opportunities(text[], integer) to anon;
grant execute on function public.tax_history_at(text) to anon;
grant execute on function public.parcel_contacts(text) to anon;
grant execute on function public.postgis_store_status() to anon;

create or replace function public.postgis_public_read_schema_check()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'ok',
      has_function_privilege('anon', 'public.lot_at(double precision,double precision)', 'EXECUTE')
      and has_function_privilege('anon', 'public.nta_polys(double precision,double precision,double precision,double precision)', 'EXECUTE')
      and has_function_privilege('anon', 'public.assemblage_at(text)', 'EXECUTE')
      and has_function_privilege('anon', 'public.parcels_opportunities(text[],integer)', 'EXECUTE')
      and has_function_privilege('anon', 'public.tax_history_at(text)', 'EXECUTE')
      and has_function_privilege('anon', 'public.parcel_contacts(text)', 'EXECUTE')
      and has_function_privilege('anon', 'public.postgis_store_status()', 'EXECUTE'),
    'revision', '202608180005_postgis_public_read_acl',
    'anonExecute', jsonb_build_object(
      'lotAt', has_function_privilege('anon', 'public.lot_at(double precision,double precision)', 'EXECUTE'),
      'ntaPolys', has_function_privilege('anon', 'public.nta_polys(double precision,double precision,double precision,double precision)', 'EXECUTE'),
      'assemblageAt', has_function_privilege('anon', 'public.assemblage_at(text)', 'EXECUTE'),
      'opportunities', has_function_privilege('anon', 'public.parcels_opportunities(text[],integer)', 'EXECUTE'),
      'taxHistory', has_function_privilege('anon', 'public.tax_history_at(text)', 'EXECUTE'),
      'parcelContacts', has_function_privilege('anon', 'public.parcel_contacts(text)', 'EXECUTE'),
      'storeStatus', has_function_privilege('anon', 'public.postgis_store_status()', 'EXECUTE')
    )
  );
$$;

revoke all on function public.postgis_public_read_schema_check() from public, anon, authenticated;
grant execute on function public.postgis_public_read_schema_check() to service_role;
