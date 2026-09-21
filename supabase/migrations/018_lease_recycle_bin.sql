-- Rentals: recycle bin for leases. Delete marks the row instead of removing
-- it; the bin can restore it or delete it for good. Safe to re-run.
alter table public.rental_leases add column if not exists deleted_at timestamptz;
create index if not exists rental_leases_deleted_idx on public.rental_leases(deleted_at);
