-- Phase 3.3: to-dos extracted from emails/documents + in-app scan activity.
-- Run in Supabase → SQL Editor. Idempotent.

-- ============================================================================
-- 1. family_tasks — action items ("fill out form X", "send rent payment")
--    extracted by AI (status='proposed' until approved) or added by hand.
-- ============================================================================
create table if not exists public.family_tasks (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid references public.households(id),
  title         text not null,
  notes         text,
  due_date      date,
  status        text not null default 'proposed'
                check (status in ('proposed','open','done','rejected')),
  source        text default 'ai',
  document_id   uuid references public.family_documents(id) on delete set null,
  ai_confidence numeric,
  created_by    uuid default auth.uid(),
  created_at    timestamptz default now(),
  completed_at  timestamptz
);
alter table public.family_tasks enable row level security;
create index if not exists family_tasks_household_idx on public.family_tasks(household_id);
create index if not exists family_tasks_status_idx    on public.family_tasks(status);

drop policy if exists "hh tasks" on public.family_tasks;
create policy "hh tasks" on public.family_tasks
  for all
  using (household_id in (select public.my_household_ids()))
  with check (household_id in (select public.my_household_ids()) or household_id is null);

drop trigger if exists trg_default_household_tasks on public.family_tasks;
create trigger trg_default_household_tasks
  before insert on public.family_tasks
  for each row execute function public.default_household();

-- ============================================================================
-- 2. scan_activity — one row per email the inbox scan looked at, so the app
--    can show what was kept and what was skipped. Written by gmail-ingest
--    (service role); members can only read their household's rows.
-- ============================================================================
create table if not exists public.scan_activity (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid references public.households(id),
  account_email text,
  gmail_msg_id  text,
  subject       text,
  sender        text,
  attachments   text,
  decision      text,   -- 'ingested' | 'skipped' | 'error'
  detail        text,
  created_at    timestamptz default now()
);
alter table public.scan_activity enable row level security;
create index if not exists scan_activity_hh_time_idx
  on public.scan_activity(household_id, created_at desc);

drop policy if exists "hh read scan_activity" on public.scan_activity;
create policy "hh read scan_activity" on public.scan_activity
  for select using (household_id in (select public.my_household_ids()));

-- ============================================================================
-- 3. Count extracted tasks per AI run (shown in the activity feed)
-- ============================================================================
alter table public.ai_extractions add column if not exists tasks_created int default 0;

-- ============================================================================
-- 4. Realtime so the to-do list updates live
-- ============================================================================
do $$ begin
  begin
    alter publication supabase_realtime add table public.family_tasks;
  exception when duplicate_object then null; end;
end $$;
