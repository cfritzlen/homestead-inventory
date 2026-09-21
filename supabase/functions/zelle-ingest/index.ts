// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: zelle-ingest
//
// Reads "You received money with Zelle®" emails (Chase format) from the
// connected Gmail account(s), including Trash, and turns each one into a
// rental_zelle_payments row. Rows whose sender is known (rental_zelle_senders,
// or a name on an active lease) are applied to rental_payments straight away;
// the rest wait in Rentals → Payments for you to assign.
//
// Calls:
//   { days_back }                          scan. Service role = every account
//                                          (daily cron); signed-in user = their
//                                          household's accounts (Scan button).
//   { action:'apply', id, payment_default_id, period, remember, force }
//   { action:'ignore', id, remember }
//   { action:'undo', id }
//
// Env / secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (same as gmail-ingest).

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';

const GMAIL_QUERY = 'from:no.reply.alerts@chase.com subject:"You received money with Zelle" in:anywhere';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const supa = getServiceClient();
    let body: any = {};
    try { body = await req.json(); } catch (_) { /* cron sends empty body */ }

    // Who's calling?
    const authToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const isService = !!authToken && authToken === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    let householdId: string | null = null;
    if (!isService) {
      const { data: caller } = await supa.auth.getUser(authToken);
      if (!caller?.user) return json({ error: 'sign in first' }, 401);
      const { data: membership } = await supa.from('household_members')
        .select('household_id,can_access_homestead').eq('user_id', caller.user.id).limit(1).maybeSingle();
      if (!membership || membership.can_access_homestead === false) return json({ error: 'not a homestead member' }, 403);
      householdId = membership.household_id;
    }

    // ---- review actions (signed-in only) ----
    if (body.action) {
      if (isService) return json({ error: 'actions need a signed-in user' }, 401);
      const { data: row, error } = await supa.from('rental_zelle_payments').select('*').eq('id', body.id).maybeSingle();
      if (error || !row) return json({ error: 'payment not found' }, 404);

      if (body.action === 'ignore') {
        if (body.remember) await rememberSender(supa, row.sender_name, null, true);
        await supa.from('rental_zelle_payments').update({ status: 'ignored', note: 'ignored' }).eq('id', row.id);
        return json({ ok: true });
      }
      if (body.action === 'apply') {
        const defaultId = Number(body.payment_default_id);
        const period = String(body.period || row.period || '');
        if (!defaultId || !/^\d{4}-\d{2}$/.test(period)) return json({ error: 'pick a unit and a month' }, 400);
        if (body.remember) await rememberSender(supa, row.sender_name, defaultId, false);
        const r = await applyPayment(supa, row, defaultId, period, !!body.force);
        return json({ ok: true, ...r });
      }
      if (body.action === 'undo') {
        const r = await undoPayment(supa, row);
        return json({ ok: true, ...r });
      }
      return json({ error: 'unknown action' }, 400);
    }

    // ---- scan ----
    const daysBack = Math.min(Math.max(Number(body.days_back) || 7, 1), 365);
    let q = supa.from('oauth_tokens').select('account_email,household_id').eq('provider', 'google');
    if (householdId) q = q.eq('household_id', householdId);
    const { data: accounts, error: acctErr } = await q;
    if (acctErr) return json({ error: `accounts query failed: ${acctErr.message}` }, 500);
    if (!accounts?.length) return json({ ok: true, note: 'no gmail connected in Family Hub' });

    const perAccount: any[] = [];
    for (const { account_email } of accounts) {
      try {
        perAccount.push({ account_email, ...(await scanAccount(supa, account_email, daysBack)) });
      } catch (e) {
        perAccount.push({ account_email, error: e.message });
      }
    }
    return json({ ok: true, accounts: perAccount });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
async function scanAccount(supa: any, accountEmail: string, daysBack: number) {
  const access = await getFreshAccessToken(supa, accountEmail);
  const sinceEpoch = Math.floor((Date.now() - daysBack * 24 * 3600 * 1000) / 1000);
  const q = encodeURIComponent(`${GMAIL_QUERY} after:${sinceEpoch}`);

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await gApi<{ messages?: { id: string }[]; nextPageToken?: string }>(
      access, `/gmail/v1/users/me/messages?q=${q}&maxResults=100&includeSpamTrash=true`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''));
    for (const m of list.messages || []) ids.push(m.id);
    pageToken = list.nextPageToken;
  } while (pageToken && ids.length < 500);

  let found = ids.length, added = 0, applied = 0, pending = 0, ignored = 0, skipped = 0;
  const problems: string[] = [];
  for (const id of ids) {
    const { data: dup } = await supa.from('rental_zelle_payments').select('id').eq('gmail_message_id', id).maybeSingle();
    if (dup) { skipped++; continue; }

    const msg = await gApi<any>(access, `/gmail/v1/users/me/messages/${id}?format=full`);
    const text = messageText(msg);
    const parsed = parseZelle(text);
    if (!parsed) { problems.push(`could not read email ${id}`); continue; }

    const { data: row, error } = await supa.from('rental_zelle_payments').insert({
      gmail_message_id: id,
      account_email: accountEmail,
      sender_name: parsed.sender,
      amount: parsed.amount,
      sent_on: parsed.sentOn,
      transaction_number: parsed.txn,
      memo: parsed.memo,
      period: guessPeriod(parsed.memo, parsed.sentOn),
      status: 'pending',
      note: 'new',
    }).select().single();
    if (error) { problems.push(`save failed for ${parsed.sender}: ${error.message}`); continue; }
    added++;

    const r = await autoMatch(supa, row);
    if (r === 'applied') applied++;
    else if (r === 'ignored') ignored++;
    else pending++;
  }
  return { found, added, applied, pending, ignored, skipped, problems };
}

