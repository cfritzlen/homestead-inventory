// Fills the Borough of East Stroudsburg rental forms (assets/borough/*.pdf)
// with pdf-lib. Pure functions: (PDFLib, blank PDF bytes, data) → filled bytes.
// Coordinates are PDF points from the bottom-left corner of each page and
// match the September 2026 versions of the forms. If the Borough sends new
// forms, replace the files in assets/borough and redo the numbers here.
//
// data = {
//   date: 'YYYY-MM-DD',
//   address1, address2, unit, pin, lastInspection,
//   owner:   { name, phone, email, mailing1, mailing2, contact },
//   manager: { name, email, mailing1, mailing2, physical1, physical2, dayPhone, phone24, localContact },
//   tenants: [{ name, phone, email, employer }],   // empty when vacant
//   vacant: bool, occupancy: 'same' | 'new' | 'vacant',
//   unitsInBuilding, occupants, bedrooms, bathrooms,
//   meters: { water, electric, garbage },
//   answers: { license_active, license_displayed, evac_plan, smoke_detectors },  // 'yes' | 'no' | ''
//   pets: { count, breeds }, maxOccupants, disruptive, leaseSignedOn,
//   tenantContactAddress,        // optional: address shown to tenants on the Addendum instead of the owner's
//   signaturePng, initialsPng   // data URLs or null
// }
(function (global) {
  const INK = [0.05, 0.05, 0.3];

  function fmtDate(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso);
  }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dateParts(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return { day: '', month: '', yy: '' };
    return { day: String(parseInt(m[3], 10)), month: MONTHS[parseInt(m[2], 10) - 1] || '', yy: m[1].slice(2) };
  }
  const na = (v) => (v == null || String(v).trim() === '') ? 'N/A' : String(v).trim();
  const blank = (v) => (v == null) ? '' : String(v).trim();

  async function open(PDFLib, bytes) {
    const doc = await PDFLib.PDFDocument.load(bytes);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const color = PDFLib.rgb(...INK);
    const pages = doc.getPages();
    // Text on a line from x0 to x1 sitting on y; shrinks to fit.
    const text = (pi, x0, x1, y, str, size) => {
      str = blank(str); if (!str) return;
      let s = size || 10; const maxW = x1 - x0 - 3;
      while (s > 5.5 && font.widthOfTextAtSize(str, s) > maxW) s -= 0.5;
      pages[pi].drawText(str, { x: x0 + 2, y: y + 2.2, size: s, font, color });
    };
    // X inside a small box (x0..x1 by y0..y1)
    const cross = (pi, x0, x1, y0, y1) => {
      const p = pages[pi], o = 2.5, t = 1.1;
      p.drawLine({ start: { x: x0 + o, y: y0 + o }, end: { x: x1 - o, y: y1 - o }, thickness: t, color });
      p.drawLine({ start: { x: x0 + o, y: y1 - o }, end: { x: x1 - o, y: y0 + o }, thickness: t, color });
    };
    // PNG (data URL) with its bottom-left at x,y, scaled to height h, no wider than maxW
    const png = async (pi, dataUrl, x, y, h, maxW) => {
      if (!dataUrl) return;
      try {
        const img = await doc.embedPng(dataUrl);
        let scale = h / img.height; let w = img.width * scale;
        if (maxW && w > maxW) { scale = maxW / img.width; w = maxW; }
        pages[pi].drawImage(img, { x, y, width: w, height: img.height * scale });
      } catch (e) { console.warn('signature image skipped:', e.message); }
    };
    return { doc, pages, text, cross, png, save: () => doc.save() };
  }

  // ---- Registration for Residential Rental License (3 pages) ----
  async function registration(PDFLib, bytes, d) {
    const f = await open(PDFLib, bytes);
    const o = d.owner || {}, m = d.manager || {};
    // page 1: property
    f.text(0, 140.7, 331.1, 632.6, d.address1);
    f.text(0, 56.7, 330.7, 613.6, d.address2);
    f.text(0, 482.5, 584.1, 632.6, na(d.unit));
    f.text(0, 461.1, 584.1, 613.6, d.lastInspection ? fmtDate(d.lastInspection) : 'N/A');
    f.text(0, 228.4, 584.1, 594.3, na(d.pin));
    // owner
    f.text(0, 89.2, 331.1, 551.8, o.name);
    f.text(0, 370.7, 584.5, 554.1, o.phone);
    f.text(0, 362.4, 584.5, 539.7, o.email);
    f.text(0, 132.0, 330.7, 536.6, o.mailing1);
    f.text(0, 89.2, 331.1, 521.0, o.mailing2);
    f.text(0, 276.8, 584.5, 507.0, na(o.contact));
    // property manager (the Borough wants it filled even when it's the owner)
    f.text(0, 89.2, 331.1, 437.1, m.name);
    f.text(0, 361.2, 584.5, 437.1, m.email);
    f.text(0, 134.0, 331.1, 422.0, m.mailing1);
    f.text(0, 89.6, 331.1, 406.9, m.mailing2);
    f.text(0, 473.0, 584.5, 422.4, m.physical1);
    f.text(0, 356.1, 584.5, 407.6, m.physical2);
    f.text(0, 135.6, 331.1, 391.8, m.dayPhone);
    f.text(0, 399.7, 584.5, 392.9, m.phone24);
    f.text(0, 151.0, 331.1, 376.7, m.localContact);
    // tenants
    const nameY = [299.5, 261.3, 221.9, 182.3], mailY = [283.5, 245.5, 206.3, 166.3];
    if (d.vacant) {
      f.text(0, 89.9, 332.3, nameY[0], 'VACANT');
    } else {
      (d.tenants || []).slice(0, 4).forEach((t, i) => {
        f.text(0, 89.9, 332.3, nameY[i], t.name);
        f.text(0, 377.1, 584.5, nameY[i], na(t.phone));
        f.text(0, 89.9, 332.3, mailY[i], na(t.email));
        f.text(0, 382.6, 584.5, mailY[i], na(t.employer));
      });
    }
    f.text(0, 139.9, 158.7, 112.4, d.unitsInBuilding);
    f.text(0, 331.9, 350.7, 96.5, d.vacant ? '0' : d.occupants);
    f.text(0, 513.0, 538.9, 115.0, d.bedrooms);
    f.text(0, 513.6, 539.5, 96.8, d.bathrooms);

    // page 2: meters, yes/no, pets
    const mt = d.meters || {};
    f.text(1, 103.5, 143.3, 686.5, mt.water);
    f.text(1, 202.3, 242.1, 686.5, mt.electric);
    f.text(1, 298.8, 338.6, 686.5, mt.garbage);
    const rows = { license_active: [643.3, 655.1], license_displayed: [629.0, 640.8], evac_plan: [612.0, 623.9], smoke_detectors: [583.6, 595.4], pets: [552.4, 564.2] };
    const YES = [520.9, 535.2], NO = [556.5, 570.8];
    const ans = Object.assign({}, d.answers || {});
    const petCount = parseInt((d.pets || {}).count, 10) || 0;
    ans.pets = d.vacant ? 'no' : (petCount > 0 ? 'yes' : 'no');
    for (const k of Object.keys(rows)) {
      const v = String(ans[k] || '').toLowerCase();
      if (v === 'yes') f.cross(1, YES[0], YES[1], rows[k][0], rows[k][1]);
      else if (v === 'no') f.cross(1, NO[0], NO[1], rows[k][0], rows[k][1]);
    }
    if (ans.pets === 'yes') {
      f.text(1, 246.6, 287.2, 537.2, String(petCount));
      f.text(1, 354.4, 494.1, 538.7, (d.pets || {}).breeds);
    }
    // initials: documents included + the statements
    if (d.initialsPng) {
      const docs = [480.1, 462.5, 445.4];                      // this form, fee, addendum
      if (d.occupancy === 'same') docs.push(429.0);           // affidavit of same occupants
      if (d.vacant) docs.push(411.9);                          // affidavit of vacant unit
      for (const y of docs) await f.png(1, d.initialsPng, 50, y + 1.5, 13, 40);
      for (const y of [312.0, 263.1, 228.8, 165.7, 101.3]) await f.png(1, d.initialsPng, 50, y + 1.5, 13, 40);
      for (const y of [686.6, 629.9]) await f.png(2, d.initialsPng, 48, y + 1.5, 13, 40);
    }
    // page 3: names, signature, date
    f.text(2, 222.5, 583.7, 462.2, o.name, 11);
    f.text(2, 222.1, 583.7, 426.7, m.name || o.name, 11);
    if (d.signaturePng) {
      await f.png(2, d.signaturePng, 226, 445.5, 22, 200);
      f.text(2, 469.0, 583.7, 444.5, fmtDate(d.date), 11);
      if (!m.name || m.name === o.name) { await f.png(2, d.signaturePng, 226, 409.5, 22, 200); f.text(2, 469.0, 583.7, 409.0, fmtDate(d.date), 11); }
    }
    return f.save();
  }

  // ---- Addendum to Lease (2 pages) ----
  async function addendum(PDFLib, bytes, d) {
    const f = await open(PDFLib, bytes);
    const o = d.owner || {}, m = d.manager || {};
    const dp = dateParts(d.date);
    f.text(0, 240.0, 273.0, 667.0, dp.day, 11);
    f.text(0, 303.0, 396.0, 667.0, dp.month, 11);
    f.text(0, 413.0, 440.0, 667.0, dp.yy, 11);
    f.text(0, 293.0, 468.5, 636.0, fmtDate(d.leaseSignedOn), 11);
    f.text(0, 72.0, 411.5, 605.0, [d.address1, d.unit ? 'Unit ' + d.unit : '', d.address2].filter(Boolean).join(', '), 11);
    // C. responsible person for management / code compliance
    const who = m.name ? m : { name: o.name, physical1: o.mailing1, physical2: o.mailing2, dayPhone: o.phone, email: o.email };
    f.text(0, 126.5, 536.5, 363.0, who.name, 11);
    // Tenants see this page: a separate contact address can be shown here
    f.text(0, 126.5, 536.5, 312.0, d.tenantContactAddress || [who.physical1 || who.mailing1, who.physical2 || who.mailing2].filter(Boolean).join(', '), 11);
    f.text(0, 126.0, 295.5, 261.0, who.dayPhone || who.phone24, 11);
    f.text(0, 336.0, 538.0, 261.0, who.email, 11);
    f.text(0, 319.0, 351.5, 133.0, String(d.maxOccupants || 4), 11);
    // page 2
    f.text(1, 195.0, 227.5, 693.0, String(d.disruptive == null || d.disruptive === '' ? 0 : d.disruptive), 11);
    f.text(1, 72.0, 247.5, 452.5, o.name, 11);
    if (d.signaturePng) await f.png(1, d.signaturePng, 328, 454, 22, 200);
    const occY = [385.5, 318.5, 251.0, 184.0];
    (d.tenants || []).slice(0, 4).forEach((t, i) => f.text(1, 72.0, 247.5, occY[i], t.name, 11));
    return f.save();
  }

  // ---- Affidavit of Same Tenants (1 page) ----
  async function affidavitSame(PDFLib, bytes, d) {
    const f = await open(PDFLib, bytes);
    const o = d.owner || {};
    const addr = [d.address1, d.unit ? 'Unit ' + d.unit : '', d.address2].filter(Boolean).join(', ');
    f.text(0, 84.0, 300.0, 674.7, o.name);
    f.text(0, 168.0, 391.0, 646.3, addr);
    f.text(0, 265.0, 531.0, 632.9, na(d.pin));
    f.text(0, 90.0, 301.0, 606.3, o.name);
    f.text(0, 120.0, 274.0, 593.0, o.phone);
    f.text(0, 372.0, 534.0, 593.0, [o.mailing1, o.mailing2].filter(Boolean).join(', '));
    f.text(0, 117.0, 287.0, 579.7, o.email);
    f.text(0, 90.0, 431.0, 553.0, na(o.contact));
    f.text(0, 172.0, 420.0, 539.7, (d.tenants || []).map(t => t.name).filter(Boolean).join(', '));
    if (d.signaturePng) { await f.png(0, d.signaturePng, 76, 291, 22, 150); f.text(0, 240.0, 305.0, 289.1, fmtDate(d.date)); }
    return f.save();
  }

  // ---- Affidavit of Vacant Regulated Residential Unit (1 page) ----
  async function affidavitVacant(PDFLib, bytes, d) {
    const f = await open(PDFLib, bytes);
    const o = d.owner || {};
    const addr = [d.address1, d.unit ? 'Unit ' + d.unit : '', d.address2].filter(Boolean).join(', ');
    f.text(0, 120.0, 245.0, 650.2, o.name, 11);
    f.text(0, 72.0, 531.0, 614.9, addr, 11);
    f.text(0, 72.0, 531.0, 468.4, addr, 11);
    if (d.signaturePng) { await f.png(0, d.signaturePng, 328, 213, 22, 200); f.text(0, 362.0, 540.0, 174.0, fmtDate(d.date), 11); }
    return f.save();
  }

  const BoroughForms = { registration, addendum, affidavitSame, affidavitVacant, fmtDate };
  global.BoroughForms = BoroughForms;
  if (typeof module !== 'undefined' && module.exports) module.exports = BoroughForms;
})(typeof window !== 'undefined' ? window : globalThis);
