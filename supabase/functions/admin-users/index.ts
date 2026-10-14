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

async function writeAuditEvent(
  adminClient: ReturnType<typeof createClient>,
  actor: any,
  auditSessionId: unknown,
  event: {
    eventType: string;
    dashboardName?: string;
    action: string;
    target?: string;
    details?: unknown;
    changeCompleted?: boolean;
  }
) {
  if (!auditSessionId) {
    if (!event.changeCompleted) return;
    throw new Error('The account change was saved, but it could not be linked to an activity history session.');
  }
  const historyError = (message: string) => new Error(event.changeCompleted
    ? `The account change was saved, but ${message}`
    : message);
  const sessionId = String(auditSessionId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw historyError('the activity history session is invalid. Sign out and sign in again.');
  }
  const { data: session, error: sessionError } = await adminClient.from('audit_sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('user_id', actor.id)
    .is('ended_at', null)
    .maybeSingle();
  if (sessionError || !session) throw historyError('the activity history session could not be verified. Sign out and sign in again.');
  const details = event.details ?? {};
  if (JSON.stringify(details).length > 250_000) throw historyError('the activity history details are too large to store.');
  const { error } = await adminClient.from('audit_events').insert({
    session_id: sessionId,
    actor_user_id: actor.id,
    actor_username: actor.username,
    event_type: event.eventType,
    dashboard_name: event.dashboardName || '',
    action: event.action,
    target: event.target || '',
    details
  });
  if (error) throw historyError('the activity history could not be saved.');
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
  const actorClients = new Set((actor.client_names?.length ? actor.client_names : [actor.client_name])
    .map((client: string) => String(client || '').toLocaleLowerCase()));
  const targetClients = target.client_names?.length ? target.client_names : [target.client_name];
  const hasClientAccess = targetClients.some((client: string) =>
    client && client !== 'My spreadsheets' && actorClients.has(String(client).toLocaleLowerCase()));
  if (!hasClientAccess) return false;
  if (Array.isArray(actor.managed_user_ids)) return actor.managed_user_ids.includes(target.id);
  return true;
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
      if (body.auditSessionId) {
        const { error: auditError } = await adminClient.from('audit_sessions')
          .update({ last_activity_at: lastSeenAt })
          .eq('id', body.auditSessionId)
          .eq('user_id', user.id)
          .is('ended_at', null);
        if (auditError) throw new Error('Could not update activity history heartbeat.');
      }
      return respond({ lastSeenAt });
    }
    if (body.action === 'start-audit-session') {
      if (actor.status === 'inactive') return respond({ error: 'This account is inactive.' }, 403);
      const clientNames = Array.isArray(actor.client_names) && actor.client_names.length
        ? actor.client_names
        : [actor.client_name].filter(Boolean);
      const { data: session, error } = await adminClient.from('audit_sessions')
        .insert({
          user_id: actor.id,
          username: actor.username,
          display_name: actor.display_name,
          role: actor.is_master_admin ? 'master_admin' : actor.role,
          client_names: clientNames,
          user_agent: String(body.userAgent || '').slice(0, 500)
        })
        .select('id, started_at')
        .single();
      if (error || !session) throw new Error('Could not start the login activity history session.');
      await writeAuditEvent(adminClient, actor, session.id, {
        eventType: 'session',
        action: 'login',
        details: { role: actor.is_master_admin ? 'master_admin' : actor.role }
      });
      return respond({ auditSessionId: session.id, startedAt: session.started_at });
    }
    if (body.action === 'resume-audit-session') {
      if (actor.status === 'inactive') return respond({ error: 'This account is inactive.' }, 403);
      const sessionId = String(body.auditSessionId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error('The audit session is invalid. Sign out and sign in again.');
      }
      const { data: session, error } = await adminClient.from('audit_sessions')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('id', sessionId)
        .eq('user_id', actor.id)
        .is('ended_at', null)
        .select('id')
        .maybeSingle();
      if (error || !session) throw new Error('Could not resume activity history for this session. Sign out and sign in again.');
      return respond({ auditSessionId: session.id });
    }
    if (body.action === 'record-audit-event') {
      const eventType = String(body.eventType || '');
      const action = String(body.eventAction || '').trim();
      const dashboardName = String(body.dashboardName || '').trim();
      if (!['navigation', 'action', 'edit', 'session'].includes(eventType) ||
        !action || action.length > 120 || dashboardName.length > 100) {
        throw new Error('The activity history event is invalid.');
      }
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType,
        action,
        dashboardName,
        target: String(body.target || '').slice(0, 200),
        details: body.details && typeof body.details === 'object' ? body.details : {}
      });
      return respond({ recorded: true });
    }
    if (body.action === 'end-audit-session') {
      const sessionId = String(body.auditSessionId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error('The audit session is invalid.');
      }
      const endedAt = new Date().toISOString();
      const { data: session, error: sessionError } = await adminClient.from('audit_sessions')
        .update({ ended_at: endedAt, last_activity_at: endedAt, end_reason: String(body.reason || 'logout').slice(0, 80) })
        .eq('id', sessionId)
        .eq('user_id', actor.id)
        .is('ended_at', null)
        .select('id')
        .maybeSingle();
      if (sessionError || !session) throw new Error('Could not close the login activity history session.');
      const { error } = await adminClient.from('audit_events').insert({
        session_id: sessionId,
        actor_user_id: actor.id,
        actor_username: actor.username,
        event_type: 'session',
        action: 'logout',
        target: '',
        details: { reason: String(body.reason || 'logout').slice(0, 80) }
      });
      if (error) throw new Error('Session closed, but the logout event could not be saved.');
      return respond({ endedAt });
    }
    if (body.action === 'activate-default') {
      if (actor.status !== 'default') return respond({ error: 'This account is not awaiting a password change.' }, 403);
      const { error } = await adminClient.from('profiles').update({ status: 'active' }).eq('id', user.id);
      if (error) throw new Error('Could not activate account.');
      return respond({ status: 'active' });
    }

    if (body.action === 'my-dashboard-sources') {
      const { data, error } = await adminClient.from('dashboard_assignments')
        .select('dashboard_name, sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs, client_buffer_detail_tabs, client_vcode_source_urls, client_vcode_source_tabs, client_vcode_deleted_tabs')
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
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'action',
        action: 'updated own account',
        target: username,
        changeCompleted: true,
        details: {
          username: { before: actor.username, after: username },
          passwordChanged: !!newPassword,
          profilePhotoChanged: photoUrl !== undefined,
          status: completingDefaultAccount ? { before: actor.status, after: 'active' } : undefined
        }
      });
      return respond({ username, photoUrl: photoUrl ?? actor.photo_url, passwordUpdated: !!newPassword, status: completingDefaultAccount ? 'active' : actor.status });
    }

    if (actor.role !== 'admin' || actor.status !== 'active') return respond({ error: 'Administrator access is required.' }, 403);
    if (!actor.is_master_admin && !['list', 'get-dashboard-assignment', 'set-dashboard-assignment'].includes(body.action)) {
      return respond({ error: 'Master Admin access is required for account management.' }, 403);
    }

    if (body.action === 'audit-history') {
      if (!actor.is_master_admin) return respond({ error: 'Only the Master Admin can view login activity history.' }, 403);
      const limit = Math.max(1, Math.min(500, Number(body.limit) || 200));
      let sessionsQuery = adminClient.from('audit_sessions')
        .select('id, user_id, username, display_name, role, client_names, started_at, last_activity_at, ended_at, end_reason, user_agent')
        .order('started_at', { ascending: false })
        .limit(limit);
      if (body.username) sessionsQuery = sessionsQuery.eq('username', String(body.username).slice(0, 40));
      const { data: sessions, error } = await sessionsQuery;
      if (error) throw new Error('Could not load login activity history.');
      return respond({ sessions: sessions || [] });
    }
    if (body.action === 'audit-session-events') {
      if (!actor.is_master_admin) return respond({ error: 'Only the Master Admin can view login activity history.' }, 403);
      const sessionId = String(body.sessionId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error('Choose a valid login history session.');
      }
      const { data: events, error } = await adminClient.from('audit_events')
        .select('id, occurred_at, actor_username, event_type, dashboard_name, action, target, details')
        .eq('session_id', sessionId)
        .order('occurred_at', { ascending: true })
        .limit(1000);
      if (error) throw new Error('Could not load the selected login activity history.');
      return respond({ events: events || [] });
    }
    if (body.action === 'rename-client') {
      if (!actor.is_master_admin) return respond({ error: 'Only the Master Admin can rename a client.' }, 403);
      const oldClient = String(body.oldClient || '').trim();
      const newClient = String(body.newClient || '').trim();
      if (!oldClient || !newClient || oldClient.length > 80 || newClient.length > 80) {
        throw new Error('Client names must contain 1 to 80 characters.');
      }
      const { data: renameResult, error } = await adminClient.rpc('rename_client_globally', {
        old_client: oldClient,
        new_client: newClient
      });
      if (error) throw new Error(error.message || 'Could not rename this client.');
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'edit',
        action: 'renamed client across portal assignments',
        target: `${oldClient} → ${newClient}`,
        changeCompleted: true,
        details: renameResult || { oldClient, newClient }
      });
      return respond(renameResult || { oldClient, newClient });
    }

    if (body.action === 'list') {
      const { data, error } = await adminClient.from('profiles')
        .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, client_names, managed_user_ids, is_master_admin, role, status, created_at, last_seen_at')
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
          .select('sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs, client_buffer_detail_tabs, client_vcode_source_urls, client_vcode_source_tabs, client_vcode_deleted_tabs, client_deactivation_mika_tabs')
          .eq('user_id', target.id)
          .eq('dashboard_name', dashboardName)
          .maybeSingle();
        if (error) throw new Error('Could not load this user\'s spreadsheet assignment.');
        const assignedClientNames = data?.client_names?.length
          ? data.client_names
          : target.client_names?.length
            ? target.client_names
            : [target.client_name].filter(Boolean);
        const profileClientSet = new Set((target.client_names?.length ? target.client_names : [target.client_name])
          .map((name: string) => String(name || '').trim().toLocaleLowerCase()));
        const clientNames = target.is_master_admin
          ? assignedClientNames
          : assignedClientNames.filter((name: string) => profileClientSet.has(String(name).trim().toLocaleLowerCase()));
        const rawUrls = data?.sheet_urls || [];
        const urls = rawUrls.length > 1 && rawUrls.length === assignedClientNames.length
          ? clientNames.map((name: string) => rawUrls[assignedClientNames.findIndex((assigned: string) =>
            assigned.toLocaleLowerCase() === name.toLocaleLowerCase())]).filter(Boolean)
          : rawUrls;
        const filterClientMap = (value: any) => Object.fromEntries(Object.entries(value || {}).filter(([name]) =>
          clientNames.some((client: string) => client.toLocaleLowerCase() === name.toLocaleLowerCase())));
        return respond({
          username,
          dashboardName,
          urls,
          clientNames,
          clientSheetUrls: filterClientMap(data?.client_sheet_urls),
          sheetTab: data?.sheet_tab || '',
          clientSheetTabs: filterClientMap(data?.client_sheet_tabs),
          clientBufferDetailTabs: filterClientMap(data?.client_buffer_detail_tabs),
          clientVcodeSourceUrls: filterClientMap(data?.client_vcode_source_urls),
          clientVcodeSourceTabs: filterClientMap(data?.client_vcode_source_tabs),
          clientVcodeDeletedTabs: filterClientMap(data?.client_vcode_deleted_tabs),
          clientDeactivationMikaTabs: filterClientMap(data?.client_deactivation_mika_tabs)
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
      if (dashboardName === 'DEACTIVATION' && urls.length === 0 && Object.keys(clientSheetUrls).length === 0) {
        throw new Error('Enter the DEACTIVATION Google Sheets URL before saving this assignment.');
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
      const clientDeactivationMikaTabs: Record<string, string> = {};
      if (body.clientDeactivationMikaTabs !== undefined) {
        if (!body.clientDeactivationMikaTabs || typeof body.clientDeactivationMikaTabs !== 'object' || Array.isArray(body.clientDeactivationMikaTabs)) {
          throw new Error('Provide a valid MIKA FILE tab name for each assigned client.');
        }
        for (const clientName of clientNames) {
          const tabName = body.clientDeactivationMikaTabs[clientName];
          if (tabName === undefined) continue;
          if (typeof tabName !== 'string' || !tabName.trim() || tabName.trim().length > 100) {
            throw new Error(`Enter a valid MIKA FILE tab name for ${clientName} (1-100 characters).`);
          }
          if (/[:\\/?*\[\]\r\n]/.test(tabName.trim())) {
            throw new Error(`The MIKA FILE tab name for ${clientName} contains an unsupported character.`);
          }
          clientDeactivationMikaTabs[clientName] = tabName.trim();
        }
        if (Object.keys(body.clientDeactivationMikaTabs).some(client => !clientNames.includes(client))) {
          throw new Error('Each MIKA FILE tab name must match a selected client.');
        }
      }
      if (dashboardName === 'DEACTIVATION') {
        if (!clientNames.length) throw new Error('Select a client for the DEACTIVATION assignment.');
        const missingMikaTab = clientNames.find(client => !clientDeactivationMikaTabs[client]);
        if (missingMikaTab) throw new Error(`Enter the MIKA FILE tab name for ${missingMikaTab}.`);
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
      const clientVcodeSourceUrls: Record<string, string> = {};
      if (body.clientVcodeSourceUrls !== undefined) {
        if (!body.clientVcodeSourceUrls || typeof body.clientVcodeSourceUrls !== 'object' || Array.isArray(body.clientVcodeSourceUrls)) {
          throw new Error('Provide a separate VCODE spreadsheet URL for each assigned client.');
        }
        for (const clientName of clientNames) {
          const assignedUrl = body.clientVcodeSourceUrls[clientName];
          if (typeof assignedUrl !== 'string' || !assignedUrl.trim()) {
            throw new Error(`Provide a separate VCODE spreadsheet URL for ${clientName}.`);
          }
          let parsed: URL;
          try { parsed = new URL(assignedUrl.trim()); } catch { throw new Error(`Enter a complete VCODE spreadsheet URL for ${clientName}.`); }
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== 'docs.google.com' ||
            !/^\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(parsed.pathname)) {
            throw new Error(`Use a Google Sheets document link for the VCODE spreadsheet assigned to ${clientName}.`);
          }
          clientVcodeSourceUrls[clientName] = parsed.href;
        }
        if (Object.keys(body.clientVcodeSourceUrls).some(client => !clientNames.includes(client))) {
          throw new Error('Each VCODE spreadsheet URL must match a selected client.');
        }
      }
      const clientVcodeDeletedTabs: Record<string, string> = {};
      const clientVcodeSourceTabs: Record<string, string> = {};
      if (body.clientVcodeSourceTabs !== undefined) {
        if (!body.clientVcodeSourceTabs || typeof body.clientVcodeSourceTabs !== 'object' || Array.isArray(body.clientVcodeSourceTabs)) {
          throw new Error('Provide valid VCODE source tab names for assigned clients.');
        }
        for (const clientName of clientNames) {
          const tabName = body.clientVcodeSourceTabs[clientName];
          if (tabName === undefined) continue;
          if (typeof tabName !== 'string' || tabName.trim().length > 100) {
            throw new Error(`Enter a valid VCODE source tab name for ${clientName} (up to 100 characters).`);
          }
          if (/[:\\/?*\[\]\r\n]/.test(tabName.trim())) {
            throw new Error(`The VCODE source tab name for ${clientName} contains an unsupported character.`);
          }
          clientVcodeSourceTabs[clientName] = tabName.trim();
        }
        if (Object.keys(body.clientVcodeSourceTabs).some(client => !clientNames.includes(client))) {
          throw new Error('Each VCODE source tab name must match a selected client.');
        }
      }
      if (body.clientVcodeDeletedTabs !== undefined) {
        if (!body.clientVcodeDeletedTabs || typeof body.clientVcodeDeletedTabs !== 'object' || Array.isArray(body.clientVcodeDeletedTabs)) {
          throw new Error('Provide valid deleted VCODE tab names for assigned clients.');
        }
        for (const clientName of clientNames) {
          const tabName = body.clientVcodeDeletedTabs[clientName];
          if (tabName === undefined) continue;
          if (typeof tabName !== 'string' || tabName.trim().length > 100) {
            throw new Error(`Enter a valid deleted VCODE tab name for ${clientName} (up to 100 characters).`);
          }
          if (/[:\\/?*\[\]\r\n]/.test(tabName.trim())) {
            throw new Error(`The deleted VCODE tab name for ${clientName} contains an unsupported character.`);
          }
          clientVcodeDeletedTabs[clientName] = tabName.trim();
        }
        if (Object.keys(body.clientVcodeDeletedTabs).some(client => !clientNames.includes(client))) {
          throw new Error('Each deleted VCODE tab name must match a selected client.');
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
        client_vcode_source_urls: clientVcodeSourceUrls,
        client_vcode_source_tabs: clientVcodeSourceTabs,
        client_vcode_deleted_tabs: clientVcodeDeletedTabs,
        client_deactivation_mika_tabs: clientDeactivationMikaTabs,
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
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'edit',
        dashboardName,
        action: 'updated dashboard assignment',
        target: username,
        changeCompleted: true,
        details: {
          clients: clientNames,
          spreadsheetUrls: urls,
          clientSpreadsheetUrls: clientSheetUrls,
          sheetTab,
          clientSheetTabs,
          bufferDetailTabs: clientBufferDetailTabs,
          vcodeSourceUrls: clientVcodeSourceUrls,
          vcodeSourceTabs: clientVcodeSourceTabs,
          deletedVcodeTabs: clientVcodeDeletedTabs,
          deactivationMikaTabs: clientDeactivationMikaTabs
        }
      });
      return respond({ username, dashboardName, urls, clientNames, sheetTab, clientSheetTabs, clientBufferDetailTabs, clientVcodeSourceUrls, clientVcodeSourceTabs, clientVcodeDeletedTabs });
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
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'action',
        action: 'created account',
        target: username,
        changeCompleted: true,
        details: {
          displayName,
          role,
          status,
          clientNames,
          googleEmail,
          assignedSheetUrl: sheetUrl || '',
          managedUserIds
        }
      });
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
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'edit',
        action: 'bulk-updated account statuses',
        target: usernames.join(', '),
        changeCompleted: true,
        details: {
          status,
          accounts: targets.map(target => ({ username: target.username, previousStatus: target.status, status }))
        }
      });
      return respond({ status, usernames });
    }

    const targetUsername = String(body.username || '').trim();
    const { data: target, error: targetError } = await adminClient.from('profiles')
      .select('id, username, display_name, photo_url, sheet_url, google_email, client_name, client_names, managed_user_ids, is_master_admin, role, status')
      .eq('username', targetUsername)
      .single();
    if (targetError || !target) throw new Error('Username was not found.');
    if (target.is_master_admin) throw new Error('The Master Admin account cannot be modified through user management.');
    if (!canManageUserProfile(actor, target)) {
      throw new Error('This account is not assigned to your administrator account.');
    }

    if (body.action === 'update-account') {
      if (!actor.is_master_admin) throw new Error('Only the Master Admin can edit account details and access.');
      const username = String(body.newUsername || '').trim().toLowerCase();
      const displayName = String(body.displayName || '').trim();
      const googleEmail = String(body.googleEmail || '').trim().toLowerCase();
      const photoUrl = String(body.photoUrl || '').trim();
      const sheetUrl = String(body.sheetUrl || '').trim();
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const role = body.role === 'admin' ? 'admin' : body.role === 'user' ? 'user' : '';
      const status = String(body.status || '');
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {
        throw new Error('Username must be 3-40 characters: lowercase letters, numbers, dots, hyphens, or underscores.');
      }
      if (!displayName || displayName.length > 80) throw new Error('Enter a display name up to 80 characters.');
      if (googleEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(googleEmail)) throw new Error('Enter a valid Google account email or leave it blank.');
      if (photoUrl.length > 700_000) throw new Error('Profile photo must be smaller than 512 KB.');
      if (photoUrl) {
        const isInlineImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photoUrl);
        let isHttpsImageUrl = false;
        try { isHttpsImageUrl = new URL(photoUrl).protocol === 'https:'; } catch { /* not an absolute image URL */ }
        if (!isInlineImage && !isHttpsImageUrl) throw new Error('Use an HTTPS profile photo URL or choose an image file.');
      }
      if (sheetUrl) {
        let parsedSheetUrl: URL;
        try { parsedSheetUrl = new URL(sheetUrl); } catch { throw new Error('Enter a valid Google Sheets document URL or leave it blank.'); }
        if (!['http:', 'https:'].includes(parsedSheetUrl.protocol) || parsedSheetUrl.hostname !== 'docs.google.com' ||
          !/^\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(parsedSheetUrl.pathname)) {
          throw new Error('Assigned spreadsheet URL must be a Google Sheets document link.');
        }
      }
      if (newPassword && !/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/.test(newPassword)) {
        throw new Error('New password must be at least 8 characters and include both letters and numbers.');
      }
      if (!['active', 'inactive', 'default'].includes(status)) throw new Error('Choose active, inactive, or default account status.');
      if (!role) throw new Error('Choose a valid account role.');
      if (!Array.isArray(body.clientNames)) throw new Error('Select the client access for this account.');
      const clientNames = [...new Set(body.clientNames.map((value: unknown) => {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Choose valid client names.');
        return value.trim();
      }))];
      if (role === 'user' && clientNames.length !== 1) throw new Error('Select exactly one client for a User account.');
      if (role === 'admin' && (clientNames.length < 1 || clientNames.length > 30)) {
        throw new Error('Select between 1 and 30 clients for a Regular Admin.');
      }
      const submittedManagedIds = role === 'admin' ? body.managedUserIds : [];
      if (!Array.isArray(submittedManagedIds) || submittedManagedIds.length > 200) {
        throw new Error('Choose a valid list of User accounts for this Regular Admin.');
      }
      const managedUserIds = [...new Set(submittedManagedIds.map((value: unknown) => {
        if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
          throw new Error('Choose valid User accounts for this administrator.');
        }
        return value;
      }))];
      if (role === 'admin' && managedUserIds.length) {
        if (managedUserIds.includes(target.id)) throw new Error('A Regular Admin cannot manage their own account.');
        const { data: managedUsers, error: managedUsersError } = await adminClient.from('profiles')
          .select('id, role, is_master_admin, client_name, client_names')
          .in('id', managedUserIds);
        if (managedUsersError) throw new Error('Could not validate the selected User accounts.');
        if (!managedUsers || managedUsers.length !== managedUserIds.length ||
          managedUsers.some(profile => profile.role !== 'user' || profile.is_master_admin)) {
          throw new Error('Select only existing User accounts to assign to a Regular Admin.');
        }
        const allowedClients = new Set(clientNames.map(name => name.toLocaleLowerCase()));
        const outsideScope = managedUsers.some(profile => {
          const profileClients = Array.isArray(profile.client_names) && profile.client_names.length
            ? profile.client_names
            : [profile.client_name];
          const scopedClients = profileClients.filter((name: string) => name && name !== 'My spreadsheets');
          return !scopedClients.length || scopedClients.some((name: string) => !allowedClients.has(name.toLocaleLowerCase()));
        });
        if (outsideScope) throw new Error('Each selected account must belong to a client assigned to this Regular Admin.');
      }
      if (target.role === 'admin' && target.status === 'active' && (role !== 'admin' || status !== 'active')) {
        await protectLastAdmin(adminClient, target);
      }
      const { data: profiles, error: profileListError } = await adminClient.from('profiles').select('id, username');
      if (profileListError) throw new Error('Could not check whether that username is available.');
      if (profiles?.some(profile => profile.id !== target.id && String(profile.username).toLowerCase() === username)) {
        throw new Error('That username is already in use.');
      }

      const changes = {
        username,
        display_name: displayName,
        photo_url: photoUrl,
        sheet_url: sheetUrl,
        google_email: googleEmail,
        client_name: role === 'admin' ? 'ADMIN' : clientNames[0],
        client_names: clientNames,
        managed_user_ids: role === 'admin' ? managedUserIds : null,
        role,
        status
      };
      const { error: profileUpdateError } = await adminClient.from('profiles').update(changes).eq('id', target.id);
      if (profileUpdateError) throw new Error('Could not save the account profile and access settings.');

      const usernameChanged = username !== target.username;
      if (usernameChanged || newPassword) {
        const { data: authResult, error: authLookupError } = await adminClient.auth.admin.getUserById(target.id);
        if (authLookupError || !authResult.user) {
          const { error: rollbackError } = await adminClient.from('profiles').update(target).eq('id', target.id);
          if (rollbackError) throw new Error('Credential lookup failed and the profile could not be restored. Contact support.');
          throw new Error('Could not load the account credentials for updating.');
        }
        const authChanges: Record<string, unknown> = {};
        if (usernameChanged) {
          authChanges.email = usernameEmail(username);
          authChanges.email_confirm = true;
          authChanges.user_metadata = { ...authResult.user.user_metadata, username };
        }
        if (newPassword) authChanges.password = newPassword;
        const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(target.id, authChanges);
        if (authUpdateError) {
          const { error: rollbackError } = await adminClient.from('profiles').update(target).eq('id', target.id);
          if (rollbackError) throw new Error('Credential update failed and the profile could not be restored. Contact support.');
          throw new Error(authUpdateError.message || 'Could not update account credentials.');
        }
      }
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'edit',
        action: 'updated account and access settings',
        target: username,
        changeCompleted: true,
        details: {
          before: {
            username: target.username,
            displayName: target.display_name,
            googleEmail: target.google_email,
            clientNames: target.client_names,
            role: target.role,
            status: target.status
          },
          after: {
            username,
            displayName,
            googleEmail,
            clientNames,
            role,
            status
          },
          profilePhotoChanged: photoUrl !== target.photo_url,
          assignedSheetUrlChanged: sheetUrl !== target.sheet_url,
          managedUserIds: role === 'admin' ? managedUserIds : [],
          passwordChanged: !!newPassword
        }
      });
      return respond({
        username,
        displayName,
        role,
        status,
        clientNames,
        passwordUpdated: !!newPassword
      });
    }

    if (body.action === 'reset-password') {
      const temporaryPassword = createTemporaryPassword();
      const { error } = await adminClient.auth.admin.updateUserById(target.id, { password: temporaryPassword });
      if (error) throw new Error('Could not reset the account password.');
      const { error: statusError } = await adminClient.from('profiles').update({ status: 'default' }).eq('id', target.id);
      if (statusError) throw new Error('Password reset, but account status could not be updated.');
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'action',
        action: 'reset account password',
        target: target.username,
        changeCompleted: true,
        details: { passwordReset: true, previousStatus: target.status, status: 'default' }
      });
      return respond({ username: target.username, temporaryPassword });
    }

    if (body.action === 'set-status') {
      const status = body.status;
      if (!['active', 'inactive', 'default'].includes(status)) throw new Error('Choose active, inactive, or default status.');
      if (status !== 'active') await protectLastAdmin(adminClient, target);
      const { error } = await adminClient.from('profiles').update({ status }).eq('id', target.id);
      if (error) throw new Error('Could not update account status.');
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'edit',
        action: 'updated account status',
        target: target.username,
        changeCompleted: true,
        details: { status: { before: target.status, after: status } }
      });
      return respond({ username: target.username, status });
    }

    if (body.action === 'delete') {
      await protectLastAdmin(adminClient, target);
      const { error } = await adminClient.auth.admin.deleteUser(target.id);
      if (error) throw new Error('Could not delete account.');
      await writeAuditEvent(adminClient, actor, body.auditSessionId, {
        eventType: 'action',
        action: 'deleted account',
        target: target.username,
        changeCompleted: true,
        details: {
          role: target.role,
          status: target.status,
          clientNames: target.client_names
        }
      });
      return respond({ username: target.username, deleted: true });
    }

    return respond({ error: 'Unknown account action.' }, 400);
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Unexpected account service error.' }, 400);
  }
});