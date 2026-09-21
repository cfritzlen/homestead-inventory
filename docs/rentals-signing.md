# Rentals: electronic lease signing (no DocuSign)

Tenants get an email link, read the whole lease on their phone, draw a
signature and initials, and tick "I agree to sign electronically". You sign
last the same way. When everyone has signed, the app stamps every page,
adds a signing record page (who, when, from where), keeps the signed PDF on
the lease and emails it to everyone. Emails go out from your connected Gmail.

## One-time setup
1. Supabase (Homestead project) → SQL Editor → paste all of
   `supabase/migrations/016_lease_signing.sql` → Run.
2. In a terminal in the repo folder (after `git pull`):
   ```
   supabase functions deploy lease-sign --no-verify-jwt
   ```
   The flag matters: tenants have no login, their private link is the key.
3. Make sure every tenant on the lease has an email address.

## Using it
- All Leases → **View** → **Send for signature**. The app builds a fresh PDF,
  stores it, and emails each tenant and you a link.
- The lease shows "✍️ Out for signature" until done, then "✓ Signed".
- In the lease view you can see who opened and who signed, send a
  **Remind**, or **Cancel signing** (links stop working; send again after
  changing the lease).
- Try it first with a test lease that has your own email as the tenant.

## Good to know
- A link only works for that one person and that one lease. It stops
  working after they sign, or if you cancel.
- The signed PDF has one extra page, "Signing record": name, email, time
  signed, time the link was opened, IP address and device for each signer.
- Nothing is sent to any third party. Files live in the private
  `rental-leases` bucket.
- Signatures are stored with the lease (`rental_lease_signers`).
