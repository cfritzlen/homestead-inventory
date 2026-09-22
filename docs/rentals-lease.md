# Rentals: the lease PDF, per-property options, signed copies

## One-time setup
1. Supabase (Homestead project) → SQL Editor → paste all of
   `supabase/migrations/015_rental_lease_docs.sql` → Run.
2. Rentals → New Lease → open **Landlord contact** and check the name, email
   and phone. They print on every lease (page 1, the emergency line on page 4,
   and the signature page).

## The PDF
"Save & Generate PDF" (or the **PDF** button on any lease) downloads the full
19-page lease:
- Page 1 and page 19 are drawn from the lease details.
- Pages 2–18 come from `assets/lease-middle-pages.pdf`. The app stamps onto
  them: the emergency phone, a box around each Landlord/Tenant choice, and
  one initial line per tenant (with the tenant's name under it) on every
  "By initialing below" line.
- A copy of every generated PDF is kept on the lease.

**If you ever replace `assets/lease-middle-pages.pdf`**, the stamp positions
(and the old phone-number removal) must be redone. Tell Claude.

## Lease options (per property)
On the New Lease form, under the property, pick the appliances included and
who handles each maintenance and utility item. They are saved with the lease
and become that property's defaults for next time.

## Signed copies
All Leases → **View** opens the lease with its files. **Attach signed lease**
uploads the signed PDF (or a photo); the lease then shows a "✓ Signed" badge.
Files live in the private `rental-leases` bucket; links expire after 10
minutes and only work when signed in.

## Units and leases
Every lease points at its unit (`rental_leases.property_id` →
`rental_properties.id`, migration 024). All Leases groups by that link and
falls back to matching the address text for anything not linked yet; the
orange banner on All Leases → **Link leases to units** finishes the job and
can create missing unit records from a lease address.

## Tables
`rental_settings` (landlord contact), `rental_lease_files` (files on a
lease), plus a `lease_options` column on `rental_properties` and
`rental_leases`.
