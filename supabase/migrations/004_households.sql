-- Phase 3: multi-household support.
-- Same database, invisible walls: every family-hub row belongs to a household,
-- and RLS scopes reads/writes to households you're a member of.
-- Existing data is backfilled into an "Our Family" owner household whose
-- members keep access to the legacy homestead pages.
-- Run in Supabase → SQL Editor. Idempotent where possible.

-- ============================================================================
-- 1. Core tables
-- ============================================================================
create table if not exists public.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id  uuid not null references public.households(id) on delete cascade,
  user_id       uuid not null,
  email         text not null,
  role          text not null default 'member',          -- 'owner' | 'member'
  can_access_homestead boolean not null default false,   -- legacy homestead pages
  created_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index if not exists household_members_user_idx on public.household_members(user_id);

create table if not exists public.household_invites (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  household_id uuid references public.households(id) on delete cascade,  -- null = "gets their own household"
  invited_by   uuid not null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz
);
create index if not exists household_invites_email_idx on public.household_invites(lower(email));

-- ============================================================================
-- 2. Helper: which households am I in?  (security definer dodges RLS recursion)
-- ============================================================================
create or replace function public.my_household_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select household_id from public.household_members where user_id = auth.uid();
$$;

create or replace function public.am_homestead_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(bool_or(can_access_homestead), false)
  from public.household_members where user_id = auth.uid();
$$;

-- ============================================================================
-- 3. Add household_id to the family tables
-- ============================================================================
alter table public.family_events    add column if not exists household_id uuid references public.households(id);
alter table public.family_documents add column if not exists household_id uuid references public.households(id);
alter table public.oauth_tokens     add column if not exists household_id uuid references public.households(id);
alter table public.oauth_tokens     add column if not exists is_calendar_target boolean not null default true;
alter table public.gmail_state      add column if not exists household_id uuid references public.households(id);

create index if not exists family_events_household_idx    on public.family_events(household_id);
create index if not exists family_documents_household_idx on public.family_documents(household_id);

-- ============================================================================
-- 4. Backfill: one owner household adopts all existing rows + users
-- ============================================================================
do $$
declare
  hh uuid;
begin
  select id into hh from public.households where name = 'Our Family' limit 1;
  if hh is null then
    insert into public.households(name) values ('Our Family') returning id into hh;
  end if;

  insert into public.household_members(household_id, user_id, email, role, can_access_homestead)
  select hh, u.id, u.email, 'owner', true
  from auth.users u
  on conflict (household_id, user_id) do nothing;

  update public.family_events    set household_id = hh where household_id is null;
  update public.family_documents set household_id = hh where household_id is null;
  update public.oauth_tokens     set household_id = hh where household_id is null;
  update public.gmail_state      set household_id = hh where household_id is null;
end $$;

-- Now that everything's backfilled, require household_id going forward
alter table public.family_events    alter column household_id set not null;
alter table public.family_documents alter column household_id set not null;

-- ============================================================================
-- 5. Auto-fill household on client inserts (service role sets it explicitly)
-- ============================================================================
create or replace function public.default_household()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.household_id is null and auth.uid() is not null then
    select household_id into new.household_id
    from public.household_members where user_id = auth.uid() limit 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_default_household_events on public.family_events;
create trigger trg_default_household_events
  before insert on public.family_events
  for each row execute function public.default_household();

drop trigger if exists trg_default_household_docs on public.family_documents;
create trigger trg_default_household_docs
  before insert on public.family_documents
  for each row execute function public.default_household();

-- ============================================================================
-- 6. Onboarding functions (called from the UI via rpc)
-- ============================================================================
-- Accept any pending invites for my email. Joining a household requires an
-- invite; this is the only path in (household_members has no insert policy).
create or replace function public.accept_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare
  accepted int := 0;
  inv record;
begin
  for inv in
    select * from public.household_invites
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and accepted_at is null and household_id is not null
  loop
    insert into public.household_members(household_id, user_id, email)
    values (inv.household_id, auth.uid(), auth.jwt() ->> 'email')
    on conflict do nothing;
    update public.household_invites set accepted_at = now() where id = inv.id;
    accepted := accepted + 1;
  end loop;
  return accepted;
end $$;

-- Create my own household (used by own-household invitees; also marks the
-- open-ended invite accepted). Refuses if I already belong to one.
create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  hh uuid;
  has_invite boolean;
begin
  if exists (select 1 from public.household_members where user_id = auth.uid()) then
    raise exception 'already in a household';
  end if;
  select exists(
    select 1 from public.household_invites
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and accepted_at is null and household_id is null
  ) into has_invite;
  if not has_invite then
    raise exception 'no invite for this email';
  end if;
  insert into public.households(name, created_by) values (p_name, auth.uid()) returning id into hh;
  insert into public.household_members(household_id, user_id, email, role)
  values (hh, auth.uid(), auth.jwt() ->> 'email', 'owner');
  update public.household_invites set accepted_at = now()
  where lower(email) = lower(auth.jwt() ->> 'email') and accepted_at is null and household_id is null;
  return hh;
