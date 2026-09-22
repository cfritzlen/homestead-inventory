-- Rentals → Borough tab: keep the rental license number the Borough sends back
-- for each unit and year. Run once in Supabase → SQL Editor. Safe to re-run.
alter table public.rental_borough_filings add column if not exists license_no text;
