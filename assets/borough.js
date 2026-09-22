// Rentals → Borough tab: East Stroudsburg rental registration paperwork.
// Uses the page's globals from rentals.html: supabaseClient, landlord,
// groupLeasesByUnit, originalLeaseFor, showAlert, LEASE_BUCKET, ESign, JSZip, PDFLib.
// Form filling itself lives in assets/borough-forms.js.

const BOROUGH = {
    name: 'Borough of East Stroudsburg',
    officer: 'Sue Balmoos', officerTitle: 'Code Enforcement Officer · Rental & Resale Inspector',
    phone: '570-421-8300 ext. 117', email: 'sue.balmoos@eaststroudsburgboro.org',
    submitEmail: 'rental@eaststroudsburgboro.org',
    address: '24 Analomink Street, East Stroudsburg, PA 18301',
    hours: 'Public hours: Thursdays 12:00–2:00 pm',
    website: 'https://www.eaststroudsburgboro.org/',
};
const BOROUGH_FORMS_DIR = 'assets/borough/';
const BOROUGH_FORMS = [
    { file: 'Rental-Registration-2027.pdf', name: 'Registration for Residential Rental License (2027)', note: 'The main 3-page form. One per unit, every year.', fill: 'registration' },
    { file: 'Addendum-to-Lease.pdf', name: 'Addendum to Lease', note: 'Signed by you and every tenant. Goes with the registration (or send last year\'s signed copy if the tenants are the same).', fill: 'addendum' },
    { file: 'Affidavit-of-Same-Tenants.pdf', name: 'Affidavit of Same Tenants', note: 'Only when the same tenants stayed all year. Attach the Addendum they signed before.', fill: 'same' },
    { file: 'Affidavit-of-Vacant-Unit.pdf', name: 'Affidavit of Vacant Unit', note: 'Only for an empty unit. Send an Addendum within 10 days of someone moving in.', fill: 'vacant' },
    { file: 'Tips-and-Tricks-Rental-Registration.pdf', name: 'Tips & Tricks (from Sue)', note: 'How to fill the packet so it is not sent back: type it, no blanks (write N/A), employer is the business name.' },
    { file: 'Rental-License-FAQ.pdf', name: 'Rental License FAQ' },
    { file: 'Rental-Inspection-Checklist.pdf', name: 'Rental Inspection Checklist', note: 'What the inspector looks for.' },
    { file: '12-Top-Inspection-Findings.pdf', name: '12 Top Inspection Findings' },
    { file: 'New-Rental-License-Application.pdf', name: 'Rental License Application (2026 version)', note: 'Last year\'s form, kept for reference.' },
];
// Registration packet for license year Y is due October 1 of the year before.
const BOROUGH_DEFAULT_YEAR = 2027;
const boroughDueDate = (year) => `${year - 1}-10-01`;
const BOROUGH_STATUS = { todo: 'Not started', ready: 'Ready to send', submitted: 'Sent to Borough', licensed: 'License received' };
const BOROUGH_OCC = { same: 'Same tenants as last year', new: 'New tenants this year', vacant: 'Vacant' };

// Answers that are the same for every unit in the Courtland building unless
// Unit details says otherwise (from Colette, Sept 2026).
const BOROUGH_UNIT_DEFAULTS = {
    units_in_building: '4', bedrooms: '2', bathrooms: '1',
    meters_water: '1', meters_electric: '5', meters_garbage: '4',
    license_active: 'yes', license_displayed: 'no', evac_plan: 'no', smoke_detectors: 'yes',
    last_inspection: '2026-06-16', disruptive: '0',
};
const BOROUGH_SIGN_FN = () => Auth.client.supabaseUrl + '/functions/v1/borough-sign';
const BOROUGH_SITE_URL = () => location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '').replace(/\/+$/, '');
let boroughSigners = {};        // filing_id -> [rental_borough_signers]

let boroughYear = BOROUGH_DEFAULT_YEAR;
let boroughUnits = [];          // rental_properties rows (units only)
let boroughLeases = [];         // rental_leases rows (not deleted)
let boroughFilings = {};        // property_id -> rental_borough_filings row
let boroughFiles = {};          // filing_id -> [rental_borough_files]
let boroughInfo = { owner: {}, manager: {}, managerSameAsOwner: true };   // rental_settings key 'borough_info'
let boroughSetupError = '';

function boroughDaysLeft(year) {
    const due = new Date(boroughDueDate(year) + 'T23:59:59');
    return Math.ceil((due - new Date()) / 86400000);
}
function boroughEsc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function boroughFmt(iso) { return BoroughForms.fmtDate(iso); }

