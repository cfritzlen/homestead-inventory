-- Phase 3.1: daycare category + per-category Google Calendar sync toggles.
-- Run in Supabase → SQL Editor. Idempotent.

-- 1. Add 'daycare' to the allowed categories
alter table public.family_events drop constraint if exists family_events_category_check;
alter table public.family_events add constraint family_events_category_check
  check (category in ('school','daycare','medical','travel','vacation','sports','general'));

-- family_documents.category is free-text (no constraint) — nothing to change.

-- 2. Household settings blob. sync_categories: which categories push to
--    Google Calendar. When the key is absent, the push function defaults to
--    everything EXCEPT daycare (daycare is opt-in by design).
alter table public.households
  add column if not exists settings jsonb not null default '{}'::jsonb;
