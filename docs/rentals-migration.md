# Rentals: moving the data into the Homestead database

One-time, about 5 minutes. Do it **before** merging the branch that switches
`rentals.html` to the new tables (or right after, the page is just empty until
you finish).

1. **Create the tables.** Supabase (Homestead project) → SQL Editor → New query
   → paste all of `supabase/migrations/012_rentals.sql` → Run.
   You should see "Success. No rows returned."
2. **Copy the data.** Open
   `https://cfritzlen.github.io/homestead-inventory/rentals-migrate.html`
   (signed in) → **Check** → **Copy everything**.
   The log at the bottom shows each table and how many receipt files moved.
3. **Look at Rentals.** Open the Rentals card and spot-check a lease, an expense
   with a receipt, and this month's payments.

Nothing is deleted from the old Rental-Manager database, so it stays as a
backup. If the Check step lists "columns not copied", tell Claude which ones
and they can be added to the migration.

Tables created: `rental_properties`, `rental_leases`, `rental_expenses`,
`rental_payment_defaults`, `rental_payments`, `rental_rate_schedules`.
Bucket created: `rental-receipts` (public read, signed-in write, same as the old one).
