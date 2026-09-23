// Rentals → Properties tab: one card per building with the facts you need for
// taxes, escrow and licensing, the paperwork filed by year, and reminders.
// Uses rentals.html globals: supabaseClient, showAlert, LEASE_BUCKET, openLeaseFile,
// closeLeaseModal, buildingForAddress, unitLabel.

// What to keep for every building, and when it normally turns up
const PROP_KINDS = [
    { k: 'tax_county', label: 'County / township tax bill', when: 'Bill March 1 · 2% discount by April 30', yearly: true, month: 3 },
    { k: 'tax_school', label: 'School tax bill', when: 'Bill Aug 1 · 2% discount by Sept 30', yearly: true, month: 8 },
    { k: 'escrow', label: 'Escrow analysis (from the lender)', when: 'Once a year', yearly: true },
    { k: 'f1098', label: 'Form 1098 mortgage interest', when: 'January, for your taxes', yearly: true, month: 1 },
    { k: 'insurance', label: 'Insurance declarations page', when: 'At each renewal', yearly: true },
    { k: 'license', label: 'Rental license / registration', when: 'Once a year', yearly: true },
    { k: 'inspection', label: 'Inspection report', when: 'When one happens', yearly: false },
    { k: 'deed', label: 'Deed / closing statement', when: 'Once (sets your cost basis)', once: true },
    { k: 'lead', label: 'Lead paint disclosure (pre-1978 buildings)', when: 'Once per tenant', once: true },
    { k: 'other', label: 'Other', when: '' },
];
const PROP_KIND = Object.fromEntries(PROP_KINDS.map(k => [k.k, k]));

// Facts already known (from the 2026 tax bills and Fidelity emails); used until you edit them
const PROP_DEFAULTS = [
    { match: /courtland/i, info: {
        display_name: '180-182 N Courtland St', address: '180-182 N Courtland St, East Stroudsburg, PA 18301',
        parcel: '05-5.2.18.6', pin: '05730112853408', tax_account: '61870',
        tax_collector: 'Lisa VanWhy (East Stroudsburg SD / E. Stroudsburg Boro) · 350 Race St, East Stroudsburg PA 18301 · 570-664-3422 · l.vanwhy@aol.com',
        lender: 'Fidelity Bank (Fidelity Deposit & Discount Bank)', escrow_contact: 'escrow-loans@fddbank.com · Carol Petliski carol.petliski@fddbank.com', taxes_by_escrow: 'yes',
        license_body: 'Borough of East Stroudsburg rental license (Sue Balmoos, 570-421-8300 x117) — see the Borough tab', license_due: 'October 1 each year',
        notes: 'Deed: Martin Valdez and Colette G. Fritzlen. 2026 school tax $9,358.34 ($9,171.17 by 9/30/26), sent to escrow 9/22/26.' } },
    { match: /poplar/i, info: {
        display_name: '1038 & 1028 Poplar Valley Road East', address: '1038 Poplar Valley Rd E, Stroudsburg, PA 18360 (2 dwellings: 1038 and 1028, one parcel)',
        parcel: '17.8.2.31', pin: '17720900556002', tax_account: '175002',
        tax_collector: 'Wendy Bogart Shiffer (Stroudsburg SD / Stroud Township) · 1212 Christopher St (rear), PO Box 128, Stroudsburg PA 18360 · 570-421-5638 · wshiffer@ptd.net',
        lender: 'Fidelity Bank (Fidelity Deposit & Discount Bank)', escrow_contact: 'escrow-loans@fddbank.com · Carol Petliski carol.petliski@fddbank.com', taxes_by_escrow: 'yes',
        license_body: 'Stroud Township — check whether a rental registration is required', license_due: '',
        notes: 'Deed: Martin Valdez and Colette Fritzlen. Homestead exclusion applies. 2026 school tax $6,458.16 ($6,329.01 by 9/30/26), sent to escrow 9/22/26.' } },
    { match: /lindbergh/i, info: {
        display_name: '503 Lindbergh Ave', address: '503 Lindbergh Ave, Stroudsburg, PA 18360',
        license_body: 'Stroudsburg Borough — check whether a rental license is required', notes: '' } },
];
const PROP_FIELDS = [
    ['display_name', 'Name'], ['address', 'Address'], ['parcel', 'Parcel number'], ['pin', 'PIN'], ['tax_account', 'Tax account #'],
    ['tax_collector', 'Tax collector (name, address, phone, email)'], ['lender', 'Mortgage lender'], ['loan_no', 'Loan number'],
    ['escrow_contact', 'Escrow contact'], ['taxes_by_escrow', 'Taxes paid from escrow? (yes/no)'],
    ['insurer', 'Insurance company'], ['policy_no', 'Policy number'], ['insurance_agent', 'Insurance agent (name, phone)'], ['insurance_renews', 'Insurance renews on (YYYY-MM-DD)'],
    ['license_body', 'Rental license / registration (who)'], ['license_due', 'License due'], ['year_built', 'Year built (lead paint applies before 1978)'], ['notes', 'Notes'],
];

