-- Unify the exact production Kanban (oppId stages) with Dossier/My Desk parcel
-- pipeline rows in one authenticated cre_pipeline table.
alter table public.cre_pipeline add column if not exists opp_id text;
create unique index if not exists cre_pipeline_user_opp_uq
  on public.cre_pipeline(user_id,opp_id) where opp_id is not null;
create index if not exists cre_pipeline_user_updated_idx
  on public.cre_pipeline(user_id,updated_at desc);

-- Existing direct-browser insert/update grants remain column-scoped. Allow the
-- server/API compatibility layer to use opp_id through the user's JWT/RLS.
grant insert(user_id,bbl,address,owner_entity,stage,distress_score,propensity_score,assessed_value,last_sale,notes,metadata,opp_id,created_at,updated_at)
  on public.cre_pipeline to authenticated;
grant update(address,owner_entity,stage,distress_score,propensity_score,assessed_value,last_sale,notes,metadata,opp_id,updated_at)
  on public.cre_pipeline to authenticated;
