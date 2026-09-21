// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: lease-sign
//
// In-app lease signing. Deploy with --no-verify-jwt: tenants open their
// private link without an account, so the public actions authenticate with
// the signer's token instead of a JWT. Landlord actions still need a
// signed-in homestead member.
//
// Landlord (signed in):
//   { action:'send',   lease_id, site_url }   create signers, email each a link
//   { action:'status', lease_id }             signers + their state
//   { action:'remind', signer_id, site_url }  resend one signer's email
//   { action:'cancel', lease_id }             remove signers, back to draft
// Signer (token):
//   { action:'get',  token }                              lease summary + PDF link
//   { action:'sign', token, signature_png, initials_png }  record the signature;
//                                                          finalizes when all signed
//
// Emails go out through the landlord's connected Gmail (oauth_tokens, same
// connection Family Hub uses). Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const BUCKET = 'rental-leases';
const MAX_PNG = 300_000;                       // bytes of data URL per drawing

// Where things go on the final PDF. Page 1 and the signature page are Letter
// (drawn in mm by jsPDF); the middle pages are the static file. Must match
// buildLeaseDoc() and INITIAL_LINES/INITIAL_X in rentals.html.
const PT = 72 / 25.4;
const LETTER_H_MM = 279.4;
const SIG_FIRST_Y_MM = 53, SIG_STEP_MM = 26, SIG_LANDLORD_GAP_MM = 10, SIG_X_MM = 30;   // X line, then name 6mm under, then 20mm gap
const INITIAL_LINES: [number, number][] = [[2, 137.1], [7, 297.3], [9, 428.9], [10, 302.2], [11, 390.8], [11, 117.6], [12, 356.3], [15, 585.6], [16, 435.3], [16, 74.1]];
const INITIAL_X = [36, 252, 468, 144];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const supa = getServiceClient();
    let body: any = {};
    try { body = await req.json(); } catch (_) { /* empty */ }
    const action = String(body.action || '');

    // ---- public, token-based ----
    if (action === 'get' || action === 'sign') {
      const token = String(body.token || '');
      if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: 'bad link' }, 400);
      const { data: signer } = await supa.from('rental_lease_signers').select('*').eq('token', token).maybeSingle();
      if (!signer) return json({ error: 'This signing link is no longer valid.' }, 404);
      const { data: lease } = await supa.from('rental_leases').select('*').eq('id', signer.lease_id).maybeSingle();
      if (!lease) return json({ error: 'lease not found' }, 404);
      const { data: others } = await supa.from('rental_lease_signers').select('name,role,status,signed_at').eq('lease_id', lease.id).order('id');
      const { data: settings } = await supa.from('rental_settings').select('key,value');
      const landlordName = (settings || []).find((s: any) => s.key === 'landlord_name')?.value || 'the landlord';

      if (action === 'get') {
        if (!signer.viewed_at) await supa.from('rental_lease_signers').update({ viewed_at: new Date().toISOString() }).eq('id', signer.id);
        let pdf_url: string | null = null;
        if (lease.signing_pdf_path) {
          const { data } = await supa.storage.from(BUCKET).createSignedUrl(lease.signing_pdf_path, 3600);
          pdf_url = data?.signedUrl || null;
        }
        return json({
          ok: true, signer: { name: signer.name, role: signer.role, status: signer.status, signed_at: signer.signed_at },
          lease: { property: lease.property_address, start: lease.lease_start, end: lease.lease_end, rent: lease.rent_amount, tenants: lease.tenant_names, landlord: landlordName, status: lease.signing_status },
          signers: others || [], pdf_url,
        });
      }

      // sign
      if (signer.status === 'signed') return json({ ok: true, already: true });
      if (lease.signing_status !== 'sent') return json({ error: 'This lease is not open for signing.' }, 400);
      const sig = String(body.signature_png || ''), ini = String(body.initials_png || '');
      if (!isPng(sig) || !isPng(ini)) return json({ error: 'Please draw both a signature and initials.' }, 400);
      if (body.consent !== true) return json({ error: 'Please tick the agreement box.' }, 400);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || null;
      await supa.from('rental_lease_signers').update({
        status: 'signed', signed_at: new Date().toISOString(), signed_ip: ip,
        signed_agent: (req.headers.get('user-agent') || '').slice(0, 300),
        signature_png: sig, initials_png: ini,
      }).eq('id', signer.id);

      const { data: all } = await supa.from('rental_lease_signers').select('*').eq('lease_id', lease.id).order('id');
      const remaining = (all || []).filter((s: any) => s.status !== 'signed');
      let finalized = false;
      if (!remaining.length) {
        try { await finalize(supa, lease, all || [], settings || []); finalized = true; }
        catch (e) { console.error('finalize failed', e); return json({ ok: true, finalized: false, warning: 'Signed, but the final PDF could not be built: ' + e.message }); }
      }
      return json({ ok: true, finalized, remaining: remaining.length });
    }

    // ---- landlord actions: signed-in homestead member ----
    const authToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: caller } = await supa.auth.getUser(authToken);
    if (!caller?.user) return json({ error: 'sign in first' }, 401);
    const { data: membership } = await supa.from('household_members')
      .select('household_id,can_access_homestead').eq('user_id', caller.user.id).limit(1).maybeSingle();
    if (!membership || membership.can_access_homestead === false) return json({ error: 'not a homestead member' }, 403);
    const siteUrl = String(body.site_url || '').replace(/\/+$/, '');

    if (action === 'status') {
      const { data } = await supa.from('rental_lease_signers')
        .select('id,role,name,email,status,sent_at,viewed_at,signed_at').eq('lease_id', body.lease_id).order('id');
      return json({ ok: true, signers: data || [] });
    }

    if (action === 'cancel') {
      await supa.from('rental_lease_signers').delete().eq('lease_id', body.lease_id);
      await supa.from('rental_leases').update({ signing_status: 'draft', signing_pdf_path: null }).eq('id', body.lease_id);
      return json({ ok: true });
    }

    if (action === 'remind') {
      const { data: s } = await supa.from('rental_lease_signers').select('*').eq('id', body.signer_id).maybeSingle();
      if (!s) return json({ error: 'signer not found' }, 404);
      const { data: lease } = await supa.from('rental_leases').select('*').eq('id', s.lease_id).maybeSingle();
      const settings = await landlordSettings(supa);
      await sendInvite(supa, settings, lease, s, siteUrl);
      await supa.from('rental_lease_signers').update({ sent_at: new Date().toISOString() }).eq('id', s.id);
      return json({ ok: true });
    }

    if (action === 'send') {
      if (!siteUrl) return json({ error: 'missing site_url' }, 400);
      const { data: lease } = await supa.from('rental_leases').select('*').eq('id', body.lease_id).maybeSingle();
      if (!lease) return json({ error: 'lease not found' }, 404);
      const { data: gen } = await supa.from('rental_lease_files').select('*').eq('lease_id', lease.id).eq('kind', 'generated')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!gen) return json({ error: 'Generate the lease PDF first (Download full lease PDF), then send.' }, 400);
      const settings = await landlordSettings(supa);
      if (!settings.email) return json({ error: 'Set the landlord email under Landlord contact first.' }, 400);

      const signers: any[] = [];
      for (let i = 1; i <= 4; i++) {
        const name = lease[`tenant${i}_name`], email = lease[`tenant${i}_email`];
        if (!name) continue;
        if (!email) return json({ error: `${name} has no email on the lease. Add it, save, and try again.` }, 400);
        signers.push({ lease_id: lease.id, role: 'tenant', name, email: String(email).trim() });
      }
      if (!signers.length) return json({ error: 'no tenants on this lease' }, 400);
      signers.push({ lease_id: lease.id, role: 'landlord', name: settings.name, email: settings.email });

      await supa.from('rental_lease_signers').delete().eq('lease_id', lease.id);
      const { data: rows, error } = await supa.from('rental_lease_signers').insert(signers).select();
      if (error) return json({ error: error.message }, 500);
      await supa.from('rental_leases').update({ signing_status: 'sent', signing_pdf_path: gen.storage_path }).eq('id', lease.id);

      const problems: string[] = [];
      for (const s of rows || []) {
        try { await sendInvite(supa, settings, lease, s, siteUrl); await supa.from('rental_lease_signers').update({ sent_at: new Date().toISOString() }).eq('id', s.id); }
        catch (e) { problems.push(`${s.email}: ${e.message}`); }
      }
      return json({ ok: true, sent: (rows || []).length - problems.length, problems });
    }

    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