let propBuildings = [], propUnits = [], propDocs = {}, propYear = new Date().getFullYear(), propSetupError = '';
const pEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : ''; };
function propInfo(b) {
    const d = PROP_DEFAULTS.find(x => x.match.test(b.property_name || '') || x.match.test(b.street_address || ''));
    return Object.assign({}, d ? d.info : {}, Object.fromEntries(Object.entries(b.property_info || {}).filter(([, v]) => v)));
}
function propUnitsOf(b) {
    const key = buildingForAddress(b.property_name);
    return propUnits.filter(u => buildingForAddress(u.street_address ? `${u.street_address}${u.unit ? ', Unit ' + u.unit : ''}` : u.property_name) === key
        || (b.property_name && (u.property_name || '').toLowerCase().includes(b.property_name.toLowerCase().replace(/\s*\(.*\)/, ''))));
}

// ---------- load ----------
async function loadPropertiesTab() {
    propSetupError = '';
    try {
        const { data, error } = await supabaseClient.from('rental_properties').select('*').neq('status', 'archived').order('property_name');
        if (error) throw error;
        propBuildings = (data || []).filter(p => p.is_building_level);
        propUnits = (data || []).filter(p => !p.is_building_level);
        if (propBuildings.length && propBuildings[0].property_info === undefined) propSetupError = 'Run supabase/migrations/025_properties.sql in Supabase → SQL Editor to save property details and documents.';
        propDocs = {};
        const { data: docs, error: e2 } = await supabaseClient.from('rental_property_docs').select('*').order('year', { ascending: false }).order('created_at', { ascending: false });
        if (e2) propSetupError = propSetupError || 'Run supabase/migrations/025_properties.sql in Supabase → SQL Editor to save property details and documents.';
        for (const d of docs || []) (propDocs[d.property_id] = propDocs[d.property_id] || []).push(d);
    } catch (e) { showAlert('Could not load properties: ' + e.message, 'error'); return; }
    renderPropertiesTab();
}

