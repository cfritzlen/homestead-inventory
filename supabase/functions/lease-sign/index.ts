// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: lease-sign
//
// In-app lease signing. Deploy with --no-verify-jwt: tenants open their
// private link without an account, so the public actions authenticate with
// the signer's token instead of a JWT. Landlord actions still need a
// signed-in homestead member.
//
// Landlord (signed in):
//   { action:'send', lease_id, site_url, landlord_signature_png }
//                       stamp the landlord's signature, create signers, email tenants
//   { action:'status', lease_id }             signers + their state
//   { action:'remind', signer_id, site_url }  resend one signer's email
//   { action:'cancel', lease_id }             remove signers, back to draft
// Signer (token):
//   { action:'get',  token }                              lease summary + PDF link
//   { action:'sign', token, signature_png, initials_png, tags_done, consent, id_image }
//                       record the signature (every tag must be tapped, ID photo required);
//                       finalizes when all tenants have signed
//
// Emails go out through the landlord's connected Gmail (oauth_tokens, same
// connection Family Hub uses). Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.

import { getFreshAccessToken, getServiceClient } from '../_shared/google.ts';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const BUCKET = 'rental-leases';
const MAX_PNG = 300_000;                       // bytes of data URL per drawing
const MAX_ID = 4_000_000;                      // bytes of data URL for the ID photo (resized on the phone)

// Where things go on the final PDF. Page 1 and the signature page are Letter
// (drawn in mm by jsPDF); the middle pages are the static file. Must match
// buildLeaseDoc() and INITIAL_LINES/INITIAL_X in rentals.html.
const PT = 72 / 25.4;
const LETTER_H_MM = 279.4;
const SIG_FIRST_Y_MM = 53, SIG_STEP_MM = 26, SIG_LANDLORD_GAP_MM = 10, SIG_X_MM = 30;   // X line, then name 6mm under, then 20mm gap
const INITIAL_LINES: [number, number][] = [[2, 137.1], [7, 297.3], [9, 428.9], [10, 302.2], [11, 390.8], [11, 117.6], [12, 356.3], [15, 585.6], [16, 435.3], [16, 74.1]];
const INITIAL_X = [36, 252, 468, 144];
const PT_W_LETTER = 215.9 * PT, PT_H_LETTER = LETTER_H_MM * PT;

