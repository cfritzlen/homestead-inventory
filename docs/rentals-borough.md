# Rentals → Borough tab: East Stroudsburg rental registration

Every fall the Borough (Sue Balmoos, Code Enforcement, 570-421-8300 x117)
emails the Rental Registration packet. The **2027 packet is due 10/01/2026**.
The Borough tab keeps the forms, fills them from your lease data, and tracks
what was sent for each unit.

## One-time setup
1. Supabase (Homestead project) → SQL Editor → paste all of
   `supabase/migrations/021_borough_registration.sql` → Run, then the same
   with `022_borough_signing.sql`.
1b. In a terminal in the repo folder (after `git pull`):
   ```
   supabase functions deploy borough-sign --no-verify-jwt
   ```
   Same flag as lease-sign: tenants have no login, their private link is the key.
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
- **Sign & send to tenants** (units with tenants): you sign, each tenant
  gets an email link (sign.html?b=…) to read the Addendum and tap "Sign
  here". When the last one signs, the app adds a signing-record page and,
  if the box was ticked, emails the whole packet (Registration, affidavit if
  any, signed Addendum) to rental@eaststroudsburgboro.org with you in copy.
  Otherwise a **Send packet to Borough** button appears.
- **Send packet to Borough** (vacant units, or after signing when auto-send
  was off): you see every file first, then it emails.
- **Review & send all ready units in one email** (top of the unit list):
  one email to the Borough with every ready unit's packet. A unit is ready
  once its Addendum is signed or it is vacant.
- Each unit card has **Edit tenant details** (email, phone, employer) that
  saves straight to the lease.
- The unit then shows "Sent to the Borough" with the date; set it to
  **License received** when the license arrives and attach it.
- Prefer paper? **Filled packet (zip)** still downloads everything to send
  yourself.
- Tenants only ever see the 2-page Addendum. Its manager address line uses
  "Address tenants see on the Addendum" from Owner details (falls back to
  the mailing address).

## Files
- Blank forms and Sue's guides: `assets/borough/*.pdf`.
- Form filling (line positions): `assets/borough-forms.js`. If the Borough
  sends new versions of the forms, replace the PDFs and tell Claude so the
  positions get redone.
- Tab logic: `assets/borough.js`. Building-wide defaults (4 units, 2 bed /
  1 bath, 1 water / 5 electric / 4 trash meters, smoke detectors yes,
  license and evacuation plan not posted) live in `BOROUGH_UNIT_DEFAULTS`
  there; Unit details overrides them per unit.
- Signing: `supabase/functions/borough-sign/index.ts` (mirror of lease-sign)
  and the `?b=` mode of `sign.html`.
- Tables: `rental_borough_filings` (one row per unit per year, with
  signing_status / auto_submit), `rental_borough_signers`,
  `rental_borough_files` (copies, stored in the private `rental-leases`
  bucket under `borough/`), `borough_info` column on `rental_properties`,
  and the `borough_info` key in `rental_settings`.