// ---------- loading ----------
async function loadBorough() {
    boroughSetupError = '';
    document.getElementById('borough-year').value = boroughYear;
    renderBoroughHeader();
    renderBoroughFormsList();
    try {
        const [props, leases, settings] = await Promise.all([
            supabaseClient.from('rental_properties').select('*').eq('is_building_level', false).eq('status', 'active').order('property_name'),
            supabaseClient.from('rental_leases').select('*').is('deleted_at', null).order('lease_start', { ascending: false }),
            supabaseClient.from('rental_settings').select('key,value').eq('key', 'borough_info').maybeSingle(),
        ]);
        if (props.error) throw props.error;
        if (leases.error) throw leases.error;
        boroughUnits = props.data || [];
        boroughLeases = leases.data || [];
        if (settings.data && settings.data.value) { try { boroughInfo = Object.assign({ owner: {}, manager: {}, managerSameAsOwner: true }, JSON.parse(settings.data.value)); } catch (_) { } }
        if (boroughUnits.length && boroughUnits[0].borough_info === undefined) boroughSetupError = 'Run supabase/migrations/021_borough_registration.sql in Supabase → SQL Editor to save unit details and track what was sent.';
    } catch (e) {
        showAlert('Could not load rentals: ' + e.message, 'error');
        return;
    }
    await loadBoroughFilings();
    renderBoroughInfoForm();
    renderBoroughUnits();
}
async function loadBoroughFilings() {
    boroughFilings = {}; boroughFiles = {};
    try {
        const { data, error } = await supabaseClient.from('rental_borough_filings').select('*').eq('year', boroughYear);
        if (error) throw error;
        for (const f of data || []) boroughFilings[f.property_id] = f;
        const ids = (data || []).map(f => f.id);
        if (ids.length) {
            const { data: files } = await supabaseClient.from('rental_borough_files').select('*').in('filing_id', ids).order('created_at', { ascending: false });
            for (const fl of files || []) (boroughFiles[fl.filing_id] = boroughFiles[fl.filing_id] || []).push(fl);
            boroughSigners = {};
            const { data: signers } = await supabaseClient.from('rental_borough_signers').select('id,filing_id,role,name,email,status,sent_at,viewed_at,signed_at').in('filing_id', ids).order('id');
            for (const sg of signers || []) (boroughSigners[sg.filing_id] = boroughSigners[sg.filing_id] || []).push(sg);
        }
    } catch (e) {
        boroughSetupError = boroughSetupError || 'Run supabase/migrations/021_borough_registration.sql in Supabase → SQL Editor to save unit details and track what was sent.';
    }
}
function changeBoroughYear(v) { boroughYear = parseInt(v, 10) || BOROUGH_DEFAULT_YEAR; loadBorough(); }

// ---------- header, contact, forms list ----------
function renderBoroughHeader() {
    const days = boroughDaysLeft(boroughYear);
    const due = boroughFmt(boroughDueDate(boroughYear));
    const el = document.getElementById('borough-deadline');
    const tone = days < 0 ? ['#fee2e2', '#991b1b'] : days <= 14 ? ['#fef3c7', '#92400e'] : ['#dcfce7', '#166534'];
    el.style.background = tone[0]; el.style.color = tone[1];
    el.innerHTML = `<strong style="font-size:16px;">${boroughYear} Rental Registration packet due ${due}</strong><br>
        <span>${days < 0 ? `${-days} day(s) overdue` : days === 0 ? 'Due today' : `${days} day(s) left`} · email the packet to <a href="mailto:${BOROUGH.submitEmail}?subject=${encodeURIComponent(boroughYear + ' Rental Registration packet')}" style="color:inherit;">${BOROUGH.submitEmail}</a> (preferred) or drop it at ${BOROUGH.address}</span>`;
    document.getElementById('borough-contact').innerHTML = `
        <div><strong>${BOROUGH.officer}</strong> · ${BOROUGH.officerTitle}</div>
        <div>📞 ${BOROUGH.phone} &nbsp; ✉️ <a href="mailto:${BOROUGH.email}">${BOROUGH.email}</a></div>
        <div>🏛 ${BOROUGH.name}, ${BOROUGH.address} · ${BOROUGH.hours} · <a href="${BOROUGH.website}" target="_blank" rel="noopener">website</a></div>
        <ul style="margin:8px 0 0 18px;padding:0;color:var(--text-secondary);font-size:13px;">
            <li>License fee is $90 per unit. Tell the Borough within 10 days when tenants change.</li>
            <li>You or your representative (never the tenant) must be at inspections. A missed inspection costs $129 per unit.</li>
            <li>Type the forms, leave nothing blank (write N/A), sign everything. Sue sends packets back otherwise.</li>
        </ul>`;
}
function renderBoroughFormsList() {
    document.getElementById('borough-forms').innerHTML = BOROUGH_FORMS.map(f => `
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
            <div><a href="${BOROUGH_FORMS_DIR}${f.file}" target="_blank" rel="noopener"><strong>${f.name}</strong></a>${f.note ? `<div style="font-size:13px;color:var(--text-secondary);">${f.note}</div>` : ''}</div>
            <a class="action-btn btn-secondary" style="text-decoration:none;" href="${BOROUGH_FORMS_DIR}${f.file}" download>⬇ Blank</a>
        </div>`).join('');
}

