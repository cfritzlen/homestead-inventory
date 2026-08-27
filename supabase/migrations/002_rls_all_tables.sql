-- Phase 1b: enable RLS on every table the site uses.
-- Run this in Supabase → SQL Editor once. Idempotent (safe to re-run).
--
-- This is the concrete version of the commented-out step 4 in
-- 001_family_hub_and_auth.sql: signed-in users can read/write everything,
-- the bare anon key gets nothing. Tables that don't exist in your project
-- are skipped, so the list can be a superset.
--
-- IMPORTANT: the site was updated (assets/auth.js + all pages) to send the
-- signed-in user's token on every request, so enabling RLS here will not
-- break the pages — but run the site update and this script together:
-- old pages + RLS = empty data; new pages work with or without RLS.
--
-- Exception: prediction_trades is used by predictions.html, which connects
-- with its own user-entered key and has no auth gate token — it is included
-- below, so predictions.html will only load data if you paste a signed-in
-- token, or you can delete it from the list to leave that table open.

do $$
declare
  t text;
begin
  foreach t in array array[
    'bp_readings',
    'brain_documents',
    'brain_memories',
    'brain_people',
    'brain_tags',
    'brain_topics',
    'family_documents',
    'family_events',
    'finance_accounts',
    'finance_bill_payments',
    'finance_bills',
    'finance_categories',
    'finance_extra_payments',
    'finance_loan_schedules',
    'finance_other_payments',
    'finance_transactions',
    'finance_weekly_entries',
    'harvest_log',
    'hatching_batches',
    'home_expense_receipts',
    'home_expenses',
    'home_vendors',
    'homestead_chores',
    'inventory',
    'master_items',
    'meal_plan',
    'med_logs',
    'med_notes',
    'meds',
    'plant_entries',
    'plant_photos',
    'prediction_trades',
    'recipe_ingredients',
    'recipe_steps',
    'recipes',
    'shopping_list',
    'sleep_entries',
    'solar_electric_bills'
  ]
  loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = t) then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "signed-in all" on public.%I', t);
      execute format(
        'create policy "signed-in all" on public.%I for all using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
        t
      );
    end if;
  end loop;
end $$;

-- Storage: the receipts bucket used by expenses.html. Same idea — signed-in
-- only. (The family-docs bucket policies are in migration 001's comments.)
--
--   create policy "signed-in read home-receipts" on storage.objects
--     for select using (bucket_id = 'home-receipts' and auth.role() = 'authenticated');
--   create policy "signed-in insert home-receipts" on storage.objects
--     for insert with check (bucket_id = 'home-receipts' and auth.role() = 'authenticated');
--   create policy "signed-in update home-receipts" on storage.objects
--     for update using (bucket_id = 'home-receipts' and auth.role() = 'authenticated');
--   create policy "signed-in delete home-receipts" on storage.objects
--     for delete using (bucket_id = 'home-receipts' and auth.role() = 'authenticated');