// ---------- render ----------
function renderPropertiesTab() {
    const box = document.getElementById('properties-list');
    document.getElementById('properties-note').innerHTML = propSetupError ? `<div class="alert alert-error" style="display:block;">${pEsc(propSetupError)}</div>` : '';
    document.getElementById('prop-year').value = propYear;
    if (!propBuildings.length) {
        box.innerHTML = `<p style="color:var(--text-secondary);">No buildings yet. Tap <strong>Add property</strong> to create one (503 Lindbergh, 180-182 N Courtland, 1038 Poplar Valley).</p>`;
        document.getElementById('properties-reminders').innerHTML = ''; return;
    }
    renderPropReminders();
    box.innerHTML = propBuildings.map(renderPropertyCard).join('');
}
function docsFor(b, kind, year) { return (propDocs[b.id] || []).filter(d => d.kind === kind && (year == null || d.year === year)); }
function renderPropertyCard(b) {
    const info = propInfo(b);
    const units = propUnitsOf(b);
    const docs = propDocs[b.id] || [];
    const fact = (label, v) => v ? `<div><span style="color:var(--text-secondary);">${label}</span><br>${pEsc(v)}</div>` : '';
    const checklist = PROP_KINDS.filter(k => k.k !== 'other' && k.k !== 'inspection').map(k => {
        const have = k.once ? docs.filter(d => d.kind === k.k) : docsFor(b, k.k, propYear);
        const ok = have.length > 0;
        const paid = have.find(d => d.paid_on);
        return `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
            <span>${ok ? '✅' : '⬜'} <strong>${k.label}</strong>${k.once ? '' : ' ' + propYear}<br><small style="color:var(--text-secondary);">${k.when}${paid ? ` · paid ${pDate(paid.paid_on)}` : ''}${ok && have[0].amount ? ` · $${Number(have[0].amount).toLocaleString()}` : ''}</small></span>
            <span style="white-space:nowrap;">${ok ? have.map(d => d.storage_path ? `<a href="#" onclick="openLeaseFile('${d.storage_path}');return false;" style="font-size:12px;margin-left:6px;">open</a>` : '').join('') : ''}<button class="act" style="margin-left:6px;" onclick="openPropDocForm(${b.id}, '${k.k}')">${ok ? '+ another' : 'Add'}</button></span></div>`;
    }).join('');
    const others = docs.filter(d => d.kind === 'other' || d.kind === 'inspection').map(d => `<div style="font-size:13px;padding:4px 0;">📎 ${d.storage_path ? `<a href="#" onclick="openLeaseFile('${d.storage_path}');return false;">${pEsc(d.title || d.file_name)}</a>` : pEsc(d.title || '')} <small style="color:var(--text-secondary);">${d.year || ''}</small> <a href="#" onclick="removePropDoc(${d.id}, ${b.id}, '${d.storage_path || ''}');return false;" style="color:var(--danger);font-size:12px;">✕</a></div>`).join('');
    return `<div class="bu-card">
        <div class="bu-head">
            <div><div class="bu-unit">Property</div>
                <div class="bu-names">${pEsc(info.display_name || b.property_name)}</div>
                <div class="bu-meta">${pEsc(info.address || '')}${units.length ? `<br>${units.length} unit${units.length === 1 ? '' : 's'}: ${units.map(u => pEsc(unitLabel(u.unit || u.property_name))).join(', ')}` : ''}</div></div>
            <div style="display:flex;gap:6px;"><button class="act" onclick="openPropEdit(${b.id})">✏️ Edit details</button></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin:12px 0;font-size:13px;">
            ${fact('Parcel', info.parcel)}${fact('PIN', info.pin)}${fact('Tax account', info.tax_account)}
            ${fact('Tax collector', info.tax_collector)}${fact('Lender', info.lender)}${fact('Loan #', info.loan_no)}
            ${fact('Escrow', info.escrow_contact)}${fact('Taxes paid from escrow', info.taxes_by_escrow)}
            ${fact('Insurance', [info.insurer, info.policy_no].filter(Boolean).join(' · '))}${fact('Insurance renews', info.insurance_renews && pDate(info.insurance_renews))}
            ${fact('License / registration', info.license_body)}${fact('License due', info.license_due)}
        </div>
        ${info.notes ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">📝 ${pEsc(info.notes)}</div>` : ''}
        <div style="font-weight:600;font-size:14px;margin:6px 0;">Paperwork for ${propYear}</div>
        ${checklist}
        ${others ? `<div style="margin-top:8px;">${others}</div>` : ''}
        <div class="bu-more"><a href="#" onclick="openPropDocForm(${b.id}, 'other');return false;">Add another document</a><a href="#" onclick="openPropDocForm(${b.id}, 'inspection');return false;">Add inspection report</a><a href="#" onclick="showPropAllDocs(${b.id});return false;">All years (${docs.length})</a></div>
    </div>`;
}
function renderPropReminders() {
    const el = document.getElementById('properties-reminders');
    const today = new Date(); const items = [];
    const push = (date, text, b) => { const d = new Date(date + 'T00:00:00'); const days = Math.ceil((d - today) / 86400000); if (days >= -30 && days <= 120) items.push({ days, date, text, name: propInfo(b).display_name || b.property_name }); };
    const y = today.getFullYear();
    for (const b of propBuildings) {
        const info = propInfo(b);
        const school = docsFor(b, 'tax_school', y), county = docsFor(b, 'tax_county', y);
        if (!school.some(d => d.paid_on)) push(`${y}-09-30`, 'School tax: 2% discount ends' + (info.taxes_by_escrow === 'yes' ? ' (check escrow paid it)' : ''), b);
        if (!county.some(d => d.paid_on)) push(`${y}-04-30`, 'County/township tax: 2% discount ends' + (info.taxes_by_escrow === 'yes' ? ' (check escrow paid it)' : ''), b);
        if (!docsFor(b, 'f1098', y).length) push(`${y + 1}-01-31`, 'Form 1098 arrives (file it for taxes)', b);
        if (info.insurance_renews) push(info.insurance_renews, 'Insurance renewal', b);
        if (/courtland/i.test(b.property_name)) push(`${y}-10-01`, 'Borough rental registration packet due (Borough tab)', b);
        for (const d of propDocs[b.id] || []) if (d.due_on && !d.paid_on) push(d.due_on, `${PROP_KIND[d.kind]?.label || d.kind}${d.amount ? ` $${Number(d.amount).toLocaleString()}` : ''} due`, b);
    }
    items.sort((a, b) => a.days - b.days);
    el.innerHTML = items.length ? `<div class="card"><div class="card-header">Coming up</div>${items.map(i => `<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:14px;">
        <span class="bu-pill ${i.days < 0 ? 'bu-p-wait' : i.days <= 14 ? 'bu-p-wait' : 'bu-p-todo'}" style="min-width:110px;text-align:center;">${i.days < 0 ? -i.days + ' days ago' : i.days === 0 ? 'today' : 'in ' + i.days + ' days'}</span>
        <span><strong>${pEsc(i.text)}</strong> · ${pEsc(i.name)} <small style="color:var(--text-secondary);">${pDate(i.date)}</small></span></div>`).join('')}</div>` : '';
}
function changePropYear(v) { propYear = parseInt(v, 10) || new Date().getFullYear(); renderPropertiesTab(); }

// ---------- edit facts ----------
function openPropEdit(id) {
    const b = propBuildings.find(x => x.id === id); if (!b) return;
    const info = propInfo(b);
    const modal = document.getElementById('lease-modal'); modal.style.display = 'flex';
    document.getElementById('lm-title').textContent = `Edit · ${info.display_name || b.property_name}`;
    document.getElementById('lm-body').innerHTML = `<div class="form-grid">${PROP_FIELDS.map(([k, label]) => `<div class="form-group${k === 'notes' || k === 'tax_collector' || k === 'address' ? ' full-width' : ''}"><label>${label}</label>${k === 'notes' ? `<textarea id="pe-${k}" rows="3">${pEsc(info[k])}</textarea>` : `<input id="pe-${k}" value="${pEsc(info[k])}">`}</div>`).join('')}</div>
        <div style="display:flex;gap:8px;margin-top:12px;"><button class="btn btn-primary" onclick="savePropEdit(${id})">Save</button><button class="btn btn-secondary" onclick="closeLeaseModal()">Cancel</button></div>`;
}
async function savePropEdit(id) {
    const b = propBuildings.find(x => x.id === id); if (!b) return;
    const info = {}; for (const [k] of PROP_FIELDS) info[k] = (document.getElementById('pe-' + k) || {}).value?.trim() || '';
    const { error } = await supabaseClient.from('rental_properties').update({ property_info: info }).eq('id', id);
    if (error) { showAlert('Could not save: ' + error.message + ' (run migration 025?)', 'error'); return; }
    b.property_info = info; closeLeaseModal(); renderPropertiesTab(); showAlert('Saved.', 'success');
}
async function addProperty() {
    const name = (prompt('Property name (e.g. "503 Lindbergh Ave"):') || '').trim(); if (!name) return;
    const { data, error } = await supabaseClient.from('rental_properties').insert([{ property_name: name, is_building_level: true, status: 'active' }]).select().single();
    if (error) { showAlert('Could not add: ' + error.message, 'error'); return; }
    propBuildings.push(data); renderPropertiesTab(); openPropEdit(data.id);
}

// ---------- documents ----------
function openPropDocForm(id, kind) {
    const b = propBuildings.find(x => x.id === id); if (!b) return;
    const modal = document.getElementById('lease-modal'); modal.style.display = 'flex';
    document.getElementById('lm-title').textContent = `Add · ${propInfo(b).display_name || b.property_name}`;
    document.getElementById('lm-body').innerHTML = `<div class="form-grid">
        <div class="form-group"><label>What is it</label><select id="pd-kind">${PROP_KINDS.map(k => `<option value="${k.k}" ${k.k === kind ? 'selected' : ''}>${k.label}</option>`).join('')}</select></div>
        <div class="form-group"><label>Year</label><input id="pd-year" type="number" value="${propYear}"></div>
        <div class="form-group"><label>Amount ($, if a bill)</label><input id="pd-amount" type="number" step="0.01"></div>
        <div class="form-group"><label>Due on</label><input id="pd-due" type="date"></div>
        <div class="form-group"><label>Paid on (leave blank if not yet)</label><input id="pd-paid" type="date"></div>
        <div class="form-group"><label>Title (optional)</label><input id="pd-title" placeholder="e.g. 2026 school tax bill"></div>
        <div class="form-group full-width"><label>Notes</label><input id="pd-notes" placeholder="e.g. paid from escrow, sent to Fidelity 9/22"></div>
        <div class="form-group full-width"><label>File (photo or PDF, optional)</label><input id="pd-file" type="file" accept="application/pdf,image/*"></div></div>
        <div style="display:flex;gap:8px;margin-top:12px;"><button class="btn btn-primary" onclick="savePropDoc(${id})">Save</button><button class="btn btn-secondary" onclick="closeLeaseModal()">Cancel</button></div>`;
}
async function savePropDoc(id) {
    const v = (k) => (document.getElementById('pd-' + k) || {}).value?.trim() || '';
    const file = (document.getElementById('pd-file') || {}).files?.[0];
    const row = { property_id: id, kind: v('kind'), year: v('year') ? parseInt(v('year'), 10) : null, title: v('title') || null, amount: v('amount') ? parseFloat(v('amount')) : null, due_on: v('due') || null, paid_on: v('paid') || null, notes: v('notes') || null, file_name: null, storage_path: null };
    try {
        if (file) {
            const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
            const path = `property/${id}/${Date.now()}_${safe}`;
            const { error } = await supabaseClient.storage.from(LEASE_BUCKET).upload(path, file, { upsert: false, contentType: file.type || undefined });
            if (error) throw error;
            row.file_name = file.name; row.storage_path = path;
        }
        const { error } = await supabaseClient.from('rental_property_docs').insert([row]);
        if (error) throw error;
        closeLeaseModal(); await loadPropertiesTab(); showAlert('Saved.', 'success');
    } catch (e) { showAlert('Could not save: ' + e.message + (/rental_property_docs/.test(e.message) ? ' (run migration 025?)' : ''), 'error'); }
}
async function removePropDoc(docId, propertyId, path) {
    if (!confirm('Remove this document?')) return;
    if (path) await supabaseClient.storage.from(LEASE_BUCKET).remove([path]);
    await supabaseClient.from('rental_property_docs').delete().eq('id', docId);
    await loadPropertiesTab();
}
function showPropAllDocs(id) {
    const b = propBuildings.find(x => x.id === id); if (!b) return;
    const docs = propDocs[id] || [];
    const modal = document.getElementById('lease-modal'); modal.style.display = 'flex';
    document.getElementById('lm-title').textContent = `All documents · ${propInfo(b).display_name || b.property_name}`;
    document.getElementById('lm-body').innerHTML = docs.length ? docs.map(d => `<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <span><strong>${d.year || ''}</strong> ${PROP_KIND[d.kind]?.label || d.kind}${d.title ? ' · ' + pEsc(d.title) : ''}${d.amount ? ` · $${Number(d.amount).toLocaleString()}` : ''}${d.paid_on ? ` · paid ${pDate(d.paid_on)}` : d.due_on ? ` · due ${pDate(d.due_on)}` : ''}${d.notes ? `<br><small style="color:var(--text-secondary);">${pEsc(d.notes)}</small>` : ''}</span>
        <span style="white-space:nowrap;">${d.storage_path ? `<a href="#" onclick="openLeaseFile('${d.storage_path}');return false;">open</a> ` : ''}<a href="#" onclick="removePropDoc(${d.id}, ${id}, '${d.storage_path || ''}');closeLeaseModal();return false;" style="color:var(--danger);">✕</a></span></div>`).join('')
        : '<p style="color:var(--text-secondary);">Nothing filed yet.</p>';
}
