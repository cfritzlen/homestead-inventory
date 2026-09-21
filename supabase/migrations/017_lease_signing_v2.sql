-- Rentals: signing v2. Landlord signs first (stamped on the PDF before it
-- goes out); tenants tap every initial line and the signature line.
-- Run once in Supabase → SQL Editor. Safe to re-run.

alter table public.rental_lease_signers add column if not exists tenant_index integer;          -- 0-3, position among tenants
alter table public.rental_lease_signers add column if not exists stamped      boolean default false; -- already drawn onto signing_pdf_path
alter table public.rental_lease_signers add column if not exists tags_done   integer;              -- how many spots they tapped

-- Landlord's saved signature lives in rental_settings as
-- landlord_signature_png / landlord_initials_png (data URLs). No schema change.
