-- Phase 1 schema for family hub + auth
-- Run this in Supabase → SQL Editor once. Idempotent (safe to re-run).
--
-- After running:
--   1. Go to Authentication → Providers → Email, disable "Confirm email" (so the
--      single shared account can sign in without inbox roundtrip) OR keep it on
--      and confirm from the invite email.
--   2. Go to Authentication → Users → "Add user" → email + password. Just one row.
--      Both you and your spouse use those creds.
--   3. Storage → Create bucket "family-docs", private (not public).
--   4. Storage → family-docs → Policies → add the 4 policies at the bottom of this file.

-- ============================================================================
-- 1. Family events table
-- ============================================================================
create table if not exists public.family_events (
  id           uuid primary key default gen_random_uuid(),
  category     text not null check (category in ('school','medical','travel','vacation','sports','general')),
  title        text not null,
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  all_day      boolean not null default false,
  location     text,
  notes        text,
  document_id  uuid,          -- optional link to family_documents.id
  google_event_id text,        -- filled in once phase 3 syncs it
  created_by   uuid not null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists family_events_starts_at_idx on public.family_events(starts_at);
create index if not exists family_events_category_idx on public.family_events(category);

-- ============================================================================
-- 2. Family documents table (metadata; the actual files live in Storage)
-- ============================================================================
create table if not exists public.family_documents (
  id          uuid primary key default gen_random_uuid(),
  storage_path text not null,   -- e.g. "family-docs/2026/school-note-abc.jpg"
  file_name   text not null,
  mime_type   text,
  size_bytes  bigint,
  category    text,             -- optional pre-tag before AI extraction
  notes       text,
  extracted_at timestamptz,     -- set once phase 2 AI has processed it
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- Add the FK from events → docs now that both tables exist
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_events_document_fkey'
  ) then
    alter table public.family_events
      add constraint family_events_document_fkey
      foreign key (document_id) references public.family_documents(id) on delete set null;
  end if;
end $$;

-- ============================================================================
-- 3. Row Level Security — the whole point.
--    Anyone signed in can read/write. Not signed in = nothing.
--    (Small household, single trusted couple — no per-user isolation needed.)
-- ============================================================================
alter table public.family_events    enable row level security;
alter table public.family_documents enable row level security;

drop policy if exists "signed-in read events"   on public.family_events;
drop policy if exists "signed-in write events"  on public.family_events;
drop policy if exists "signed-in read docs"     on public.family_documents;
drop policy if exists "signed-in write docs"    on public.family_documents;

create policy "signed-in read events"  on public.family_events    for select using (auth.role() = 'authenticated');
create policy "signed-in write events" on public.family_events    for all    using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "signed-in read docs"    on public.family_documents for select using (auth.role() = 'authenticated');
create policy "signed-in write docs"   on public.family_documents for all    using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ============================================================================
-- 4. Do the SAME to your existing tables — this is what actually secures the
--    anon-key leak. Uncomment and adjust table names, then run.
-- ============================================================================
-- Example (repeat for every table currently used by the HTML pages):
--
-- alter table public.finance_transactions enable row level security;
-- create policy "signed-in all on finance_transactions"
--   on public.finance_transactions for all
--   using (auth.role() = 'authenticated')
--   with check (auth.role() = 'authenticated');
--
-- Query to list all your public tables so you know what to add:
--   select tablename from pg_tables where schemaname='public';

-- ============================================================================
-- 5. Storage bucket policies — paste these in the Supabase UI:
--    Storage → family-docs → Policies → "New policy" (custom SQL)
-- ============================================================================
-- Read:
--   create policy "signed-in read family-docs" on storage.objects
--     for select using (bucket_id = 'family-docs' and auth.role() = 'authenticated');
-- Insert:
--   create policy "signed-in insert family-docs" on storage.objects
--     for insert with check (bucket_id = 'family-docs' and auth.role() = 'authenticated');
-- Update:
--   create policy "signed-in update family-docs" on storage.objects
--     for update using (bucket_id = 'family-docs' and auth.role() = 'authenticated');
-- Delete:
--   create policy "signed-in delete family-docs" on storage.objects
--     for delete using (bucket_id = 'family-docs' and auth.role() = 'authenticated');
