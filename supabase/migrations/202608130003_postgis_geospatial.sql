-- NYC RE Market Intel — geospatial rebuild.
-- Real NYC parcel architecture on PostgreSQL + PostGIS: MapPLUTO lot polygons,
-- ACRIS deed/mortgage documents, DOB filings, DOF tax roll and 2020 NTA
-- polygons, with spatial RPCs (ST_Contains / ST_MakeEnvelope / ST_Touches)
-- consumed by the Express contract layer over PostgREST.
--
-- Everything here is public NYC record data: RLS allows read to anon and
-- authenticated; writes happen only through the service role (ingestion
-- workers in scripts/ingest/), which bypasses RLS.

create extension if not exists postgis with schema extensions;

set search_path = public, extensions;

-- ------------------------------------------------------------------ parcels
-- One row per tax lot (BBL). Attribute columns cover what the contract layer
-- reads; attrs keeps the full source record (PLUTO vocabulary, geometry
-- stripped) so plutoRowToBuilding-style mappers work unchanged.
create table if not exists public.parcels (
  bbl         text primary key check (bbl ~ '^[1-5][0-9]{9}$'),
  borough     smallint generated always as ((substring(bbl from 1 for 1))::smallint) stored,
  block       integer,
  lot         integer,
  address     text,
  zipcode     text,
  owner_name  text,
  bldg_class  text,
  land_use    text,
  zoning      text,
  lot_area    double precision,
  bldg_area   double precision,
  built_far   double precision,
  resid_far   double precision,
  comm_far    double precision,
  facil_far   double precision,
  num_floors  double precision,
  units_res   integer,
  units_total integer,
  year_built  integer,
  assess_land double precision,
  assess_total double precision,
  lat         double precision,
  lng         double precision,
  attrs       jsonb not null default '{}'::jsonb,
  geom        extensions.geometry(MultiPolygon, 4326),
  updated_at  timestamptz not null default now()
);

create index if not exists parcels_geom_gist on public.parcels using gist (geom);
create index if not exists parcels_zipcode_idx on public.parcels (zipcode);
create index if not exists parcels_owner_idx on public.parcels (owner_name);
create index if not exists parcels_boro_block_idx on public.parcels (borough, block);

-- --------------------------------------------------------------- acris_docs
-- Recorded deeds/mortgages (ACRIS master + legals + parties, flattened).
-- One recorded document can cover several lots, so the key is (document_id, bbl).
--
-- With document_id alone as the primary key and a single bbl column, the
-- ingestion worker — which loops BBL by BBL and upserts on document_id — wrote a
-- multi-lot deed once per lot and each write overwrote the previous lot's
-- association. The document survived; every parcel link but the last was lost,
-- and which one won depended on ingestion order. An assemblage deed is exactly
-- the kind of transaction this product exists to surface. ACRIS itself models
-- this grain correctly: its legals table has one row per (document_id, bbl).
create table if not exists public.acris_docs (
  document_id text not null,
  bbl         text not null,
  doc_type    text,
  doc_date    date,
  recorded_at timestamptz,
  amount      double precision,
  parties     jsonb not null default '[]'::jsonb,
  raw         jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (document_id, bbl)
);
create index if not exists acris_docs_bbl_idx on public.acris_docs (bbl, recorded_at desc);
-- Every lot a given document touches.
create index if not exists acris_docs_document_idx on public.acris_docs (document_id);
create index if not exists acris_docs_type_idx on public.acris_docs (doc_type);

