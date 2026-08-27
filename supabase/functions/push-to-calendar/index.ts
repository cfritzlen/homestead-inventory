// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: push-to-calendar
//
// Trigger: DB trigger when family_events.status flips to 'approved' and google_event_id is null.
// Payload:  { event_id: uuid }
//
// Uses the stored Google OAuth refresh token to POST the event to the primary
// calendar of the shared gmail account (or a specific calendar id if the
// GOOGLE_CALENDAR_ID env var is set).
//
// Env / secrets:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET      — the OAuth app
//   GOOGLE_CALENDAR_ID                          — optional, defaults to 'primary'
//   GOOGLE_ACCOUNT_EMAIL                        — the shared gmail address (matches oauth_tokens row)

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';

const CALENDAR_ID = Deno.env.get('GOOGLE_CALENDAR_ID') || 'primary';
const ACCOUNT_EMAIL = Deno.env.get('GOOGLE_ACCOUNT_EMAIL')!;

Deno.serve(async (req) => {
  try {
    const { event_id } = await req.json();
    if (!event_id) return json({ error: 'missing event_id' }, 400);

    const supa = getServiceClient();
    const { data: ev, error: evErr } = await supa
      .from('family_events').select('*').eq('id', event_id).single();
    if (evErr || !ev) return json({ error: `event not found: ${evErr?.message}` }, 404);
    if (ev.google_event_id) return json({ skipped: true, reason: 'already synced' });

    const access = await getFreshAccessToken(supa, ACCOUNT_EMAIL);

    const description = [
      ev.notes,
      ev.ai_notes ? `\n(AI summary: ${ev.ai_notes})` : null,
      `\n[Family Hub · ${ev.category}${ev.source ? ' · from ' + ev.source : ''}]`,
    ].filter(Boolean).join('\n');

    const body: any = {
      summary: `[${ev.category}] ${ev.title}`,
      description,
      location: ev.location || undefined,
    };
    if (ev.all_day) {
      body.start = { date: ev.starts_at.slice(0, 10) };
      body.end = { date: (ev.ends_at || ev.starts_at).slice(0, 10) };
    } else {
      body.start = { dateTime: ev.starts_at };
      body.end = { dateTime: ev.ends_at || addHour(ev.starts_at) };
    }

    const gRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!gRes.ok) {
      const errText = await gRes.text();
      return json({ error: `google ${gRes.status}: ${errText}` }, 500);
    }
    const gEvent = await gRes.json();
    await supa.from('family_events').update({
      google_event_id: gEvent.id,
      updated_at: new Date().toISOString(),
    }).eq('id', event_id);

    return json({ ok: true, google_event_id: gEvent.id, html_link: gEvent.htmlLink });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

function addHour(iso: string): string {
  return new Date(new Date(iso).getTime() + 60 * 60 * 1000).toISOString();
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