// ---------- owner / manager details (rental_settings 'borough_info') ----------
function renderBoroughInfoForm() {
    const o = boroughInfo.owner || {}, m = boroughInfo.manager || {};
    const same = boroughInfo.managerSameAsOwner !== false;
    const inp = (id, label, val, ph) => `<div class="form-group"><label>${label}</label><input id="bi-${id}" value="${boroughEsc(val)}" placeholder="${boroughEsc(ph || '')}"></div>`;
    document.getElementById('borough-info-form').innerHTML = `
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">Owner name, phone and email come from <em>Landlord contact</em> on the New Lease page (${boroughEsc(landlord.name)} · ${boroughEsc(landlord.phone)} · ${boroughEsc(landlord.email)}). Fill in the rest once; it prints on every form.</div>
        <div class="form-grid">
            ${inp('owner_mailing1', 'Owner mailing address (line 1)', o.mailing1, 'Street')}
            ${inp('owner_mailing2', 'Owner mailing address (line 2)', o.mailing2, 'City, State ZIP')}
            ${inp('owner_contact', 'Contact name (only if the owner is a company)', o.contact, 'N/A')}
            ${inp('tenant_address', 'Address tenants see on the Addendum', o.tenantAddress, 'Leave blank to use the mailing address')}
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-top:-6px;">Tenants only ever see the 2-page Addendum. The Registration form and affidavits go to the Borough alone. The Addendum lists a contact address for the manager; use a PO box or the building's address here if you'd rather not show your home address.</div>
        <label style="display:flex;align-items:center;gap:8px;margin:12px 0;"><input type="checkbox" id="bi-same" ${same ? 'checked' : ''} onchange="document.getElementById('bi-mgr').style.display = this.checked ? 'none' : 'block'"> I manage the property myself (use my details as Property Manager)</label>
        <div id="bi-mgr" style="display:${same ? 'none' : 'block'};">
            <div class="form-grid">
                ${inp('mgr_name', 'Property manager name', m.name)}
                ${inp('mgr_email', 'Manager email', m.email)}
                ${inp('mgr_mailing1', 'Manager mailing address (line 1)', m.mailing1)}
                ${inp('mgr_mailing2', 'Manager mailing address (line 2)', m.mailing2)}
                ${inp('mgr_physical1', 'Manager physical address (line 1, not a PO box)', m.physical1)}
                ${inp('mgr_physical2', 'Manager physical address (line 2)', m.physical2)}
                ${inp('mgr_day_phone', 'Daytime phone', m.dayPhone)}
                ${inp('mgr_phone24', '24-hour phone', m.phone24)}
                ${inp('mgr_local_contact', 'Local contact name', m.localContact)}
            </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">
            <button class="btn btn-primary" onclick="saveBoroughInfo()">Save details</button>
            <button class="btn btn-secondary" onclick="setupBoroughSignature()">${landlord.signature_png ? '✍️ Change my signature & initials' : '✍️ Set up my signature & initials'}</button>
            <span style="font-size:13px;color:var(--text-secondary);">${landlord.signature_png ? 'Saved signature will be placed on the forms.' : 'No saved signature yet: forms come out unsigned.'}</span>
        </div>`;
}
async function saveBoroughInfo() {
    const v = (id) => (document.getElementById('bi-' + id) || {}).value?.trim() || '';
    boroughInfo = {
        owner: { mailing1: v('owner_mailing1'), mailing2: v('owner_mailing2'), contact: v('owner_contact'), tenantAddress: v('tenant_address') },
        managerSameAsOwner: document.getElementById('bi-same').checked,
        manager: { name: v('mgr_name'), email: v('mgr_email'), mailing1: v('mgr_mailing1'), mailing2: v('mgr_mailing2'), physical1: v('mgr_physical1'), physical2: v('mgr_physical2'), dayPhone: v('mgr_day_phone'), phone24: v('mgr_phone24'), localContact: v('mgr_local_contact') },
    };
    const { error } = await supabaseClient.from('rental_settings').upsert([{ key: 'borough_info', value: JSON.stringify(boroughInfo) }], { onConflict: 'key' });
    if (error) showAlert('Could not save: ' + error.message + ' (run migration 015?)', 'error');
    else showAlert('Owner details saved.', 'success');
}
async function setupBoroughSignature() {
    const r = await ESign.adopt({ name: landlord.name, saved: landlord.signature_png ? { signature_png: landlord.signature_png, initials_png: landlord.initials_png } : null });
    if (!r) return;
    landlord.signature_png = r.signature_png;
    if (r.initials_png) landlord.initials_png = r.initials_png;
    const rows = [{ key: 'landlord_signature_png', value: r.signature_png }];
    if (r.initials_png) rows.push({ key: 'landlord_initials_png', value: r.initials_png });
    await supabaseClient.from('rental_settings').upsert(rows, { onConflict: 'key' });
    renderBoroughInfoForm();
}