// Decide what to do with a fresh row. Returns applied | ignored | pending.
async function autoMatch(supa: any, row: any): Promise<string> {
  const key = row.sender_name.toUpperCase().trim();
  const { data: known } = await supa.from('rental_zelle_senders').select('*').eq('sender_name', key).maybeSingle();
  if (known?.ignore) {
    await supa.from('rental_zelle_payments').update({ status: 'ignored', note: 'sender is on the ignore list' }).eq('id', row.id);
    return 'ignored';
  }
  let defaultId: number | null = known?.payment_default_id || null;

  if (!defaultId) {
    // Match the sender to a name on an active lease, then that unit's rent line.
    const norm = (s: string) => (s || '').toUpperCase().replace(/[^A-Z]/g, '');
    const target = norm(row.sender_name);
    const { data: leases } = await supa.from('rental_leases')
      .select('id,property_address,tenant_names,tenant1_name,tenant2_name,tenant3_name,tenant4_name')
      .eq('status', 'active').is('deleted_at', null);
    const hits = (leases || []).filter((l: any) => {
      const names = [l.tenant1_name, l.tenant2_name, l.tenant3_name, l.tenant4_name,
        ...String(l.tenant_names || '').split(',')].map(norm).filter(Boolean);
      return names.includes(target);
    });
    const addresses = [...new Set(hits.map((l: any) => l.property_address))];
    if (addresses.length === 1) {
      const { data: defs } = await supa.from('rental_payment_defaults')
        .select('id').eq('type', 'rent').eq('status', 'active').eq('property_name', addresses[0]);
      if (defs?.length === 1) {
        defaultId = defs[0].id;
        await rememberSender(supa, row.sender_name, defaultId, false);
      } else {
        await supa.from('rental_zelle_payments').update({ note: `on the lease for ${addresses[0]} but no single rent line for it` }).eq('id', row.id);
        return 'pending';
      }
    } else {
      await supa.from('rental_zelle_payments').update({ note: addresses.length ? 'name is on more than one lease' : 'new sender: pick their unit' }).eq('id', row.id);
      return 'pending';
    }
  }

  const r = await applyPayment(supa, row, defaultId, row.period, false);
  return r.status;
}

async function rememberSender(supa: any, senderName: string, defaultId: number | null, ignore: boolean) {
  await supa.from('rental_zelle_senders').upsert({
    sender_name: senderName.toUpperCase().trim(),
    payment_default_id: defaultId,
    ignore,
  }, { onConflict: 'sender_name' });
}

// ---------------------------------------------------------------------------
// Applying to rental_payments (mirrors what the Payments tab does by hand:
// a month is "paid" when date_paid is set; partial payments add up.)
// ---------------------------------------------------------------------------
async function applyPayment(supa: any, row: any, defaultId: number, period: string, force: boolean) {
  const amount = Number(row.amount);
  const { data: def } = await supa.from('rental_payment_defaults').select('*').eq('id', defaultId).maybeSingle();
  if (!def) return { status: 'pending', note: 'rent line not found' };

  const owed = await amountOwed(supa, def, period);
  const { data: existing } = await supa.from('rental_payments')
    .select('*').eq('payment_default_id', defaultId).eq('period', period)
    .order('id', { ascending: true }).limit(1).maybeSingle();

  let paymentId: number;
  if (!existing) {
    const { data: ins, error } = await supa.from('rental_payments').insert({
      payment_default_id: defaultId, period, amount_owed: owed, amount_paid: amount, date_paid: row.sent_on,
    }).select('id').single();
    if (error) return { status: 'pending', note: `could not save: ${error.message}` };
    paymentId = ins.id;
  } else if (!existing.date_paid) {
    // Row exists but the month is still unpaid: this payment is the first one.
    const { error } = await supa.from('rental_payments')
      .update({ amount_paid: amount, date_paid: row.sent_on }).eq('id', existing.id);
    if (error) return { status: 'pending', note: `could not save: ${error.message}` };
    paymentId = existing.id;
  } else {
    const alreadyPaid = Number(existing.amount_paid || 0);
    const owedNow = Number(existing.amount_owed || owed);
    if (!force && alreadyPaid >= owedNow - 0.01) {
      const note = `${def.label} ${period} is already marked paid ($${alreadyPaid.toFixed(2)})`;
      await supa.from('rental_zelle_payments').update({ payment_default_id: defaultId, period, note }).eq('id', row.id);
      return { status: 'pending', note };
    }
    const { error } = await supa.from('rental_payments')
      .update({ amount_paid: alreadyPaid + amount }).eq('id', existing.id);
    if (error) return { status: 'pending', note: `could not save: ${error.message}` };
    paymentId = existing.id;
  }

  const note = `applied to ${def.label} for ${period}`;
  await supa.from('rental_zelle_payments').update({
    status: 'applied', payment_default_id: defaultId, period, note,
    applied_payment_id: paymentId, applied_at: new Date().toISOString(),
  }).eq('id', row.id);
  return { status: 'applied', note };
}