// ---------------------------------------------------------------------------
async function landlordSettings(supa: any) {
  const { data } = await supa.from('rental_settings').select('key,value');
  const get = (k: string) => (data || []).find((r: any) => r.key === k)?.value || '';
  return { name: get('landlord_name') || 'Landlord', email: get('landlord_email'), phone: get('landlord_phone') };
}

async function sendInvite(supa: any, settings: any, lease: any, s: any, siteUrl: string) {
  const link = `${siteUrl}/sign.html?t=${s.token}`;
  const who = s.role === 'landlord' ? 'Your tenants have been sent their links; sign as landlord here:' : `${settings.name} has sent you the lease for ${lease.property_address} to review and sign.`;
  const html = `<p>Hi ${esc(s.name)},</p>
<p>${esc(who)}</p>
<p><a href="${link}" style="display:inline-block;background:#1e40af;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Review and sign the lease</a></p>
<p>Or copy this link: ${link}</p>
<p>Lease term: ${esc(lease.lease_start)} to ${esc(lease.lease_end)}. Rent: $${esc(String(lease.rent_amount))}/month.</p>
<p>It takes a couple of minutes: read the lease, then draw your signature and initials. Everyone gets the signed copy by email once all parties have signed.</p>
<p>Questions? Just reply to this email.</p>`;
  await sendGmail(supa, settings.email, s.email, `Lease to sign: ${lease.property_address}`, html);
}

