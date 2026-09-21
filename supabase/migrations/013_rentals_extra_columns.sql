-- Rentals: extra columns that exist in the old Rental-Manager tables but were
-- not in migration 012. The Rentals page doesn't display them, but they are
-- copied over so nothing is lost. Safe to re-run.

alter table public.rental_properties
  add column if not exists street_address   text,
  add column if not exists unit             text,
  add column if not exists city             text,
  add column if not exists state            text,
  add column if not exists zip              text,
  add column if not exists bedrooms         numeric(4,1),
  add column if not exists bathrooms        numeric(4,1),
  add column if not exists property_type    text,
  add column if not exists has_washer_dryer boolean,
  add column if not exists has_dishwasher   boolean,
  add column if not exists notes            text;

alter table public.rental_leases
  add column if not exists is_renewal        boolean,
  add column if not exists previous_lease_id bigint;

alter table public.rental_payments
  add column if not exists notes text;