-- -------------------------------------------------------------- dob_filings
-- DOB NOW job filings + DOB permit issuance + violations, one vocabulary.
create table if not exists public.dob_filings (
  id          text primary key,
  bbl         text not null,
  bin         text,
  source      text not null check (source in ('dob_now','dob_permits','dob_violations')),
  filing_type text,
  status      text,
  filed_at    date,
  raw         jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
create index if not exists dob_filings_bbl_idx on public.dob_filings (bbl, filed_at desc);

-- ---------------------------------------------------------------- tax_bills
-- DOF Property Valuation & Assessment roll, one row per BBL x year.
create table if not exists public.tax_bills (
  bbl            text not null,
  year           integer not null,
  tax_class      text,
  market_value   double precision,
  assessed_total double precision,
  taxable        double precision,
  raw            jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (bbl, year)
);

-- --------------------------------------------------------------------- ntas
-- 2020 Neighborhood Tabulation Area polygons for the map overlay.
create table if not exists public.ntas (
  nta_code   text primary key,
  name       text not null,
  boro       text,
  geom       extensions.geometry(MultiPolygon, 4326),
  updated_at timestamptz not null default now()
);
create index if not exists ntas_geom_gist on public.ntas using gist (geom);

-- ------------------------------------------------------------------- RLS
-- Public NYC records: world-readable, service-role writable only.
alter table public.parcels     enable row level security;
alter table public.acris_docs  enable row level security;
alter table public.dob_filings enable row level security;
alter table public.tax_bills   enable row level security;
alter table public.ntas        enable row level security;

drop policy if exists "parcels are public records"    on public.parcels;
drop policy if exists "acris docs are public records" on public.acris_docs;
drop policy if exists "dob filings are public records" on public.dob_filings;
drop policy if exists "tax bills are public records"  on public.tax_bills;
drop policy if exists "ntas are public records"       on public.ntas;

create policy "parcels are public records"     on public.parcels     for select to anon, authenticated using (true);
create policy "acris docs are public records"  on public.acris_docs  for select to anon, authenticated using (true);
create policy "dob filings are public records" on public.dob_filings for select to anon, authenticated using (true);
create policy "tax bills are public records"   on public.tax_bills   for select to anon, authenticated using (true);
create policy "ntas are public records"        on public.ntas        for select to anon, authenticated using (true);

-- ------------------------------------------------------------ spatial RPCs
-- lot_at: exact polygon hit for a map click (ST_Contains), with a nearest-lot
-- fallback within ~70m so a click on the sidewalk still resolves the lot —
-- replacing the old mock Euclidean centroid math.
create or replace function public.lot_at(p_lng double precision, p_lat double precision)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  with pt as (select st_setsrid(st_makepoint(p_lng, p_lat), 4326) as g)
  select coalesce(
    (select to_jsonb(p) - 'geom' || jsonb_build_object('hit', 'st_contains')
       from public.parcels p, pt
      where p.geom is not null and st_contains(p.geom, pt.g)
      limit 1),
    (select to_jsonb(p) - 'geom' || jsonb_build_object('hit', 'nearest')
       from public.parcels p, pt
      where p.geom is not null and st_dwithin(p.geom, pt.g, 0.0008)
      order by p.geom <-> pt.g
      limit 1)
  );
$$;

-- nta_polys: viewport query via ST_MakeEnvelope bounding box.
create or replace function public.nta_polys(
  min_lng double precision, min_lat double precision,
  max_lng double precision, max_lat double precision
)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'name', n.name,
      'boro', n.boro,
      'geom', st_asgeojson(n.geom)::jsonb
    )),
    '[]'::jsonb
  )
  from public.ntas n
  where n.geom is not null
    and n.geom && st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326);
$$;

-- assemblage_at: real contiguous same-owner lots — a lot joins the assemblage
-- when it shares the subject's owner of record and either physically touches
-- the subject parcel (ST_Touches) or sits on the same block.
create or replace function public.assemblage_at(p_bbl text)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  with subject as (
    select * from public.parcels where bbl = p_bbl
  ),
  cluster as (
    select p.*, st_touches(p.geom, s.geom) as touches_subject
      from public.parcels p, subject s
     where coalesce(p.owner_name, '') <> ''
       and p.owner_name = s.owner_name
       and (
         p.bbl = s.bbl
         or (p.geom is not null and s.geom is not null and st_touches(p.geom, s.geom))
         or (p.borough = s.borough and p.block = s.block)
       )
  )
  select jsonb_build_object(
    'owner', s.owner_name,
    'count', (select count(*) from cluster),
    'subjectUnusedSf', greatest(0, round(coalesce(s.lot_area, 0) *
        greatest(0, greatest(coalesce(s.resid_far, 0), coalesce(s.comm_far, 0)) - coalesce(s.built_far, 0)))),
    'lots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bbl', c.bbl,
        'address', coalesce(c.address, '—'),
        'lotArea', coalesce(c.lot_area, 0),
        'builtFar', coalesce(c.built_far, 0),
        'maxFar', greatest(coalesce(c.resid_far, 0), coalesce(c.comm_far, 0)),
        'unusedSf', greatest(0, round(coalesce(c.lot_area, 0) *
            greatest(0, greatest(coalesce(c.resid_far, 0), coalesce(c.comm_far, 0)) - coalesce(c.built_far, 0)))),
        'touches', coalesce(c.touches_subject, c.bbl = s.bbl)
      ) order by c.bbl)
      from cluster c
    ), '[]'::jsonb)
  )
  from subject s;