// ---------- units ----------
// Only units inside the Borough of East Stroudsburg register there. Guessed
// from the address (the Courtland building); Unit details can override.
function boroughIsBoroughUnit(u) {
    const flag = (u.borough_info || {}).in_borough;
    if (flag === 'yes') return true;
    if (flag === 'no') return false;
    return /courtland/i.test(`${u.property_name || ''} ${u.street_address || ''}`) || /east\s*stroudsburg/i.test(u.city || '');
}
async function setBoroughUnitFlag(propertyId, inBorough) {
    const u = boroughUnits.find(x => x.id === propertyId); if (!u) return;
    const info = Object.assign({}, u.borough_info || {}, { in_borough: inBorough ? 'yes' : 'no' });
    const { error } = await supabaseClient.from('rental_properties').update({ borough_info: info }).eq('id', propertyId);
    if (error) { showAlert('Could not save: ' + error.message + ' (run migration 021?)', 'error'); return; }
    u.borough_info = info; renderBoroughUnits();
}
function boroughCurrentLease(unit) {
    const key = (unit.property_name || '').trim().toLowerCase();
    const g = groupLeasesByUnit(boroughLeases).find(g => (g.current.property_address || '').trim().toLowerCase() === key);
    if (!g) return null;
    return g.current.status === 'active' ? g.current : null;
}
function boroughGuessOccupancy(unit, lease) {
    if (!lease) return 'vacant';
    const first = originalLeaseFor(lease);
    return (first.lease_start || '') < boroughDueDate(boroughYear - 1) ? 'same' : 'new';
}
function boroughTenants(lease) {
    const out = [];
    if (!lease) return out;
    for (let i = 1; i <= 4; i++) if (lease[`tenant${i}_name`]) out.push({ name: lease[`tenant${i}_name`], phone: lease[`tenant${i}_phone`], email: lease[`tenant${i}_email`], employer: lease[`tenant${i}_employer`] });
    if (!out.length && lease.tenant_names) out.push({ name: lease.tenant_names, phone: lease.tenant_phone, email: lease.tenant_email, employer: lease.tenant_employer });
    return out;
}
function renderBoroughUnits() {
    const box = document.getElementById('borough-units');
    document.getElementById('borough-setup-note').innerHTML = boroughSetupError ? `<div class="alert alert-error" style="display:block;">${boroughEsc(boroughSetupError)}</div>` : '';
    if (!boroughUnits.length) { box.innerHTML = '<p style="color:var(--text-secondary);">No units yet. Add properties on the New Lease page first.</p>'; return; }
    const inBorough = boroughUnits.filter(boroughIsBoroughUnit);
    const outside = boroughUnits.filter(u => !boroughIsBoroughUnit(u));
    let sent = 0;
    const rows = inBorough.map(u => {
        const lease = boroughCurrentLease(u);
        const filing = boroughFilings[u.id] || {};
        const occ = filing.occupancy || boroughGuessOccupancy(u, lease);
        const status = filing.status || 'todo';
        if (status === 'submitted' || status === 'licensed') sent++;
        const tenants = boroughTenants(lease).map(t => t.name).join(', ') || '<em>vacant</em>';
        const fileLabel = { packet: '📄', signing: '✍️', sent: '📎', license: '🪪', other: '📎' };
        const files = (boroughFiles[filing.id] || []).map(f => `<div>${fileLabel[f.kind] || '📎'} <a href="#" onclick="openLeaseFile('${f.storage_path}');return false;">${boroughEsc(f.file_name)}</a> <small>${(f.created_at || '').slice(0, 10)}</small> <a href="#" onclick="removeBoroughFile(${f.id}, '${f.storage_path}');return false;" style="color:var(--danger);">✕</a></div>`).join('');
        const info = Object.assign({}, BOROUGH_UNIT_DEFAULTS, u.borough_info || {});
        const missing = [!info.pin && 'PIN/Tax ID', !boroughInfo.owner?.mailing1 && 'your mailing address (Owner details below)'].filter(Boolean);
        const forms = occ === 'vacant'
            ? `<button class="action-btn btn-secondary" onclick="boroughDownload(${u.id}, 'registration')">Registration</button> <button class="action-btn btn-secondary" onclick="boroughDownload(${u.id}, 'vacant')">Vacant affidavit</button>`
            : `<button class="action-btn btn-secondary" onclick="boroughDownload(${u.id}, 'registration')">Registration</button> <button class="action-btn btn-secondary" onclick="boroughDownload(${u.id}, 'addendum')">Addendum</button>${occ === 'same' ? ` <button class="action-btn btn-secondary" onclick="boroughDownload(${u.id}, 'same')">Same-tenants affidavit</button>` : ''}`;
        return `<div class="card" style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start;">
                <div>
                    <div style="font-weight:600;font-size:15px;">${boroughEsc(u.property_name)}</div>
                    <div style="font-size:13px;color:var(--text-secondary);">Tenants now: ${tenants}${lease ? ` · lease ${lease.lease_start} → ${lease.lease_end}` : ''}</div>
                    ${missing.length ? `<div style="font-size:12px;color:#92400e;margin-top:4px;">Missing for the form: ${missing.join(', ')} → <a href="#" onclick="openBoroughUnit(${u.id});return false;">Unit details</a></div>` : ''}
                    <div style="font-size:11px;margin-top:2px;"><a href="#" onclick="setBoroughUnitFlag(${u.id}, false);return false;" style="color:var(--text-secondary);">Not in East Stroudsburg? Leave it out</a></div>
                </div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                    <select onchange="saveBoroughFiling(${u.id}, { occupancy: this.value })" style="padding:6px;border:1px solid var(--border);border-radius:4px;">
                        ${Object.entries(BOROUGH_OCC).map(([k, v]) => `<option value="${k}" ${k === occ ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                    <select onchange="saveBoroughFiling(${u.id}, { status: this.value })" style="padding:6px;border:1px solid var(--border);border-radius:4px;">
                        ${Object.entries(BOROUGH_STATUS).map(([k, v]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                </div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;">
                <button class="action-btn btn-primary" onclick="boroughDownload(${u.id}, 'packet')">⬇ Filled packet (zip)</button>
                ${forms}
                <button class="action-btn btn-secondary" onclick="openBoroughUnit(${u.id})">Unit details</button>
                <label class="action-btn btn-secondary" style="cursor:pointer;">📎 Attach what was sent / the license
                    <input type="file" accept="application/pdf,image/*" style="display:none;" onchange="attachBoroughFile(${u.id}, this)"></label>
            </div>
            ${renderBoroughSigning(u, filing, occ)}
            ${files ? `<div style="font-size:13px;margin-top:8px;">${files}</div>` : ''}
        </div>`;
    });
    box.innerHTML = `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">${sent} of ${inBorough.length} East Stroudsburg unit(s) sent for ${boroughYear}. Pick what applies to each unit, check <em>Unit details</em>, then Sign & send.</div>`
        + (inBorough.length ? rows.join('') : '<p style="color:var(--text-secondary);">No units marked as East Stroudsburg.</p>')
        + (outside.length ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">Not in the Borough (no registration needed): ${outside.map(u => `${boroughEsc(u.property_name)} <a href="#" onclick="setBoroughUnitFlag(${u.id}, true);return false;">include</a>`).join(' · ')}</div>` : '');
}
async function saveBoroughFiling(propertyId, patch) {
    const existing = boroughFilings[propertyId];
    const lease = boroughCurrentLease(boroughUnits.find(u => u.id === propertyId));
    const row = Object.assign({ year: boroughYear, property_id: propertyId, occupancy: existing?.occupancy || boroughGuessOccupancy(boroughUnits.find(u => u.id === propertyId), lease), status: existing?.status || 'todo' }, patch, { updated_at: new Date().toISOString() });
    if (patch.status === 'submitted' && !existing?.submitted_on) row.submitted_on = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseClient.from('rental_borough_filings').upsert([row], { onConflict: 'year,property_id' }).select().single();
    if (error) { showAlert('Could not save: ' + error.message + ' (run migration 021?)', 'error'); return null; }
    boroughFilings[propertyId] = data;
    renderBoroughUnits();
    return data;
}
async function attachBoroughFile(propertyId, input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
        const filing = boroughFilings[propertyId] || await saveBoroughFiling(propertyId, {});
        if (!filing) return;
        const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
        const path = `borough/${boroughYear}/${propertyId}/${Date.now()}_${safe}`;
        const { error } = await supabaseClient.storage.from(LEASE_BUCKET).upload(path, file, { upsert: false });
        if (error) throw error;
        const { error: e2 } = await supabaseClient.from('rental_borough_files').insert([{ filing_id: filing.id, kind: 'sent', file_name: file.name, storage_path: path }]);
        if (e2) throw e2;
        await loadBoroughFilings(); renderBoroughUnits();
    } catch (e) { showAlert('Upload failed: ' + e.message, 'error'); }
}
async function removeBoroughFile(id, path) {
    if (!confirm('Remove this file?')) return;
    await supabaseClient.storage.from(LEASE_BUCKET).remove([path]);
    await supabaseClient.from('rental_borough_files').delete().eq('id', id);
    await loadBoroughFilings(); renderBoroughUnits();
}

// ---------- unit details (rental_properties.borough_info) ----------
function openBoroughUnit(propertyId) {
    const u = boroughUnits.find(x => x.id === propertyId); if (!u) return;
    const lease = boroughCurrentLease(u);
    const info = Object.assign({}, BOROUGH_UNIT_DEFAULTS, u.borough_info || {});
    const pets = lease ? (parseInt(lease.num_cats, 10) || 0) + (parseInt(lease.num_dogs, 10) || 0) : 0;
    const modal = document.getElementById('lease-modal');
    modal.style.display = 'flex';
    document.getElementById('lm-title').textContent = `${u.property_name} · Borough details`;
    const inp = (id, label, val, type, ph) => `<div class="form-group"><label>${label}</label><input id="bu-${id}" type="${type || 'text'}" value="${boroughEsc(val)}" placeholder="${boroughEsc(ph || '')}"></div>`;
    const yn = (id, label, val) => `<div class="form-group"><label>${label}</label><select id="bu-${id}"><option value="">—</option><option value="yes" ${val === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${val === 'no' ? 'selected' : ''}>No</option></select></div>`;
    document.getElementById('lm-body').innerHTML = `
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">Address on the form: <strong>${boroughEsc(u.street_address || u.property_name)}${u.unit ? ', Unit ' + boroughEsc(u.unit) : ''}</strong>${u.city ? `, ${boroughEsc(u.city)}, ${boroughEsc(u.state || 'PA')} ${boroughEsc(u.zip || '')}` : ''} (edit the property on the New Lease page to change it).</div>
        <div class="form-grid">
            ${inp('pin', 'Property PIN (Map ID#) and/or Tax ID', info.pin)}
            ${inp('last_inspection', 'Date of last inspection', info.last_inspection, 'date')}
            ${inp('units_in_building', 'This unit is one of how many units in the building', info.units_in_building, 'number')}
            ${inp('occupants', 'Total people living here (incl. children)', info.occupants ?? (lease ? boroughTenants(lease).length : 0), 'number')}
            ${inp('bedrooms', 'Legal bedrooms', info.bedrooms ?? u.bedrooms ?? '', 'number')}
            ${inp('bathrooms', 'Legal bathrooms', info.bathrooms ?? u.bathrooms ?? '', 'number')}
            ${inp('meters_water', 'Water meters/accounts for the property', info.meters_water, 'number')}
            ${inp('meters_electric', 'Electric meters/accounts', info.meters_electric, 'number')}
            ${inp('meters_garbage', 'Garbage accounts', info.meters_garbage, 'number')}
            ${yn('license_active', 'Active rental license for this unit?', info.license_active)}
            ${yn('license_displayed', 'License displayed in the unit?', info.license_displayed)}
            ${yn('evac_plan', 'Evacuation plan posted in the unit?', info.evac_plan)}
            ${yn('smoke_detectors', 'Interconnected smoke detectors working?', info.smoke_detectors)}
            ${inp('pets_count', 'Number of pets', info.pets_count ?? pets, 'number')}
            ${inp('pets_breeds', 'Pet breed(s)', info.pets_breeds)}
            ${inp('disruptive', 'Disruptive Conduct Reports pending (Addendum item F)', info.disruptive ?? 0, 'number')}
            ${inp('lease_signed_on', 'Date the original lease was signed (Addendum)', info.lease_signed_on || (lease && originalLeaseFor(lease).lease_start) || '', 'date')}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;"><button class="btn btn-primary" onclick="saveBoroughUnit(${u.id})">Save</button><button class="btn btn-secondary" onclick="closeLeaseModal()">Cancel</button></div>`;
}
async function saveBoroughUnit(propertyId) {
    const v = (id) => (document.getElementById('bu-' + id) || {}).value?.trim() ?? '';
    const info = {};
    for (const k of ['pin', 'last_inspection', 'units_in_building', 'occupants', 'bedrooms', 'bathrooms', 'meters_water', 'meters_electric', 'meters_garbage', 'license_active', 'license_displayed', 'evac_plan', 'smoke_detectors', 'pets_count', 'pets_breeds', 'disruptive', 'lease_signed_on']) info[k] = v(k);
    const { error } = await supabaseClient.from('rental_properties').update({ borough_info: info }).eq('id', propertyId);
    if (error) { showAlert('Could not save: ' + error.message + ' (run migration 021?)', 'error'); return; }
    const u = boroughUnits.find(x => x.id === propertyId); if (u) u.borough_info = info;
    closeLeaseModal(); renderBoroughUnits();
}

// ---------- filling + download ----------
function boroughFormData(u) {
    const lease = boroughCurrentLease(u);
    const filing = boroughFilings[u.id] || {};
    const occupancy = filing.occupancy || boroughGuessOccupancy(u, lease);
    const info = Object.assign({}, BOROUGH_UNIT_DEFAULTS, u.borough_info || {});
    const tenants = occupancy === 'vacant' ? [] : boroughTenants(lease);
    const owner = { name: landlord.name, phone: landlord.phone, email: landlord.email, mailing1: boroughInfo.owner?.mailing1, mailing2: boroughInfo.owner?.mailing2, contact: boroughInfo.owner?.contact };
    const manager = boroughInfo.managerSameAsOwner === false && boroughInfo.manager?.name
        ? boroughInfo.manager
        : { name: owner.name, email: owner.email, mailing1: owner.mailing1, mailing2: owner.mailing2, physical1: owner.mailing1, physical2: owner.mailing2, dayPhone: owner.phone, phone24: owner.phone, localContact: owner.name };
    const city = u.city ? `${u.city}, ${u.state || 'PA'} ${u.zip || ''}`.trim() : 'East Stroudsburg, PA 18301';
    return {
        date: new Date().toISOString().slice(0, 10),
        address1: u.street_address || u.property_name, address2: city, unit: u.unit || '',
        pin: info.pin, lastInspection: info.last_inspection,
        owner, manager, tenants, vacant: occupancy === 'vacant', occupancy,
        unitsInBuilding: info.units_in_building, occupants: info.occupants || tenants.length,
        bedrooms: info.bedrooms || u.bedrooms, bathrooms: info.bathrooms || u.bathrooms,
        meters: { water: info.meters_water, electric: info.meters_electric, garbage: info.meters_garbage },
        answers: { license_active: info.license_active, license_displayed: info.license_displayed, evac_plan: info.evac_plan, smoke_detectors: info.smoke_detectors },
        pets: { count: info.pets_count ?? (lease ? (parseInt(lease.num_cats, 10) || 0) + (parseInt(lease.num_dogs, 10) || 0) : 0), breeds: info.pets_breeds },
        maxOccupants: 4, disruptive: info.disruptive,
        leaseSignedOn: info.lease_signed_on || (lease && originalLeaseFor(lease).lease_start) || '',
        tenantContactAddress: boroughInfo.owner?.tenantAddress || '',
        signaturePng: landlord.signature_png || null, initialsPng: landlord.initials_png || null,
    };
}
async function boroughFill(kind, d) {
    const spec = { registration: ['Rental-Registration-2027.pdf', 'registration'], addendum: ['Addendum-to-Lease.pdf', 'addendum'], same: ['Affidavit-of-Same-Tenants.pdf', 'affidavitSame'], vacant: ['Affidavit-of-Vacant-Unit.pdf', 'affidavitVacant'] }[kind];
    const bytes = await fetch(BOROUGH_FORMS_DIR + spec[0]).then(r => { if (!r.ok) throw new Error('form not found: ' + spec[0]); return r.arrayBuffer(); });
    return BoroughForms[spec[1]](PDFLib, bytes, d);
}
function boroughSaveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
}
async function boroughDownload(propertyId, kind) {
    const u = boroughUnits.find(x => x.id === propertyId); if (!u) return;
    const d = boroughFormData(u);
    const tag = (u.property_name || 'unit').replace(/[^A-Za-z0-9]+/g, '_');
    const names = { registration: `Registration-${boroughYear}`, addendum: 'Addendum-to-Lease', same: 'Affidavit-Same-Tenants', vacant: 'Affidavit-Vacant-Unit' };
    try {
        if (kind !== 'packet') {
            boroughSaveBlob(new Blob([await boroughFill(kind, d)], { type: 'application/pdf' }), `${tag}-${names[kind]}.pdf`);
            return;
        }
        const kinds = d.vacant ? ['registration', 'vacant'] : d.occupancy === 'same' ? ['registration', 'same', 'addendum'] : ['registration', 'addendum'];
        const zip = new JSZip();
        for (const k of kinds) zip.file(`${tag}-${names[k]}.pdf`, await boroughFill(k, d));
        zip.file('README.txt', `${boroughYear} Rental Registration packet for ${u.property_name}\n\nEmail everything to ${BOROUGH.submitEmail} by ${boroughFmt(boroughDueDate(boroughYear))}.\n` +
            (d.occupancy === 'same' ? 'Same tenants: send the Affidavit plus the Addendum they signed last year (if you have it; otherwise have them sign the new Addendum).\n' : d.vacant ? 'Vacant: the license fee is still due if the unit is being advertised.\n' : 'New tenants: every adult must sign the Addendum.\n') +
            `Check every line before sending; Sue returns packets with blanks or missing signatures.\n`);
        boroughSaveBlob(await zip.generateAsync({ type: 'blob' }), `${tag}-Borough-${boroughYear}.zip`);
        if ((boroughFilings[u.id]?.status || 'todo') === 'todo') saveBoroughFiling(u.id, { status: 'ready' });
    } catch (e) { showAlert('Could not build the form: ' + e.message, 'error'); }
}

// ---------- sign & send (borough-sign edge function) ----------
async function callBoroughSign(body) {
    const res = await fetch(BOROUGH_SIGN_FN(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + Auth.bearer() }, body: JSON.stringify(body) });
    let data = {}; try { data = await res.json(); } catch (_) { }
    if (!res.ok || data.error) throw new Error(data.error || ('request failed (' + res.status + ')'));
    return data;
}
function renderBoroughSigning(u, filing, occ) {
    const box = (inner) => `<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:13px;margin-top:10px;">${inner}</div>`;
    const st = filing.signing_status || 'draft';
    if (filing.status === 'submitted' || filing.status === 'licensed') {
        return box(`<strong>✅ Sent to the Borough</strong>${filing.submitted_on ? ' on ' + boroughFmt(filing.submitted_on) : ''}${filing.submitted_to ? ' (' + boroughEsc(filing.submitted_to) + ')' : ''}. ${filing.status === 'licensed' ? 'License received.' : 'Set the status to <em>License received</em> when it arrives.'}`);
    }
    if (occ === 'vacant') {
        return box(`<strong>📤 Vacant unit: nothing for tenants to sign.</strong><div style="color:var(--text-secondary);margin:4px 0 8px;">Sends the Registration and the Affidavit of Vacant Unit, with your saved signature, to ${BOROUGH.submitEmail} with you in copy.</div>
            <button class="action-btn btn-primary" onclick="boroughSubmitNow(${u.id})">Send packet to Borough</button>`);
    }
    if (st === 'draft') {
        const lease = boroughCurrentLease(u);
        const missing = boroughTenants(lease).filter(t => !t.email).map(t => t.name);
        return box(`<strong>✍️ Electronic signing</strong><div style="color:var(--text-secondary);margin:4px 0 8px;">You sign, each tenant gets an email link to read the Addendum and tap "Sign here" on their phone. When the last one signs, the whole packet (Registration${occ === 'same' ? ', Affidavit of Same Tenants' : ''}, signed Addendum) is emailed to ${BOROUGH.submitEmail} with you in copy.</div>
            ${missing.length ? `<div style="color:var(--danger);margin-bottom:8px;">Missing email for: ${boroughEsc(missing.join(', '))}. Add it on the lease first.</div>` : ''}
            <label style="display:flex;gap:8px;align-items:center;margin-bottom:8px;"><input type="checkbox" id="bauto-${u.id}" checked> Email the Borough automatically when everyone has signed</label>
            <button class="action-btn btn-primary" ${missing.length ? 'disabled' : ''} onclick="boroughSendForSignature(${u.id})">Sign & send to tenants</button>`);
    }
    const signers = boroughSigners[filing.id] || [];
    const fmt = (d) => d ? new Date(d).toLocaleDateString() : '';
    const rows = signers.map(s => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);">
        <span>${s.status === 'signed' ? '✅' : (s.viewed_at ? '👀' : '⏳')} <strong>${boroughEsc(s.name)}</strong> · ${boroughEsc(s.email)}<br><small style="color:var(--text-secondary);">${s.status === 'signed' ? 'signed ' + fmt(s.signed_at) : (s.viewed_at ? 'opened ' + fmt(s.viewed_at) + ', not signed yet' : 'sent ' + fmt(s.sent_at))}</small></span>
        ${s.status !== 'signed' && st === 'sent' ? `<button class="action-btn btn-secondary" onclick="boroughRemind(${s.id})">Remind</button>` : ''}</div>`).join('');
    if (st === 'sent') {
        return box(`<strong>✍️ Out for signature</strong><div style="margin-top:6px;">${rows}</div>
            <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;"><button class="action-btn delete-btn" onclick="boroughCancelSigning(${u.id})">Cancel signing</button><span style="color:var(--text-secondary);">Cancel and re-send if something changes.</span></div>`);
    }
    // signed but not yet submitted
    return box(`<strong>✍️ Addendum fully signed</strong><div style="margin-top:6px;">${rows}</div>
        <div style="margin-top:8px;"><button class="action-btn btn-primary" onclick="boroughSubmitNow(${u.id})">Send packet to Borough</button> <span style="color:var(--text-secondary);">Emails everything to ${BOROUGH.submitEmail} with you in copy.</span></div>`);
}
async function ensureBoroughFiling(propertyId) {
    return boroughFilings[propertyId] || await saveBoroughFiling(propertyId, {});
}
async function boroughEnsureSignature() {
    if (landlord.signature_png && landlord.initials_png) return true;
    const r = await ESign.adopt({ name: landlord.name, initials: true, title: 'Sign as landlord', subtitle: 'Goes on the Borough forms and the Addendum before it is sent.', saved: landlord.signature_png ? { signature_png: landlord.signature_png, initials_png: landlord.initials_png } : null });
    if (!r) return false;
    landlord.signature_png = r.signature_png; if (r.initials_png) landlord.initials_png = r.initials_png;
    const rows = [{ key: 'landlord_signature_png', value: r.signature_png }];
    if (r.initials_png) rows.push({ key: 'landlord_initials_png', value: r.initials_png });
    await supabaseClient.from('rental_settings').upsert(rows, { onConflict: 'key' });
    return true;
}
// Fill a form, upload it, and list it on the filing (replacing an older copy with the same name).
async function boroughUploadForm(u, filing, kind, d, fileKind) {
    const names = { registration: `Registration-${boroughYear}`, addendum: 'Addendum-to-Lease', same: 'Affidavit-Same-Tenants', vacant: 'Affidavit-Vacant-Unit' };
    const tag = (u.property_name || 'unit').replace(/[^A-Za-z0-9]+/g, '_');
    const fileName = `${tag}-${names[kind]}.pdf`;
    const bytes = await boroughFill(kind, d);
    const path = `borough/${boroughYear}/${u.id}/${Date.now()}_${fileName}`;
    const { error } = await supabaseClient.storage.from(LEASE_BUCKET).upload(path, new Blob([bytes], { type: 'application/pdf' }), { upsert: false, contentType: 'application/pdf' });
    if (error) throw new Error('upload failed: ' + error.message);
    if (fileKind) {
        const old = (boroughFiles[filing.id] || []).filter(f => f.kind === fileKind && f.file_name === fileName);
        if (old.length) {
            await supabaseClient.from('rental_borough_files').delete().in('id', old.map(f => f.id));
            await supabaseClient.storage.from(LEASE_BUCKET).remove(old.map(f => f.storage_path));
        }
        const { error: e2 } = await supabaseClient.from('rental_borough_files').insert([{ filing_id: filing.id, kind: fileKind, file_name: fileName, storage_path: path }]);
        if (e2) throw new Error(e2.message);
    }
    return path;
}
async function boroughSendForSignature(propertyId) {
    const u = boroughUnits.find(x => x.id === propertyId); if (!u) return;
    try {
        if (!(await boroughEnsureSignature())) return;
        const auto = !!(document.getElementById('bauto-' + propertyId) || {}).checked;
        const filing = await ensureBoroughFiling(propertyId); if (!filing) return;
        const d = boroughFormData(u);
        if (!d.tenants.length) throw new Error('No tenants on the current lease. Mark the unit Vacant instead.');
        showAlert('Building the forms…', 'success');
        await boroughUploadForm(u, filing, 'registration', d, 'packet');
        if (d.occupancy === 'same') await boroughUploadForm(u, filing, 'same', d, 'packet');
        const addendumPath = await boroughUploadForm(u, filing, 'addendum', d, null);
        const r = await callBoroughSign({ action: 'send', filing_id: filing.id, site_url: BOROUGH_SITE_URL(), addendum_path: addendumPath, tenants: d.tenants.map(t => ({ name: t.name, email: t.email })), auto_submit: auto });
        showAlert(`Sent to ${r.sent} tenant${r.sent === 1 ? '' : 's'}.` + (r.problems && r.problems.length ? ' Problems: ' + r.problems.join('; ') : ''), r.problems && r.problems.length ? 'error' : 'success');
    } catch (e) { showAlert('Send failed: ' + e.message, 'error'); }
    await loadBoroughFilings(); renderBoroughUnits();
}
async function boroughSubmitNow(propertyId) {
    const u = boroughUnits.find(x => x.id === propertyId); if (!u) return;
    if (!confirm(`Email the ${boroughYear} packet for ${u.property_name} to ${BOROUGH.submitEmail} now?`)) return;
    try {
        if (!(await boroughEnsureSignature())) return;
        const filing = await ensureBoroughFiling(propertyId); if (!filing) return;
        const d = boroughFormData(u);
        showAlert('Building the forms…', 'success');
        await boroughUploadForm(u, filing, 'registration', d, 'packet');
        if (d.vacant) await boroughUploadForm(u, filing, 'vacant', d, 'packet');
        else if (d.occupancy === 'same') await boroughUploadForm(u, filing, 'same', d, 'packet');
        const r = await callBoroughSign({ action: 'submit', filing_id: filing.id });
        showAlert(`Sent to ${r.sent_to}: ${(r.files || []).join(', ')}`, 'success');
    } catch (e) { showAlert('Send failed: ' + e.message, 'error'); }
    await loadBoroughFilings(); renderBoroughUnits();
}
async function boroughRemind(signerId) {
    try { await callBoroughSign({ action: 'remind', signer_id: signerId, site_url: BOROUGH_SITE_URL() }); showAlert('Reminder sent', 'success'); }
    catch (e) { showAlert('Reminder failed: ' + e.message, 'error'); }
}
async function boroughCancelSigning(propertyId) {
    const filing = boroughFilings[propertyId]; if (!filing) return;
    if (!confirm('Cancel signing? Existing links stop working. You can send again later.')) return;
    try { await callBoroughSign({ action: 'cancel', filing_id: filing.id }); }
    catch (e) { showAlert('Cancel failed: ' + e.message, 'error'); }
    await loadBoroughFilings(); renderBoroughUnits();
}

// ---------- dashboard reminder ----------
async function renderBoroughDashCard() {
    const card = document.getElementById('borough-dash-card'); if (!card) return;
    const year = BOROUGH_DEFAULT_YEAR, days = boroughDaysLeft(year);
    if (days < -60) { card.style.display = 'none'; return; }
    let progress = '';
    try {
        const [{ data: units }, { data: filings }] = await Promise.all([
            supabaseClient.from('rental_properties').select('*').eq('is_building_level', false).eq('status', 'active'),
            supabaseClient.from('rental_borough_filings').select('property_id,status').eq('year', year),
        ]);
        if (units && filings) {
            const mine = units.filter(boroughIsBoroughUnit);
            progress = ` · ${filings.filter(f => mine.some(u => u.id === f.property_id) && (f.status === 'submitted' || f.status === 'licensed')).length} of ${mine.length} unit(s) sent`;
        }
    } catch (_) { }
    const tone = days < 0 ? ['#fee2e2', '#991b1b', '#ef4444'] : days <= 14 ? ['#fef3c7', '#92400e', '#f59e0b'] : ['#eff6ff', '#1e3a8a', '#3b82f6'];
    card.style.display = 'block';
    card.innerHTML = `<div style="padding:12px;border-left:3px solid ${tone[2]};background:${tone[0]};border-radius:4px;color:${tone[1]};display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
        <div><strong>🏛 Borough: ${year} Rental Registration due ${boroughFmt(boroughDueDate(year))}</strong><br><small>${days < 0 ? `${-days} day(s) overdue` : days === 0 ? 'Due today' : `${days} day(s) left`}${progress}</small></div>
        <button class="action-btn btn-primary" onclick="showView('borough')">Open Borough tab</button></div>`;
}
