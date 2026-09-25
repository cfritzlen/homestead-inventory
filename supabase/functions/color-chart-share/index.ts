// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: color-chart-share
//
// Read-only view of a kid's Color Chart for the daycare teacher. The teacher
// has no account: the private link's token is the key, so deploy with
//   supabase functions deploy color-chart-share --no-verify-jwt
//
//   { token, day }                                → today's chart
//   { token, day, action:'add', kind, label, note, weight } → the teacher logs
//                                                   an up or down from daycare
//   { token, day, action:'nap', nap_day, napped }  → mark a school nap (or no nap);
//                                                   napped: true | false | null (clear)
//   → { name, level, ups, downs, share_reasons, events?, actions, naps }
//
// `naps` covers the Mon-Fri week that contains `day`.
//
// `day` is the phone's local calendar day (YYYY-MM-DD). Events are only sent
// when the parent left "teacher sees reasons" on. Teacher entries are marked
// source = 'teacher'. The ladder has MAX spots; every day starts at MAX.

import { getServiceClient } from '../_shared/google.ts';

const MAX = 10;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    let body: any = {};
    try { body = await req.json(); } catch (_) { /* empty */ }
    const token = String(body.token || '');
    const day = String(body.day || '');
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: 'bad link' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: 'bad day' }, 400);

    const supa = getServiceClient();
    const { data: kid } = await supa.from('color_chart_kids').select('id,name,share_reasons').eq('share_token', token).maybeSingle();
    if (!kid) return json({ error: 'This link is no longer valid.' }, 404);

    if (String(body.action || '') === 'add') {
      const kind = String(body.kind || '');
      const label = String(body.label || '').trim().slice(0, 60);
      const note = String(body.note || '').trim().slice(0, 300);
      const weight = Math.max(1, Math.min(9, parseInt(body.weight, 10) || 1));
      if (kind !== 'up' && kind !== 'down') return json({ error: 'bad kind' }, 400);
      if (!label) return json({ error: 'label required' }, 400);
      const { error } = await supa.from('color_chart_events').insert({ kid_id: kid.id, day, kind, status: 'approved', label, note: note || null, weight, source: 'teacher' });
      if (error) return json({ error: error.message }, 500);
    }

    if (String(body.action || '') === 'nap') {
      const napDay = String(body.nap_day || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(napDay)) return json({ error: 'bad day' }, 400);
      if (body.napped === null || body.napped === undefined) {
        await supa.from('color_chart_naps').delete().eq('kid_id', kid.id).eq('day', napDay);
      } else {
        const { error } = await supa.from('color_chart_naps').upsert({ kid_id: kid.id, day: napDay, napped: !!body.napped, source: 'teacher' }, { onConflict: 'kid_id,day' });
        if (error) return json({ error: error.message }, 500);
      }
    }

    // Mon-Fri of the week containing `day`
    const d = new Date(day + 'T12:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;            // Mon = 0
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow);
    const fri = new Date(mon); fri.setUTCDate(mon.getUTCDate() + 4);
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    const { data: naps } = await supa.from('color_chart_naps').select('day,napped').eq('kid_id', kid.id).gte('day', iso(mon)).lte('day', iso(fri));

    const { data: acts } = await supa.from('color_chart_actions').select('kind,label,emoji').eq('kid_id', kid.id).eq('active', true).order('sort').order('id');
    const { data: events } = await supa.from('color_chart_events')
      .select('at,kind,label,note,weight,source').eq('kid_id', kid.id).eq('day', day).eq('status', 'approved')
      .order('at', { ascending: false });
    const rows = events || [];
    const ups = rows.filter((e: any) => e.kind === 'up').length;
    const downs = rows.filter((e: any) => e.kind === 'down').length;
    // Same walk as the page: clamp at every step so an extra "up" at super
    // green does not bank against a later "down".
    let level = MAX;
    rows.slice().sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime())
      .forEach((e: any) => { level = Math.max(1, Math.min(MAX, level + (e.kind === 'up' ? 1 : -1) * (e.weight || 1))); });

    return json({
      ok: true, name: kid.name, level, ups, downs, share_reasons: kid.share_reasons,
      events: kid.share_reasons ? rows : undefined,
      actions: acts || [],
      naps: naps || [],
    });
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, 500);
  }
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function cors() { return new Response(null, { status: 204, headers: CORS_HEADERS }); }
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
