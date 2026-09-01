-- Phase 2.1: expose a safe list of connected Google accounts to the UI.
-- oauth_tokens itself stays service-role-only (refresh tokens never reach the
-- client); this view exposes only email + scopes + freshness.
-- Run in Supabase → SQL Editor. Idempotent.

create or replace view public.family_accounts as
  select account_email, scopes, updated_at
  from public.oauth_tokens
  where provider = 'google';

-- View owner (postgres) bypasses RLS on oauth_tokens; gate the view itself:
revoke all on public.family_accounts from anon, authenticated;
grant select on public.family_accounts to authenticated;
