// Shared helpers for Google OAuth token refresh + API calls, used by
// gmail-ingest, push-to-calendar, and google-oauth-exchange.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  account_email: string;
  scopes: string;
}

/** Ensure we have a non-expired access token, refreshing if needed. */
export async function getFreshAccessToken(
  supa: SupabaseClient,
  accountEmail: string,
): Promise<string> {
  const { data: row, error } = await supa
    .from('oauth_tokens')
    .select('*')
    .eq('provider', 'google')
    .eq('account_email', accountEmail)
    .single();
  if (error || !row) throw new Error(`no oauth_tokens row for ${accountEmail}: ${error?.message}`);

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row.access_token && expiresAt - Date.now() > 60_000) {
    return row.access_token;
  }

  // Refresh
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`google refresh failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const newExpires = new Date(Date.now() + (body.expires_in - 60) * 1000).toISOString();

  await supa.from('oauth_tokens').update({
    access_token: body.access_token,
    expires_at: newExpires,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);

  return body.access_token;
}

/** Exchange an OAuth authorization code for tokens (called from oauth callback). */
export async function exchangeCode(code: string, redirectUri: string) {
  const params = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`google exchange failed: ${res.status} ${await res.text()}`);
  return await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
    id_token: string;
  };
}

/** Decode the email out of a Google id_token without verifying signature. */
export function emailFromIdToken(idToken: string): string {
  const payload = idToken.split('.')[1];
  const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  return decoded.email as string;
}

export function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}
