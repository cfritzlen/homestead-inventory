-- Rentals: keep the landlord-signed PDF as an untouched base so the working
-- copy and the final signed PDF are always rebuilt from it plus every
-- recorded tenant signature (safe even if two tenants sign at once).
alter table public.rental_leases add column if not exists signing_base_path text;
