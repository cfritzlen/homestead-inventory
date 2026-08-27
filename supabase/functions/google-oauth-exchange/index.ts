// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: google-oauth-exchange
//
// Called by oauth-callback.html after Google redirects with ?code=...
// Exchanges the code for tokens (server-side so the client_secret never touches
// the browser), stores refresh_token in oauth_tokens, and returns success.
//
// This function must be exposed WITHOUT auth verification because it's called
// from an unauthenticated context (the OAuth callback happens before we know
// who the user is). Deploy with:  supabase functions deploy google-oauth-exchange --no-verify-jwt

import { exchangeCode, emailFromIdToken, getServiceClient } from '../_shared/google.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const { code, redirect_uri } = await req.json();
    if (!code || !redirect_uri) return json({ error: 'missing code or redirect_uri' }, 400);

    const tokens = await exchangeCode(code, redirect_uri);
    if (!tokens.refresh_token) {
      return json({
        error: "Google didn't return a refresh_token. Revoke this app's access at " +
               "myaccount.google.com/permissions and try again — refresh tokens are only issued on first consent."
      }, 400);
    }
    const email = emailFromIdToken(tokens.id_token);
    const supa = getServiceClient();
    const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();

    const { error } = await supa.from('oauth_tokens').upsert({
      provider: 'google',
      account_email: email,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: expiresAt,
      scopes: tokens.scope,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'provider,account_email' });

    if (error) return json({ error: `db upsert failed: ${error.message}` }, 500);
    return json({ ok: true, account_email: email, scopes: tokens.scope }, 200, corsHeaders());
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function cors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
function json(obj: any, status = 200, extraHeaders: Record<string,string> = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}
