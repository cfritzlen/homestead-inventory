# Phase 2 setup — AI extraction + Gmail ingest + Google Calendar sync

Everything in this doc is one-time setup. After this, uploads and labeled emails will flow automatically.

---

## 0. Prerequisites you already did (Phase 1)

- Supabase project + shared gmail user in Authentication
- `family_events`, `family_documents` tables with RLS
- `family-docs` storage bucket with the 4 policies

---

## 1. Run the Phase 2 migration

Supabase → **SQL Editor** → paste the entire contents of `supabase/migrations/002_ai_and_calendar.sql` → Run.

That creates: `ai_extractions`, `oauth_tokens`, `gmail_state`, adds `status`/`source`/etc. columns to `family_events`, enables `pg_net`, and installs the two triggers that fan out to the Edge Functions.

---

## 2. Get an Anthropic API key (~5 min)

1. Go to https://console.anthropic.com
2. Sign in with your shared gmail (or any gmail — this is admin, not the shared calendar account)
3. Left nav → **API Keys** → **Create Key** → name it `homestead-family-hub`
4. **Copy the key** (starts with `sk-ant-…`) — you can't see it again after closing the dialog

Cost estimate: a typical school-note screenshot processed by Haiku 4.5 = ~$0.003. 200 uploads/month ≈ $0.60/month.

---

## 3. Google Cloud OAuth 2.0 client (~10 min)

This one client gives us both **Gmail read** (to ingest labeled emails) and **Google Calendar write** (to push approved events). One consent screen, two scopes.

### 3a. Create the project + enable APIs
1. Go to https://console.cloud.google.com
2. Top bar → project dropdown → **New Project** → name it `homestead-family-hub` → Create
3. Left nav → **APIs & Services → Library**
4. Search **Gmail API** → click **Enable**
5. Search **Google Calendar API** → click **Enable**

### 3b. Configure the consent screen
1. **APIs & Services → OAuth consent screen**
2. User Type: **External** → Create
3. App name: `Homestead Family Hub`, User support email: your shared gmail, Developer contact: same
4. **Save and Continue**
5. Scopes step → skip (we request them at auth time), **Save and Continue**
6. Test users → **Add users** → add the shared gmail address. This is the only account that can consent.
7. **Save and Continue** → **Back to Dashboard**

### 3c. Create the credentials
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: `Homestead Web`
4. **Authorized redirect URIs** → **Add URI** → paste this exactly:
   ```
   https://cfritzlen.github.io/homestead-inventory/oauth-callback.html
   ```
5. Create
6. Copy the **Client ID** and **Client secret** from the dialog

### 3d. Put them where they need to go

- **`assets/config.js`** in this repo — set `window.__GOOGLE_CLIENT_ID__ = 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com';` → commit + push. (Client ID is safe to publish; secret is not.)
- **Supabase Edge Function secrets** — see step 5.

---

## 4. Install the Supabase CLI (~2 min)

If you already have it, skip. Otherwise:

- **macOS**: `brew install supabase/tap/supabase`
- **Windows**: `scoop bucket add supabase https://github.com/supabase/scoop-bucket.git && scoop install supabase`
- Login: `supabase login` → opens browser

Link this repo to your Supabase project:
```bash
cd homestead-inventory
supabase link --project-ref jzpipxvxrtdhmsdkveog
```

---

## 5. Set Edge Function secrets

Replace the `< >` placeholders with actual values:

```bash
supabase secrets set \
  ANTHROPIC_API_KEY='sk-ant-...' \
  GOOGLE_CLIENT_ID='...apps.googleusercontent.com' \
  GOOGLE_CLIENT_SECRET='GOCSPX-...' \
  GOOGLE_ACCOUNT_EMAIL='<shared-gmail@gmail.com>' \
  GOOGLE_CALENDAR_ID='primary'
```

