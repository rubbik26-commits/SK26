-- Widen acris_docs' primary key on projects that already have the old one.
--
-- 202608130003 now creates the table with primary key (document_id, bbl). This
-- migration brings an already-deployed project to the same shape. It only
-- widens the key, so no rows are lost — but note that rows already overwritten
-- by the previous single-key upsert cannot be recovered here; re-run
-- scripts/ingest/acris.js to repopulate the associations that were dropped.
--
-- Guarded with to_regclass so it is a no-op on a project without the PostGIS
-- layer installed, rather than failing the whole migration run.
do $$
begin
  if to_regclass('public.acris_docs') is null then
    raise notice 'acris_docs not present; skipping';
    return;
  end if;

  if exists (
    select 1
      from pg_constraint
     where conrelid = to_regclass('public.acris_docs')
       and contype  = 'p'
       and array_length(conkey, 1) = 1
  ) then
    execute 'alter table public.acris_docs drop constraint acris_docs_pkey';
    execute 'alter table public.acris_docs add constraint acris_docs_pkey primary key (document_id, bbl)';
    raise notice 'acris_docs primary key widened to (document_id, bbl)';
  end if;

  execute 'create index if not exists acris_docs_document_idx on public.acris_docs (document_id)';
end $$;