$$;

-- parcels_opportunities: the underbuilt-envelope universe in raw PLUTO
-- vocabulary, so the contract layer's production parcel mapper applies as-is.
create or replace function public.parcels_opportunities(p_zips text[] default null, p_limit integer default 160)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(t.row), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'bbl', p.bbl, 'address', p.address, 'zipcode', p.zipcode,
      'block', p.block, 'lot', p.lot,
      'lotarea', p.lot_area, 'bldgarea', p.bldg_area,
      'builtfar', p.built_far, 'residfar', p.resid_far, 'commfar', p.comm_far,
      'landuse', p.land_use, 'bldgclass', p.bldg_class, 'zonedist1', p.zoning,
      'ownername', p.owner_name, 'unitsres', p.units_res, 'unitstotal', p.units_total,
      'yearbuilt', p.year_built, 'numfloors', p.num_floors,
      'assessland', p.assess_land, 'assesstot', p.assess_total,
      'latitude', p.lat, 'longitude', p.lng
    ) as row,
    (coalesce(p.lot_area, 0) * greatest(0, greatest(coalesce(p.resid_far, 0), coalesce(p.comm_far, 0)) - coalesce(p.built_far, 0))) as unused_sf
    from public.parcels p
    where (p_zips is null or p.zipcode = any (p_zips))
      and greatest(coalesce(p.resid_far, 0), coalesce(p.comm_far, 0)) > 0
    order by unused_sf desc
    limit least(greatest(coalesce(p_limit, 160), 1), 400)
  ) t;
$$;

-- tax_history_at: DOF valuation roll rows for a BBL, newest first.
create or replace function public.tax_history_at(p_bbl text)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'year', b.year,
    'taxClass', b.tax_class,
    'marketValue', b.market_value,
    'assessedTotal', b.assessed_total,
    'taxable', b.taxable
  ) order by b.year desc), '[]'::jsonb)
  from public.tax_bills b
  where b.bbl = p_bbl;
$$;

