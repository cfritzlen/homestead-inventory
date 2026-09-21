// Adopt-your-signature pop-up shared by sign.html (tenants) and rentals.html
// (landlord). Draw with finger/mouse, or type a name and pick a script font.
// Usage:  const r = await ESign.adopt({ name, initials, saved: { signature_png, initials_png } });
//         r = { signature_png, initials_png, remember } or null if cancelled.
(function (global) {
  const FONTS = ['Dancing Script', 'Great Vibes', 'Homemade Apple'];
  const CSS = `
    #esign-overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.6); z-index: 5000; display: flex; align-items: center; justify-content: center; padding: 12px; font-family: 'Inter', system-ui, sans-serif; }
    #esign-box { background: #fff; border-radius: 12px; width: 100%; max-width: 560px; max-height: 96vh; overflow: auto; padding: 18px; color: #0f172a; }
    #esign-box h2 { font-size: 1.15rem; margin: 0 0 4px; }
    #esign-box .sub { color: #475569; font-size: 0.9rem; margin-bottom: 12px; }
    .esign-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
    .esign-tabs button { flex: 1; padding: 9px; border: 1px solid #cbd5e1; background: #f8fafc; border-radius: 8px; font: inherit; cursor: pointer; }
    .esign-tabs button.on { background: #1e40af; color: #fff; border-color: #1e40af; }
    .esign-label { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin: 10px 0 4px; font-size: 0.95rem; }
    .esign-label button { background: none; border: 0; color: #1e40af; font: inherit; font-size: 0.85rem; cursor: pointer; }
    .esign-pad { position: relative; border: 2px dashed #94a3b8; border-radius: 8px; background: #fff; touch-action: none; }
    .esign-pad canvas { display: block; width: 100%; height: 100%; }
    .esign-pad .hint { position: absolute; left: 10px; bottom: 6px; color: #94a3b8; font-size: 0.8rem; pointer-events: none; }
    .esign-type input { width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; font-size: 1rem; }
    .esign-fonts { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .esign-fonts label { display: flex; align-items: center; gap: 10px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
    .esign-fonts label.on { border-color: #1e40af; background: #eff6ff; }
    .esign-fonts .prev { font-size: 30px; line-height: 1.2; flex: 1; white-space: nowrap; overflow: hidden; }
    .esign-fonts .ini { font-size: 22px; color: #334155; }
    .esign-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; align-items: center; }
    .esign-actions .primary { flex: 1; background: #1e40af; color: #fff; border: 0; border-radius: 8px; padding: 12px; font: inherit; font-weight: 600; cursor: pointer; }
    .esign-actions .secondary { background: #f1f5f9; border: 0; border-radius: 8px; padding: 12px 14px; font: inherit; cursor: pointer; }
    .esign-saved { display: flex; align-items: center; gap: 12px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; }
    .esign-saved img { height: 44px; max-width: 200px; object-fit: contain; }
    .esign-remember { display: flex; gap: 8px; align-items: center; font-size: 0.85rem; color: #475569; }
  `;

  function ensureFonts() {
    if (document.getElementById('esign-fonts-link')) return;
    const l = document.createElement('link'); l.id = 'esign-fonts-link'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Dancing+Script:wght@600&family=Great+Vibes&family=Homemade+Apple&display=swap';
    document.head.appendChild(l);
    const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s);
  }

  // Drawing pad → trimmed PNG data URL
  function makePad(canvas) {
    const ctx = canvas.getContext('2d'); let drawing = false, strokes = 0;
    const size = () => { const r = canvas.parentElement.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1f7a'; };
    size();
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', e => { drawing = true; canvas.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); strokes++; e.preventDefault(); });
    const up = () => { drawing = false; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    return {
      clear() { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); strokes = 0; },
      isEmpty() { return strokes < 3; },
      png() { return trimToPng(canvas); },
    };
  }
  function trimToPng(c) {
    const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (maxX <= minX || maxY <= minY) return null;
    const pad = 6, out = document.createElement('canvas');
    out.width = maxX - minX + pad * 2; out.height = maxY - minY + pad * 2;
    out.getContext('2d').drawImage(c, minX - pad, minY - pad, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }
  // Typed text in a script font → trimmed PNG data URL
  async function typedPng(text, font, px) {
    try { await document.fonts.load(`${px}px "${font}"`); } catch (_) {}
    const c = document.createElement('canvas'); c.width = Math.max(200, text.length * px) ; c.height = px * 2;
    const ctx = c.getContext('2d'); ctx.font = `${px}px "${font}"`; ctx.fillStyle = '#0b1f7a'; ctx.textBaseline = 'middle';
    ctx.fillText(text, px * 0.3, px);
    return trimToPng(c);
  }
  const initialsOf = (name) => (name || '').split(/[\s,]+/).filter(Boolean).map(w => w[0].toUpperCase()).join('').slice(0, 4);

  function adopt(opts) {
    ensureFonts();
    opts = opts || {};
    const name = opts.name || '';
    const wantInitials = opts.initials !== false;
    return new Promise((resolve) => {
      const ov = document.createElement('div'); ov.id = 'esign-overlay';
      const savedHtml = opts.saved && opts.saved.signature_png ? `
        <div class="esign-saved"><img src="${opts.saved.signature_png}" alt="saved signature"><div style="flex:1;font-size:0.9rem;">Your saved signature</div><button type="button" class="secondary" id="esign-use-saved">Use it</button></div>` : '';
      ov.innerHTML = `<div id="esign-box">
        <h2>${opts.title || 'Set up your signature'}</h2>
        <div class="sub">${opts.subtitle || 'Draw it, or type your name and pick a style. It will be placed wherever you tap on the lease.'}</div>
        ${savedHtml}
        <div class="esign-tabs"><button type="button" id="esign-tab-draw" class="on">✍️ Draw</button><button type="button" id="esign-tab-type">⌨️ Type</button></div>
        <div id="esign-draw">
          <div class="esign-label">Signature <button type="button" id="esign-clear-sig">Clear</button></div>
          <div class="esign-pad" style="height:150px;"><canvas id="esign-sig"></canvas><span class="hint">Draw with your finger or mouse</span></div>
          ${wantInitials ? `<div class="esign-label">Initials <button type="button" id="esign-clear-ini">Clear</button></div>
          <div class="esign-pad" style="height:100px;width:200px;"><canvas id="esign-ini"></canvas><span class="hint">Initials</span></div>` : ''}
        </div>
        <div id="esign-type" class="esign-type" style="display:none;">
          <input id="esign-name" value="${name.replace(/"/g, '&quot;')}" placeholder="Your full name">
          <div class="esign-fonts" id="esign-fonts"></div>
        </div>
        <div class="esign-actions">
          <button type="button" class="primary" id="esign-ok">Use this signature</button>
          <button type="button" class="secondary" id="esign-cancel">Cancel</button>
          ${opts.remember ? `<label class="esign-remember"><input type="checkbox" id="esign-remember" checked> Remember for next time</label>` : ''}
        </div>
      </div>`;
      document.body.appendChild(ov);
      const $ = (id) => ov.querySelector('#' + id);
      const pads = { sig: makePad($('esign-sig')), ini: wantInitials ? makePad($('esign-ini')) : null };
      let mode = 'draw', fontChoice = FONTS[0];
      const renderFonts = () => {
        const n = $('esign-name').value.trim() || 'Your Name';
        $('esign-fonts').innerHTML = FONTS.map(f => `<label class="${f === fontChoice ? 'on' : ''}" data-font="${f}"><input type="radio" name="esign-font" ${f === fontChoice ? 'checked' : ''} style="display:none"><span class="prev" style="font-family:'${f}'">${n.replace(/</g, '&lt;')}</span>${wantInitials ? `<span class="ini" style="font-family:'${f}'">${initialsOf(n)}</span>` : ''}</label>`).join('');
        $('esign-fonts').querySelectorAll('label').forEach(l => l.addEventListener('click', () => { fontChoice = l.dataset.font; renderFonts(); }));
      };
      renderFonts();
      $('esign-name').addEventListener('input', renderFonts);
      const setMode = (m) => { mode = m; $('esign-draw').style.display = m === 'draw' ? '' : 'none'; $('esign-type').style.display = m === 'type' ? '' : 'none';
        $('esign-tab-draw').classList.toggle('on', m === 'draw'); $('esign-tab-type').classList.toggle('on', m === 'type'); };
      $('esign-tab-draw').onclick = () => setMode('draw');
      $('esign-tab-type').onclick = () => setMode('type');
      $('esign-clear-sig').onclick = () => pads.sig.clear();
      if (wantInitials) $('esign-clear-ini').onclick = () => pads.ini.clear();
      const done = (r) => { ov.remove(); resolve(r); };
      $('esign-cancel').onclick = () => done(null);
      if ($('esign-use-saved')) $('esign-use-saved').onclick = () => done({ signature_png: opts.saved.signature_png, initials_png: opts.saved.initials_png || null, remember: false, reused: true });
      $('esign-ok').onclick = async () => {
        let signature_png, initials_png = null;
        if (mode === 'draw') {
          if (pads.sig.isEmpty()) { alert('Please draw your signature.'); return; }
          if (wantInitials && pads.ini.isEmpty()) { alert('Please draw your initials too.'); return; }
          signature_png = pads.sig.png(); if (wantInitials) initials_png = pads.ini.png();
        } else {
          const n = $('esign-name').value.trim();
          if (!n) { alert('Please type your name.'); return; }
          signature_png = await typedPng(n, fontChoice, 64);
          if (wantInitials) initials_png = await typedPng(initialsOf(n), fontChoice, 56);
        }
        if (!signature_png || (wantInitials && !initials_png)) { alert('Something went wrong making the image. Please try again.'); return; }
        done({ signature_png, initials_png, remember: !!($('esign-remember') && $('esign-remember').checked), reused: false });
      };
    });
  }

  global.ESign = { adopt, initialsOf };
})(window);
