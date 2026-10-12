// Kiosk mode for the kids' tablet.
//   Turn on:  open any page with ?kiosk=on   (or the link at the bottom of the home page)
//   Turn off: ?kiosk=off, or press-and-hold the page title for 3 seconds
// The setting is saved on that device only. When on, <html> gets class "kiosk"
// and window.KIOSK is true; pages use that to hide ways out and grown-up actions.
(function () {
  var params = new URLSearchParams(location.search);
  var q = params.get('kiosk');
  try {
    if (q === 'on' || q === '1') localStorage.setItem('kiosk', '1');
    if (q === 'off' || q === '0') localStorage.removeItem('kiosk');
  } catch (_) {}
  var on = false;
  try { on = localStorage.getItem('kiosk') === '1'; } catch (_) {}
  window.KIOSK = on;
  if (on) document.documentElement.classList.add('kiosk');
  if (q !== null) {
    params.delete('kiosk');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
  }

  var s = document.currentScript;
  var BASE = s ? new URL('.', s.src).href.replace(/assets\/$/, '') : '';

  function menu() {
    var bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif';
    bg.innerHTML = '<div style="background:#fff;border-radius:16px;padding:22px;width:100%;max-width:360px;display:grid;gap:12px">' +
      '<div style="font-size:18px;font-weight:700;color:#333;text-align:center">Grown-ups</div>' +
      '<button data-a="home" style="font-size:18px;padding:16px;border:0;border-radius:12px;background:#06408d;color:#fff">⌂ Back to the tiles</button>' +
      '<button data-a="off" style="font-size:18px;padding:16px;border:0;border-radius:12px;background:#eee;color:#333">Turn kiosk mode off</button>' +
      '<button data-a="x" style="font-size:16px;padding:12px;border:0;border-radius:12px;background:none;color:#666">Cancel</button></div>';
    bg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      var a = b ? b.getAttribute('data-a') : 'x';
      if (a === 'home') location.href = BASE + 'index.html';
      else if (a === 'off') { try { localStorage.removeItem('kiosk'); } catch (_) {} location.href = BASE + 'index.html'; }
      else bg.remove();
    });
    document.body.appendChild(bg);
  }

  // Press and hold a [data-kiosk-hold] element (the page title) for 3 seconds.
  function arm(el) {
    var t = null;
    function clear() { if (t) { clearTimeout(t); t = null; } }
    el.addEventListener('pointerdown', function () { clear(); t = setTimeout(function () { t = null; menu(); }, 3000); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { el.addEventListener(ev, clear); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.style.userSelect = 'none'; el.style.webkitUserSelect = 'none'; el.style.webkitTouchCallout = 'none';
  }
  document.addEventListener('DOMContentLoaded', function () {
    if (!on) return;
    document.querySelectorAll('[data-kiosk-hold]').forEach(arm);
  });
})();