-- parcel_contacts: permit applicants (DOB) and recorded mortgage parties
-- (ACRIS) already ingested for this lot.
create or replace function public.parcel_contacts(p_bbl text)
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'permitContacts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', nullif(trim(concat_ws(' ', f.raw->>'permittee_s_first_name', f.raw->>'permittee_s_last_name',
                                            f.raw->>'applicant_first_name', f.raw->>'applicant_last_name')), ''),
        'business', coalesce(f.raw->>'permittee_s_business_name', f.raw->>'applicant_business_name', f.raw->>'owner_s_business_name'),
        'phone', coalesce(f.raw->>'permittee_s_phone__', f.raw->>'owner_s_phone__'),
        'role', coalesce(f.raw->>'work_type', f.raw->>'job_type', f.filing_type),
        'date', f.filed_at,
        'source', case f.source when 'dob_now' then 'DOB NOW job filing' else 'DOB permit issuance' end
      ) order by f.filed_at desc nulls last)
      from (
        select * from public.dob_filings
        where bbl = p_bbl and source in ('dob_permits', 'dob_now')
        order by filed_at desc nulls last
        limit 8
      ) f
    ), '[]'::jsonb),
    'debtParties', coalesce((
      select d.parties from public.acris_docs d
      where d.bbl = p_bbl and d.doc_type ~* 'MTGE|MORTGAGE|AGMT|CONSOLIDAT'
      order by d.recorded_at desc nulls last
      limit 1
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------- ingest RPCs
-- Service-role-only batch upserts. Geometry arrives as GeoJSON and is
-- normalized server-side (ST_GeomFromGeoJSON → ST_MakeValid → ST_Multi);
-- lat/lng default to ST_PointOnSurface so every lot has a usable centroid.
create or replace function public.ingest_parcels(p_rows jsonb)
returns integer
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  n integer := 0;
  r jsonb;
  g extensions.geometry;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce(r->>'bbl', '') !~ '^[1-5][0-9]{9}$' then continue; end if;
    g := null;
    if jsonb_typeof(r->'geom') = 'object' then
      begin
        g := st_multi(st_makevalid(st_setsrid(st_geomfromgeojson((r->'geom')::text), 4326)));
      exception when others then g := null;
      end;
    end if;
    insert into public.parcels as t (
      bbl, block, lot, address, zipcode, owner_name, bldg_class, land_use, zoning,
      lot_area, bldg_area, built_far, resid_far, comm_far, facil_far, num_floors,
      units_res, units_total, year_built, assess_land, assess_total, lat, lng, attrs, geom, updated_at
    ) values (
      r->>'bbl',
      nullif(r->>'block', '')::integer,
      nullif(r->>'lot', '')::integer,
      nullif(r->>'address', ''),
      nullif(r->>'zipcode', ''),
      nullif(r->>'owner_name', ''),
      nullif(r->>'bldg_class', ''),
      nullif(r->>'land_use', ''),
      nullif(r->>'zoning', ''),
      nullif(r->>'lot_area', '')::double precision,
      nullif(r->>'bldg_area', '')::double precision,
      nullif(r->>'built_far', '')::double precision,
      nullif(r->>'resid_far', '')::double precision,
      nullif(r->>'comm_far', '')::double precision,
      nullif(r->>'facil_far', '')::double precision,
      nullif(r->>'num_floors', '')::double precision,
      nullif(r->>'units_res', '')::integer,
      nullif(r->>'units_total', '')::integer,
      nullif(r->>'year_built', '')::integer,
      nullif(r->>'assess_land', '')::double precision,
      nullif(r->>'assess_total', '')::double precision,
      coalesce(nullif(r->>'lat', '')::double precision, case when g is not null then st_y(st_pointonsurface(g)) end),
      coalesce(nullif(r->>'lng', '')::double precision, case when g is not null then st_x(st_pointonsurface(g)) end),
      coalesce(r->'attrs', '{}'::jsonb),
      g,
      now()
    )
    on conflict (bbl) do update set
      block = excluded.block, lot = excluded.lot, address = excluded.address,
      zipcode = excluded.zipcode, owner_name = excluded.owner_name,
      bldg_class = excluded.bldg_class, land_use = excluded.land_use, zoning = excluded.zoning,
      lot_area = excluded.lot_area, bldg_area = excluded.bldg_area, built_far = excluded.built_far,
      resid_far = excluded.resid_far, comm_far = excluded.comm_far, facil_far = excluded.facil_far,
      num_floors = excluded.num_floors, units_res = excluded.units_res, units_total = excluded.units_total,
      year_built = excluded.year_built, assess_land = excluded.assess_land, assess_total = excluded.assess_total,
      lat = excluded.lat, lng = excluded.lng, attrs = excluded.attrs,
      geom = coalesce(excluded.geom, t.geom), updated_at = now();
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.ingest_ntas(p_rows jsonb)
returns integer
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  n integer := 0;
  r jsonb;
  g extensions.geometry;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if coalesce(r->>'nta_code', '') = '' then continue; end if;
    g := null;
    if jsonb_typeof(r->'geom') = 'object' then
      begin
        g := st_multi(st_makevalid(st_setsrid(st_geomfromgeojson((r->'geom')::text), 4326)));
      exception when others then g := null;
      end;
    end if;
    insert into public.ntas as t (nta_code, name, boro, geom, updated_at)
    values (r->>'nta_code', coalesce(nullif(r->>'name', ''), r->>'nta_code'), nullif(r->>'boro', ''), g, now())
    on conflict (nta_code) do update set
      name = excluded.name, boro = excluded.boro,
      geom = coalesce(excluded.geom, t.geom), updated_at = now();
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function public.ingest_parcels(jsonb) from public;
revoke execute on function public.ingest_ntas(jsonb) from public;
grant execute on function public.ingest_parcels(jsonb) to service_role;
grant execute on function public.ingest_ntas(jsonb) to service_role;

-- Read functions are the public surface for the public-record store.
revoke execute on function public.lot_at(double precision, double precision) from public;
revoke execute on function public.nta_polys(double precision, double precision, double precision, double precision) from public;
revoke execute on function public.assemblage_at(text) from public;
revoke execute on function public.parcels_opportunities(text[], integer) from public;
revoke execute on function public.tax_history_at(text) from public;
revoke execute on function public.parcel_contacts(text) from public;

grant execute on function public.lot_at(double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.nta_polys(double precision, double precision, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.assemblage_at(text) to anon, authenticated, service_role;
grant execute on function public.parcels_opportunities(text[], integer) to anon, authenticated, service_role;
grant execute on function public.tax_history_at(text) to anon, authenticated, service_role;
grant execute on function public.parcel_contacts(text) to anon, authenticated, service_role;
