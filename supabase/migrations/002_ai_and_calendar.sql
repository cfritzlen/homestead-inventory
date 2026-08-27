-- Phase 2: AI extraction + Gmail ingest + Google Calendar sync
-- Run in Supabase → SQL Editor after Phase 1. Idempotent.

-- ============================================================================
-- 1. Add status to family_events (for the review queue)
-- ============================================================================
do $$ begin
  if not exists (select 1 from pg_type where typname = 'family_event_status') then
    create type family_event_status as enum ('proposed','approved','rejected');
  end if;
end $$;

alter table public.family_events
  add column if not exists status family_event_status not null default 'approved',
  add column if not exists source text,                    -- 'manual' | 'ai' | 'gmail'
  add column if not exists source_ref text,                -- e.g. gmail message id, doc id
  add column if not exists ai_confidence real,             -- 0..1
  add column if not exists ai_notes text;                  -- reasoning/context from Claude

-- Existing rows created before Phase 2 were manually entered — mark them so
create or replace function public.__phase2_backfill_source() returns void as $$
begin
  update public.family_events set source = 'manual' where source is null;
end $$ language plpgsql;
select public.__phase2_backfill_source();
drop function public.__phase2_backfill_source();

create index if not exists family_events_status_idx on public.family_events(status);

-- ============================================================================
-- 2. AI extraction runs — one row per Claude call, for debugging + cost tracking
-- ============================================================================
create table if not exists public.ai_extractions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid references public.family_documents(id) on delete cascade,
  model         text not null,
  prompt_tokens integer,
  output_tokens integer,
  cost_usd      numeric(10,6),
  raw_response  jsonb,
  events_created integer default 0,
  error         text,
  created_at    timestamptz not null default now()
);

-- ============================================================================
-- 3. OAuth tokens — a single row per (provider, account_email) pair
-- ============================================================================
create table if not exists public.oauth_tokens (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,                  -- 'google'
  account_email  text not null,
  refresh_token  text not null,
  access_token   text,
  expires_at     timestamptz,
  scopes         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (provider, account_email)
);

-- ============================================================================
-- 4. Gmail ingest state — remembers the last historyId we processed, so each
--    poll only picks up new/labeled messages
-- ============================================================================
create table if not exists public.gmail_state (
  account_email       text primary key,
  last_history_id     text,
  label_id            text,        -- resolved id for the "family-hub" label
  last_polled_at      timestamptz,
  last_error          text,
  updated_at          timestamptz not null default now()
);

-- ============================================================================
-- 5. RLS on new tables — signed-in users can read/write, but oauth_tokens is
--    lockdown: only the service_role (i.e. Edge Functions) can touch it.
-- ============================================================================
alter table public.ai_extractions enable row level security;
alter table public.oauth_tokens   enable row level security;
alter table public.gmail_state    enable row level security;

drop policy if exists "signed-in read ai_extractions" on public.ai_extractions;
create policy "signed-in read ai_extractions"
  on public.ai_extractions for select using (auth.role() = 'authenticated');
-- writes only via service_role — no policy for insert/update/delete for `authenticated`

-- oauth_tokens: no policies for authenticated. service_role bypasses RLS.
-- (This keeps refresh tokens off the client entirely.)

-- gmail_state: same lockdown as oauth_tokens.

-- ============================================================================
-- 6. Storage: a signed-URL webhook trigger from Storage isn't first-class in
--    Supabase yet, so we use a database trigger on family_documents inserts to
--    call the ai-extract Edge Function.
-- ============================================================================
create extension if not exists pg_net;                    -- enables http calls from Postgres

create or replace function public.trigger_ai_extract()
returns trigger language plpgsql security definer as $$
declare
  fn_url text;
  service_key text;
begin
  -- These are set via `alter database ... set` (see docs/phase2-setup.md)
  fn_url := current_setting('app.ai_extract_url', true);
  service_key := current_setting('app.service_role_key', true);
  if fn_url is null or service_key is null then
    -- Not yet configured; skip silently. Manual retry via "Process now" button works.
    return new;
  end if;
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body := jsonb_build_object('document_id', new.id::text)
  );
  return new;
end $$;

drop trigger if exists trg_ai_extract on public.family_documents;
create trigger trg_ai_extract
  after insert on public.family_documents
  for each row execute function public.trigger_ai_extract();

-- Do the same for approved-event → push-to-calendar
create or replace function public.trigger_push_calendar()
returns trigger language plpgsql security definer as $$
declare
  fn_url text;
  service_key text;
begin
  if new.status = 'approved' and (old.status is distinct from new.status)
     and new.google_event_id is null then
    fn_url := current_setting('app.push_calendar_url', true);
    service_key := current_setting('app.service_role_key', true);
    if fn_url is null or service_key is null then
      return new;
    end if;
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body := jsonb_build_object('event_id', new.id::text)
    );
  end if;
  return new;
end $$;

drop trigger if exists trg_push_calendar on public.family_events;
create trigger trg_push_calendar
  after update on public.family_events
  for each row execute function public.trigger_push_calendar();