end $$;

grant execute on function public.accept_invites() to authenticated;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.my_household_ids() to authenticated;
grant execute on function public.am_homestead_member() to authenticated;
revoke execute on function public.accept_invites() from anon;
revoke execute on function public.create_household(text) from anon;
revoke execute on function public.my_household_ids() from anon;
revoke execute on function public.am_homestead_member() from anon;

-- ============================================================================
-- 7. RLS: household walls
-- ============================================================================
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

drop policy if exists "members read households" on public.households;
create policy "members read households" on public.households
  for select using (id in (select public.my_household_ids()));
drop policy if exists "members rename household" on public.households;
create policy "members rename household" on public.households
  for update using (id in (select public.my_household_ids()));

drop policy if exists "see own memberships" on public.household_members;
create policy "see own memberships" on public.household_members
  for select using (user_id = auth.uid() or household_id in (select public.my_household_ids()));

drop policy if exists "see my invites" on public.household_invites;
create policy "see my invites" on public.household_invites
  for select using (
    lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or invited_by = auth.uid()
    or household_id in (select public.my_household_ids())
  );
drop policy if exists "members create invites" on public.household_invites;
create policy "members create invites" on public.household_invites
  for insert with check (
    invited_by = auth.uid()
    and (household_id is null or household_id in (select public.my_household_ids()))
  );
drop policy if exists "cancel own invites" on public.household_invites;
create policy "cancel own invites" on public.household_invites
  for delete using (invited_by = auth.uid());

-- Replace the "any signed-in" family policies with household-scoped ones
drop policy if exists "signed-in read events"  on public.family_events;
drop policy if exists "signed-in write events" on public.family_events;
drop policy if exists "hh events" on public.family_events;
create policy "hh events" on public.family_events
  for all
  using (household_id in (select public.my_household_ids()))
  with check (household_id in (select public.my_household_ids()) or household_id is null);

drop policy if exists "signed-in read docs"  on public.family_documents;
drop policy if exists "signed-in write docs" on public.family_documents;
drop policy if exists "hh docs" on public.family_documents;
create policy "hh docs" on public.family_documents
  for all
  using (household_id in (select public.my_household_ids()))
  with check (household_id in (select public.my_household_ids()) or household_id is null);

-- ai_extractions: readable if you can see the underlying document
drop policy if exists "signed-in read ai_extractions" on public.ai_extractions;
drop policy if exists "hh read ai_extractions" on public.ai_extractions;
create policy "hh read ai_extractions" on public.ai_extractions
  for select using (
    document_id in (select id from public.family_documents
                    where household_id in (select public.my_household_ids()))
  );

-- ============================================================================
-- 8. Scope the accounts view by household
-- ============================================================================
create or replace view public.family_accounts as
  select account_email, scopes, updated_at, household_id
  from public.oauth_tokens
  where provider = 'google'
    and household_id in (select public.my_household_ids());
revoke all on public.family_accounts from anon, authenticated;
grant select on public.family_accounts to authenticated;

-- ============================================================================
-- 9. Storage: household-prefixed paths.
--    New uploads land under {household_id}/...; legacy year-prefixed paths
--    stay readable by the owner household only.
-- ============================================================================
do $$
declare
  hh uuid;
begin
  select id into hh from public.households where name = 'Our Family' limit 1;

  -- Tear out the old any-authenticated policies
  execute 'drop policy if exists "signed-in read family-docs" on storage.objects';
  execute 'drop policy if exists "signed-in insert family-docs" on storage.objects';
  execute 'drop policy if exists "signed-in update family-docs" on storage.objects';
  execute 'drop policy if exists "signed-in delete family-docs" on storage.objects';
  execute 'drop policy if exists "hh read family-docs" on storage.objects';
  execute 'drop policy if exists "hh insert family-docs" on storage.objects';
  execute 'drop policy if exists "hh delete family-docs" on storage.objects';

  execute format($p$
    create policy "hh read family-docs" on storage.objects for select using (
      bucket_id = 'family-docs' and (
        (storage.foldername(name))[1] in (select public.my_household_ids()::text)
        or ((storage.foldername(name))[1] ~ '^20\d\d$'
            and %L in (select public.my_household_ids()::text))
      )
    )$p$, hh::text);

  execute $p$
    create policy "hh insert family-docs" on storage.objects for insert with check (
      bucket_id = 'family-docs'
      and (storage.foldername(name))[1] in (select public.my_household_ids()::text)
    )$p$;

  execute format($p$
    create policy "hh delete family-docs" on storage.objects for delete using (
      bucket_id = 'family-docs' and (
        (storage.foldername(name))[1] in (select public.my_household_ids()::text)
        or ((storage.foldername(name))[1] ~ '^20\d\d$'
            and %L in (select public.my_household_ids()::text))
      )
    )$p$, hh::text);
end $$;
