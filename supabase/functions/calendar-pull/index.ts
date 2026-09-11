// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: calendar-pull
//
// Called by the Family Hub on page load (with the signed-in user's JWT).
// Reads upcoming events from the shared Google calendar (GOOGLE_CALENDAR_ID)
// and imports anything new into family_events as already-approved entries —
// so events family members add straight to Google Calendar show up in the hub.
//
// Env / secrets:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   GOOGLE_CALENDAR_ID   — the shared calendar to pull from ('primary' if unset)

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';

const CALENDAR_ID = Deno.env.get('GOOGLE_CALENDAR_ID') || 'primary';
const CATEGORY_PREFIX = /^\[(school|daycare|medical|travel|vacation|sports|general)\]\s*/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const supa = getServiceClient();

    // Resolve the caller's household from their JWT
    const authToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!authToken) return json({ error: 'not signed in' }, 401);
    const { data: caller } = await supa.auth.getUser(authToken);
    if (!caller?.user) return json({ error: 'not signed in' }, 401);
    const { data: membership } = await supa
      .from('household_members').select('household_id')
      .eq('user_id', caller.user.id).limit(1).maybeSingle();
    if (!membership) return json({ error: 'no household' }, 403);
    const householdId = membership.household_id;

    // Which connected account reads the calendar — same choice push-to-calendar makes
    let accountEmail: string | null = null;
    const { data: target } = await supa
      .from('oauth_tokens').select('account_email')
      .eq('provider', 'google').eq('household_id', householdId)
      .eq('is_calendar_target', true).limit(1).maybeSingle();
    if (target) accountEmail = target.account_email;
    else {
      const { data: anyAcct } = await supa
        .from('oauth_tokens').select('account_email')
        .eq('provider', 'google').eq('household_id', householdId)
        .limit(1).maybeSingle();
      if (anyAcct) accountEmail = anyAcct.account_email;
    }
    if (!accountEmail) return json({ ok: true, note: 'no Google account connected' });

    const access = await getFreshAccessToken(supa, accountEmail);

    // Family member names, for auto-tagging imported events
    const { data: hh } = await supa
      .from('households').select('settings').eq('id', householdId).maybeSingle();
    const familyPeople: string[] = Array.isArray(hh?.settings?.people) ? hh.settings.people : [];

    // Upcoming window: yesterday → 60 days out, recurring series expanded
    const timeMin = new Date(Date.now() - 86400000).toISOString();
    const timeMax = new Date(Date.now() + 60 * 86400000).toISOString();
    const params = new URLSearchParams({
      timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    const gRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`,
      { headers: { Authorization: `Bearer ${access}` } },
    );
    if (!gRes.ok) return json({ error: `google ${gRes.status}: ${await gRes.text()}` }, 500);
    const feed = await gRes.json();
    const items: any[] = feed.items || [];

    let imported = 0, updated = 0, skipped = 0;
    for (const g of items) {
      if (g.status === 'cancelled' || !g.id) { skipped++; continue; }
      // Events the app itself pushed carry a Family Hub marker in the
      // description — never re-import those (covers ones deleted in the hub).
      if ((g.description || '').includes('[Family Hub ·')) { skipped++; continue; }

      const allDay = !!g.start?.date;
      const startsAt = g.start?.dateTime || (g.start?.date ? g.start.date + 'T00:00:00' : null);
      const endsAt = allDay ? null : (g.end?.dateTime || null);
      if (!startsAt) { skipped++; continue; }
      const title = (g.summary || '(no title)').replace(CATEGORY_PREFIX, '').trim() || '(no title)';

      // Already imported (any status — a hidden one stays hidden)?
      const { data: existing } = await supa.from('family_events')
        .select('id,source,status,title,starts_at,ends_at,location')
        .eq('household_id', householdId)
        .eq('google_event_id', g.id)
        .limit(1).maybeSingle();
      if (existing) {
        // Keep imported rows in step with Google edits (time moved, renamed)
        if (existing.source === 'google' && existing.status === 'approved') {
          const fresh = {
            title,
            starts_at: new Date(startsAt).toISOString(),
            ends_at: endsAt ? new Date(endsAt).toISOString() : null,
            all_day: allDay,
            location: g.location || null,
          };
          const stale = fresh.title !== existing.title
            || fresh.starts_at !== new Date(existing.starts_at).toISOString()
            || (fresh.ends_at || '') !== (existing.ends_at ? new Date(existing.ends_at).toISOString() : '')
            || (fresh.location || '') !== (existing.location || '');
          if (stale) {
            await supa.from('family_events').update(fresh).eq('id', existing.id);
            updated++;
          } else skipped++;
        } else skipped++;
        continue;
      }

      const row: any = {
        household_id: householdId,
        category: 'general',
        title,
        starts_at: new Date(startsAt).toISOString(),
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        all_day: allDay,
        location: g.location || null,
        notes: (g.description || '').trim().slice(0, 300) || null,
        status: 'approved',
        source: 'google',
        google_event_id: g.id,
        sync_to_google: false,
        created_by: caller.user.id,
      };
      const tagged = familyPeople.filter((p) =>
        new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(title));
      if (tagged.length) row.people = tagged;

      let { error: insErr } = await supa.from('family_events').insert(row);
      if (insErr && row.people) {
        delete row.people;
        ({ error: insErr } = await supa.from('family_events').insert(row));
      }
      if (insErr && 'sync_to_google' in row) {
        // sync_to_google column not migrated yet
        delete row.sync_to_google;
        ({ error: insErr } = await supa.from('family_events').insert(row));
      }
      if (!insErr) imported++; else skipped++;
    }

    return json({ ok: true, imported, updated, skipped, calendar: CALENDAR_ID });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function cors() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
