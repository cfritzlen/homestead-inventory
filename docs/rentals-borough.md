# Rentals → Borough tab: East Stroudsburg rental registration

Every fall the Borough (Sue Balmoos, Code Enforcement, 570-421-8300 x117)
emails the Rental Registration packet. The **2027 packet is due 10/01/2026**.
The Borough tab keeps the forms, fills them from your lease data, and tracks
what was sent for each unit.

## One-time setup
1. Supabase (Homestead project) → SQL Editor → paste all of
   `supabase/migrations/021_borough_registration.sql` → Run.
2. Rentals → Borough → open **Owner & property manager details**, fill in
   your mailing address (and manager info if someone else manages), Save.
   If you have not set up a signature yet, tap **Set up my signature &
   initials** so the forms come out signed and initialed.
3. For each unit tap **Unit details** and fill in the PIN/Tax ID, number of
   units in the building, bedrooms/bathrooms, meters and the yes/no questions.
   These are saved and reused every year.

## Each year
- The dashboard shows the deadline and how many units were sent.
- On the Borough tab, for each unit pick what applies: **Same tenants**,
  **New tenants** or **Vacant**. The app guesses from the current lease.
- **Filled packet (zip)** downloads the right forms already typed:
  - Same tenants → Registration + Affidavit of Same Tenants + Addendum
    (send last year's signed Addendum if you still have it).
  - New tenants → Registration + Addendum (every adult signs it).
  - Vacant → Registration (tenant line says VACANT) + Affidavit of Vacant Unit.
- Check every line, get tenant signatures on the Addendum, then email the
  packet to rental@eaststroudsburgboro.org. Set the unit to **Sent to
  Borough**, and attach a copy of what you sent (and later the license).

## Files
- Blank forms and Sue's guides: `assets/borough/*.pdf`.
- Form filling (line positions): `assets/borough-forms.js`. If the Borough
  sends new versions of the forms, replace the PDFs and tell Claude so the
  positions get redone.
- Tab logic: `assets/borough.js`. Tables: `rental_borough_filings` (one row
  per unit per year), `rental_borough_files` (copies, stored in the private
  `rental-leases` bucket under `borough/`), `borough_info` column on
  `rental_properties`, and the `borough_info` key in `rental_settings`.
