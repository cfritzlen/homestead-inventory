// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: borough-sign
//
// East Stroudsburg rental registration: tenants sign the Addendum to Lease
// online, then the whole packet is emailed to the Borough. Same shape as
// lease-sign. Deploy with --no-verify-jwt: tenants open their private link
// without an account, so the public actions authenticate with the signer's
// token instead of a JWT. Landlord actions still need a signed-in member.
//
// Landlord (signed in):
//   { action:'send', filing_id, site_url, addendum_path, tenants:[{name,email}], auto_submit }
//        the browser already filled the Addendum (landlord signature on it) and
//        uploaded it to the rental-leases bucket; this creates the signers and
//        emails each tenant a link
//   { action:'status', filing_id }              signers + their state
//   { action:'remind', signer_id, site_url }    resend one tenant's email
//   { action:'cancel', filing_id }              remove signers, back to draft
//   { action:'submit', filing_id }              email the packet (files of kind 'packet') to the Borough now
//   { action:'submit_all', filing_ids:[…] }     one email to the Borough with every listed unit's packet
// Signer (token):
//   { action:'get',  token }                              summary + PDF link + where to tap
//   { action:'sign', token, signature_png, consent }      record the signature; finalizes
//                                                         (and emails the Borough if auto_submit) when the last tenant signs
//
// Emails go out through the landlord's connected Gmail (oauth_tokens).
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const BUCKET = 'rental-leases';
const MAX_PNG = 300_000;
const BOROUGH_EMAIL = 'rental@eaststroudsburgboro.org';
const BOROUGH_NAME = 'Borough of East Stroudsburg';

// Addendum page 2 occupant signature lines (PDF points, bottom-left origin).
// Must match assets/borough-forms.js.
const SIG_ROWS_Y = [385.5, 318.5, 251.0, 184.0];
const SIG_X0 = 324, SIG_X1 = 537.5;

