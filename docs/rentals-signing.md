# Rentals: electronic lease signing (no DocuSign)

**You sign first.** "Sign & send to tenants" opens a pop-up where you draw
or type your signature (saved for next time). It goes on the signature page
before the lease is emailed. **Tenants** set up their signature and initials
the same way, then tap every yellow "Initial" spot and the "Sign here" spot on
the lease itself; a counter shows progress and Finish only unlocks when every
spot is done. When the last tenant finishes, the app stamps everything, adds a
signing record page (who, when, from where, spots tapped), keeps the signed
PDF on the lease and emails it to everyone. You also get a short email each
time a tenant signs. Emails go out from your connected Gmail.

## One-time setup
1. Supabase (Homestead project) → SQL Editor → run
   `supabase/migrations/016_lease_signing.sql`, then
   `017_lease_signing_v2.sql` and `019_lease_signer_id.sql`.
2. In a terminal in the repo folder (after `git pull`):
   ```
   supabase functions deploy lease-sign --no-verify-jwt
   ```
   The flag matters: tenants have no login, their private link is the key.
3. Make sure every tenant on the lease has an email address.

## Using it
- All Leases → **View** → **Sign & send to tenants**. Sign in the pop-up; the
  app builds a fresh PDF with your signature and emails each tenant a link.
- The lease shows "✍️ Out for signature" until done, then "✓ Signed".
- In the lease view you can see who opened and who signed, send a
  **Remind**, or **Cancel signing** (links stop working; send again after
  changing the lease).
- Try it first with a test lease that has your own email as the tenant.

## Tenant ID
Before a tenant can finish, they must add a photo of their government-issued
ID (the phone camera opens for it). It is stored in the private
`rental-leases` bucket, listed on the lease as "🪪 Tenant ID", and only
visible when signed in to the app. The signing record notes "ID photo: on
file".

## Several tenants
Each tenant gets their own link and signs their own line and initials
column, in any order. Their signature is stamped the moment they finish, so
the next tenant sees it. Every tenant gets a "Download a copy for your
records" button right after signing and again once the lease is fully
signed, plus the final PDF by email.

## Good to know
- A link only works for that one person and that one lease. It stops
  working after they sign, or if you cancel.
- The signed PDF has one extra page, "Signing record": name, email, time
  signed, time the link was opened, IP address and device for each signer.
- Nothing is sent to any third party. Files live in the private
  `rental-leases` bucket.
- Signatures are stored with the lease (`rental_lease_signers`).
