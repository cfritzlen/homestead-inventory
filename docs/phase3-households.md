# Phase 3 — Households: share Family Hub with anyone

Same database, invisible walls. Every event, document, and connected Google
account belongs to a **household**. Members of a household see only their own
household's stuff. Your existing data was adopted by an owner household named
"Our Family" (rename it any time — it's the H1 on the Family Hub page).

## One-time setup after merging

1. **Run migration 004** — SQL Editor → paste `supabase/migrations/004_households.sql` → Run.
2. **Redeploy the edge functions** (PowerShell, in the repo folder):
   ```powershell
   git pull
   supabase functions deploy ai-extract
   supabase functions deploy gmail-ingest
   supabase functions deploy push-to-calendar
   supabase functions deploy google-oauth-exchange --no-verify-jwt
   supabase functions deploy invite-user
   ```
   (No new secrets needed.)

## Inviting people

From Family Hub → **Connected accounts** → **+ Invite someone**:

- **Join my family** — they share your calendar, docs, events. Spouse/co-parent.
- **Their own family** — completely separate space. Sister, friends, anyone.

What the invitee does: go to the login page, request a magic link with the
invited email, click it. If they were invited to their own family, they get a
"name your family" screen; then they're in an empty Family Hub of their own.

To use the AI + Google Calendar features, each household connects its own
gmail from the Family Hub (**+ Add another gmail**) and creates the
`family-hub` label in that gmail. First account connected becomes that
household's calendar target.

⚠️ Each invited Google account must also be added as a **test user** on the
Google Cloud OAuth consent screen (APIs & Services → OAuth consent screen →
Test users) until the app is verified. 100-user cap — fine for family use.

## What guests can and can't see

- Invitees (any household) can open **only** Family Hub; the homestead pages
  (finances, inventory, solar, …) redirect them back to Family Hub.
- Members of the original "Our Family" household keep full access
  (`can_access_homestead = true` on their membership row).
- Database-level: RLS scopes `family_events`, `family_documents`,
  `oauth_tokens`, storage objects, and the accounts view by household.
  The homestead redirect for legacy pages is client-side; the legacy tables'
  own RLS is still the commented-out template in migration 001 — run it if you
  want those tables hard-locked too.

## How the walls work (for the curious)

- `households` / `household_members` / `household_invites` tables
- `my_household_ids()` — security-definer helper used by every policy
- Family tables carry `household_id` (auto-filled on insert via trigger)
- Storage paths now start with the household id; policies match on the prefix
- Legacy year-prefixed files stay readable only by the owner household