function tagsFor(tenantIndex: number) {
  const y = SIG_ROWS_Y[Math.min(tenantIndex, SIG_ROWS_Y.length - 1)];
  return [{ kind: 'signature', page: 2, x: SIG_X0 + 2, y: y + 2, w: SIG_X1 - SIG_X0 - 4, h: 36, pw: 612, ph: 792 }];
}

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
      const { data: signer } = await supa.from('rental_borough_signers').select('*').eq('token', token).maybeSingle();
      if (!signer) return json({ error: 'This signing link is no longer valid.' }, 404);
      const { data: filing } = await supa.from('rental_borough_filings').select('*').eq('id', signer.filing_id).maybeSingle();
      if (!filing) return json({ error: 'not found' }, 404);
      const { data: prop } = await supa.from('rental_properties').select('property_name').eq('id', filing.property_id).maybeSingle();
      const property = prop?.property_name || 'your rental unit';
      const { data: others } = await supa.from('rental_borough_signers').select('name,role,status,signed_at').eq('filing_id', filing.id).order('id');
      const settings = await landlordSettings(supa);

      if (action === 'get') {
        if (!signer.viewed_at) await supa.from('rental_borough_signers').update({ viewed_at: new Date().toISOString() }).eq('id', signer.id);
        let pdf_url: string | null = null, signed_url: string | null = null;
        if (filing.signing_pdf_path) {
          const { data } = await supa.storage.from(BUCKET).createSignedUrl(filing.signing_pdf_path, 3600);
          pdf_url = data?.signedUrl || null;
        }
        if (filing.signing_status === 'signed') {
          const { data: sf } = await supa.from('rental_borough_files').select('storage_path').eq('filing_id', filing.id).eq('kind', 'packet')
            .ilike('file_name', '%Addendum%signed%').order('created_at', { ascending: false }).limit(1).maybeSingle();
          if (sf) { const { data } = await supa.storage.from(BUCKET).createSignedUrl(sf.storage_path, 3600); signed_url = data?.signedUrl || null; }
        }
        return json({
          ok: true, mode: 'borough',
          signer: { name: signer.name, role: signer.role, status: signer.status, signed_at: signer.signed_at, tenant_index: signer.tenant_index ?? 0 },
          lease: { property, start: '', end: '', rent: null, tenants: '', landlord: settings.name, status: filing.signing_status, year: filing.year },
          signers: others || [], pdf_url, signed_url, tags: signer.role === 'tenant' ? tagsFor(signer.tenant_index ?? 0) : [],
        });
      }

      // sign
      if (signer.status === 'signed') return json({ ok: true, already: true });
      if (filing.signing_status !== 'sent') return json({ error: 'This addendum is not open for signing.' }, 400);
      const sig = String(body.signature_png || '');
      if (!isPng(sig)) return json({ error: 'Please draw your signature.' }, 400);
      if (body.consent !== true) return json({ error: 'Please tick the agreement box.' }, 400);
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || null;
      const now = new Date().toISOString();
      await supa.from('rental_borough_signers').update({
        status: 'signed', signed_at: now, signed_ip: ip, signed_agent: (req.headers.get('user-agent') || '').slice(0, 300), signature_png: sig,
      }).eq('id', signer.id);

      // Stamp it onto the working PDF now
      let download_url: string | null = null;
      try {
        const { data: file } = await supa.storage.from(BUCKET).download(filing.signing_pdf_path);
        if (!file) throw new Error('no working PDF');
        const pdf = await PDFDocument.load(await file.arrayBuffer());
        await stampSigner(pdf, { ...signer, signature_png: sig });
        const newPath = `borough/${filing.year}/${filing.property_id}/${Date.now()}_Addendum_in_signing.pdf`;
        const { error: upErr } = await supa.storage.from(BUCKET).upload(newPath, await pdf.save(), { contentType: 'application/pdf' });
        if (upErr) throw upErr;
        await supa.from('rental_borough_filings').update({ signing_pdf_path: newPath }).eq('id', filing.id);
        await supa.from('rental_borough_signers').update({ stamped: true }).eq('id', signer.id);
        await supa.from('rental_borough_files').update({ storage_path: newPath }).eq('filing_id', filing.id).eq('kind', 'signing');
        if (filing.signing_pdf_path && filing.signing_pdf_path !== newPath) await supa.storage.from(BUCKET).remove([filing.signing_pdf_path]);
        filing.signing_pdf_path = newPath;
        const { data: u } = await supa.storage.from(BUCKET).createSignedUrl(newPath, 3600);
        download_url = u?.signedUrl || null;
      } catch (e) { console.warn('immediate stamp failed; finalize will do it:', e.message); }

      // Heads-up to the landlord (best effort)
      const left = (others || []).filter((o: any) => o.status !== 'signed' && o.name !== signer.name).length;
      try {
        await sendGmail(supa, settings.email, settings.email, `${signer.name} signed the Borough addendum for ${property}`,
          `<p>${esc(signer.name)} just signed the Addendum to Lease for ${esc(property)} (${filing.year} rental registration).</p><p>${left ? `${left} more signature${left === 1 ? '' : 's'} to go.` : (filing.auto_submit !== false ? 'That was the last one; the packet is being emailed to the Borough.' : 'That was the last one. Open Rentals → Borough and tap Send packet to Borough.')}</p>`);
      } catch (e) { console.warn('landlord notice failed', e.message); }

      const { data: all } = await supa.from('rental_borough_signers').select('*').eq('filing_id', filing.id).order('id');
      const remaining = (all || []).filter((s: any) => s.status !== 'signed');
      let finalized = false, submitted = false;
      if (!remaining.length) {
        try {
          await finalize(supa, filing, all || [], property); finalized = true;
          if (filing.auto_submit !== false) { await submitPackets(supa, [{ ...filing, property_name: property }], settings); submitted = true; }
        } catch (e) { console.error('finalize failed', e); return json({ ok: true, finalized, warning: 'Signed, but finishing up failed: ' + e.message }); }
      }
      return json({ ok: true, finalized, submitted, remaining: remaining.length, download_url });
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
      const { data } = await supa.from('rental_borough_signers')
        .select('id,role,name,email,status,sent_at,viewed_at,signed_at').eq('filing_id', body.filing_id).order('id');
      return json({ ok: true, signers: data || [] });
    }

    if (action === 'cancel') {
      const { data: w } = await supa.from('rental_borough_files').select('storage_path').eq('filing_id', body.filing_id).eq('kind', 'signing');
      if (w?.length) { await supa.storage.from(BUCKET).remove(w.map((f: any) => f.storage_path)); await supa.from('rental_borough_files').delete().eq('filing_id', body.filing_id).eq('kind', 'signing'); }
      await supa.from('rental_borough_signers').delete().eq('filing_id', body.filing_id);
      await supa.from('rental_borough_filings').update({ signing_status: 'draft', signing_pdf_path: null }).eq('id', body.filing_id);
      return json({ ok: true });
    }

    if (action === 'remind') {
      const { data: s } = await supa.from('rental_borough_signers').select('*').eq('id', body.signer_id).maybeSingle();
      if (!s) return json({ error: 'signer not found' }, 404);
      const { data: filing } = await supa.from('rental_borough_filings').select('*').eq('id', s.filing_id).maybeSingle();
      const { data: prop } = await supa.from('rental_properties').select('property_name').eq('id', filing.property_id).maybeSingle();
      const settings = await landlordSettings(supa);
      await sendInvite(supa, settings, prop?.property_name || 'your rental unit', filing.year, s, siteUrl);
      await supa.from('rental_borough_signers').update({ sent_at: new Date().toISOString() }).eq('id', s.id);
      return json({ ok: true });
    }

    if (action === 'submit' || action === 'submit_all') {
      const ids = action === 'submit' ? [Number(body.filing_id)] : (Array.isArray(body.filing_ids) ? body.filing_ids.map(Number) : []);
      if (!ids.filter(Boolean).length) return json({ error: 'no units selected' }, 400);
      const { data: filings } = await supa.from('rental_borough_filings').select('*').in('id', ids);
      if (!filings?.length) return json({ error: 'filing not found' }, 404);
      const { data: props } = await supa.from('rental_properties').select('id,property_name').in('id', filings.map((f: any) => f.property_id));
      for (const f of filings) f.property_name = props?.find((p: any) => p.id === f.property_id)?.property_name || 'rental unit';
      const stillSigning = filings.filter((f: any) => f.signing_status === 'sent');
      if (stillSigning.length) return json({ error: `Tenants are still signing the Addendum for ${stillSigning.map((f: any) => f.property_name).join(', ')}. Wait for them or cancel signing first.` }, 400);
      const settings = await landlordSettings(supa);
      const r = await submitPackets(supa, filings, settings);
      return json({ ok: true, ...r });
    }

    if (action === 'send') {
      if (!siteUrl) return json({ error: 'missing site_url' }, 400);
      const { data: filing } = await supa.from('rental_borough_filings').select('*').eq('id', body.filing_id).maybeSingle();
      if (!filing) return json({ error: 'filing not found' }, 404);
      const addendumPath = String(body.addendum_path || '');
      if (!addendumPath.startsWith(`borough/`)) return json({ error: 'missing the filled Addendum' }, 400);
      const { data: prop } = await supa.from('rental_properties').select('property_name').eq('id', filing.property_id).maybeSingle();
      const property = prop?.property_name || 'your rental unit';
      const settings = await landlordSettings(supa);
      if (!settings.email) return json({ error: 'Set the landlord email under Landlord contact first.' }, 400);

      const signers: any[] = [];
      for (const t of (Array.isArray(body.tenants) ? body.tenants : []).slice(0, 4)) {
        const name = String(t?.name || '').trim(), email = String(t?.email || '').trim();
        if (!name) continue;
        if (!email) return json({ error: `${name} has no email on the lease. Add it, save, and try again.` }, 400);
        signers.push({ filing_id: filing.id, role: 'tenant', name, email, tenant_index: signers.length, status: 'pending', stamped: false,
          signed_at: null, signed_ip: null, signed_agent: null, signature_png: null, viewed_at: null, sent_at: null });
      }
      if (!signers.length) return json({ error: 'no tenants to sign' }, 400);

      // The browser's upload is the working copy
      await supa.from('rental_borough_files').delete().eq('filing_id', filing.id).eq('kind', 'signing');
      await supa.from('rental_borough_files').insert({ filing_id: filing.id, kind: 'signing', storage_path: addendumPath, file_name: 'Addendum to Lease (in signing).pdf' });
      await supa.from('rental_borough_signers').delete().eq('filing_id', filing.id);
      const { data: rows, error } = await supa.from('rental_borough_signers').insert(signers).select();
      if (error) return json({ error: error.message }, 500);
      await supa.from('rental_borough_filings').update({ signing_status: 'sent', signing_pdf_path: addendumPath, auto_submit: body.auto_submit !== false, status: 'ready' }).eq('id', filing.id);

      const problems: string[] = [];
      let sent = 0;
      for (const s of rows || []) {
        try { await sendInvite(supa, settings, property, filing.year, s, siteUrl); await supa.from('rental_borough_signers').update({ sent_at: new Date().toISOString() }).eq('id', s.id); sent++; }
        catch (e) { problems.push(`${s.email}: ${e.message}`); }
      }
      return json({ ok: true, sent, problems });
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

async function sendInvite(supa: any, settings: any, property: string, year: number, s: any, siteUrl: string) {
  const link = `${siteUrl}/sign.html?b=${s.token}`;
  const html = `<p>Hi ${esc(s.name)},</p>
<p>${esc(settings.name)} needs your signature on the ${BOROUGH_NAME}'s <strong>Addendum to Lease</strong> for ${esc(property)}. The Borough requires it every year for the ${year} rental license; it does not change your lease or rent.</p>
<p><a href="${link}" style="display:inline-block;background:#1e40af;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Review and sign the addendum</a></p>
<p>Or copy this link: ${link}</p>
<p>It takes a minute: set up your signature once, read the two pages, and tap the "Sign here" spot.</p>
<p>Questions? Just reply to this email.</p>`;
  await sendGmail(supa, settings.email, s.email, `Signature needed: Borough addendum for ${property}`, html);
}

// Draw one tenant's signature on their occupant line (page 2).
async function stampSigner(pdf: any, s: any) {
  if (!s.signature_png) return;
  const page = pdf.getPages()[1];
  if (!page) return;
  const img = await pdf.embedPng(s.signature_png);
  const y = SIG_ROWS_Y[Math.min(s.tenant_index ?? 0, SIG_ROWS_Y.length - 1)];
  const scale = Math.min((SIG_X1 - SIG_X0 - 8) / img.width, 30 / img.height);
  page.drawImage(img, { x: SIG_X0 + 4, y: y + 2, width: img.width * scale, height: img.height * scale });
}

// Final Addendum: stamp anyone missing, add a signing record page, keep it as a packet file.
async function finalize(supa: any, filing: any, signers: any[], property: string) {
  if (!filing.signing_pdf_path) throw new Error('no PDF on this filing');
  const { data: file, error } = await supa.storage.from(BUCKET).download(filing.signing_pdf_path);
  if (error || !file) throw new Error('could not read the addendum PDF: ' + (error?.message || ''));
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const s of signers) if (!s.stamped && s.role === 'tenant') await stampSigner(pdf, s);

  const rec = pdf.addPage([612, 792]);
  let y = 740;
  rec.drawText('ELECTRONIC SIGNING RECORD', { x: 54, y, size: 14, font: bold }); y -= 22;
  rec.drawText(`Addendum to Lease for ${property} (${BOROUGH_NAME}, ${filing.year} rental registration)`, { x: 54, y, size: 10, font }); y -= 14;
  rec.drawText('Each occupant reviewed the addendum online and signed electronically (a drawn or typed signature),', { x: 54, y, size: 9, font }); y -= 12;
  rec.drawText('after agreeing to sign electronically. Details of each signature:', { x: 54, y, size: 9, font }); y -= 22;
  for (const s of signers) {
    rec.drawText(`${s.name} (${s.role})`, { x: 54, y, size: 10, font: bold }); y -= 13;
    rec.drawText(`Email: ${s.email}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Signed: ${s.signed_at ? new Date(s.signed_at).toUTCString() : 'n/a'}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Link opened: ${s.viewed_at ? new Date(s.viewed_at).toUTCString() : 'n/a'}   IP: ${s.signed_ip || 'n/a'}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Device: ${(s.signed_agent || 'n/a').slice(0, 95)}`, { x: 70, y, size: 8, font, color: rgb(0.3, 0.3, 0.3) }); y -= 20;
  }
  rec.drawText(`Record generated ${new Date().toUTCString()}`, { x: 54, y, size: 8, font, color: rgb(0.4, 0.4, 0.4) });

  const bytes = await pdf.save();
  const tag = property.replace(/[^A-Za-z0-9]+/g, '_');
  const fileName = `${tag}-Addendum-to-Lease-signed.pdf`;
  const path = `borough/${filing.year}/${filing.property_id}/${Date.now()}_${fileName}`;
  const { error: upErr } = await supa.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf' });
  if (upErr) throw new Error('could not store signed addendum: ' + upErr.message);
  await supa.from('rental_borough_files').insert({ filing_id: filing.id, kind: 'packet', file_name: fileName, storage_path: path });
  await supa.from('rental_borough_files').delete().eq('filing_id', filing.id).eq('kind', 'signing');
  await supa.from('rental_borough_filings').update({ signing_status: 'signed' }).eq('id', filing.id);
  filing.signing_status = 'signed';
}

