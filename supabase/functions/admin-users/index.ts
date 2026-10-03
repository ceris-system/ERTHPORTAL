// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const authEmailDomain = 'accounts.erthportal.invalid';
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function usernameEmail(username: string) {
  return `${username}@${authEmailDomain}`;
}

function createTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const values = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(values, value => alphabet[value % alphabet.length]).join('');
}

async function findProfile(adminClient: ReturnType<typeof createClient>, id: string) {
  const { data, error } = await adminClient.from('profiles')
    .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, role, status')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error('Account profile was not found.');
  return data;
}

async function protectLastAdmin(adminClient: ReturnType<typeof createClient>, profile: { id: string; role: string; status: string }) {
  if (profile.role !== 'admin' || profile.status !== 'active') return;
  const { count, error } = await adminClient.from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('status', 'active');
  if (error) throw new Error('Could not verify active administrator count.');
  if ((count || 0) <= 1) throw new Error('Cannot remove or deactivate the last active administrator.');
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);

  try {
    const authorization = request.headers.get('Authorization');
    if (!authorization?.startsWith('Bearer ')) return respond({ error: 'Sign in is required.' }, 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: { user }, error: authError } = await adminClient.auth.getUser(authorization.slice(7));
    if (authError || !user) return respond({ error: 'Your session is invalid or expired.' }, 401);

    const actor = await findProfile(adminClient, user.id);
    const body = await request.json();
    if (body.action === 'activate-default') {
      if (actor.status !== 'default') return respond({ error: 'This account is not awaiting a password change.' }, 403);
      const { error } = await adminClient.from('profiles').update({ status: 'active' }).eq('id', user.id);
      if (error) throw new Error('Could not activate account.');
      return respond({ status: 'active' });
    }

    if (actor.role !== 'admin' || actor.status !== 'active') return respond({ error: 'Administrator access is required.' }, 403);

    if (body.action === 'list') {
      const { data, error } = await adminClient.from('profiles')
        .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, role, status, created_at')
        .order('username');
      if (error) throw new Error('Could not load account list.');
      return respond({ users: data });
    }

    if (body.action === 'create') {
      const username = String(body.username || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim();
      const googleEmail = String(body.googleEmail || '').trim().toLowerCase();
      const photoUrl = String(body.photoUrl || '').trim();
      const sheetUrl = String(body.sheetUrl || '').trim();
      const defaultPassword = String(body.defaultPassword || '').trim();
      const clientName = String(body.clientName || '').trim() || 'My spreadsheets';
      const role = body.role === 'admin' ? 'admin' : 'user';
      const status = ['default', 'active', 'inactive'].includes(String(body.status || '').trim()) ? String(body.status).trim() : 'default';
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) throw new Error('Username must be 3-40 characters: letters, numbers, dots, hyphens, or underscores.');
      if (!displayName) throw new Error('Display name is required.');
      if (googleEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(googleEmail)) throw new Error("If provided, Google email must be a valid email address.");

      const temporaryPassword = defaultPassword || createTemporaryPassword();
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email: usernameEmail(username),
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { username }
      });
      if (createError || !created.user) throw new Error(createError?.message || 'Could not create account.');

      const { data: profile, error: profileError } = await adminClient.from('profiles').insert({
        id: created.user.id,
        username,
        display_name: displayName,
        photo_url: photoUrl || '',
        sheet_url: sheetUrl || '',
        google_email: googleEmail || '',
        client_name: clientName,
        role,
        status
      }).select('id, username, display_name, photo_url, sheet_url, google_email, client_name, role, status').single();
      if (profileError || !profile) {
        await adminClient.auth.admin.deleteUser(created.user.id);
        throw new Error(profileError?.message || 'Could not create account profile.');
      }
      return respond({ user: profile, temporaryPassword: defaultPassword ? defaultPassword : temporaryPassword });
    }

    const targetUsername = String(body.username || '').trim().toLowerCase();
    const { data: target, error: targetError } = await adminClient.from('profiles')
      .select('id, username, display_name, google_email, client_name, role, status')
      .eq('username', targetUsername)
      .single();
    if (targetError || !target) throw new Error('Username was not found.');

    if (body.action === 'reset-password') {
      const temporaryPassword = createTemporaryPassword();
      const { error } = await adminClient.auth.admin.updateUserById(target.id, { password: temporaryPassword });
      if (error) throw new Error('Could not reset the account password.');
      const { error: statusError } = await adminClient.from('profiles').update({ status: 'default' }).eq('id', target.id);
      if (statusError) throw new Error('Password reset, but account status could not be updated.');
      return respond({ username: target.username, temporaryPassword });
    }

    if (body.action === 'set-status') {
      const status = body.status;
      if (!['active', 'inactive'].includes(status)) throw new Error('Choose active or inactive status.');
      if (status === 'inactive') await protectLastAdmin(adminClient, target);
      const { error } = await adminClient.from('profiles').update({ status }).eq('id', target.id);
      if (error) throw new Error('Could not update account status.');
      return respond({ username: target.username, status });
    }

    if (body.action === 'delete') {
      await protectLastAdmin(adminClient, target);
      const { error } = await adminClient.auth.admin.deleteUser(target.id);
      if (error) throw new Error('Could not delete account.');
      return respond({ username: target.username, deleted: true });
    }

    return respond({ error: 'Unknown account action.' }, 400);
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Unexpected account service error.' }, 400);
  }
});