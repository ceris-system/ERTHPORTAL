// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const serviceAccountEmail = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')!;
const serviceAccountPrivateKey = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')!;
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
const statuses = new Set([
  'ACTIVE', 'AWOL', 'BACK OUT', 'ENDO', 'FLOATING', 'MATERNITY LEAVE', 'NEWLY HIRED',
  'PATERNITY LEAVE', 'QUARANTINE', 'RE-HIRED', 'RELIEVER', 'RESIGNED', 'SEASONAL',
  'SICK LEAVE', 'VACATION LEAVE', 'TERMINATED', 'TEMPORARY STORE CLOSED',
  'PERMANENTLY STORE CLOSED', 'NAME DIFFER', 'PREVENTIVE SUSPENSION', 'DOUBLE ENTRY',
  'HC ISSUE', 'LATE DTR', 'RESHUFFLE', 'MOVEMENT'
]);

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function base64Url(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodePrivateKey(pem: string) {
  const encoded = pem.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

let cachedGoogleToken = '';
let googleTokenExpiresAt = 0;

async function getGoogleAccessToken() {
  if (cachedGoogleToken && Date.now() < googleTokenExpiresAt - 60_000) return cachedGoogleToken;
  if (!serviceAccountEmail || !serviceAccountPrivateKey) throw new Error('Google service account is not configured in Supabase secrets.');

  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600
  }))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    decodePrivateKey(serviceAccountPrivateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error(result.error_description || 'Google service-account authorization failed.');
  cachedGoogleToken = result.access_token;
  googleTokenExpiresAt = Date.now() + Number(result.expires_in || 3600) * 1000;
  return cachedGoogleToken;
}

async function googleRequest(path: string, options: RequestInit = {}) {
  const token = await getGoogleAccessToken();
  const response = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Google Sheets request failed.');
  return result;
}

async function getAssignedSheet(adminClient: ReturnType<typeof createClient>, actor: any, body: any) {
  if (actor.status !== 'active') throw new Error('This account is inactive.');
  const dashboardNameByAction: Record<string, string> = {
    'read-vcode': 'VCODE MASTERLIST',
    'read-vacancy': 'VACANCY MONITORING',
    'update-vacancy': 'VACANCY MONITORING',
    'read-hr-emploc': 'HR EMPLOC MONITORING',
    'update-hr-emploc': 'HR EMPLOC MONITORING',
    'list-client-options': 'HR EMPLOC MONITORING'
  };
  const dashboardName = dashboardNameByAction[body.action] || 'PLANTILLA';
  let target = actor;
  const targetUsername = String(body.targetUsername || '').trim().toLowerCase();
  if (actor.role === 'admin' && targetUsername && targetUsername !== actor.username) {
    if (!actor.is_master_admin) throw new Error('Only the Master Admin can preview another account.');
    const { data, error } = await adminClient.from('profiles')
      .select('id, username, role, status, sheet_url, client_name, client_names, is_master_admin')
      .eq('username', targetUsername)
      .single();
    if (error || !data || data.role === 'admin') throw new Error('The previewed user was not found.');
    target = data;
  } else if (actor.role !== 'admin' && targetUsername && targetUsername !== actor.username) {
    throw new Error('You can only open spreadsheets assigned to your account.');
  }

  const { data: assignment, error: assignmentError } = await adminClient.from('dashboard_assignments')
    .select('sheet_urls, client_names')
    .eq('user_id', target.id)
    .eq('dashboard_name', dashboardName)
    .maybeSingle();
  if (assignmentError) throw new Error(`Could not load the ${dashboardName} assignment.`);

  const urls = assignment?.sheet_urls?.length ? assignment.sheet_urls : (dashboardName === 'PLANTILLA' && target.sheet_url ? [target.sheet_url] : []);
  if (!urls.length) throw new Error(`No ${dashboardName} spreadsheet is assigned to this account. Ask the administrator to assign one.`);

  const selectedUrl = String(body.spreadsheetUrl || urls[0]).trim();
  let parsed: URL;
  try { parsed = new URL(selectedUrl); } catch { throw new Error('The assigned spreadsheet URL is invalid.'); }
  if (parsed.hostname !== 'docs.google.com') throw new Error('The assigned URL must be a Google Sheets document.');
  const match = parsed.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('The assigned URL is not a Google Sheets document link.');
  if (!urls.some((value: string) => {
    try { return new URL(value).pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] === match[1]; }
    catch { return false; }
  })) throw new Error('That spreadsheet is not assigned to this account.');
  const assignedClientNames = Array.isArray(assignment?.client_names) ? assignment.client_names : [];
  const profileClientNames = Array.isArray(target.client_names) ? target.client_names : [];
  const clientNames = [...new Set((assignedClientNames.length ? assignedClientNames : profileClientNames.length ? profileClientNames : [target.client_name])
    .map((value: unknown) => String(value || '').trim())
    .filter((value: string) => value && value !== 'My spreadsheets'))];
  return { spreadsheetId: match[1], clientName: String(target.client_name || '').trim(), clientNames };
}