Optional overrides:
- `ANTHROPIC_MODEL` — defaults to `claude-haiku-4-5-20251001`
- `GMAIL_LABEL_NAME` — defaults to `family-hub`
- `GOOGLE_CALENDAR_ID` — defaults to `primary` (the shared gmail's main calendar). To use a specific calendar, get its ID from Google Calendar → Settings → your calendar → Integrate → Calendar ID (looks like a long random string @ group.calendar.google.com)

---

## 6. Deploy the Edge Functions

```bash
supabase functions deploy ai-extract
supabase functions deploy push-to-calendar
supabase functions deploy gmail-ingest
supabase functions deploy google-oauth-exchange --no-verify-jwt
```

(The `--no-verify-jwt` flag is only for the oauth-exchange one — it runs during the login flow before any JWT is available.)

---

## 7. Point the DB triggers at the deployed functions

Back in **SQL Editor**, run this once, replacing `<project-ref>` with `jzpipxvxrtdhmsdkveog`:

```sql
alter database postgres set app.ai_extract_url       = 'https://jzpipxvxrtdhmsdkveog.supabase.co/functions/v1/ai-extract';
alter database postgres set app.push_calendar_url    = 'https://jzpipxvxrtdhmsdkveog.supabase.co/functions/v1/push-to-calendar';
alter database postgres set app.service_role_key     = '<paste your service_role key from Supabase → Settings → API>';
```

The service role key is under **Project Settings → API → Project API keys → `service_role` (secret)**. Treat it like a password — never commit it.

---

## 8. Schedule the gmail-ingest cron

Supabase → **Database → Cron Jobs** (or SQL Editor):

```sql
select cron.schedule(
  'gmail-ingest-every-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://jzpipxvxrtdhmsdkveog.supabase.co/functions/v1/gmail-ingest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    )
  );
  $$
);
```

---

## 8b. (Optional) Daily deep scan — catch everything

Once a day, scan the last 36 hours of inbox mail for every connected account
(same as pressing "Scan inbox", but automatic). The overlapping window means
nothing slips through. Supabase → **SQL Editor**:

```sql
select cron.schedule(
  'gmail-ingest-daily-deep-scan',
  '0 10 * * *',  -- 10:00 UTC = 5:00 AM Central. Adjust to taste.
  $$
  select net.http_post(
    url := 'https://jzpipxvxrtdhmsdkveog.supabase.co/functions/v1/gmail-ingest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('hours_back', 36)
  );
  $$
);
```

To remove it later: `select cron.unschedule('gmail-ingest-daily-deep-scan');`

---

## 9. Create the gmail label

In gmail (web) → Settings gear → **See all settings** → **Labels** → **Create new label** → `family-hub`. That's it.

Anything you label `family-hub` (mobile: long-press email → Label as → family-hub) will be picked up on the next 15-minute poll, uploaded to `family-docs`, and fed through the AI extractor.

---

## 10. Connect Google (one-time consent)

1. Deploy the current code (merge to `main`)
2. Wait for GitHub Pages to publish (~60s)
3. Visit `https://cfritzlen.github.io/homestead-inventory/family-hub.html`
4. Click **Connect Google** in the top-right
5. Sign in as the shared gmail, approve the two scopes (Gmail modify + Calendar events)
6. You should land back at `oauth-callback.html` with "✓ Connected as …" — that means the refresh token is stored in `oauth_tokens`

---

## 11. Try it end-to-end

**Path A — upload:**
- family-hub → drop a photo of a school note
- Wait 10-15 seconds
- Refresh — a yellow "AI-proposed events" panel appears with each event extracted
- Click Approve — event moves to the calendar and shows up in your shared Google Calendar

**Path B — email:**
- In gmail, open an email from the school
- Label it `family-hub`
- Wait up to 15 min
- Same panel appears

**Path C — manual:**
- Fill out the "Add event" form — instantly saved as `approved`, shows on calendar

---

## Troubleshooting

- **"Auth is not defined"** → hard-refresh; `assets/auth.js` may be cached
- **AI panel never populates** → check Supabase → **Edge Functions → ai-extract → Logs**; likely missing `ANTHROPIC_API_KEY` secret
- **"no oauth_tokens row for …"** → you haven't clicked Connect Google yet, or you connected as a different gmail than `GOOGLE_ACCOUNT_EMAIL`
- **Events don't appear on Google Calendar** → check `push-to-calendar` logs; also confirm `GOOGLE_CALENDAR_ID` and that the connected gmail has write access to that calendar
- **Gmail ingest empty** → confirm the `family-hub` label exists in that gmail account and you've applied it to at least one message
