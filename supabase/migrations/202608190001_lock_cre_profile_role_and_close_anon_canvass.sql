-- Owner workspace privilege boundary.
--
-- cre_profiles.role is the authority source consumed by cre_is_owner(). An
-- authenticated account may edit its own display/report preferences, but role
-- promotion must remain a server/service-role operation. RLS constrained the
-- row id but did not make the role column immutable, so a direct PATCH could
-- otherwise promote the caller's own row.
revoke update on table public.cre_profiles from authenticated;
grant update (display_name, report_identity, updated_at) on table public.cre_profiles to authenticated;

-- cre_canvass is authenticated-user workspace data. Its RLS policy already
-- limits rows to auth.uid(); remove the leftover anon table grants so the SQL
-- privilege surface matches the product contract instead of relying on an
-- implicit RLS denial.
revoke all privileges on table public.cre_canvass from anon;
