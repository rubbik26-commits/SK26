-- Restore the execution grant required by the self-only account-deletion design.
--
-- 202608170003_account_delete_self_only.sql deliberately makes auth.uid() the
-- account authority inside cre_account_delete_tk() and grants EXECUTE only to
-- authenticated users. The live project subsequently lost that grant: the
-- function ACL contained only the owner, so a correctly signed-in user could not
-- invoke the self-delete RPC and account_delete_schema_check() reported
-- authenticatedExecute=false. This migration reasserts the intended least-
-- privilege boundary without granting anon or service_role direct execution of
-- the token RPC.

revoke all on function public.cre_account_delete_tk(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cre_account_delete_tk(uuid, text)
  to authenticated;

-- The schema probe itself is deployment metadata. The production verifier uses
-- a validated server credential, so keep the probe callable by service_role only.
revoke all on function public.account_delete_schema_check()
  from public, anon, authenticated, service_role;
grant execute on function public.account_delete_schema_check()
  to service_role;
