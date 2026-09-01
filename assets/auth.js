// Shared auth helper. Include on every gated page BEFORE any page-specific code:
//
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/assets/auth.js"></script>
//   <script>Auth.requireAuth();</script>
//
// requireAuth() redirects to /login.html if there's no session. Session persistence
// is handled by supabase-js in localStorage.
//
// Provides:
//   Auth.client                       — the supabase client
//   Auth.requireAuth()                — call at top of every gated page
//   Auth.sendMagicLink(email)         — for login.html
//   Auth.signOut()                    — logs out and bounces to /login.html
//   Auth.getUser()                    — returns { email } or null
//   Auth.renderHeader(containerId)    — drops a shared header w/ sign-out button

(function (global) {
  const SUPABASE_URL = 'https://jzpipxvxrtdhmsdkveog.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6cGlweHZ4cnRkaG1zZGt2ZW9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3NTE1MjUsImV4cCI6MjA4NTMyNzUyNX0.7mm0ts91y0leGKLFCgRk6KJitah3V5WJZdiD_gHL57o';

  if (!global.supabase) {
    console.error('auth.js requires @supabase/supabase-js to be loaded first');
    return;
  }
  const client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Resolve login.html relative to the site root (works both on GitHub Pages
  // subpath and local file:// or root-hosted serves).
  const scriptEl = document.currentScript || Array.from(document.scripts).find(s => (s.src || '').includes('auth.js'));
  const BASE = scriptEl ? new URL('.', scriptEl.src).href.replace(/assets\/$/, '') : '';
  const LOGIN_URL = BASE + 'login.html';

  async function getSession() {
    const { data } = await client.auth.getSession();
    return data.session || null;
  }

  // Track the current access token so raw REST pages can send the user's JWT
  // instead of the anon key (RLS'd tables return nothing to anon).
  let accessToken = null;
  const ready = getSession().then(session => {
    accessToken = session ? session.access_token : null;
    return session;
  });
  client.auth.onAuthStateChange((_event, session) => {
    accessToken = session ? session.access_token : null;
  });

  // Bearer token for hand-rolled fetch() calls to /rest/v1 and /storage/v1.
  // Await Auth.ready before the first data load so the session has been
  // restored from storage; after that this stays fresh across token refreshes.
  function bearer() {
    return accessToken || SUPABASE_ANON_KEY;
  }

  // Pages guests (non-homestead households) may open; everything else is
  // homestead-members only and bounces guests to the Family Hub.
  const GUEST_PAGES = ['family-hub.html', 'oauth-callback.html', 'login.html'];

  async function requireAuth() {
    const session = await ready.then(() => getSession());
    if (!session) {
      const back = encodeURIComponent(location.pathname + location.search);
      location.replace(`${LOGIN_URL}?next=${back}`);
      return null;
    }

    const page = location.pathname.split('/').pop() || 'index.html';
    if (!GUEST_PAGES.includes(page)) {
      try {
        const { data: isMember } = await client.rpc('am_homestead_member');
        if (isMember === false) {
          location.replace(BASE + 'family-hub.html');
          return null;
        }
        // isMember === true, or null/error (pre-migration DB) → let through
      } catch (_) { /* rpc missing pre-migration — let through */ }
    }
    return session;
  }

  async function sendMagicLink(email) {
    const next = new URLSearchParams(location.search).get('next') || (BASE + 'index.html');
    // 'next' may be a relative path or absolute path; make it absolute for Supabase
    const redirectTo = next.startsWith('http')
      ? next
      : (next.startsWith('/') ? location.origin + next : new URL(next, location.href).href);
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw error;
  }

  async function signOut() {
    await client.auth.signOut();
    location.replace(LOGIN_URL);
  }

  async function getUser() {
    const session = await getSession();
    if (!session) return null;
    return { email: session.user.email };
  }

  function renderHeader(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#f4f4f0;border-bottom:1px solid #ddd;font-family:system-ui,sans-serif;font-size:13px;">
        <div>
          <a href="${BASE}index.html" style="color:#333;text-decoration:none;font-weight:600;">Homestead</a>
          &nbsp;·&nbsp;
          <a href="${BASE}family-hub.html" style="color:#555;text-decoration:none;">Family Hub</a>
          &nbsp;·&nbsp;
          <a href="${BASE}finances.html" style="color:#555;text-decoration:none;">Finances</a>
          &nbsp;·&nbsp;
          <a href="${BASE}inventory.html" style="color:#555;text-decoration:none;">Inventory</a>
          &nbsp;·&nbsp;
          <a href="${BASE}calendar.html" style="color:#555;text-decoration:none;">Calendar</a>
        </div>
        <div>
          <span id="__auth_email" style="color:#666;margin-right:8px;"></span>
          <button id="__auth_signout" style="font-size:12px;padding:2px 8px;cursor:pointer;">Sign out</button>
        </div>
      </div>`;
    getUser().then(u => {
      const emailSpan = document.getElementById('__auth_email');
      if (emailSpan && u) emailSpan.textContent = u.email;
    });
    document.getElementById('__auth_signout').addEventListener('click', signOut);
  }

  global.Auth = { client, ready, bearer, requireAuth, sendMagicLink, signOut, getUser, renderHeader };
})(window);
