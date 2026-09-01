// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: gmail-ingest
//
// Trigger: cron (Supabase → Database → Cron Jobs → schedule every 15 min).
// For EVERY Google account connected in oauth_tokens: reads messages carrying
// the "family-hub" label, uploads attachments + the message body as documents
// into the family-docs bucket, then removes the label so the message isn't
// re-processed. The DB trigger on family_documents fires ai-extract per file.
//
// Env / secrets:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   GMAIL_LABEL_NAME           — optional, default "family-hub"

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';

const LABEL_NAME = Deno.env.get('GMAIL_LABEL_NAME') || 'family-hub';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const supa = getServiceClient();

    // Three calling modes:
    //   Cron, empty body (service role): every connected account, label pass +
    //   incremental auto-scan for opted-in households.
    //   Cron, hours_back in body (service role): every connected account,
    //   forced deep scan of that window ("daily catch-up").
    //   Signed-in user ("Scan now" button): scope to their household, explicit
    //   days_back window, bigger message budget.
    let body: any = {};
    try { body = await req.json(); } catch (_) { /* cron sends empty body */ }

    // Window in hours: days_back (Scan-now button) or hours_back (daily cron)
    const hoursBack = Math.min(Math.max(
      Number(body.hours_back) || (Number(body.days_back) || 0) * 24, 0), 30 * 24);

    let manual: { householdId: string; hoursBack: number; userId: string } | null = null;
    let forcedHours = 0;
    const authToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (hoursBack && authToken) {
      if (authToken === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
        forcedHours = hoursBack;  // scheduled deep scan, all accounts
      } else {
        const { data: caller } = await supa.auth.getUser(authToken);
        if (caller?.user) {
          const { data: membership } = await supa
            .from('household_members').select('household_id')
            .eq('user_id', caller.user.id).limit(1).maybeSingle();
          if (!membership) return json({ error: 'no household' }, 403);
          manual = { householdId: membership.household_id, hoursBack, userId: caller.user.id };
        }
      }
    }

    let q = supa.from('oauth_tokens').select('account_email,household_id').eq('provider', 'google');
    if (manual) q = q.eq('household_id', manual.householdId);
    const { data: accounts, error: acctErr } = await q;
    if (acctErr) return json({ error: `accounts query failed: ${acctErr.message}` }, 500);
    if (!accounts?.length) {
      return json({ ok: true, note: manual ? 'no gmail connected for your household' : 'no connected accounts' });
    }

    const perAccount: any[] = [];
    for (const { account_email, household_id } of accounts) {
      try {
        const r = await pollAccount(supa, account_email, household_id, manual?.hoursBack || forcedHours, manual?.userId);
        perAccount.push({ account_email, ...r });
      } catch (e) {
        perAccount.push({ account_email, error: e.message });
        await supa.from('gmail_state').upsert({
          account_email,
          last_error: e.message,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'account_email' });
      }
    }
    return json({ ok: true, manual: !!manual, accounts: perAccount });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