async function readPlantilla(spreadsheetId: string) {
  const range = encodeURIComponent('PLANTILLA!A9:AJ');
  const [raw, display] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  return { rawValues: raw.values || [], displayValues: display.values || [] };
}

async function readVcode(spreadsheetId: string) {
  const range = encodeURIComponent('VCODE!A3:N');
  const result = await googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  return { displayValues: result.values || [] };
}

async function readVacancy(spreadsheetId: string, clientNames: string[] = []) {
  const activeClients = new Set(clientNames.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!activeClients.size) throw new Error('Select at least one client before loading vacancy records.');
  const range = encodeURIComponent('VACANCY!B5:AF');
  const clientRange = encodeURIComponent('VACANCY!C5:C');
  const [raw, display, clientValues, deployers] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${clientRange}?valueRenderOption=FORMATTED_VALUE`),
    readDeployers(spreadsheetId)
  ]);
  const rowCount = Math.max(raw.values?.length || 0, display.values?.length || 0);
  const filteredRaw: unknown[][] = [];
  const filteredDisplay: unknown[][] = [];
  if (activeClients.size) {
    for (let index = 0; index < rowCount; index += 1) {
      const rawRow = raw.values?.[index] || [];
      const displayRow = display.values?.[index] || [];
      const clientValue = String(clientValues.values?.[index]?.[0] ?? displayRow[1] ?? rawRow[1] ?? '').trim();
      if (activeClients.has(clientValue.toLocaleLowerCase())) {
        filteredRaw.push(rawRow);
        filteredDisplay.push(displayRow);
      }
    }
  } else {
    filteredRaw.push(...(raw.values || []));
    filteredDisplay.push(...(display.values || []));
  }
  return {
    rawValues: filteredRaw,
    displayValues: filteredDisplay,
    deployers
  };
}

async function readDeployers(spreadsheetId: string) {
  const range = encodeURIComponent('Deployer!A2:A');
  const result = await googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  return (result.values || []).flat().map((value: unknown) => String(value || '').trim()).filter(Boolean);
}

async function readClientOptions(spreadsheetId: string) {
  const range = encodeURIComponent('G1vcode!C3:C');
  const result = await googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const clientsByNormalizedName = new Map<string, string>();
  for (const value of (result.values || []).flat()) {
    const clientName = String(value || '').trim();
    const normalizedName = clientName.toLocaleLowerCase();
    if (normalizedName && !clientsByNormalizedName.has(normalizedName)) {
      clientsByNormalizedName.set(normalizedName, clientName);
    }
  }
  const clients = [...clientsByNormalizedName.values()];
  return { clients };
}

async function readHrEmploc(spreadsheetId: string, clientNames: string[] = []) {
  const activeClients = new Set(clientNames.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!activeClients.size) throw new Error('Select at least one client before loading HR EMPLOC records.');
  const range = encodeURIComponent('G1N!G9:AC');
  const clientRange = encodeURIComponent('G1N!B9:B');
  const [raw, display, clientValues] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${clientRange}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  const rowCount = Math.max(raw.values?.length || 0, display.values?.length || 0);
  const filteredRaw: unknown[][] = [];
  const filteredDisplay: unknown[][] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const rawRow = raw.values?.[index] || [];
    const displayRow = display.values?.[index] || [];
    const clientValue = String(clientValues.values?.[index]?.[0] ?? '').trim();
    if (activeClients.has(clientValue.toLocaleLowerCase())) {
      filteredRaw.push(rawRow);
      filteredDisplay.push(displayRow);
    }
  }
  return { rawValues: filteredRaw, displayValues: filteredDisplay };
}

function dateSerial(value: unknown) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Choose a valid separation date.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    throw new Error('Choose a valid separation date.');
  }
  return (date.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
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
    const { data: actor, error: profileError } = await adminClient.from('profiles')
      .select('id, username, role, status, sheet_url, client_name, client_names, is_master_admin')
      .eq('id', user.id)
      .single();
    if (profileError || !actor) return respond({ error: 'Account profile was not found.' }, 403);

    const body = await request.json();
    if (!['read-plantilla', 'read-vcode', 'read-vacancy', 'update-vacancy', 'read-hr-emploc', 'update-hr-emploc', 'update-plantilla', 'list-client-options'].includes(body.action)) throw new Error('Unknown sheets action.');
    if (body.action === 'list-client-options' && !actor.is_master_admin) {
      throw new Error('Only the Master Admin can load client options.');
    }
    const { spreadsheetId, clientName, clientNames } = await getAssignedSheet(adminClient, actor, body);

    if (body.action === 'list-client-options') return respond(await readClientOptions(spreadsheetId));
    if (body.action === 'read-plantilla') return respond(await readPlantilla(spreadsheetId));
    if (body.action === 'read-vcode') return respond(await readVcode(spreadsheetId));
    if (body.action === 'read-vacancy') return respond(await readVacancy(spreadsheetId, clientNames));
    if (body.action === 'read-hr-emploc') return respond(await readHrEmploc(spreadsheetId, clientNames));

    if (body.action === 'update-vacancy') {
      const vcode = String(body.vcode || '').trim();
      if (!vcode) throw new Error('VCODE is required.');
      const fieldColumns: Record<string, { column: string; offset: number; type: 'text' | 'date' }> = {
        lastName: { column: 'K', offset: 0, type: 'text' },
        firstName: { column: 'L', offset: 1, type: 'text' },
        middleName: { column: 'M', offset: 2, type: 'text' },
        contactNumber: { column: 'N', offset: 3, type: 'text' },
        vacantDate: { column: 'O', offset: 4, type: 'date' },
        dateOnboard: { column: 'P', offset: 5, type: 'date' },
        reliever: { column: 'U', offset: 10, type: 'text' },
        hrcoRemarks: { column: 'W', offset: 12, type: 'text' },
        coordinator: { column: 'AD', offset: 19, type: 'text' },
        deployedBy: { column: 'AF', offset: 21, type: 'text' }
      };
      const updates: Record<string, unknown> = {};
      for (const [field, definition] of Object.entries(fieldColumns)) {
        if (!Object.hasOwn(body, field)) continue;
        if (definition.type === 'date') {
          updates[field] = dateSerial(body[field]);
          continue;
        }
        const value = body[field] === undefined || body[field] === null ? '' : String(body[field]).trim();
        if (value.length > 500) throw new Error(`${field} cannot exceed 500 characters.`);
        updates[field] = value;
      }
      if (!Object.keys(updates).length) throw new Error('Make at least one change before updating the vacancy record.');
      const deployerValues = await readDeployers(spreadsheetId);
      if (Object.hasOwn(updates, 'coordinator') && updates.coordinator && !deployerValues.includes(String(updates.coordinator))) {
        throw new Error('Choose a Coordinator from the Deployer sheet options.');
      }
      if (Object.hasOwn(updates, 'deployedBy') && updates.deployedBy && !deployerValues.includes(String(updates.deployedBy))) {
        throw new Error('Choose a Deployed By value from the Deployer sheet options.');
      }
      const vcodeRange = encodeURIComponent('VACANCY!B5:B');
      const values = await googleRequest(`spreadsheets/${spreadsheetId}/values/${vcodeRange}?valueRenderOption=FORMATTED_VALUE`);
      const matches = (values.values || []).flat().map((value: unknown, index: number) => String(value).trim() === vcode ? index + 5 : 0).filter(Boolean);
      if (!matches.length) throw new Error(`No VACANCY row found for VCODE ${vcode}.`);
      if (matches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in VACANCY; no changes were made.`);
      const row = matches[0];
      const clientValues = await googleRequest(`spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`VACANCY!C${row}`)}?valueRenderOption=FORMATTED_VALUE`);
      const rowClient = String(clientValues.values?.[0]?.[0] || '').trim().toLocaleLowerCase();
      if (!clientNames.some(name => name.toLocaleLowerCase() === rowClient)) {
        throw new Error(`VCODE ${vcode} is not assigned to your selected client(s).`);
      }
      const formulaRange = encodeURIComponent(`VACANCY!K${row}:AF${row}`);
      const formulaResult = await googleRequest(`spreadsheets/${spreadsheetId}/values/${formulaRange}?valueRenderOption=FORMULA`);
      const formulaRow = formulaResult.values?.[0] || [];
      const formulaFields = Object.keys(updates).filter(field => String(formulaRow[fieldColumns[field].offset] || '').startsWith('='));
      if (formulaFields.length) {
        const columns = formulaFields.map(field => fieldColumns[field].column).join(', ');
        throw new Error(`Cannot overwrite a formula in column ${columns} for VCODE ${vcode}. Change the source data for that formula instead.`);
      }
      const data = Object.entries(updates).map(([field, value]) => ({
        range: `VACANCY!${fieldColumns[field].column}${row}`,
        values: [[value]]
      }));
      await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data
        })
      });
      return respond({ vcode, updated: true });
    }

    if (body.action === 'update-hr-emploc') {
      const vcode = String(body.vcode || '').trim();
      const hrcoRemarks = String(body.hrcoRemarks || '').trim();
      if (!vcode) throw new Error('VCODE is required.');
      if (hrcoRemarks.length > 500) throw new Error('HRCO Remarks cannot exceed 500 characters.');
      const vcodeRange = encodeURIComponent('G1N!G9:G');
      const values = await googleRequest(`spreadsheets/${spreadsheetId}/values/${vcodeRange}?valueRenderOption=FORMATTED_VALUE`);
      const matches = (values.values || []).flat().map((value: unknown, index: number) => String(value).trim() === vcode ? index + 9 : 0).filter(Boolean);
      if (!matches.length) throw new Error(`No G1N row found for VCODE ${vcode}.`);
      if (matches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in G1N; no changes were made.`);
      const row = matches[0];
      const clientValues = await googleRequest(`spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`G1N!B${row}`)}?valueRenderOption=FORMATTED_VALUE`);
      const rowClient = String(clientValues.values?.[0]?.[0] || '').trim().toLocaleLowerCase();
      if (!clientNames.some(name => name.toLocaleLowerCase() === rowClient)) {
        throw new Error(`VCODE ${vcode} is not assigned to your selected client(s).`);
      }
      await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: [{ range: `G1N!J${row}`, values: [[hrcoRemarks]] }] })
      });
      return respond({ vcode, updated: true });
    }

    const vcode = String(body.vcode || '').trim();
    const rate = Number(body.rate);
    const status = String(body.status || '').trim();
    if (!vcode) throw new Error('VCODE is required.');
    if (!Number.isFinite(rate)) throw new Error('Rate must be a number.');
    if (!statuses.has(status)) throw new Error('Choose a valid status.');
    const vcodeRange = encodeURIComponent('PLANTILLA!B9:B');
    const values = await googleRequest(`spreadsheets/${spreadsheetId}/values/${vcodeRange}?valueRenderOption=FORMATTED_VALUE`);
    const matches = (values.values || []).flat().map((value: unknown, index: number) => String(value).trim() === vcode ? index + 9 : 0).filter(Boolean);
    if (!matches.length) throw new Error(`No row found for VCODE ${vcode}.`);
    if (matches.length > 1) throw new Error(`VCODE ${vcode} appears more than once; no changes were made.`);

    const rowNumber = matches[0];
    const separationDate = dateSerial(body.separationDate);
    await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          { range: `PLANTILLA!H${rowNumber}`, values: [[rate]] },
          { range: `PLANTILLA!AG${rowNumber}`, values: [[separationDate]] },
          { range: `PLANTILLA!AH${rowNumber}`, values: [[status]] }
        ]
      })
    });
    return respond({ vcode, updated: true });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Unexpected spreadsheet service error.' }, 400);
  }
});