// One email to the Borough (landlord in copy) with every 'packet' file of
// each listed filing: one unit or the whole building at once.
async function submitPackets(supa: any, filings: any[], settings: any) {
  const attachments: { name: string; bytes: Uint8Array }[] = [];
  const perUnit: { property: string; files: string[] }[] = [];
  for (const filing of filings) {
    const { data: files } = await supa.from('rental_borough_files').select('*').eq('filing_id', filing.id).eq('kind', 'packet').order('created_at');
    if (!files?.length) throw new Error(`Nothing to send for ${filing.property_name}: build the packet first.`);
    const latest = new Map<string, any>();                 // newest copy of each form name only
    for (const f of files) latest.set(f.file_name, f);
    const names: string[] = [];
    for (const f of latest.values()) {
      const { data, error } = await supa.storage.from(BUCKET).download(f.storage_path);
      if (error || !data) throw new Error('could not read ' + f.file_name);
      attachments.push({ name: f.file_name, bytes: new Uint8Array(await data.arrayBuffer()) });
      names.push(f.file_name);
    }
    perUnit.push({ property: filing.property_name, files: names });
  }
  const year = filings[0].year;
  const units = perUnit.map((u) => u.property);
  const html = `<p>Good day,</p>
<p>Attached ${units.length === 1 ? 'is' : 'are'} the ${year} Rental Registration packet${units.length === 1 ? '' : 's'} for:</p>
${perUnit.map((u) => `<p><strong>${esc(u.property)}</strong></p><ul>${u.files.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`).join('')}
<p>Please let me know if anything else is needed.</p>
<p>Thank you,<br>${esc(settings.name)}<br>${esc(settings.phone || '')}<br>${esc(settings.email || '')}</p>`;
  const subject = units.length === 1 ? `${year} Rental Registration packet - ${units[0]}` : `${year} Rental Registration packets - ${units.length} units - ${units.join(', ')}`;
  await sendGmail(supa, settings.email, BOROUGH_EMAIL, subject, html, attachments, settings.email);
  const today = new Date().toISOString().slice(0, 10);
  for (const filing of filings) {
    await supa.from('rental_borough_filings').update({ status: 'submitted', submitted_on: today, submitted_to: BOROUGH_EMAIL, updated_at: new Date().toISOString() }).eq('id', filing.id);
  }
  return { sent_to: BOROUGH_EMAIL, files: attachments.map((a) => a.name), units };
}

// ---------------------------------------------------------------------------
// Gmail send from the landlord's connected account
async function sendGmail(supa: any, from: string, to: string, subject: string, html: string, attachments?: { name: string; bytes: Uint8Array }[], cc?: string) {
  const { data: accts } = await supa.from('oauth_tokens').select('account_email').eq('provider', 'google');
  if (!accts?.length) throw new Error('no Gmail connected in Family Hub');
  const account = (accts.find((a: any) => a.account_email.toLowerCase() === (from || '').toLowerCase()) || accts[0]).account_email;
  const access = await getFreshAccessToken(supa, account);

  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  const headers = [`From: ${account}`, `To: ${to}`, cc ? `Cc: ${cc}` : '', from && from.toLowerCase() !== account.toLowerCase() ? `Reply-To: ${from}` : '', `Subject: ${subject}`, 'MIME-Version: 1.0'].filter(Boolean);
  let raw: string;
  if (attachments?.length) {
    const parts = [`--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(new TextEncoder().encode(html)), ''];
    for (const a of attachments) {
      parts.push(`--${boundary}`, `Content-Type: application/pdf; name="${a.name}"`, `Content-Disposition: attachment; filename="${a.name}"`, 'Content-Transfer-Encoding: base64', '', b64(a.bytes), '');
    }
    parts.push(`--${boundary}--`);
    raw = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
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
