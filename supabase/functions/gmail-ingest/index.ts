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

Deno.serve(async (_req) => {
  try {
    const supa = getServiceClient();

    const { data: accounts, error: acctErr } = await supa
      .from('oauth_tokens').select('account_email').eq('provider', 'google');
    if (acctErr) return json({ error: `accounts query failed: ${acctErr.message}` }, 500);
    if (!accounts?.length) return json({ ok: true, note: 'no connected accounts' });

    const perAccount: any[] = [];
    for (const { account_email } of accounts) {
      try {
        const r = await pollAccount(supa, account_email);
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
    return json({ ok: true, accounts: perAccount });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

async function pollAccount(supa: any, accountEmail: string) {
  const access = await getFreshAccessToken(supa, accountEmail);

  // Resolve label id (cached in gmail_state)
  const { data: state } = await supa.from('gmail_state')
    .select('*').eq('account_email', accountEmail).maybeSingle();
  let labelId = state?.label_id;
  if (!labelId) {
    const labels = await gApi<{ labels: any[] }>(access, '/gmail/v1/users/me/labels');
    const lbl = labels.labels.find((l) => l.name === LABEL_NAME);
    if (!lbl) {
      // Not an error: this account just hasn't made the label (yet)
      return { skipped: true, reason: `label "${LABEL_NAME}" not found in this account` };
    }
    labelId = lbl.id;
    await supa.from('gmail_state').upsert({
      account_email: accountEmail, label_id: labelId,
    }, { onConflict: 'account_email' });
  }

  const list = await gApi<{ messages?: {id: string}[] }>(
    access, `/gmail/v1/users/me/messages?labelIds=${labelId}&maxResults=25`,
  );
  const messageIds = (list.messages || []).map((m) => m.id);

  const results: any[] = [];
  for (const id of messageIds) {
    try {
      const msg = await gApi<any>(access, `/gmail/v1/users/me/messages/${id}?format=full`);
      const uploaded = await ingestMessage(supa, access, msg);
      await gApi(access, `/gmail/v1/users/me/messages/${id}/modify`, {
        method: 'POST',
        body: JSON.stringify({ removeLabelIds: [labelId] }),
      });
      results.push({ id, uploaded });
    } catch (e) {
      results.push({ id, error: e.message });
    }
  }

  await supa.from('gmail_state').upsert({
    account_email: accountEmail,
    label_id: labelId,
    last_polled_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_email' });

  return { processed: results.length, results };
}

async function ingestMessage(supa: any, access: string, msg: any): Promise<number> {
  const headers: any[] = msg.payload?.headers || [];
  const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value || '(no subject)';
  const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value || '';
  const date = headers.find((h) => h.name.toLowerCase() === 'date')?.value || '';

  const attachments = collectAttachments(msg.payload);
  const bodyText = extractBodyText(msg.payload);

  let uploaded = 0;
  const year = new Date().getFullYear();

  // Save the email body itself as a "document" if there's meaningful text
  if (bodyText && bodyText.trim().length > 40) {
    const path = `${year}/gmail-${msg.id}-body.txt`;
    const content = `Subject: ${subject}\nFrom: ${from}\nDate: ${date}\n\n${bodyText}`;
    const { error } = await supa.storage.from('family-docs').upload(
      path, new Blob([content], { type: 'text/plain' }),
      { contentType: 'text/plain', upsert: true },
    );
    if (!error) {
      await supa.from('family_documents').insert({
        storage_path: path,
        file_name: `${subject}.txt`,
        mime_type: 'text/plain',
        size_bytes: content.length,
        notes: `From gmail: ${from}`,
      });
      uploaded++;
    }
  }

  // Save each attachment
  for (const att of attachments) {
    const attData = await gApi<{ data: string }>(access,
      `/gmail/v1/users/me/messages/${msg.id}/attachments/${att.attachmentId}`);
    const bytes = base64UrlToBytes(attData.data);
    const safeName = (att.filename || 'attachment').replace(/[^a-z0-9._-]/gi, '_');
    const path = `${year}/gmail-${msg.id}-${safeName}`;
    const { error } = await supa.storage.from('family-docs').upload(
      path, new Blob([bytes], { type: att.mimeType || 'application/octet-stream' }),
      { contentType: att.mimeType || 'application/octet-stream', upsert: true },
    );
    if (!error) {
      await supa.from('family_documents').insert({
        storage_path: path,
        file_name: att.filename,
        mime_type: att.mimeType,
        size_bytes: bytes.length,
        notes: `From gmail: ${subject} (${from})`,
      });
      uploaded++;
    }
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

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
