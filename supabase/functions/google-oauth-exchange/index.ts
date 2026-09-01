// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: google-oauth-exchange
//
// Called by oauth-callback.html after Google redirects with ?code=...
// Exchanges the code for tokens server-side (client_secret never touches the
// browser), resolves the CALLER's household from their session JWT, and stores
// the refresh token scoped to that household.
//
// Deploy WITHOUT platform JWT verification (the page passes the user JWT in
// the body of the Authorization header, which we verify ourselves):
//   supabase functions deploy google-oauth-exchange --no-verify-jwt

import { exchangeCode, emailFromIdToken, getServiceClient } from '../_shared/google.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const { code, redirect_uri, user_jwt } = await req.json();
    if (!code || !redirect_uri) return json({ error: 'missing code or redirect_uri' }, 400);
    if (!user_jwt) return json({ error: 'missing user_jwt — sign in first' }, 401);

    const supa = getServiceClient();

    // Who is connecting? Resolve their household.
    const { data: caller, error: userErr } = await supa.auth.getUser(user_jwt);
    if (userErr || !caller?.user) return json({ error: 'invalid session — sign in again' }, 401);
    const { data: membership } = await supa
      .from('household_members').select('household_id')
      .eq('user_id', caller.user.id).limit(1).maybeSingle();
    if (!membership) return json({ error: 'no household yet — finish onboarding first' }, 403);

    const tokens = await exchangeCode(code, redirect_uri);
    if (!tokens.refresh_token) {
      return json({
        error: "Google didn't return a refresh_token. Revoke this app's access at " +
               "myaccount.google.com/permissions and try again — refresh tokens are only issued on first consent."
      }, 400);
    }
    const email = emailFromIdToken(tokens.id_token);
    const expiresAt = new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString();

    // First account connected for a household becomes its calendar target
    const { data: existingTarget } = await supa
      .from('oauth_tokens').select('id')
      .eq('provider', 'google')
      .eq('household_id', membership.household_id)
      .eq('is_calendar_target', true)
      .limit(1);

    const { error } = await supa.from('oauth_tokens').upsert({
      provider: 'google',
      account_email: email,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expires_at: expiresAt,
      scopes: tokens.scope,
      household_id: membership.household_id,
      is_calendar_target: !existingTarget?.length,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'provider,account_email' });

    if (error) return json({ error: `db upsert failed: ${error.message}` }, 500);
    return json({ ok: true, account_email: email, scopes: tokens.scope });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function cors() { return new Response(null, { status: 204, headers: corsHeaders() }); }
function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
