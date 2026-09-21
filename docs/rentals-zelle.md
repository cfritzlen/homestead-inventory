# Rentals: rent payments from Zelle emails

Reads the Chase "You received money with Zelle®" emails in the connected
Gmail account (Trash included) and records them on the Rentals → Payments tab.

## One-time setup (about 5 minutes)

1. **Tables + daily schedule.** Supabase (Homestead project) → SQL Editor →
   paste all of `supabase/migrations/014_rental_zelle.sql` → Run.
2. **Deploy the scanner.** In a terminal, from this repo folder (you already
   ran `supabase link` for the family hub):
   ```
   supabase functions deploy zelle-ingest
   ```
   It reuses the Google secrets the family-hub scanner already has.
3. **First scan.** Rentals → Payments → pick "Last 4 months" → **Scan Zelle emails**.

## How it works

- Every email becomes a line. Senders it can match are **applied** to that
  month's rent right away. The rest wait under "Zelle payments from email"
  for you to pick their unit. Tick "remember sender" and it's automatic from
  then on.
- Matching: a sender on the ignore list is skipped; a remembered sender goes
  to their rent line; otherwise the name is looked up on active leases.
- Month: a month named in the memo wins ("September rent" sent Aug 31 →
  September). No memo → the sent date, except payments sent on the 25th or
  later count for the next month. You can change the month before applying.
- A month already marked paid is **never** touched automatically. It shows in
  yellow with an "Apply anyway" button.
- **Undo** on a recently applied line puts the money back and returns the
  line to the review list.
- Your own transfers ("Colette Fritzlen") are ignored from the start. Zelle
  *requests* are never read, only received payments.
- Runs by itself every morning at 7 AM Eastern for the last 7 days. Gmail
  empties Trash after 30 days, so anything older than that is gone.

## Tables

`rental_zelle_payments` (one row per email) and `rental_zelle_senders`
(who each sender is). Edit the senders table directly if you need to change a
mapping.