async function undoPayment(supa: any, row: any) {
  if (row.status !== 'applied' || !row.applied_payment_id) {
    await supa.from('rental_zelle_payments').update({ status: 'pending', note: 'back for review' }).eq('id', row.id);
    return { status: 'pending' };
  }
  const { data: p } = await supa.from('rental_payments').select('*').eq('id', row.applied_payment_id).maybeSingle();
  if (p) {
    const left = Number(p.amount_paid || 0) - Number(row.amount);
    if (left > 0.005) {
      await supa.from('rental_payments').update({ amount_paid: left }).eq('id', p.id);
    } else {
      // Nothing left: back to the unpaid state the Payments tab expects
      await supa.from('rental_payments').update({ amount_paid: p.amount_owed, date_paid: null }).eq('id', p.id);
    }
  }
  await supa.from('rental_zelle_payments').update({
    status: 'pending', note: 'undone, back for review', applied_payment_id: null, applied_at: null,
  }).eq('id', row.id);
  return { status: 'pending' };
}

async function amountOwed(supa: any, def: any, period: string): Promise<number> {
  const { data: rate } = await supa.from('rental_rate_schedules')
    .select('amount').eq('payment_default_id', def.id).lte('effective_date', `${period}-01`)
    .order('effective_date', { ascending: false }).limit(1).maybeSingle();
  return Number(rate?.amount ?? def.default_amount ?? 0);
}

// ---------------------------------------------------------------------------
// Parsing the Chase email
// ---------------------------------------------------------------------------
export function parseZelle(text: string) {
  const t = text.replace(/\s+/g, ' ').trim();
  const sender = t.match(/payment\s+(.+?)\s+sent you money/i)?.[1]?.trim();
  const amountStr = t.match(/Amount\s+\$?\s*([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  const sentStr = t.match(/Sent on\s+([A-Za-z]{3,9}\.?\s+\d{1,2},\s*\d{4})/i)?.[1];
  const txn = t.match(/Transaction number\s+(\d+)/i)?.[1] || null;
  if (!sender || !amountStr) return null;

  let memo: string | null = null;
  const m = t.match(new RegExp(`Memo\\s+(.*?)\\s*${escapeRe(sender)}\\s+is registered`, 'i'))
    || t.match(/Memo\s+(.*?)(?=\s+\S+(?:\s+\S+)*\s+is registered|\s+If you don|\s+Go to Zelle|$)/i);
  if (m) memo = m[1].trim() || null;
  if (memo && /^Transaction number/i.test(memo)) memo = null;

  const amount = Number(amountStr.replace(/,/g, ''));
  const sentOn = sentStr ? toIsoDate(sentStr) : null;
  return { sender, amount, sentOn, txn, memo };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function toIsoDate(s: string): string | null {
  const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

// Which month is this money for? A month named in the memo wins ("September
// rent" sent Aug 31 → September). Otherwise the sent date, except that money
// sent in the last week of a month counts for the next one.
export function guessPeriod(memo: string | null, sentOn: string | null): string | null {
  if (!sentOn) return null;
  const [sy, sm, sd] = sentOn.split('-').map(Number);
  const mm = (memo || '').toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (mm) {
    const month = MONTHS.indexOf(mm[1]) + 1;
    const yearMatch = (memo || '').match(/\b(20\d{2})\b/);
    let year = yearMatch ? Number(yearMatch[1]) : sy;
    if (!yearMatch && month < sm - 6) year = sy + 1;      // "January" sent in December
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  let y = sy, m = sm;
  if (sd >= 25) { m++; if (m > 12) { m = 1; y++; } }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function messageText(msg: any): string {
  const plain = findPart(msg.payload, 'text/plain');
  if (plain) return plain;
  const html = findPart(msg.payload, 'text/html');
  if (html) return decodeEntities(html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '));
  return decodeEntities(msg.snippet || '');
}
function findPart(part: any, mime: string): string {
  if (part?.mimeType === mime && part.body?.data) return base64UrlDecode(part.body.data);
  for (const p of part?.parts || []) { const f = findPart(p, mime); if (f) return f; }
  return '';
}
function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}
function base64UrlDecode(s: string): string {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function gApi<T>(access: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', ...(init.headers as any || {}) },
  });
  if (!res.ok) throw new Error(`gmail ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function cors() { return new Response(null, { status: 204, headers: CORS_HEADERS }); }
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