async function pollAccount(supa: any, accountEmail: string, householdId: string, forceScanHours?: number, manualUserId?: string) {
  const access = await getFreshAccessToken(supa, accountEmail);

  // family_documents.created_by is NOT NULL and defaults to auth.uid(), which
  // is null under the service role — inserts fail without an explicit value.
  // Manual scans attribute to the caller; cron runs to any household member.
  let createdBy = manualUserId || null;
  if (!createdBy) {
    const { data: member } = await supa.from('household_members')
      .select('user_id').eq('household_id', householdId).limit(1).maybeSingle();
    createdBy = member?.user_id || null;
  }
  if (!createdBy) throw new Error('no household member found to attribute documents to');

  const { data: state } = await supa.from('gmail_state')
    .select('*').eq('account_email', accountEmail).maybeSingle();

  // ---- Pass 1: explicit label (always on) ----
  let labelId = state?.label_id;
  let labelResult: any = null;
  if (!labelId) {
    const labels = await gApi<{ labels: any[] }>(access, '/gmail/v1/users/me/labels');
    const lbl = labels.labels.find((l) => l.name === LABEL_NAME);
    if (lbl) {
      labelId = lbl.id;
      await supa.from('gmail_state').upsert({
        account_email: accountEmail, label_id: labelId,
      }, { onConflict: 'account_email' });
    }
  }
  if (labelId) {
    const list = await gApi<{ messages?: {id: string}[] }>(
      access, `/gmail/v1/users/me/messages?labelIds=${labelId}&maxResults=25`,
    );
    const results: any[] = [];
    for (const { id } of list.messages || []) {
      try {
        const msg = await gApi<any>(access, `/gmail/v1/users/me/messages/${id}?format=full`);
        const uploaded = await ingestMessage(supa, access, msg, householdId, createdBy);
        await gApi(access, `/gmail/v1/users/me/messages/${id}/modify`, {
          method: 'POST',
          body: JSON.stringify({ removeLabelIds: [labelId] }),
        });
        results.push({ id, uploaded });
      } catch (e) {
        results.push({ id, error: e.message });
      }
    }
    labelResult = { processed: results.length, results };
  } else {
    labelResult = { skipped: true, reason: `label "${LABEL_NAME}" not found in this account` };
  }

  // ---- Pass 2: inbox scan ----
  // Forced ("Scan now" button or daily deep-scan cron): always runs,
  // explicit window, bigger budget.
  // 15-min cron: only when the household opted into auto-scan; incremental window.
  let scanResult: any = { skipped: true, reason: 'auto-scan off' };
  if (forceScanHours) {
    const since = new Date(Date.now() - forceScanHours * 3600 * 1000).toISOString();
    scanResult = await autoScan(supa, access, accountEmail, householdId, createdBy, since, 100);
  } else {
    const { data: hh } = await supa
      .from('households').select('settings').eq('id', householdId).maybeSingle();
    if (hh?.settings?.auto_scan_email === true) {
      scanResult = await autoScan(supa, access, accountEmail, householdId, createdBy, state?.last_scan_at, 20);
    }
  }

  await supa.from('gmail_state').upsert({
    account_email: accountEmail,
    label_id: labelId || null,
    last_polled_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_email' });

  return { label: labelResult, scan: scanResult };
}

// Scan new inbox mail (excluding promotions/social/spam) and ingest only the
// messages Claude's cheap triage says contain family-calendar events.
async function autoScan(
  supa: any, access: string, accountEmail: string, householdId: string,
  createdBy: string, lastScanAt: string | null, maxMessages = 20,
) {
  const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) return { skipped: true, reason: 'no ANTHROPIC_API_KEY' };

  const sinceEpoch = Math.floor(
    (lastScanAt ? new Date(lastScanAt).getTime() : Date.now() - 24 * 3600 * 1000) / 1000,
  );
  const scanStartedAt = new Date().toISOString();
  const q = encodeURIComponent(
    `in:inbox -category:promotions -category:social -in:spam after:${sinceEpoch}`,
  );
  const list = await gApi<{ messages?: {id: string}[] }>(
    access, `/gmail/v1/users/me/messages?q=${q}&maxResults=${maxMessages}`,
  );
  const results: any[] = [];
  for (const { id } of list.messages || []) {
    try {
      // Skip anything already ingested (label pass or a previous scan)
      const { data: dup } = await supa.from('family_documents')
        .select('id').like('storage_path', `%gmail-${id}-%`).limit(1);
      if (dup?.length) { results.push({ id, skipped: 'already ingested' }); continue; }

      const msg = await gApi<any>(access, `/gmail/v1/users/me/messages/${id}?format=full`);
      const headers: any[] = msg.payload?.headers || [];
      const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value || '';
      const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value || '';
      const body = extractBodyText(msg.payload).slice(0, 8000);
      const attNames = collectAttachments(msg.payload).map((a) => a.filename);
      if (!body && !subject && !attNames.length) { results.push({ id, skipped: 'empty' }); continue; }

      const worth = await triage(ANTHROPIC_API_KEY, subject, from, body, attNames);
      console.log(`[scan] ${accountEmail}: ${worth ? 'INGEST' : 'skip'} "${subject.slice(0, 80)}" (${from.slice(0, 60)})${attNames.length ? ` [attachments: ${attNames.join(', ').slice(0, 120)}]` : ''}`);
      if (!worth) {
        results.push({ id, triage: 'no events' });
        await logScan(supa, householdId, accountEmail, id, subject, from, attNames, 'skipped', 'no events or to-dos found');
        continue;
      }

      const uploaded = await ingestMessage(supa, access, msg, householdId, createdBy);
      results.push({ id, triage: 'has events', uploaded });
      await logScan(supa, householdId, accountEmail, id, subject, from, attNames, 'ingested', `saved ${uploaded} file(s) — proposals coming`);
    } catch (e) {
      results.push({ id, error: e.message });
      await logScan(supa, householdId, accountEmail, id, null, null, [], 'error', e.message);
    }
  }

  // Keep the activity feed table small
  await supa.from('scan_activity').delete()
    .lt('created_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());

  await supa.from('gmail_state')
    .update({ last_scan_at: scanStartedAt })
    .eq('account_email', accountEmail);

  const kept = results.filter((r) => r.triage === 'has events').length;
  console.log(`[scan] ${accountEmail}: checked ${results.length} email(s), ingested ${kept}`);
  return { scanned: results.length, results };
}

async function triage(apiKey: string, subject: string, from: string, body: string, attNames: string[] = []): Promise<boolean> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content:
`Does this email contain concrete, dated family-calendar events (appointments, school/daycare closures or activities, sports schedules, flights/reservations, deadlines) OR action items the family must handle (a form to fill out or sign, a payment to make or send such as rent or school fees, an RSVP, something to bring, return, submit, or renew)? Routine newsletters, receipts for completed purchases, promotions, and undated chatter do NOT count.

IMPORTANT: attachments count too. If the email carries an attachment that likely holds a schedule or events — a school/daycare calendar, activity schedule, itinerary, or similar (judge by the attachment name and the email context) — answer YES even if the email text itself has no dates.

From: ${from}
Subject: ${subject}
Attachments: ${attNames.length ? attNames.join(', ') : '(none)'}

${body}

Answer with exactly one word: YES or NO.`,
      }],
    }),
  });
  if (!res.ok) return false;  // triage failure → don't ingest, don't error the run
  const data = await res.json();
  return /YES/i.test(data.content?.[0]?.text || '');
}

