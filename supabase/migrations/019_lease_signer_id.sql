-- Rentals: tenants attach a photo of their government ID while signing.
-- Stored in the private rental-leases bucket; the path is kept here and the
-- file is also listed on the lease (rental_lease_files, kind 'id'). Safe to re-run.
alter table public.rental_lease_signers add column if not exists id_path text;
