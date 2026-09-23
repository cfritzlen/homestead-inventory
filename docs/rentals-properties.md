# Rentals → Properties tab

One card per building (503 Lindbergh Ave, 180-182 N Courtland St, 1038 &
1028 Poplar Valley Rd E) with the facts you need for taxes, escrow and
licensing, the paperwork filed by year, and a "Coming up" list.

## One-time setup
1. Supabase → SQL Editor → run `supabase/migrations/025_properties.sql`.
2. Rentals → Properties. If no building cards show, tap **Add property** and
   name each building. Parcel, PIN, tax collector, lender and escrow contact
   for Courtland and Poplar Valley are pre-filled from the 2026 tax bills;
   tap **Edit details** to change or add (loan number, insurance, year built).

## Each year, per building
Tap **Add** next to each item and attach the photo or PDF: county/township
tax bill (March), school tax bill (August), escrow analysis, Form 1098
(January), insurance declarations, rental license. Deed and lead-paint
disclosure are one-time. Mark bills **paid** (or note "paid from escrow") so
they leave "Coming up". Files live in the private `rental-leases` bucket
under `property/`.

## For your accountant
Per building: the year's tax bills, Form 1098, insurance, and the Expenses
tab export. Schedule E is filed per property; depreciation starts from the
deed/closing statement.

## Files
`assets/properties.js`, `property_info` column on building-level
`rental_properties` rows, table `rental_property_docs`.
