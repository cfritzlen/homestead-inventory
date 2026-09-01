// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: invite-user
//
// Lets a signed-in household member invite anyone by email.
// mode: "join"  → invitee joins the caller's household
//       "own"   → invitee gets their own household (names it on first login)
//
// Creates the auth user via the admin API (so magic-link login works even with
// public sign-ups disabled) and records a household_invites row that the
// invitee's first login consumes.
//
// Deploy with JWT verification ON (default): supabase functions deploy invite-user

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors();
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'not signed in' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: caller, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !caller?.user) return json({ error: 'invalid session' }, 401);

    const { email, mode } = await req.json();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'valid email required' }, 400);
    if (mode !== 'join' && mode !== 'own') return json({ error: "mode must be 'join' or 'own'" }, 400);

    // Caller must belong to a household
    const { data: membership } = await admin
      .from('household_members').select('household_id')
      .eq('user_id', caller.user.id).limit(1).maybeSingle();
    if (!membership) return json({ error: 'you are not in a household yet' }, 403);

    const householdId = mode === 'join' ? membership.household_id : null;

    // Create the auth user if they don't exist (idempotent-ish)
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,     // lets magic-link sign-in work immediately
    });
    if (createErr && !/already/i.test(createErr.message)) {
      return json({ error: `create user failed: ${createErr.message}` }, 500);
    }

    // Record the invite (skip if an identical unaccepted one exists)
    let q = admin.from('household_invites').select('id')
      .ilike('email', email).is('accepted_at', null);
    q = householdId === null ? q.is('household_id', null) : q.eq('household_id', householdId);
    const { data: existing } = await q.limit(1);
    if (!existing?.length) {
      const { error: invErr } = await admin.from('household_invites').insert({
        email, household_id: householdId, invited_by: caller.user.id,
      });
      if (invErr) return json({ error: `invite insert failed: ${invErr.message}` }, 500);
    }

    return json({
      ok: true,
      email,
      mode,
      note: mode === 'join'
        ? 'They can now sign in with a magic link and will land in your household.'
        : 'They can now sign in with a magic link and will be asked to name their own family.',
    });
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