// The spots a tenant must tap: every initial line (middle page index + 2 =
// 1-based page) and their signature line on the last page.
function tagsFor(tenantIndex: number, pageCount: number) {
  const tags: any[] = [];
  for (const [mi, y] of INITIAL_LINES) tags.push({ kind: 'initials', page: mi + 2, x: INITIAL_X[tenantIndex] || 36, y: y + 1, w: 44, h: 20, pw: 612, ph: 792 });
  const lineY = (LETTER_H_MM - (SIG_FIRST_Y_MM + SIG_STEP_MM * tenantIndex)) * PT;
  tags.push({ kind: 'signature', page: pageCount, x: SIG_X_MM * PT, y: lineY + 2, w: 190, h: 40, pw: PT_W_LETTER, ph: PT_H_LETTER });
  return tags;
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
      const { data: signer } = await supa.from('rental_lease_signers').select('*').eq('token', token).maybeSingle();
      if (!signer) return json({ error: 'This signing link is no longer valid.' }, 404);
      const { data: lease } = await supa.from('rental_leases').select('*').eq('id', signer.lease_id).maybeSingle();
      if (!lease) return json({ error: 'lease not found' }, 404);
      const { data: others } = await supa.from('rental_lease_signers').select('name,role,status,signed_at').eq('lease_id', lease.id).order('id');
      const { data: settings } = await supa.from('rental_settings').select('key,value');
      const landlordName = (settings || []).find((s: any) => s.key === 'landlord_name')?.value || 'the landlord';

      if (action === 'get') {
        if (!signer.viewed_at) await supa.from('rental_lease_signers').update({ viewed_at: new Date().toISOString() }).eq('id', signer.id);
        let pdf_url: string | null = null, signed_url: string | null = null;
        if (lease.signing_pdf_path) {
          const { data } = await supa.storage.from(BUCKET).createSignedUrl(lease.signing_pdf_path, 3600);
          pdf_url = data?.signedUrl || null;
        }
        if (lease.signing_status === 'signed') {
          const { data: sf } = await supa.from('rental_lease_files').select('storage_path').eq('lease_id', lease.id).eq('kind', 'signed')
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
          if (sf) { const { data } = await supa.storage.from(BUCKET).createSignedUrl(sf.storage_path, 3600); signed_url = data?.signedUrl || null; }
        }
        let pageCount = 19;
        if (lease.signing_pdf_path && signer.status !== 'signed') {
          try { const { data: f } = await supa.storage.from(BUCKET).download(lease.signing_pdf_path); if (f) pageCount = (await PDFDocument.load(await f.arrayBuffer())).getPageCount(); } catch (_) { /* keep 19 */ }
        }
        return json({
          ok: true, signer: { name: signer.name, role: signer.role, status: signer.status, signed_at: signer.signed_at, tenant_index: signer.tenant_index ?? 0 },
          lease: { property: lease.property_address, start: lease.lease_start, end: lease.lease_end, rent: lease.rent_amount, tenants: lease.tenant_names, landlord: landlordName, status: lease.signing_status },
          signers: others || [], pdf_url, signed_url, tags: signer.role === 'tenant' ? tagsFor(signer.tenant_index ?? 0, pageCount) : [],
        });
      }

      // sign
      if (signer.status === 'signed') return json({ ok: true, already: true });
      if (lease.signing_status !== 'sent') return json({ error: 'This lease is not open for signing.' }, 400);
      const sig = String(body.signature_png || ''), ini = String(body.initials_png || '');
      if (!isPng(sig) || !isPng(ini)) return json({ error: 'Please draw both a signature and initials.' }, 400);
      if (body.consent !== true) return json({ error: 'Please tick the agreement box.' }, 400);
      const idImage = String(body.id_image || '');
      const idMatch = idImage.match(/^data:image\/(jpeg|png|webp);base64,/);
      if (!idMatch || idImage.length > MAX_ID) return json({ error: 'Please add a clear photo of your government-issued ID.' }, 400);
      const expected = tagsFor(signer.tenant_index ?? 0, 19).length;
      if (Number(body.tags_done) < expected) return json({ error: `Please tap every "Initial" and "Sign" spot first (${Number(body.tags_done) || 0} of ${expected} done).` }, 400);
      // Store the ID photo privately on the lease
      const ext = idMatch[1] === 'jpeg' ? 'jpg' : idMatch[1];
      const idBytes = Uint8Array.from(atob(idImage.slice(idImage.indexOf(',') + 1)), (c) => c.charCodeAt(0));
      const idPath = `${lease.id}/id_${signer.id}_${Date.now()}.${ext}`;
      const { error: idErr } = await supa.storage.from(BUCKET).upload(idPath, idBytes, { contentType: `image/${idMatch[1]}` });
      if (idErr) return json({ error: 'Could not save the ID photo: ' + idErr.message }, 500);
      await supa.from('rental_lease_files').insert({ lease_id: lease.id, kind: 'id', file_name: `ID - ${signer.name}.${ext}`, storage_path: idPath });

      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || null;
      await supa.from('rental_lease_signers').update({
        status: 'signed', signed_at: new Date().toISOString(), signed_ip: ip,
        signed_agent: (req.headers.get('user-agent') || '').slice(0, 300),
        signature_png: sig, initials_png: ini, tags_done: Number(body.tags_done) || 0, id_path: idPath,
      }).eq('id', signer.id);
      // Heads-up to the landlord (best effort)
      try {
        const st = await landlordSettings(supa);
        const left = (others || []).filter((o: any) => o.status !== 'signed' && o.name !== signer.name).length;
        await sendGmail(supa, st.email, st.email, `${signer.name} signed the lease for ${lease.property_address}`,
          `<p>${esc(signer.name)} just signed the lease for ${esc(lease.property_address)}.</p><p>${left ? `${left} more signature${left === 1 ? '' : 's'} to go.` : 'That was the last one; the signed copy is on its way to everyone.'}</p>`);
      } catch (e) { console.warn('landlord notice failed', e.message); }

      // Rebuild the working copy: landlord-signed base + every tenant who has
      // signed so far. Rebuilding (rather than adding to the last copy) means
      // two tenants finishing at the same moment can't overwrite each other.
      const { data: all } = await supa.from('rental_lease_signers').select('*').eq('lease_id', lease.id).order('id');
      const remaining = (all || []).filter((s: any) => s.status !== 'signed');
      let download_url: string | null = null;
      try {
        const pdf = await workingCopy(supa, lease, all || []);
        const newPath = `${lease.id}/${Date.now()}_for_signing.pdf`;
        const { error: upErr } = await supa.storage.from(BUCKET).upload(newPath, await pdf.save(), { contentType: 'application/pdf' });
        if (upErr) throw upErr;
        const oldPath = lease.signing_pdf_path;
        await supa.from('rental_leases').update({ signing_pdf_path: newPath }).eq('id', lease.id);
        await supa.from('rental_lease_signers').update({ stamped: true }).eq('id', signer.id);
        await supa.from('rental_lease_files').update({ storage_path: newPath }).eq('lease_id', lease.id).eq('kind', 'signing');
        if (oldPath && oldPath !== newPath && oldPath !== lease.signing_base_path) await supa.storage.from(BUCKET).remove([oldPath]);
        lease.signing_pdf_path = newPath;
        const { data: u } = await supa.storage.from(BUCKET).createSignedUrl(newPath, 3600);
        download_url = u?.signedUrl || null;
      } catch (e) { console.warn('working copy rebuild failed; finalize will redo it:', e.message); }
      let finalized = false;
      if (!remaining.length) {
        try { await finalize(supa, lease, all || [], settings || []); finalized = true; }
        catch (e) { console.error('finalize failed', e); return json({ ok: true, finalized: false, warning: 'Signed, but the final PDF could not be built: ' + e.message }); }
      }
      if (finalized) {
        const { data: sf } = await supa.from('rental_lease_files').select('storage_path').eq('lease_id', lease.id).eq('kind', 'signed').order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (sf) { const { data: u } = await supa.storage.from(BUCKET).createSignedUrl(sf.storage_path, 3600); download_url = u?.signedUrl || download_url; }
      }
      return json({ ok: true, finalized, remaining: remaining.length, download_url });
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
      const { data: w } = await supa.from('rental_lease_files').select('storage_path').eq('lease_id', body.lease_id).eq('kind', 'signing');
      if (w?.length) { await supa.storage.from(BUCKET).remove(w.map((f: any) => f.storage_path)); await supa.from('rental_lease_files').delete().eq('lease_id', body.lease_id).eq('kind', 'signing'); }
      await supa.from('rental_lease_signers').delete().eq('lease_id', body.lease_id);
      const { data: lz } = await supa.from('rental_leases').select('signing_base_path').eq('id', body.lease_id).maybeSingle();
      if (lz?.signing_base_path) await supa.storage.from(BUCKET).remove([lz.signing_base_path]);
      await supa.from('rental_leases').update({ signing_status: 'draft', signing_pdf_path: null, signing_base_path: null }).eq('id', body.lease_id);
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
      const landlordSig = String(body.landlord_signature_png || '');
      if (!isPng(landlordSig)) return json({ error: 'Sign first: your signature is missing.' }, 400);
      const { data: lease } = await supa.from('rental_leases').select('*').eq('id', body.lease_id).maybeSingle();
      if (!lease) return json({ error: 'lease not found' }, 404);
      const { data: gen } = await supa.from('rental_lease_files').select('*').eq('lease_id', lease.id).in('kind', ['draft', 'generated'])
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!gen) return json({ error: 'Generate the lease PDF first (Download full lease PDF), then send.' }, 400);
      const settings = await landlordSettings(supa);
      if (!settings.email) return json({ error: 'Set the landlord email under Landlord contact first.' }, 400);

      const signers: any[] = [];
      for (let i = 1; i <= 4; i++) {
        const name = lease[`tenant${i}_name`], email = lease[`tenant${i}_email`];
        if (!name) continue;
        if (!email) return json({ error: `${name} has no email on the lease. Add it, save, and try again.` }, 400);
        // Same columns as the landlord row below: a bulk insert fills any missing
        // key with null, which would override the 'pending' default.
        signers.push({ lease_id: lease.id, role: 'tenant', name, email: String(email).trim(), tenant_index: signers.length,
          status: 'pending', stamped: false, signed_at: null, signed_ip: null, signed_agent: null, signature_png: null, initials_png: null, viewed_at: null });
      }
      if (!signers.length) return json({ error: 'no tenants on this lease' }, 400);

      // Landlord signs now: stamp it onto the PDF the tenants will see
      const { data: file, error: dlErr } = await supa.storage.from(BUCKET).download(gen.storage_path);
      if (dlErr || !file) return json({ error: 'could not read the generated PDF' }, 500);
      const pdf = await PDFDocument.load(await file.arrayBuffer());
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const sigPage = pdf.getPage(pdf.getPageCount() - 1);
      const img = await pdf.embedPng(landlordSig);
      const lineY = (LETTER_H_MM - (SIG_FIRST_Y_MM + SIG_STEP_MM * signers.length + SIG_LANDLORD_GAP_MM)) * PT;
      const scale = Math.min(190 / img.width, 40 / img.height);
      sigPage.drawImage(img, { x: SIG_X_MM * PT, y: lineY + 2, width: img.width * scale, height: img.height * scale });
      sigPage.drawText(`Signed ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`, { x: 330, y: lineY + 3, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
      const signingPath = `${lease.id}/${Date.now()}_for_signing.pdf`;
      const { error: upErr } = await supa.storage.from(BUCKET).upload(signingPath, await pdf.save(), { contentType: 'application/pdf' });
      if (upErr) return json({ error: 'could not store the PDF: ' + upErr.message }, 500);
      // List it on the lease as the working copy; a temporary draft is replaced by it
      await supa.from('rental_lease_files').delete().eq('lease_id', lease.id).eq('kind', 'signing');
      await supa.from('rental_lease_files').insert({ lease_id: lease.id, kind: 'signing', storage_path: signingPath,
        file_name: `Lease_${String(lease.tenant_names || '').replace(/[^A-Za-z0-9]+/g, '_')}_${lease.lease_start}_in_signing.pdf` });
      if (gen.kind === 'draft') {
        await supa.from('rental_lease_files').delete().eq('id', gen.id);
        await supa.storage.from(BUCKET).remove([gen.storage_path]);
      }

      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
      signers.push({ lease_id: lease.id, role: 'landlord', name: settings.name, email: settings.email, tenant_index: null, status: 'signed', stamped: true,
        signed_at: new Date().toISOString(), signed_ip: ip, signed_agent: (req.headers.get('user-agent') || '').slice(0, 300),
        signature_png: landlordSig, initials_png: String(body.landlord_initials_png || '') || null, viewed_at: new Date().toISOString() });

      await supa.from('rental_lease_signers').delete().eq('lease_id', lease.id);
      const { data: rows, error } = await supa.from('rental_lease_signers').insert(signers).select();
      if (error) return json({ error: error.message }, 500);
      await supa.from('rental_leases').update({ signing_status: 'sent', signing_pdf_path: signingPath, signing_base_path: signingPath }).eq('id', lease.id);

      const problems: string[] = [];
      let sent = 0;
      for (const s of (rows || []).filter((r: any) => r.role === 'tenant')) {
        try { await sendInvite(supa, settings, lease, s, siteUrl); await supa.from('rental_lease_signers').update({ sent_at: new Date().toISOString() }).eq('id', s.id); sent++; }
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

async function sendInvite(supa: any, settings: any, lease: any, s: any, siteUrl: string) {
  const link = `${siteUrl}/sign.html?t=${s.token}`;
  const who = `${settings.name} has signed and sent you the lease for ${lease.property_address} to review and sign.`;
  const html = `<p>Hi ${esc(s.name)},</p>
<p>${esc(who)}</p>
<p><a href="${link}" style="display:inline-block;background:#1e40af;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Review and sign the lease</a></p>
<p>Or copy this link: ${link}</p>
<p>Lease term: ${esc(lease.lease_start)} to ${esc(lease.lease_end)}. Rent: $${esc(String(lease.rent_amount))}/month.</p>
<p>It takes a few minutes: set up your signature once, read the lease, and tap each "Initial" and "Sign" spot. Everyone gets the signed copy by email once all tenants have signed.</p>
<p>Questions? Just reply to this email.</p>`;
  await sendGmail(supa, settings.email, s.email, `Lease to sign: ${lease.property_address}`, html);
}

// ---------------------------------------------------------------------------
// Draw one signer's signature (and, for tenants, initials) onto the PDF.
async function stampSigner(pdf: any, s: any, tenantCount: number) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const sigPage = pages[pages.length - 1];
  const yPt = (mm: number) => (LETTER_H_MM - mm) * PT;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const place = async (page: any, dataUrl: string, x: number, yBottom: number, maxW: number, maxH: number) => {
    const img = await pdf.embedPng(dataUrl);
    const scale = Math.min(maxW / img.width, maxH / img.height);
    page.drawImage(img, { x, y: yBottom, width: img.width * scale, height: img.height * scale });
  };
  if (!s.signature_png) return;
  const lineY = s.role === 'landlord'
    ? yPt(SIG_FIRST_Y_MM + SIG_STEP_MM * tenantCount + SIG_LANDLORD_GAP_MM)
    : yPt(SIG_FIRST_Y_MM + SIG_STEP_MM * (s.tenant_index ?? 0));
  await place(sigPage, s.signature_png, SIG_X_MM * PT, lineY + 2, 190, 40);
  sigPage.drawText(`Signed ${fmt(s.signed_at || new Date().toISOString())}`, { x: 330, y: lineY + 3, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
  if (s.role === 'tenant' && s.initials_png) {
    const idx = Math.min(s.tenant_index ?? 0, INITIAL_X.length - 1);
    for (const [mi, y] of INITIAL_LINES) {
      const page = pages[mi + 1];
      if (page) await place(page, s.initials_png, INITIAL_X[idx] + 2, y + 1, 44, 20);
    }
  }
}

// Final PDF: anyone not stamped yet, plus a signing record page. Then stored
// on the lease and emailed.
// The PDF as it stands: the landlord-signed base with every signed tenant
// stamped on. Leases sent before the base was recorded fall back to the last
// working copy plus whoever isn't stamped yet.
async function workingCopy(supa: any, lease: any, signers: any[]) {
  const tenants = signers.filter((s) => s.role === 'tenant');
  tenants.forEach((t, i) => { if (t.tenant_index == null) t.tenant_index = i; });   // rows from before v2
  const basePath = lease.signing_base_path || lease.signing_pdf_path;
  if (!basePath) throw new Error('no PDF on this lease');
  const { data: file, error } = await supa.storage.from(BUCKET).download(basePath);
  if (error || !file) throw new Error('could not read the lease PDF: ' + (error?.message || ''));
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const fromBase = !!lease.signing_base_path;
  for (const s of signers) {
    if (s.status !== 'signed' || !s.signature_png) continue;
    if (fromBase ? s.role === 'tenant' : !s.stamped) await stampSigner(pdf, s, tenants.length);
  }
  return pdf;
}

async function finalize(supa: any, lease: any, signers: any[], settings: any[]) {
  const pdf = await workingCopy(supa, lease, signers);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Signing record
  const rec = pdf.addPage([612, 792]);
  let y = 740;
  rec.drawText('SIGNING RECORD', { x: 54, y, size: 14, font: bold }); y -= 22;
  rec.drawText(`Lease: ${lease.property_address}, ${lease.lease_start} to ${lease.lease_end}`, { x: 54, y, size: 10, font }); y -= 14;
  rec.drawText('Each party reviewed the full lease online and signed electronically (drawn or typed signature and initials),', { x: 54, y, size: 9, font }); y -= 12;
  rec.drawText('after agreeing to sign electronically. Details of each signature:', { x: 54, y, size: 9, font }); y -= 22;
  for (const s of signers) {
    rec.drawText(`${s.name} (${s.role})`, { x: 54, y, size: 10, font: bold }); y -= 13;
    rec.drawText(`Email: ${s.email}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Signed: ${new Date(s.signed_at).toUTCString()}${s.role === 'tenant' && s.tags_done ? `   (tapped ${s.tags_done} initial/signature spots)` : ''}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Link opened: ${s.viewed_at ? new Date(s.viewed_at).toUTCString() : 'n/a'}   IP: ${s.signed_ip || 'n/a'}`, { x: 70, y, size: 9, font }); y -= 12;
    rec.drawText(`Device: ${(s.signed_agent || 'n/a').slice(0, 95)}${s.id_path ? '   ID photo: on file' : ''}`, { x: 70, y, size: 8, font, color: rgb(0.3, 0.3, 0.3) }); y -= 20;
  }
  rec.drawText(`Record generated ${new Date().toUTCString()}`, { x: 54, y, size: 8, font, color: rgb(0.4, 0.4, 0.4) });

  const bytes = await pdf.save();
  const fileName = `Signed_Lease_${String(lease.tenant_names || '').replace(/[^A-Za-z0-9]+/g, '_')}_${lease.lease_start}.pdf`;
  const path = `${lease.id}/${Date.now()}_${fileName}`;
  const { error: upErr } = await supa.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf' });
  if (upErr) throw new Error('could not store signed PDF: ' + upErr.message);
  await supa.from('rental_lease_files').insert({ lease_id: lease.id, kind: 'signed', file_name: fileName, storage_path: path });
  await supa.from('rental_lease_files').delete().eq('lease_id', lease.id).eq('kind', 'signing');
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