// Record one scan decision for the in-app activity feed. Never breaks the scan.
async function logScan(
  supa: any, householdId: string, accountEmail: string, gmailMsgId: string,
  subject: string | null, sender: string | null, attNames: string[], decision: string, detail: string,
) {
  try {
    await supa.from('scan_activity').insert({
      household_id: householdId,
      account_email: accountEmail,
      gmail_msg_id: gmailMsgId,
      subject, sender,
      attachments: attNames.length ? attNames.join(', ') : null,
      decision, detail,
    });
  } catch (_) { /* best-effort */ }
}

async function ingestMessage(supa: any, access: string, msg: any, householdId: string, createdBy: string): Promise<number> {
  const headers: any[] = msg.payload?.headers || [];
  const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value || '(no subject)';
  const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value || '';
  const date = headers.find((h) => h.name.toLowerCase() === 'date')?.value || '';

  // The same email arriving in two connected inboxes has different Gmail ids
  // but an identical RFC Message-ID header — key storage paths on that so the
  // second copy is recognized and skipped.
  const rfcId = headers.find((h) => h.name.toLowerCase() === 'message-id')?.value || '';
  const msgKey = rfcId ? rfcId.replace(/[^a-zA-Z0-9]/g, '').slice(-48) : msg.id;
  async function alreadySaved(path: string): Promise<boolean> {
    const { data } = await supa.from('family_documents')
      .select('id').eq('storage_path', path).limit(1).maybeSingle();
    return !!data;
  }

  const attachments = collectAttachments(msg.payload);
  const bodyText = extractBodyText(msg.payload);

  let uploaded = 0;
  const year = new Date().getFullYear();

  // Save the email body itself as a "document" if there's meaningful text
  if (bodyText && bodyText.trim().length > 40) {
    const path = `${householdId}/${year}/gmail-${msgKey}-body.txt`;
    if (await alreadySaved(path)) return 0;   // whole email already ingested
    const content = `Subject: ${subject}\nFrom: ${from}\nDate: ${date}\n\n${bodyText}`;
    const { error } = await supa.storage.from('family-docs').upload(
      path, new Blob([content], { type: 'text/plain' }),
      { contentType: 'text/plain', upsert: true },
    );
    if (error) throw new Error(`storage upload failed: ${error.message}`);
    const { error: dbErr } = await supa.from('family_documents').insert({
      household_id: householdId,
      storage_path: path,
      file_name: `${subject}.txt`,
      mime_type: 'text/plain',
      size_bytes: content.length,
      notes: `From gmail: ${from}`,
      created_by: createdBy,
    });
    if (dbErr) throw new Error(`family_documents insert failed: ${dbErr.message}`);
    uploaded++;
  }

  // Save each attachment
  for (const att of attachments) {
    const attData = await gApi<{ data: string }>(access,
      `/gmail/v1/users/me/messages/${msg.id}/attachments/${att.attachmentId}`);
    const bytes = base64UrlToBytes(attData.data);
    const safeName = (att.filename || 'attachment').replace(/[^a-z0-9._-]/gi, '_');
    const path = `${householdId}/${year}/gmail-${msgKey}-${safeName}`;
    if (await alreadySaved(path)) continue;   // this attachment already ingested
    const { error } = await supa.storage.from('family-docs').upload(
      path, new Blob([bytes], { type: att.mimeType || 'application/octet-stream' }),
      { contentType: att.mimeType || 'application/octet-stream', upsert: true },
    );
    if (error) throw new Error(`storage upload failed: ${error.message}`);
    const { error: dbErr } = await supa.from('family_documents').insert({
      household_id: householdId,
      storage_path: path,
      file_name: att.filename,
      mime_type: att.mimeType,
      size_bytes: bytes.length,
      notes: `From gmail: ${subject} (${from})`,
      created_by: createdBy,
    });
    if (dbErr) throw new Error(`family_documents insert failed: ${dbErr.message}`);
    uploaded++;
  }
  return uploaded;
}

function collectAttachments(part: any, out: any[] = []): any[] {
  if (part?.body?.attachmentId && part.filename) {
    out.push({ attachmentId: part.body.attachmentId, filename: part.filename, mimeType: part.mimeType });
  }
  for (const p of part?.parts || []) collectAttachments(p, out);
  return out;
}

function extractBodyText(part: any): string {
  if (part?.mimeType === 'text/plain' && part.body?.data) {
    return base64UrlDecode(part.body.data);
  }
  for (const p of part?.parts || []) {
    const found = extractBodyText(p);
    if (found) return found;
  }
  return '';
}

function base64UrlDecode(s: string): string {
  return new TextDecoder().decode(base64UrlToBytes(s));
}
function base64UrlToBytes(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gApi<T>(access: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com${path}`.replace('https://gmail.googleapis.com/gmail', 'https://gmail.googleapis.com/gmail'), {
    ...init,
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
      ...(init.headers as any || {}),
    },
  });
  if (!res.ok) throw new Error(`gmail ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

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
