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
  let target = actor;
  const targetUsername = String(body.targetUsername || '').trim().toLowerCase();
  if (actor.role === 'admin' && targetUsername && targetUsername !== actor.username) {
    const { data, error } = await adminClient.from('profiles')
      .select('id, username, role, status, sheet_url')
      .eq('username', targetUsername)
      .single();
    if (error || !data || data.role === 'admin') throw new Error('The previewed user was not found.');
    target = data;
  } else if (actor.role !== 'admin' && targetUsername && targetUsername !== actor.username) {
    throw new Error('You can only open spreadsheets assigned to your account.');
  }

  const { data: assignment, error: assignmentError } = await adminClient.from('dashboard_assignments')
    .select('sheet_urls')
    .eq('user_id', target.id)
    .eq('dashboard_name', 'PLANTILLA')
    .maybeSingle();
  if (assignmentError) throw new Error('Could not load the PLANTILLA assignment.');

  const urls = assignment?.sheet_urls?.length ? assignment.sheet_urls : (target.sheet_url ? [target.sheet_url] : []);
  if (!urls.length) throw new Error('No PLANTILLA spreadsheet is assigned to this account. Ask the administrator to assign one.');

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
  return match[1];
}

async function readPlantilla(spreadsheetId: string) {
  const range = encodeURIComponent('PLANTILLA!A9:AJ');
  const [raw, display] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  return { rawValues: raw.values || [], displayValues: display.values || [] };
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
      .select('id, username, role, status, sheet_url')
      .eq('id', user.id)
      .single();
    if (profileError || !actor) return respond({ error: 'Account profile was not found.' }, 403);

    const body = await request.json();
    if (!['read-plantilla', 'update-plantilla'].includes(body.action)) throw new Error('Unknown sheets action.');
    const spreadsheetId = await getAssignedSheet(adminClient, actor, body);

    if (body.action === 'read-plantilla') return respond(await readPlantilla(spreadsheetId));

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