// ---------------------------------------------------------------------------
// Final PDF: signatures on the signature page, initials on every initial
// line, plus a signing record page. Then stored on the lease and emailed.
async function finalize(supa: any, lease: any, signers: any[], settings: any[]) {
  if (!lease.signing_pdf_path) throw new Error('no PDF on this lease');
  const { data: file, error } = await supa.storage.from(BUCKET).download(lease.signing_pdf_path);
  if (error || !file) throw new Error('could not read the lease PDF: ' + (error?.message || ''));
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();
  const sigPage = pages[pages.length - 1];
  const tenants = signers.filter((s) => s.role === 'tenant');
  const landlord = signers.find((s) => s.role === 'landlord');
  const yPt = (mm: number) => (LETTER_H_MM - mm) * PT;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const place = async (page: any, dataUrl: string, x: number, yBottom: number, maxW: number, maxH: number) => {
    const img = await pdf.embedPng(dataUrl);
    const scale = Math.min(maxW / img.width, maxH / img.height);
    page.drawImage(img, { x, y: yBottom, width: img.width * scale, height: img.height * scale });
  };

  // Signature page
  for (let i = 0; i < tenants.length; i++) {
    const s = tenants[i];
    const lineY = yPt(SIG_FIRST_Y_MM + SIG_STEP_MM * i);
    await place(sigPage, s.signature_png, SIG_X_MM * PT, lineY + 2, 190, 40);
    sigPage.drawText(`Signed ${fmt(s.signed_at)}`, { x: 330, y: lineY + 3, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  }
  if (landlord) {
    const lineY = yPt(SIG_FIRST_Y_MM + SIG_STEP_MM * tenants.length + SIG_LANDLORD_GAP_MM);
    await place(sigPage, landlord.signature_png, SIG_X_MM * PT, lineY + 2, 190, 40);
    sigPage.drawText(`Signed ${fmt(landlord.signed_at)}`, { x: 330, y: lineY + 3, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  }

  // Initials on the middle pages (final page index = middle index + 1)
  for (const [mi, y] of INITIAL_LINES) {
    const page = pages[mi + 1];
    if (!page) continue;
    for (let i = 0; i < tenants.length && i < INITIAL_X.length; i++) {
      await place(page, tenants[i].initials_png, INITIAL_X[i] + 2, y + 1, 44, 20);
    }
  }

  // Signing record
  const rec = pdf.addPage([612, 792]);
  let y = 740;
  rec.drawText('SIGNING RECORD', { x: 54, y, size: 14, font: bold }); y -= 22;
  rec.drawText(`Lease: ${lease.property_address}, ${lease.lease_start} to ${lease.lease_end}`, { x: 54, y, size: 10, font }); y -= 14;
  rec.drawText('Each party reviewed the full lease online and signed electronically by drawing their signature and initials,', { x: 54, y, size: 9, font }); y -= 12;
  rec.drawText('after agreeing to sign electronically. Details of each signature:', { x: 54, y, size: 9, font }); y -= 22;
  for (const s of signers) {
    rec.drawText(`${s.name} (${s.role})`, { x: 54, y, size: 10, font: bold }); y -= 13;
    rec.drawText(`Email: ${s.email}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Signed: ${new Date(s.signed_at).toUTCString()}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Link opened: ${s.viewed_at ? new Date(s.viewed_at).toUTCString() : 'n/a'}   IP: ${s.signed_ip || 'n/a'}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Device: ${(s.signed_agent || 'n/a').slice(0, 95)}`, { x: 70, y, size: 8, font, color: rgb(0.3, 0.3, 0.3) }); y -= 20;
  }
  rec.drawText(`Record generated ${new Date().toUTCString()}`, { x: 54, y, size: 8, font, color: rgb(0.4, 0.4, 0.4) });

  const bytes = await pdf.save();
  const fileName = `Signed_Lease_${String(lease.tenant_names || '').replace(/[^A-Za-z0-9]+/g, '_')}_${lease.lease_start}.pdf`;
  const path = `${lease.id}/${Date.now()}_${fileName}`;
  const { error: upErr } = await supa.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf' });
  if (upErr) throw new Error('could not store signed PDF: ' + upErr.message);
  await supa.from('rental_lease_files').insert({ lease_id: lease.id, kind: 'signed', file_name: fileName, storage_path: path });
  await supa.from('rental_leases').update({ signing_status: 'signed' }).eq('id', lease.id);

  // Everyone gets the signed copy
  const get = (k: string) => settings.find((r: any) => r.key === k)?.value || '';
  const from = get('landlord_email');
  const html = `<p>Everyone has signed the lease for ${esc(lease.property_address)} (${esc(lease.lease_start)} to ${esc(lease.lease_end)}).</p><p>The signed copy is attached. Please keep it for your records.</p>`;
  for (const s of signers) {
    try { await sendGmail(supa, from, s.email, `Signed lease: ${lease.property_address}`, html, { name: fileName, bytes }); }
    catch (e) { console.error('completion email failed for', s.email, e.message); }
  }
}

// ---------------------------------------------------------------------------
// Gmail send from the landlord's connected account
async function sendGmail(supa: any, from: string, to: string, subject: string, html: string, attachment?: { name: string; bytes: Uint8Array }) {
  const { data: accts } = await supa.from('oauth_tokens').select('account_email').eq('provider', 'google');
  if (!accts?.length) throw new Error('no Gmail connected in Family Hub');
  const account = (accts.find((a: any) => a.account_email.toLowerCase() === (from || '').toLowerCase()) || accts[0]).account_email;
  const access = await getFreshAccessToken(supa, account);

  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  const headers = [`From: ${account}`, `To: ${to}`, from && from.toLowerCase() !== account.toLowerCase() ? `Reply-To: ${from}` : '', `Subject: ${subject}`, 'MIME-Version: 1.0'].filter(Boolean);
  let raw: string;
  if (attachment) {
    raw = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(new TextEncoder().encode(html)), '',
      `--${boundary}`, `Content-Type: application/pdf; name="${attachment.name}"`, `Content-Disposition: attachment; filename="${attachment.name}"`,
      'Content-Transfer-Encoding: base64', '', b64(attachment.bytes), '', `--${boundary}--`].join('\r\n');
  } else {
    raw = [...headers, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(new TextEncoder().encode(html))].join('\r\n');
  }
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64(new TextEncoder().encode(raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }),
  });
  if (!res.ok) throw new Error(`gmail send ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function b64(bytes: Uint8Array): string {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
function isPng(s: string) { return s.startsWith('data:image/png;base64,') && s.length < MAX_PNG; }
function esc(s: any) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function cors() { return new Response(null, { status: 204, headers: CORS_HEADERS }); }
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
}
