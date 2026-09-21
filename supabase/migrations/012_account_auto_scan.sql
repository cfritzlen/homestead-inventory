-- Daily auto-scan becomes a per-account choice.
-- Each connected Google account gets a "Daily scan" toggle in the hub. The
-- daily 36-hour scan (migration 011) only reads accounts that have it on.
-- The old household-wide "auto_scan_email" setting (15-minute inbox polling)
-- is retired; the 15-minute cron now only handles the family-hub label.

alter table public.oauth_tokens
  add column if not exists auto_scan boolean not null default false;

-- Carry the old household setting over so nobody loses their scan.
update public.oauth_tokens t
   set auto_scan = true
  from public.households h
 where h.id = t.household_id
   and (h.settings ->> 'auto_scan_email') = 'true';

-- Expose the flag (never the tokens) to signed-in household members.
create or replace view public.family_accounts as
  select account_email, scopes, updated_at, household_id, auto_scan
  from public.oauth_tokens
  where provider = 'google'
    and household_id in (select public.my_household_ids());
revoke all on public.family_accounts from anon, authenticated;
grant select on public.family_accounts to authenticated;

-- Toggle from the hub. Security definer so the row can be updated without
-- opening oauth_tokens to authenticated users; scoped to the caller's households.
create or replace function public.set_account_auto_scan(p_email text, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.oauth_tokens
     set auto_scan = p_enabled
   where provider = 'google'
     and account_email = p_email
     and household_id in (select public.my_household_ids());
  return found;
end $$;
revoke all on function public.set_account_auto_scan(text, boolean) from public, anon;
grant execute on function public.set_account_auto_scan(text, boolean) to authenticated;
