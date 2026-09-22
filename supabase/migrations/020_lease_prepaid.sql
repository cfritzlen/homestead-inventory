-- Rentals: on a renewal, first/last month's rent may have been paid on the
-- original lease. These flags print "previously paid" on the lease. Safe to re-run.
alter table public.rental_leases add column if not exists first_month_prepaid boolean default false;
alter table public.rental_leases add column if not exists last_month_prepaid  boolean default false;
