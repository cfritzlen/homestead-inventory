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

  const LOGIN_PATH = '/login.html';

  async function getSession() {
    const { data } = await client.auth.getSession();
    return data.session || null;
  }

  async function requireAuth() {
    const session = await getSession();
    if (!session) {
      const back = encodeURIComponent(location.pathname + location.search);
      location.replace(`${LOGIN_PATH}?next=${back}`);
      return null;
    }
    return session;
  }

  async function sendMagicLink(email) {
    const next = new URLSearchParams(location.search).get('next') || '/index.html';
    const redirectTo = `${location.origin}${next}`;
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    if (error) throw error;
  }

  async function signOut() {
    await client.auth.signOut();
    location.replace(LOGIN_PATH);
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
          <a href="/index.html" style="color:#333;text-decoration:none;font-weight:600;">Homestead</a>
          &nbsp;·&nbsp;
          <a href="/family-hub.html" style="color:#555;text-decoration:none;">Family Hub</a>
          &nbsp;·&nbsp;
          <a href="/finances.html" style="color:#555;text-decoration:none;">Finances</a>
          &nbsp;·&nbsp;
          <a href="/inventory.html" style="color:#555;text-decoration:none;">Inventory</a>
          &nbsp;·&nbsp;
          <a href="/calendar.html" style="color:#555;text-decoration:none;">Calendar</a>
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

  global.Auth = { client, requireAuth, sendMagicLink, signOut, getUser, renderHeader };
})(window);
