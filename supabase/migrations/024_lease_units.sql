-- Leases point at their unit (rental_properties) instead of only carrying the
-- address as text. Run once in Supabase → SQL Editor. Safe to re-run.
-- After running: Rentals → All Leases → "Link leases to units" finishes any
-- lease whose address does not exactly match a unit name.

alter table public.rental_leases add column if not exists property_id bigint references public.rental_properties(id) on delete set null;
create index if not exists rental_leases_property_idx on public.rental_leases(property_id);

-- Exact name matches link straight away
update public.rental_leases l
   set property_id = p.id
  from public.rental_properties p
 where l.property_id is null
   and p.is_building_level = false
   and lower(trim(l.property_address)) = lower(trim(p.property_name));
