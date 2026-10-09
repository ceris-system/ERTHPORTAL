// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const authEmailDomain = 'accounts.erthportal.invalid';
const dashboardNames = new Set([
  'PLANTILLA', 'PLANTILLA SUMMARY', 'SIL', 'VCODE MASTERLIST', 'VACANCY MONITORING',
  'HR EMPLOC MONITORING', '+-5% BUFFER', 'VCODE VARIANCE', 'DEACTIVATION', 'FOR APPROVAL', 'ATTRITION',
  'INACTIVE'
]);
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
  return `${username.toLowerCase()}@${authEmailDomain}`;
}

function createTemporaryPassword() {
  const values = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(values, value => String(value % 10)).join('');
}

async function findProfile(adminClient: ReturnType<typeof createClient>, id: string) {
  const profileQuery = adminClient.from('profiles');
  const { data, error } = await profileQuery
    .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, client_names, managed_user_ids, is_master_admin, role, status')
    .eq('id', id)
    .single();
  if (!error && data) return data;
  const missingManagedUsersColumn = error && /managed_user_ids/i.test(`${error.message || ''} ${error.details || ''} ${error.hint || ''}`)
    && /column|schema cache/i.test(`${error.message || ''} ${error.details || ''}`);
  if (!missingManagedUsersColumn) throw new Error('Account profile was not found.');
  const fallback = await adminClient.from('profiles')
    .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, client_names, is_master_admin, role, status')
    .eq('id', id)
    .single();
  if (fallback.error || !fallback.data) throw new Error('Account profile was not found.');
  return fallback.data;
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

function canManageUserProfile(actor: any, target: any) {
  if (actor.is_master_admin || target.id === actor.id) return true;
  if (target.role !== 'user') return false;
  if (Array.isArray(actor.managed_user_ids)) return actor.managed_user_ids.includes(target.id);
  const actorClients = new Set((actor.client_names?.length ? actor.client_names : [actor.client_name])
    .map((client: string) => String(client || '').toLocaleLowerCase()));
  const targetClients = target.client_names?.length ? target.client_names : [target.client_name];
  return targetClients.some((client: string) => client && client !== 'My spreadsheets' && actorClients.has(String(client).toLocaleLowerCase()));
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
    if (body.action === 'heartbeat') {
      if (actor.status === 'inactive') return respond({ error: 'This account is inactive.' }, 403);
      const lastSeenAt = new Date().toISOString();
      const { error } = await adminClient.from('profiles')
        .update({ last_seen_at: lastSeenAt })
        .eq('id', user.id);
      if (error) throw new Error('Could not update online presence.');
      return respond({ lastSeenAt });
    }
    if (body.action === 'activate-default') {
      if (actor.status !== 'default') return respond({ error: 'This account is not awaiting a password change.' }, 403);
      const { error } = await adminClient.from('profiles').update({ status: 'active' }).eq('id', user.id);
      if (error) throw new Error('Could not activate account.');
      return respond({ status: 'active' });
    }

    if (body.action === 'my-dashboard-sources') {
      const { data, error } = await adminClient.from('dashboard_assignments')
        .select('dashboard_name, sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs, client_buffer_detail_tabs')
        .eq('user_id', user.id);
      if (error) throw new Error('Could not load your assigned dashboard spreadsheets.');
      return respond({ assignments: data || [] });
    }

    if (body.action === 'update-own-account') {
      const completingDefaultAccount = actor.status === 'default';
      if (actor.status !== 'active' && !completingDefaultAccount) throw new Error('Only active accounts can change account settings.');
      const username = String(body.username || '').trim();
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const photoUrl = typeof body.photoUrl === 'string' ? body.photoUrl.trim() : undefined;
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/i.test(username)) {
        throw new Error('Username must be 3-40 characters: letters, numbers, dots, hyphens, or underscores.');
      }
      if (photoUrl !== undefined && photoUrl.length > 700_000) throw new Error('Profile photo must be smaller than 512 KB.');
      if (photoUrl) {
        const isInlineImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photoUrl);
        let isHttpsImageUrl = false;
        try { isHttpsImageUrl = new URL(photoUrl).protocol === 'https:'; } catch { /* not an absolute image URL */ }
        if (!isInlineImage && !isHttpsImageUrl) throw new Error('Use an HTTPS profile photo URL or choose an image file.');
      }
      if (newPassword && !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(newPassword)) {
        throw new Error('New password must be at least 8 characters and include both letters and numbers.');
      }
      if (completingDefaultAccount && !newPassword) throw new Error('Choose a new password to activate this account.');

      if (username !== actor.username) {
        const { data: existingProfiles, error: existingError } = await adminClient.from('profiles')
          .select('id, username');
        if (existingError) throw new Error('Could not check whether that username is available.');
        const existing = existingProfiles?.find((profile: any) =>
          profile.id !== user.id && String(profile.username).toLowerCase() === username.toLowerCase()
        );
        if (existing) throw new Error('That username is already in use.');

        const { error: profileError } = await adminClient.from('profiles')
          .update({ username })
          .eq('id', user.id);
        if (profileError) throw new Error('Could not update username.');
      }

      const authChanges: Record<string, unknown> = {};
      if (username !== actor.username) {
        if (username.toLowerCase() !== actor.username.toLowerCase()) authChanges.email = usernameEmail(username);
        authChanges.email_confirm = true;
        authChanges.user_metadata = { ...user.user_metadata, username };
      }
      if (newPassword) authChanges.password = newPassword;
      if (Object.keys(authChanges).length) {
        const { error: updateError } = await adminClient.auth.admin.updateUserById(user.id, authChanges);
        if (updateError) {
          if (username !== actor.username) {
            const { error: rollbackError } = await adminClient.from('profiles')
              .update({ username: actor.username })
              .eq('id', user.id);
            if (rollbackError) throw new Error('Account update failed, and the old username could not be restored. Contact the administrator.');
          }
          throw new Error(updateError.message || 'Could not update account settings.');
        }
      }
      if (completingDefaultAccount) {
        const { error: statusError } = await adminClient.from('profiles').update({ status: 'active' }).eq('id', user.id);
        if (statusError) throw new Error('Credentials were changed, but the account could not be activated. Contact the administrator.');
      }
      if (photoUrl !== undefined) {
        const { error: photoError } = await adminClient.from('profiles').update({ photo_url: photoUrl }).eq('id', user.id);
        if (photoError) throw new Error('Account credentials were updated, but the profile photo could not be saved.');
      }
      return respond({ username, photoUrl: photoUrl ?? actor.photo_url, passwordUpdated: !!newPassword, status: completingDefaultAccount ? 'active' : actor.status });
    }

    if (actor.role !== 'admin' || actor.status !== 'active') return respond({ error: 'Administrator access is required.' }, 403);
    if (!actor.is_master_admin && !['list', 'get-dashboard-assignment', 'set-dashboard-assignment'].includes(body.action)) {
      return respond({ error: 'Master Admin access is required for account management.' }, 403);
    }

    if (body.action === 'list') {
      const { data, error } = await adminClient.from('profiles')
        .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, client_names, is_master_admin, role, status, created_at, last_seen_at')
        .order('username');
      if (error) throw new Error('Could not load account list.');
      const users = actor.is_master_admin
        ? data || []
        : (data || []).filter((profile: any) => canManageUserProfile(actor, profile));
      return respond({ users });
    }

    if (body.action === 'get-dashboard-assignment' || body.action === 'set-dashboard-assignment') {
      if (!actor.is_master_admin) {
        return respond({ error: 'Only the Master Admin can view or change dashboard spreadsheet assignments.' }, 403);
      }
      const username = String(body.username || '').trim();
      const dashboardName = String(body.dashboardName || '').trim();
      if (!dashboardNames.has(dashboardName)) throw new Error('Choose a valid dashboard.');
      const { data: target, error: targetError } = await adminClient.from('profiles')
        .select('id, username, role, is_master_admin, client_name, client_names')
        .eq('username', username)
        .single();
      if (targetError || !target || (target.is_master_admin && target.id !== actor.id)) throw new Error('Choose a valid account.');
      if (dashboardName === 'INACTIVE' && (!actor.is_master_admin || !target.is_master_admin)) {
        throw new Error('The INACTIVE archive spreadsheet is available only to the Master Admin.');
      }
      if (!canManageUserProfile(actor, target)) {
        throw new Error('This account is not assigned to your administrator account.');
      }

      if (body.action === 'get-dashboard-assignment') {
        const { data, error } = await adminClient.from('dashboard_assignments')
          .select('sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs, client_buffer_detail_tabs')
          .eq('user_id', target.id)
          .eq('dashboard_name', dashboardName)
          .maybeSingle();
        if (error) throw new Error('Could not load this user\'s spreadsheet assignment.');
        const clientNames = data?.client_names?.length
          ? data.client_names
          : target.client_names?.length
            ? target.client_names
            : [target.client_name].filter(Boolean);
        return respond({
          username,
          dashboardName,
          urls: data?.sheet_urls || [],
          clientNames,
          clientSheetUrls: data?.client_sheet_urls || {},
          sheetTab: data?.sheet_tab || '',
          clientSheetTabs: data?.client_sheet_tabs || {},
          clientBufferDetailTabs: data?.client_buffer_detail_tabs || {}
        });
      }

      if (!Array.isArray(body.urls) || body.urls.length > 30) throw new Error('Provide up to 30 spreadsheet URLs.');
      if (!Array.isArray(body.clientNames)) throw new Error('Select client(s) for this dashboard.');
      const clientNames = [...new Set(body.clientNames.map((value: unknown) => {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Choose valid client names.');
        return value.trim();
      }))];
      if (dashboardName === 'INACTIVE' && clientNames.length) {
        throw new Error('The INACTIVE archive does not use client assignments.');
      }
      const sourceSetup = target.is_master_admin
        && ((dashboardName === 'HR EMPLOC MONITORING' && clientNames.length === 0)
          || (dashboardName === 'INACTIVE' && clientNames.length === 0));
      if (!actor.is_master_admin && clientNames.some(name => !(actor.client_names || [actor.client_name]).includes(name))) {
        throw new Error('You can assign only clients granted to your administrator account.');
      }
      const allowedClientCount = target.role === 'admin' ? 30 : 1;
      if (!sourceSetup && (clientNames.length < 1 || clientNames.length > allowedClientCount)) {
        throw new Error(target.role === 'admin' ? 'Select between 1 and 30 clients for an administrator.' : 'Select exactly one client for a user account.');
      }
      const urls = body.urls.map((value: unknown) => {
        if (typeof value !== 'string') throw new Error('Each spreadsheet URL must be text.');
        let url: URL;
        try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete spreadsheet URL.'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Spreadsheet URLs must use HTTP or HTTPS.');
        return url.href;
      });
      const clientSheetUrls: Record<string, string> = {};
      if (body.clientSheetUrls !== undefined) {
        if (!body.clientSheetUrls || typeof body.clientSheetUrls !== 'object' || Array.isArray(body.clientSheetUrls)) {
          throw new Error('Provide a spreadsheet URL for each assigned client.');
        }
        for (const clientName of clientNames) {
          const assignedUrl = body.clientSheetUrls[clientName];
          if (typeof assignedUrl !== 'string' || !assignedUrl.trim()) {
            throw new Error(`Provide a spreadsheet URL for ${clientName}.`);
          }
          let parsed: URL;
          try { parsed = new URL(assignedUrl.trim()); } catch { throw new Error(`Enter a complete spreadsheet URL for ${clientName}.`); }
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Spreadsheet URLs must use HTTP or HTTPS.');
          clientSheetUrls[clientName] = parsed.href;
        }
        if (Object.keys(body.clientSheetUrls).some(client => !clientNames.includes(client))) {
          throw new Error('Each spreadsheet URL must match a selected client.');
        }
      }
      const sheetTab = typeof body.sheetTab === 'string' ? body.sheetTab.trim() : '';
      if (sheetTab.length > 100) throw new Error('Tab names must be 100 characters or fewer.');
      if (/[:\\/?*\[\]\r\n]/.test(sheetTab)) throw new Error('Tab names cannot contain /, \\, ?, *, :, or square brackets.');
      const clientSheetTabs: Record<string, string> = {};
      if (body.clientSheetTabs !== undefined) {
        if (!body.clientSheetTabs || typeof body.clientSheetTabs !== 'object' || Array.isArray(body.clientSheetTabs)) {
          throw new Error('Provide valid tab names for assigned clients.');
        }
        for (const clientName of clientNames) {
          const assignedTab = body.clientSheetTabs[clientName];
          if (assignedTab !== undefined) {
            if (typeof assignedTab !== 'string' || assignedTab.trim().length > 100) {
              throw new Error(`Enter a valid tab name for ${clientName} (up to 100 characters).`);
            }
            if (/[:\\/?*\[\]\r\n]/.test(assignedTab.trim())) throw new Error(`The tab name for ${clientName} contains an unsupported character.`);
            clientSheetTabs[clientName] = assignedTab.trim();
          }
        }
        if (Object.keys(body.clientSheetTabs).some(client => !clientNames.includes(client))) {
          throw new Error('Each tab name must match a selected client.');
        }
      }
      const clientBufferDetailTabs: Record<string, Record<string, string>> = {};
      const bufferDetailKeys = [
        'plantillaNotInMika',
        'mikaNotInPlantilla',
        'plantillaNotInPayroll',
        'payrollNotInPlantilla'
      ];
      if (body.clientBufferDetailTabs !== undefined) {
        if (!body.clientBufferDetailTabs || typeof body.clientBufferDetailTabs !== 'object' || Array.isArray(body.clientBufferDetailTabs)) {
          throw new Error('Provide valid detail tab names for assigned clients.');
        }
        for (const clientName of clientNames) {
          const clientTabs = body.clientBufferDetailTabs[clientName];
          if (clientTabs === undefined) continue;
          if (!clientTabs || typeof clientTabs !== 'object' || Array.isArray(clientTabs)) {
            throw new Error(`Provide valid detail tab names for ${clientName}.`);
          }
          const cleanTabs: Record<string, string> = {};
          for (const key of bufferDetailKeys) {
            const tabName = clientTabs[key];
            if (tabName === undefined) continue;
            if (typeof tabName !== 'string' || tabName.trim().length > 100) {
              throw new Error(`Enter a valid detail tab name for ${clientName} (up to 100 characters).`);
            }
            if (/[:\\/?*\[\]\r\n]/.test(tabName.trim())) {
              throw new Error(`The detail tab name for ${clientName} contains an unsupported character.`);
            }
            cleanTabs[key] = tabName.trim();
          }
          clientBufferDetailTabs[clientName] = cleanTabs;
        }
        if (Object.keys(body.clientBufferDetailTabs).some(client => !clientNames.includes(client))) {
          throw new Error('Each detail tab name must match a selected client.');
        }
      }
      const { error } = await adminClient.from('dashboard_assignments').upsert({
        user_id: target.id,
        dashboard_name: dashboardName,
        sheet_urls: urls.length ? urls : [...new Set(Object.values(clientSheetUrls))],
        client_names: clientNames,
        client_sheet_urls: clientSheetUrls,
        sheet_tab: sheetTab,
        client_sheet_tabs: clientSheetTabs,
        client_buffer_detail_tabs: clientBufferDetailTabs,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,dashboard_name' });
      if (error) throw new Error('Could not save this user\'s spreadsheet assignment.');
      if (target.role === 'admin' && !target.is_master_admin) {
        const existingClients = Array.isArray(target.client_names) ? target.client_names : [];
        const updatedClients = [...new Set([...existingClients, ...clientNames])];
        const { error: profileError } = await adminClient.from('profiles')
          .update({
            client_names: updatedClients,
            client_name: target.client_name === 'My spreadsheets' ? updatedClients[0] : target.client_name
          })
          .eq('id', target.id);
        if (profileError) throw new Error('Dashboard assignment was saved, but the administrator client access list could not be updated.');
      }
      return respond({ username, dashboardName, urls, clientNames, sheetTab, clientSheetTabs, clientBufferDetailTabs });
    }

    if (body.action === 'create') {
      const username = String(body.username || '').trim();
      const displayName = String(body.displayName || '').trim();
      const googleEmail = String(body.googleEmail || '').trim().toLowerCase();
      const photoUrl = String(body.photoUrl || '').trim();
      const sheetUrl = String(body.sheetUrl || '').trim();
      const defaultPassword = String(body.defaultPassword || '').trim();
      const clientName = String(body.clientName || '').trim() || 'My spreadsheets';
      const clientNames = [...new Set((Array.isArray(body.clientNames) ? body.clientNames : [clientName])
        .map((value: unknown) => String(value || '').trim())
        .filter(Boolean))];
      const role = body.role === 'admin' ? 'admin' : 'user';
      const managedUserIds = role === 'admin' && Array.isArray(body.managedUserIds)
        ? [...new Set(body.managedUserIds.map((value: unknown) => {
          if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
            throw new Error('Choose valid user accounts for this administrator.');
          }
          return value;
        }))]
        : [];
      const status = ['default', 'active', 'inactive'].includes(String(body.status || '').trim()) ? String(body.status).trim() : 'default';
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/i.test(username)) throw new Error('Username must be 3-40 characters: letters, numbers, dots, hyphens, or underscores.');
      if (!displayName) throw new Error('Display name is required.');
      if (role === 'admin' && !actor.is_master_admin) throw new Error('Only the Master Admin can create administrator accounts.');
      if (!actor.is_master_admin && clientNames.some(name => !(actor.client_names || [actor.client_name]).includes(name))) {
        throw new Error('You can create accounts only for clients granted to your administrator account.');
      }
      if (role === 'user' && clientNames.length !== 1) throw new Error('Choose exactly one client for a user account.');
      if (role === 'admin' && (clientNames.length < 1 || clientNames.length > 30)) throw new Error('Choose between 1 and 30 clients for an administrator.');
      if (googleEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(googleEmail)) throw new Error("If provided, Google email must be a valid email address.");

      const { data: existingProfiles, error: existingProfilesError } = await adminClient.from('profiles').select('username');
      if (existingProfilesError) throw new Error('Could not check whether that username is available.');
      if (existingProfiles?.some((profile: any) => String(profile.username).toLowerCase() === username.toLowerCase())) {
        throw new Error('That username is already in use.');
      }

      if (role === 'admin' && managedUserIds.length) {
        const { data: managedUsers, error: managedUsersError } = await adminClient.from('profiles')
          .select('id, role, is_master_admin, client_name, client_names')
          .in('id', managedUserIds);
        if (managedUsersError) throw new Error('Could not validate the selected user accounts.');
        if (!managedUsers || managedUsers.length !== managedUserIds.length ||
          managedUsers.some(profile => profile.role !== 'user' || profile.is_master_admin)) {
          throw new Error('Select only existing User accounts to assign to a Regular Admin.');
        }
        const assignedClients = new Set(clientNames.map(name => name.toLocaleLowerCase()));
        const outsideScope = managedUsers.some(profile => {
          const profileClients = Array.isArray(profile.client_names) && profile.client_names.length
            ? profile.client_names
            : [profile.client_name];
          const scopedClients = profileClients.filter((name: string) => name && name !== 'My spreadsheets');
          return !scopedClients.length || scopedClients.some((name: string) => !assignedClients.has(name.toLocaleLowerCase()));
        });
        if (outsideScope) throw new Error('Each selected account must belong to a client assigned to this Regular Admin.');
      }

      const temporaryPassword = defaultPassword || createTemporaryPassword();
      if (status === 'default' && !/^\d{8,}$/.test(temporaryPassword)) {
        throw new Error('A default account password must contain at least 8 digits only.');
      }
      if (status !== 'default' && !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(temporaryPassword)) {
        throw new Error('Active or inactive accounts need an initial password of at least 8 characters with both letters and numbers.');
      }
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
        client_name: role === 'admin' ? 'ADMIN' : clientNames[0] || clientName,
        client_names: clientNames,
        managed_user_ids: role === 'admin' ? managedUserIds : null,
        is_master_admin: false,
        role,
        status
      }).select('id, username, display_name, photo_url, sheet_url, google_email, client_name, client_names, is_master_admin, role, status').single();
      if (profileError || !profile) {
        await adminClient.auth.admin.deleteUser(created.user.id);
        throw new Error(profileError?.message || 'Could not create account profile.');
      }
      return respond({ user: profile, temporaryPassword: defaultPassword ? defaultPassword : temporaryPassword });
    }

    if (body.action === 'bulk-set-status') {
      const status = String(body.status || '');
      const submitted = body.usernames;
      if (!['active', 'inactive', 'default'].includes(status)) throw new Error('Choose active, inactive, or default status.');
      if (!Array.isArray(submitted) || submitted.length < 1 || submitted.length > 200) {
        throw new Error('Select between 1 and 200 accounts.');
      }
      const usernames = [...new Set(submitted.map((value: unknown) => {
        if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,39}$/i.test(value.trim())) {
          throw new Error('The selected account list is invalid.');
        }
        return value.trim();
      }))];
      const { data: targets, error: targetsError } = await adminClient.from('profiles')
        .select('id, username, role, status, is_master_admin, client_name, client_names')
        .in('username', usernames);
      if (targetsError) throw new Error('Could not load the selected accounts.');
      if (!targets || targets.length !== usernames.length) throw new Error('One or more selected accounts no longer exist. Refresh the list and try again.');
      if (targets.some(target => target.is_master_admin)) throw new Error('The Master Admin account cannot be changed in a bulk status update.');
      if (!actor.is_master_admin && targets.some(target => !canManageUserProfile(actor, target))) {
        throw new Error('One or more selected accounts are not assigned to your administrator account.');
      }
      if (!actor.is_master_admin && targets.some(target => target.role === 'admin')) {
        throw new Error('Only the Master Admin can change administrator account statuses.');
      }

      if (status !== 'active') {
        const { count, error: countError } = await adminClient.from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('role', 'admin')
          .eq('status', 'active');
        if (countError) throw new Error('Could not verify active administrator count.');
        const selectedActiveAdmins = targets.filter(target => target.role === 'admin' && target.status === 'active').length;
        if ((count || 0) - selectedActiveAdmins < 1) {
          throw new Error('The bulk change would remove the last active administrator.');
        }
      }

      const { error: updateError } = await adminClient.from('profiles').update({ status }).in('username', usernames);
      if (updateError) throw new Error('Could not update the selected account statuses.');
      return respond({ status, usernames });
    }

    const targetUsername = String(body.username || '').trim();
    const { data: target, error: targetError } = await adminClient.from('profiles')
      .select('id, username, display_name, google_email, client_name, client_names, is_master_admin, role, status')
      .eq('username', targetUsername)
      .single();
    if (targetError || !target) throw new Error('Username was not found.');
    if (target.is_master_admin) throw new Error('The Master Admin account cannot be modified through user management.');
    if (!canManageUserProfile(actor, target)) {
      throw new Error('This account is not assigned to your administrator account.');
    }

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
      if (!['active', 'inactive', 'default'].includes(status)) throw new Error('Choose active, inactive, or default status.');
      if (status !== 'active') await protectLastAdmin(adminClient, target);
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