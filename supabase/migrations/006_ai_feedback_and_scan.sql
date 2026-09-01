-- Phase 3.2: AI feedback loop + inbox auto-scan support.
-- Run in Supabase → SQL Editor. Idempotent.

-- 1. Human-readable outcome per extraction (shown in the AI activity feed)
alter table public.ai_extractions add column if not exists summary text;

-- 2. Track the auto-scan high-water mark per gmail account
alter table public.gmail_state add column if not exists last_scan_at timestamptz;

-- 3. Realtime: let the UI hear inserts/updates live (nudge appears without
--    a manual refresh). Duplicate adds are ignored.
do $$ begin
  begin
    alter publication supabase_realtime add table public.family_events;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.family_documents;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table public.ai_extractions;
  exception when duplicate_object then null; end;
end $$;
