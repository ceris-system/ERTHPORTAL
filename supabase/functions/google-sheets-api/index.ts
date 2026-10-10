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
const inactiveTransferStatuses = new Set([
  'AWOL', 'BACK OUT', 'ENDO', 'FLOATING', 'RESIGNED', 'TERMINATED',
  'TEMPORARY STORE CLOSED', 'PERMANENTLY STORE CLOSED', 'MOVEMENT'
]);

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readDeactivationMikaFile(spreadsheetId: string, mikaFileTab: string) {
  const result = await readSheetGridRanges(spreadsheetId, mikaFileTab, [{
    startColumnIndex: 0,
    endColumnIndex: 2
  }]);
  const values: unknown[][] = result[0]?.valueRange?.values || [];
  const records = values.flatMap(row => {
    const emploc = String(row[0] ?? '').trim();
    const fullname = String(row[1] ?? '').trim();
    return emploc && fullname ? [{ emploc, fullname }] : [];
  });
  return { records };
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

function defaultSheetTab(dashboardName: string) {
  return ({
    'PLANTILLA': 'PLANTILLA',
    '+-5% BUFFER': '-+5% GAP',
    'VCODE MASTERLIST': 'VCODE',
    'VCODE VARIANCE': 'VCODE',
    'VACANCY MONITORING': 'VACANCY',
    'FOR APPROVAL': 'VACANCY',
    'HR EMPLOC MONITORING': 'G1N',
    'INACTIVE': 'INACTIVE',
    'ATTRITION': 'ATTRITION'
  } as Record<string, string>)[dashboardName] || dashboardName;
}

function sheetA1(tabName: string, cells: string) {
  const safeName = String(tabName || '').trim();
  if (!safeName || safeName.length > 100) throw new Error('The assigned spreadsheet tab name is invalid.');
  if (/[:\\/?*\[\]\r\n]/.test(safeName)) throw new Error('The assigned spreadsheet tab name contains an unsupported character.');
  const escapedName = /^[A-Za-z0-9_]+$/.test(safeName)
    ? safeName
    : `'${safeName.replace(/'/g, "''")}'`;
  return `${escapedName}!${cells}`;
}

function sheetRange(tabName: string, cells: string) {
  return encodeURIComponent(sheetA1(tabName, cells)).replace(/'/g, '%27');
}

async function readSheetGridRanges(
  spreadsheetId: string,
  sheetTab: string,
  gridRanges: Record<string, number>[]
) {
  const metadata = await googleRequest(
    `spreadsheets/${spreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
  );
  const sheet = (metadata.sheets || []).find((item: any) => item.properties?.title === sheetTab);
  if (!sheet?.properties?.sheetId) throw new Error(`The assigned spreadsheet does not have a ${sheetTab} tab.`);
  const sheetId = Number(sheet.properties.sheetId);
  const rowCount = Number(sheet.properties.gridProperties?.rowCount);
  const columnCount = Number(sheet.properties.gridProperties?.columnCount);
  const boundedRanges = gridRanges.map(range => {
    const startRowIndex = range.startRowIndex ?? 0;
    const startColumnIndex = range.startColumnIndex ?? 0;
    if (startRowIndex >= rowCount || startColumnIndex >= columnCount) return null;
    return {
      ...range,
      ...(range.endRowIndex === undefined ? {} : { endRowIndex: Math.min(range.endRowIndex, rowCount) }),
      ...(range.endColumnIndex === undefined ? {} : { endColumnIndex: Math.min(range.endColumnIndex, columnCount) })
    };
  });
  const validRanges = boundedRanges.filter((range): range is Record<string, number> => range !== null);
  if (!validRanges.length) return gridRanges.map(() => ({ valueRange: { values: [] } }));
  const data = await googleRequest(`spreadsheets/${spreadsheetId}/values:batchGetByDataFilter`, {
    method: 'POST',
    body: JSON.stringify({
      dataFilters: validRanges.map(range => ({
        gridRange: { sheetId, ...range }
      }))
    })
  });
  let resultIndex = 0;
  return boundedRanges.map(range => range ? data.valueRanges?.[resultIndex++] || { valueRange: { values: [] } } : { valueRange: { values: [] } });
}

const bufferDetailClientColumns: Record<string, number> = {
  plantillaNotInMika: 18,
  mikaNotInPlantilla: 9,
  plantillaNotInPayroll: 21,
  payrollNotInPlantilla: 10
};

const bufferDetailDataColumns: Record<string, { emploc: number; fullname: number; dateHired: number; aging: number }> = {
  plantillaNotInMika: { emploc: 15, fullname: 16, dateHired: 19, aging: 20 },
  mikaNotInPlantilla: { emploc: 6, fullname: 7, dateHired: 11, aging: 12 },
  plantillaNotInPayroll: { emploc: 17, fullname: 18, dateHired: 19, aging: 23 },
  payrollNotInPlantilla: { emploc: 6, fullname: 7, dateHired: 13, aging: 14 }
};

async function getAssignedSheet(adminClient: ReturnType<typeof createClient>, actor: any, body: any) {
  if (actor.status !== 'active') throw new Error('This account is inactive.');
  const dashboardNameByAction: Record<string, string> = {
    'read-buffer': '+-5% BUFFER',
    'read-buffer-detail': '+-5% BUFFER',
    'read-vcode': 'VCODE MASTERLIST',
    'read-vcode-variance': 'VCODE VARIANCE',
    'transfer-vcodes': 'VCODE VARIANCE',
    'delete-vcodes': 'VCODE VARIANCE',
    'read-deactivation': 'DEACTIVATION',
    'lookup-deactivation-emploc': 'DEACTIVATION',
    'read-deactivation-mika-file': 'DEACTIVATION',
    'save-deactivation': 'DEACTIVATION',
    'read-attrition': 'ATTRITION',
    'read-vacancy': 'VACANCY MONITORING',
    'read-for-approval': 'FOR APPROVAL',
    'approve-vacancy': 'FOR APPROVAL',
    'update-vacancy': 'VACANCY MONITORING',
    'fill-plantilla-newly-hired': 'PLANTILLA',
    'read-hr-emploc': 'HR EMPLOC MONITORING',
    'update-hr-emploc': 'HR EMPLOC MONITORING',
    'list-client-options': 'HR EMPLOC MONITORING'
  };
  const dashboardName = dashboardNameByAction[body.action] || 'PLANTILLA';
  let target = actor;
  const targetUsername = String(body.targetUsername || '').trim();
  if (actor.role === 'admin' && targetUsername && targetUsername !== actor.username) {
    if (!actor.is_master_admin) throw new Error('Only the Master Admin can preview another account.');
    const { data, error } = await adminClient.from('profiles')
      .select('id, username, role, status, sheet_url, client_name, client_names, is_master_admin')
      .eq('username', targetUsername)
      .single();
    if (error || !data || data.is_master_admin) throw new Error('The previewed user was not found.');
    target = data;
  } else if (actor.role !== 'admin' && targetUsername && targetUsername !== actor.username) {
    throw new Error('You can only open spreadsheets assigned to your account.');
  }

  const { data: assignment, error: assignmentError } = await adminClient.from('dashboard_assignments')
    .select('sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs, client_buffer_detail_tabs, client_vcode_source_urls, client_vcode_source_tabs, client_vcode_deleted_tabs, client_deactivation_mika_tabs')
    .eq('user_id', target.id)
    .eq('dashboard_name', dashboardName)
    .maybeSingle();
  if (assignmentError) throw new Error(`Could not load the ${dashboardName} assignment.`);

  const urls = assignment?.sheet_urls?.length ? assignment.sheet_urls : (dashboardName === 'PLANTILLA' && target.sheet_url ? [target.sheet_url] : []);
  const assignedClientNames = Array.isArray(assignment?.client_names) ? assignment.client_names : [];
  const profileClientNames = Array.isArray(target.client_names) ? target.client_names : [];
  const clientNames = [...new Set((assignedClientNames.length ? assignedClientNames : profileClientNames.length ? profileClientNames : [target.client_name])
    .map((value: unknown) => String(value || '').trim())
    .filter((value: string) => value && value !== 'My spreadsheets'))];
  const requestedClient = String(body.clientName || '').trim();
  const clientSheetUrls = assignment?.client_sheet_urls && typeof assignment.client_sheet_urls === 'object'
    ? assignment.client_sheet_urls
    : {};
  const clientSheetTabs = assignment?.client_sheet_tabs && typeof assignment.client_sheet_tabs === 'object'
    ? assignment.client_sheet_tabs
    : {};
  let clientMappedUrl = requestedClient ? clientSheetUrls[requestedClient] : '';
  if (!clientMappedUrl && requestedClient && clientNames.length > 1 && urls.length === clientNames.length) {
    clientMappedUrl = urls[clientNames.indexOf(requestedClient)];
  }
  if (!clientMappedUrl && requestedClient && clientNames.length > 1 && urls.length === 1) clientMappedUrl = urls[0];
  if (target.role === 'admin' && !target.is_master_admin && clientNames.length > 1 && !clientMappedUrl) {
    throw new Error(`No ${dashboardName} spreadsheet is assigned to ${requestedClient || 'the selected client'}. Ask the Master Admin to assign one.`);
  }
  const masterHrSelfService = body.action === 'update-hr-emploc' && actor.is_master_admin &&
    target.id === actor.id && typeof body.spreadsheetUrl === 'string' && body.spreadsheetUrl.trim();
  if (!urls.length && !masterHrSelfService) throw new Error(`No ${dashboardName} spreadsheet is assigned to this account. Ask the administrator to assign one.`);

  if (requestedClient && clientNames.length && !clientNames.some((name: string) => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase())) {
    throw new Error(`Client ${requestedClient} is not assigned to ${dashboardName}.`);
  }
  const selectedUrl = String(body.spreadsheetUrl || clientMappedUrl || urls[0]).trim();
  let parsed: URL;
  try { parsed = new URL(selectedUrl); } catch { throw new Error('The assigned spreadsheet URL is invalid.'); }
  if (parsed.hostname !== 'docs.google.com') throw new Error('The assigned URL must be a Google Sheets document.');
  const match = parsed.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('The assigned URL is not a Google Sheets document link.');
  if (target.role === 'admin' && !target.is_master_admin && clientNames.length > 1 && clientMappedUrl) {
    const expectedSpreadsheetId = spreadsheetIdFromAssignedUrl(clientMappedUrl, dashboardName);
    if (expectedSpreadsheetId !== match[1]) {
      throw new Error(`That spreadsheet is not assigned to ${requestedClient} for ${dashboardName}.`);
    }
  }
  if (!urls.some((value: string) => {
    try { return new URL(value).pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] === match[1]; }
    catch { return false; }
  }) && !Object.values(clientSheetUrls).some((value: unknown) => {
    try { return typeof value === 'string' && new URL(value).pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] === match[1]; }
    catch { return false; }
  }) && !masterHrSelfService) throw new Error('That spreadsheet is not assigned to this account.');
  const selectedMasterClient = masterHrSelfService && !urls.length && typeof body.clientName === 'string' ? body.clientName.trim() : '';
  const scopedClientNames = [...new Set((selectedMasterClient ? [selectedMasterClient] : requestedClient ? [requestedClient] : clientNames)
    .map((value: unknown) => String(value || '').trim())
    .filter((value: string) => value && value !== 'My spreadsheets'))];
  const matchedClientTab = Object.keys(clientSheetTabs).find(name => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase());
  const mappedSheetTab = String(matchedClientTab ? clientSheetTabs[matchedClientTab] || '' : '').trim();
  const assignedSheetTab = String(assignment?.sheet_tab || '').trim();
  let sheetTab = String(dashboardName === 'DEACTIVATION'
    ? assignedSheetTab || mappedSheetTab || defaultSheetTab(dashboardName)
    : mappedSheetTab || assignedSheetTab || defaultSheetTab(dashboardName)).trim();
  if (dashboardName === 'DEACTIVATION' &&
    clientNames.some(name => name.toLocaleLowerCase() === sheetTab.toLocaleLowerCase())) {
    sheetTab = mappedSheetTab &&
      !clientNames.some(name => name.toLocaleLowerCase() === mappedSheetTab.toLocaleLowerCase())
      ? mappedSheetTab
      : defaultSheetTab(dashboardName);
  }
  const deactivationMikaTabs = assignment?.client_deactivation_mika_tabs && typeof assignment.client_deactivation_mika_tabs === 'object'
    ? assignment.client_deactivation_mika_tabs
    : {};
  const matchedDeactivationMikaClient = Object.keys(deactivationMikaTabs).find(name => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase());
  const deactivationMikaTab = String((matchedDeactivationMikaClient ? deactivationMikaTabs[matchedDeactivationMikaClient] : '') || 'MIKA FILE').trim();
  if (body.action === 'read-buffer-detail') {
    const detailType = String(body.detailType || '');
    if (!Object.prototype.hasOwnProperty.call(bufferDetailClientColumns, detailType)) throw new Error('Choose a valid buffer detail dashboard.');
    const clientDetailTabs = assignment?.client_buffer_detail_tabs && typeof assignment.client_buffer_detail_tabs === 'object'
      ? assignment.client_buffer_detail_tabs
      : {};
    const matchedDetailClient = Object.keys(clientDetailTabs).find(name => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase());
    const clientTabs = matchedDetailClient ? clientDetailTabs[matchedDetailClient] : {};
    sheetTab = String(clientTabs?.[detailType] || '').trim();
    if (!sheetTab) throw new Error(`No sheet tab is assigned for this buffer detail dashboard and client ${requestedClient}. Add its tab name in the +-5% BUFFER assignment.`);
  }
  const vcodeSourceTabs = assignment?.client_vcode_source_tabs && typeof assignment.client_vcode_source_tabs === 'object'
    ? assignment.client_vcode_source_tabs
    : {};
  const matchedVcodeSourceClient = Object.keys(vcodeSourceTabs).find(name => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase());
  const vcodeSourceTab = String((matchedVcodeSourceClient ? vcodeSourceTabs[matchedVcodeSourceClient] : '') || 'VCODE').trim();
  const vcodeSourceUrls = assignment?.client_vcode_source_urls && typeof assignment.client_vcode_source_urls === 'object'
    ? assignment.client_vcode_source_urls
    : {};
  const matchedVcodeSourceUrlClient = Object.keys(vcodeSourceUrls).find(name => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase());
  const vcodeSourceUrl = String((matchedVcodeSourceUrlClient ? vcodeSourceUrls[matchedVcodeSourceUrlClient] : '') || '').trim();
  const vcodeSourceSpreadsheetId = body.action === 'delete-vcodes'
    ? spreadsheetIdFromAssignedUrl(vcodeSourceUrl, `VCODE source for ${requestedClient || 'this client'}`)
    : '';
  const deletedVcodeTabs = assignment?.client_vcode_deleted_tabs && typeof assignment.client_vcode_deleted_tabs === 'object'
    ? assignment.client_vcode_deleted_tabs
    : {};
  const matchedDeletedVcodeClient = Object.keys(deletedVcodeTabs).find(name => name.toLocaleLowerCase() === requestedClient.toLocaleLowerCase());
  const deletedVcodeTab = String((matchedDeletedVcodeClient ? deletedVcodeTabs[matchedDeletedVcodeClient] : '') || 'DELETED VCODES').trim();
  if (!sheetTab || sheetTab.length > 100) throw new Error(`The assigned tab name for ${dashboardName} is invalid.`);
  if (!deactivationMikaTab || deactivationMikaTab.length > 100 || /[:\\/?*\[\]\r\n]/.test(deactivationMikaTab)) {
    throw new Error('The assigned MIKA FILE tab name is invalid.');
  }
  if (!deletedVcodeTab || deletedVcodeTab.length > 100 || /[:\\/?*\[\]\r\n]/.test(deletedVcodeTab)) {
    throw new Error('The assigned deleted VCODE tab name is invalid.');
  }
  if (!vcodeSourceTab || vcodeSourceTab.length > 100 || /[:\\/?*\[\]\r\n]/.test(vcodeSourceTab)) {
    throw new Error('The assigned VCODE source tab name is invalid.');
  }
  return {
    spreadsheetId: match[1],
    targetUserId: target.id,
    targetUsername: String(target.username || '').trim().toLocaleLowerCase(),
    targetIsMasterAdmin: !!target.is_master_admin,
    clientName: requestedClient || String(target.client_name || '').trim(),
    clientNames: scopedClientNames,
    targetRole: target.role,
    sheetTab,
    deactivationMikaTab,
    vcodeSourceSpreadsheetId,
    vcodeSourceTab,
    deletedVcodeTab
  };
}

function spreadsheetIdFromAssignedUrl(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`No ${label} spreadsheet is assigned.`);
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(`The ${label} spreadsheet URL is invalid.`); }
  const match = url.hostname === 'docs.google.com' ? url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/) : null;
  if (!match) throw new Error(`The ${label} URL must be a Google Sheets document link.`);
  return match[1];
}

function columnLetter(columnNumber: number) {
  let remainder = columnNumber;
  let label = '';
  while (remainder > 0) {
    const digit = (remainder - 1) % 26;
    label = String.fromCharCode(65 + digit) + label;
    remainder = Math.floor((remainder - 1) / 26);
  }
  return label;
}

function normalizeSheetIdentity(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase();
}

async function getAssignedHrEmplocDestination(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string,
  clientName = ''
) {
  const [assignmentResult, profileResult] = await Promise.all([
    adminClient.from('dashboard_assignments').select('sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs')
      .eq('user_id', targetUserId).eq('dashboard_name', 'HR EMPLOC MONITORING').maybeSingle(),
    adminClient.from('profiles').select('client_name, client_names').eq('id', targetUserId).single()
  ]);
  if (assignmentResult.error) throw new Error('Could not load the assigned HR EMPLOC spreadsheet.');
  if (profileResult.error || !profileResult.data) throw new Error('Could not load the account client scope for HR EMPLOC.');
  const assignment = assignmentResult.data;
  const urls = Array.isArray(assignment?.sheet_urls) ? assignment.sheet_urls : [];
  const assignedClients = Array.isArray(assignment?.client_names) && assignment.client_names.length
    ? assignment.client_names
    : Array.isArray(profileResult.data.client_names) && profileResult.data.client_names.length
      ? profileResult.data.client_names
      : [profileResult.data.client_name];
  const clientNames = assignedClients.map((name: unknown) => String(name || '').trim().toLocaleLowerCase()).filter(Boolean);
  if (!clientNames.length) throw new Error('No clients are assigned to the HR EMPLOC spreadsheet.');
  const normalizedClient = clientName.trim().toLocaleLowerCase();
  if (normalizedClient && !clientNames.includes(normalizedClient)) {
    throw new Error(`Client ${clientName} is not assigned to the HR EMPLOC spreadsheet.`);
  }
  const mappings = assignment?.client_sheet_urls && typeof assignment.client_sheet_urls === 'object'
    ? assignment.client_sheet_urls
    : {};
  const mappedClient = normalizedClient && Object.keys(mappings).find(name => name.toLocaleLowerCase() === normalizedClient);
  let selectedUrl = mappedClient ? mappings[mappedClient] : '';
  if (!selectedUrl && normalizedClient && urls.length === clientNames.length) {
    selectedUrl = urls[clientNames.indexOf(normalizedClient)];
  }
  if (!selectedUrl && urls.length === 1) selectedUrl = urls[0];
  if (!selectedUrl) throw new Error(`No HR EMPLOC spreadsheet is assigned${clientName ? ` to ${clientName}` : ''}.`);
  const spreadsheetId = spreadsheetIdFromAssignedUrl(selectedUrl, 'HR EMPLOC');
  const scopedClientNames = normalizedClient ? [normalizedClient] : clientNames;
  const tabMappings = assignment?.client_sheet_tabs && typeof assignment.client_sheet_tabs === 'object' ? assignment.client_sheet_tabs : {};
  const mappedTab = Object.keys(tabMappings).find(name => name.toLocaleLowerCase() === normalizedClient);
  const sheetTab = String((mappedTab ? tabMappings[mappedTab] : '') || assignment?.sheet_tab || 'G1N').trim();
  return { spreadsheetId, clientNames: scopedClientNames, sheetTab };
}

const approvalRequiredSourceColumns = [10, 11, 12, 13, 14, 15, 20, 21, 22, 31];

function sameSheetValues(actual: unknown[], expected: unknown[], ignoredIndexes: number[] = []) {
  const ignored = new Set(ignoredIndexes);
  return Array.from({ length: expected.length }, (_, index) => index)
    .filter(index => !ignored.has(index))
    .every(index => String(actual[index] ?? '') === String(expected[index] ?? ''));
}

async function getAssignedVacancyDestination(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string,
  clientName: string,
  masterFallbackUrl?: unknown,
  masterClientNames: string[] = []
) {
  const [assignmentResult, profileResult] = await Promise.all([
    adminClient.from('dashboard_assignments').select('sheet_urls, client_names, client_sheet_urls, sheet_tab, client_sheet_tabs')
      .eq('user_id', targetUserId).eq('dashboard_name', 'VACANCY MONITORING').maybeSingle(),
    adminClient.from('profiles').select('client_name, client_names, is_master_admin').eq('id', targetUserId).single()
  ]);
  if (assignmentResult.error) throw new Error('Could not load the assigned VACANCY spreadsheet.');
  if (profileResult.error || !profileResult.data) throw new Error('Could not load the account client scope for VACANCY.');
  const assignment = assignmentResult.data;
  const assignedClients = Array.isArray(assignment?.client_names) && assignment.client_names.length
    ? assignment.client_names
    : masterClientNames.length ? masterClientNames
      : Array.isArray(profileResult.data.client_names) && profileResult.data.client_names.length
        ? profileResult.data.client_names
        : [profileResult.data.client_name];
  const clientNames = assignedClients.map((name: unknown) => String(name || '').trim().toLocaleLowerCase()).filter(Boolean);
  if (!clientNames.length) throw new Error('No clients are assigned to the VACANCY spreadsheet.');
  const normalizedClient = clientName.trim().toLocaleLowerCase();
  if (!clientNames.includes(normalizedClient)) {
    throw new Error(`Client ${clientName} is not assigned to the VACANCY spreadsheet.`);
  }
  const urls = Array.isArray(assignment?.sheet_urls) ? assignment.sheet_urls : [];
  const mappings = assignment?.client_sheet_urls && typeof assignment.client_sheet_urls === 'object'
    ? assignment.client_sheet_urls
    : {};
  const mappedClient = Object.keys(mappings).find(name => name.toLocaleLowerCase() === normalizedClient);
  const mappedUrl = mappedClient ? mappings[mappedClient] : '';
  let selectedUrl = typeof mappedUrl === 'string' && mappedUrl.trim() ? mappedUrl : '';
  if (!selectedUrl && urls.length === clientNames.length) {
    selectedUrl = urls[clientNames.indexOf(normalizedClient)];
  }
  if (!selectedUrl && urls.length === 1) selectedUrl = urls[0];
  if (!selectedUrl && profileResult.data.is_master_admin && typeof masterFallbackUrl === 'string') {
    selectedUrl = masterFallbackUrl.trim();
  }
  if (!selectedUrl) throw new Error(`No VACANCY spreadsheet is assigned to ${clientName}.`);
  const spreadsheetId = spreadsheetIdFromAssignedUrl(selectedUrl, 'VACANCY');
  const metadata = await googleRequest(
    `spreadsheets/${spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
  );
  const tabMappings = assignment?.client_sheet_tabs && typeof assignment.client_sheet_tabs === 'object' ? assignment.client_sheet_tabs : {};
  const mappedTab = Object.keys(tabMappings).find(name => name.toLocaleLowerCase() === normalizedClient);
  const sheetTab = String((mappedTab ? tabMappings[mappedTab] : '') || assignment?.sheet_tab || 'VACANCY').trim();
  const sheet = metadata.sheets?.find((item: any) => item.properties?.title === sheetTab);
  if (!sheet) throw new Error(`The assigned spreadsheet does not have a ${sheetTab} tab.`);
  return { spreadsheetId, sheet, clientNames, sheetTab };
}

async function ensureDestinationRow(spreadsheetId: string, sheet: any, rowNumber: number, columnCount: number) {
  const grid = sheet.properties.gridProperties || {};
  const requests = [];
  const missingRows = rowNumber - Number(grid.rowCount || 0);
  const missingColumns = columnCount - Number(grid.columnCount || 0);
  if (missingRows > 0) {
    requests.push({
      appendDimension: {
        sheetId: sheet.properties.sheetId,
        dimension: 'ROWS',
        length: missingRows
      }
    });
  }
  if (missingColumns > 0) {
    requests.push({
      appendDimension: {
        sheetId: sheet.properties.sheetId,
        dimension: 'COLUMNS',
        length: missingColumns
      }
    });
  }
  if (requests.length) {
    await googleRequest(`spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests })
    });
  }
}

async function transferHrEmplocBackout(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string,
  hrSpreadsheetId: string,
  clientNames: string[],
  vcode: string,
  rowNumber: number,
  remarks: string,
  vacancyFallbackUrl?: unknown,
  sourceTabName = 'G1N'
) {
  if (!/\bBACK(?:[\s-]?OUT)\b/i.test(remarks)) return { transferred: false };
  let backoutVerified = false;
  let vacancyVerified = false;
  let onBoardRowsDeleted = 0;
  try {
    const hrMetadata = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
    );
    const sourceSheet = hrMetadata.sheets?.find((sheet: any) => sheet.properties?.title === sourceTabName);
    const backoutSheet = hrMetadata.sheets?.find((sheet: any) => sheet.properties?.title?.toLocaleLowerCase() === 'back-out');
    if (!sourceSheet) throw new Error(`The assigned HR EMPLOC spreadsheet needs a ${sourceTabName} tab.`);
    if (!backoutSheet) throw new Error('The assigned HR EMPLOC spreadsheet needs a back-out tab.');
    const sourceWidth = 29;
    const sourceLastColumn = columnLetter(sourceWidth);
    const [sourceRowResult, sourceVcodes] = await Promise.all([
      googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${sheetRange(sourceTabName, `A${rowNumber}:${sourceLastColumn}${rowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${sheetRange(sourceTabName, 'G9:G')}?valueRenderOption=FORMATTED_VALUE`)
    ]);
    const matchedSourceRows = (sourceVcodes.values || []).flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 9] : []
    );
    if (matchedSourceRows.length !== 1 || matchedSourceRows[0] !== rowNumber) {
      throw new Error(`VCODE ${vcode} is no longer uniquely located at its G1N source row.`);
    }
    const sourceRow = Array.from({ length: sourceWidth }, (_, index) => sourceRowResult.values?.[0]?.[index] ?? '');
    if (String(sourceRow[6] ?? '').trim() !== vcode) throw new Error(`G1N row ${rowNumber} changed before transfer.`);
    const rowClient = String(sourceRow[1] ?? '').trim().toLocaleLowerCase();
    const vacancyDestination = await getAssignedVacancyDestination(
      adminClient,
      targetUserId,
      rowClient,
      vacancyFallbackUrl,
      clientNames
    );
    if (!clientNames.some(name => name.toLocaleLowerCase() === rowClient)) {
      throw new Error(`VCODE ${vcode} is not assigned to your selected client(s).`);
    }
    const [vacancyMetadata, boardMetadata] = await Promise.all([
      googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`),
      googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`)
    ]);
    const vacancySheet = vacancyMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'VACANCY');
    const boardSheet = boardMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'On Board Database');
    if (!vacancySheet) throw new Error('The assigned VACANCY spreadsheet needs a VACANCY tab.');
    if (!boardSheet) throw new Error('The assigned VACANCY spreadsheet needs an On Board Database tab.');

    const backoutLastColumn = columnLetter(sourceWidth);
    const [backoutKeysResult, backoutRowsResult, vacancyCodesResult] = await Promise.all([
      googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent("'back-out'!G:G")}?valueRenderOption=FORMATTED_VALUE`),
      googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'back-out'!A:${backoutLastColumn}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}/values/${sheetRange(vacancyDestination.sheetTab, 'B5:B')}?valueRenderOption=FORMATTED_VALUE`)
    ]);
    const backoutMatches = (backoutKeysResult.values || []).flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 1] : []
    );
    if (backoutMatches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in back-out.`);
    if (backoutMatches.length) {
      const existingBackoutResult = await googleRequest(
        `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'back-out'!A${backoutMatches[0]}:${sourceLastColumn}${backoutMatches[0]}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
      );
      if (!sameSheetValues(existingBackoutResult.values?.[0] || [], sourceRow)) {
        throw new Error(`VCODE ${vcode} already exists in back-out with different data; the G1N source row was kept.`);
      }
      backoutVerified = true;
    } else {
      const backoutRows = backoutRowsResult.values || [];
      const lastBackoutRow = backoutRows.reduce((lastRow: number, row: unknown[], index: number) =>
        row.some(value => String(value ?? '').trim()) ? index + 1 : lastRow, 0);
      const destinationRow = lastBackoutRow + 1;
      await ensureDestinationRow(hrSpreadsheetId, backoutSheet, destinationRow, sourceWidth);
      await googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'back-out'!A${destinationRow}:${sourceLastColumn}${destinationRow}`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [sourceRow] })
      });
      const verifyBackoutResult = await googleRequest(
        `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'back-out'!A${destinationRow}:${sourceLastColumn}${destinationRow}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
      );
      if (!sameSheetValues(verifyBackoutResult.values?.[0] || [], sourceRow)) {
        throw new Error(`The back-out copy for VCODE ${vcode} could not be verified; the G1N source row was kept.`);
      }
      backoutVerified = true;
    }

    const vacancyRows = vacancyCodesResult.values || [];
    const existingVacancyMatches = vacancyRows.flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 5] : []
    );
    if (existingVacancyMatches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in VACANCY.`);
    if (existingVacancyMatches.length) {
      vacancyVerified = true;
    } else {
      const lastVacancyRow = vacancyRows.reduce((lastRow: number, row: unknown[], index: number) =>
        row.some(value => String(value ?? '').trim()) ? index + 5 : lastRow, 4);
      const vacancyRowNumber = lastVacancyRow + 1;
      await ensureDestinationRow(vacancyDestination.spreadsheetId, vacancySheet, vacancyRowNumber, 2);
      await googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}/values/${sheetRange(vacancyDestination.sheetTab, `B${vacancyRowNumber}`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [[vcode]] })
      });
      const verifyVacancyResult = await googleRequest(
        `spreadsheets/${vacancyDestination.spreadsheetId}/values/${sheetRange(vacancyDestination.sheetTab, `B${vacancyRowNumber}`)}?valueRenderOption=FORMATTED_VALUE`
      );
      if (String(verifyVacancyResult.values?.[0]?.[0] ?? '').trim() !== vcode) {
        throw new Error(`The VACANCY VCODE copy for ${vcode} could not be verified; the G1N source row was kept.`);
      }
      vacancyVerified = true;
    }

    const sourceName = normalizeSheetIdentity(sourceRow[10]);
    if (!sourceName) throw new Error(`G1N column K is blank for VCODE ${vcode}; the On Board Database row cannot be safely matched.`);
    const [boardVcodesResult, boardNamesResult] = await Promise.all([
      googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}/values/${encodeURIComponent("'On Board Database'!B:B")}?valueRenderOption=FORMATTED_VALUE`),
      googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}/values/${encodeURIComponent("'On Board Database'!AL:AL")}?valueRenderOption=FORMATTED_VALUE`)
    ]);
    const boardVcodes = boardVcodesResult.values || [];
    const boardNames = boardNamesResult.values || [];
    const matchedBoardRows = Array.from({ length: Math.max(boardVcodes.length, boardNames.length) }, (_, index) => index + 1)
      .filter(boardRow => String(boardVcodes[boardRow - 1]?.[0] ?? '').trim() === vcode &&
        normalizeSheetIdentity(boardNames[boardRow - 1]?.[0]) === sourceName);
    if (matchedBoardRows.length) {
      await googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: matchedBoardRows.sort((left, right) => right - left).map(boardRow => ({
            deleteDimension: {
              range: {
                sheetId: boardSheet.properties.sheetId,
                dimension: 'ROWS',
                startIndex: boardRow - 1,
                endIndex: boardRow
              }
            }
          }))
        })
      });
      const [verifyBoardVcodes, verifyBoardNames] = await Promise.all([
        googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}/values/${encodeURIComponent("'On Board Database'!B:B")}?valueRenderOption=FORMATTED_VALUE`),
        googleRequest(`spreadsheets/${vacancyDestination.spreadsheetId}/values/${encodeURIComponent("'On Board Database'!AL:AL")}?valueRenderOption=FORMATTED_VALUE`)
      ]);
      const stillMatched = Array.from({ length: Math.max(verifyBoardVcodes.values?.length || 0, verifyBoardNames.values?.length || 0) }, (_, index) => index)
        .some(index => String(verifyBoardVcodes.values?.[index]?.[0] ?? '').trim() === vcode &&
          normalizeSheetIdentity(verifyBoardNames.values?.[index]?.[0]) === sourceName);
      if (stillMatched) throw new Error(`VCODE ${vcode} was returned to VACANCY, but its matching On Board Database row could not be deleted.`);
      onBoardRowsDeleted = matchedBoardRows.length;
    }

    const currentVcodesResult = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${sheetRange(sourceTabName, 'G9:G')}?valueRenderOption=FORMATTED_VALUE`
    );
    const currentMatches = (currentVcodesResult.values || []).flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 9] : []
    );
    if (!currentMatches.length) return { transferred: true, vcode, sourceRowDeleted: true, onBoardRowsDeleted };
    if (currentMatches.length > 1) throw new Error(`VCODE ${vcode} became duplicated in G1N before deletion.`);
    await googleRequest(`spreadsheets/${hrSpreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sourceSheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: currentMatches[0] - 1,
              endIndex: currentMatches[0]
            }
          }
        }]
      })
    });
    const verifyDeleteResult = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${sheetRange(sourceTabName, 'G9:G')}?valueRenderOption=FORMATTED_VALUE`
    );
    if ((verifyDeleteResult.values || []).some((row: unknown[]) => String(row[0] ?? '').trim() === vcode)) {
      throw new Error(`Both destinations were verified, but VCODE ${vcode} remains in G1N.`);
    }
    return { transferred: true, vcode, sourceRowDeleted: true, onBoardRowsDeleted };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const completed = [
      backoutVerified ? 'The back-out row was verified.' : '',
      vacancyVerified ? 'The VACANCY VCODE was verified.' : '',
      onBoardRowsDeleted ? `${onBoardRowsDeleted} matching On Board Database row(s) were deleted.` : ''
    ].filter(Boolean).join(' ');
    throw new Error(`HRCO remarks were saved, but the BACK OUT transfer for VCODE ${vcode} did not finish. ${error.message} ${completed} The G1N source row was retained; retry the remarks update to safely finish.`);
  }
}

async function approveVacancyRecord(
  sourceSpreadsheetId: string,
  hrEmplocSpreadsheetId: string,
  sourceClientNames: string[],
  hrClientNames: string[],
  vcode: string,
  sourceSheetTab = 'VACANCY',
  hrSheetTab = 'G1N'
) {
  let boardVerified = false;
  let emplocVerified = false;
  try {
  const sourceIndex = new Set(sourceClientNames.map(name => name.toLocaleLowerCase()));
  const sourceMatchesResult = await googleRequest(
    `spreadsheets/${sourceSpreadsheetId}/values/${sheetRange(sourceSheetTab, 'B5:C')}?valueRenderOption=FORMATTED_VALUE`
  );
  const sourceMatches = (sourceMatchesResult.values || []).flatMap((row: unknown[], index: number) =>
    String(row[0] ?? '').trim() === vcode ? [{ rowNumber: index + 5, clientName: String(row[1] ?? '').trim() }] : []
  );
  if (!sourceMatches.length) throw new Error(`VCODE ${vcode} is no longer in VACANCY.`);
  if (sourceMatches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in VACANCY; no rows were transferred.`);
  const { rowNumber: originalRowNumber, clientName } = sourceMatches[0];
  if (!sourceIndex.has(clientName.toLocaleLowerCase())) throw new Error(`VCODE ${vcode} is outside your assigned client scope.`);
  if (!hrClientNames.includes(clientName.toLocaleLowerCase())) {
    throw new Error(`Client ${clientName} is not assigned to the HR EMPLOC spreadsheet.`);
  }

  const sourceResult = await googleRequest(
    `spreadsheets/${sourceSpreadsheetId}/values/${sheetRange(sourceSheetTab, `A${originalRowNumber}:AR${originalRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
  );
  const sourceRow = Array.from({ length: 44 }, (_, index) => sourceResult.values?.[0]?.[index] ?? '');
  if (String(sourceRow[1]).trim() !== vcode) throw new Error(`VACANCY row ${originalRowNumber} changed before approval.`);
  if (!approvalRequiredSourceColumns.every(index => String(sourceRow[index] ?? '').trim() !== '')) {
    throw new Error(`VCODE ${vcode} no longer meets all required approval fields.`);
  }

  const [sourceMetadata, hrMetadata] = await Promise.all([
    googleRequest(`spreadsheets/${sourceSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`),
    googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`)
  ]);
  const boardTab = sourceMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'On Board Database');
  const vacancyTab = sourceMetadata.sheets?.find((sheet: any) => sheet.properties?.title === sourceSheetTab);
  const hrTab = hrMetadata.sheets?.find((sheet: any) => sheet.properties?.title === hrSheetTab);
  if (!boardTab) throw new Error('The VACANCY spreadsheet needs a tab named On Board Database.');
  if (!vacancyTab) throw new Error('The source spreadsheet needs a tab named VACANCY.');
  if (!hrTab) throw new Error('The assigned HR EMPLOC spreadsheet needs a tab named G1N.');

  const [boardKeyResult, boardRowValues] = await Promise.all([
    googleRequest(`spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent("'On Board Database'!B:B")}?valueRenderOption=UNFORMATTED_VALUE`),
    googleRequest(`spreadsheets/${sourceSpreadsheetId}/values:batchGet?ranges=${encodeURIComponent("'On Board Database'!A:N")}&ranges=${encodeURIComponent("'On Board Database'!P:Z")}&ranges=${encodeURIComponent("'On Board Database'!AB:AR")}&valueRenderOption=UNFORMATTED_VALUE`)
  ]);
  const boardKeys = boardKeyResult.values || [];
  const boardMatches = boardKeys.flatMap((row: unknown[], index: number) =>
    String(row[0] ?? '').trim() === vcode ? [index + 1] : []
  );
  if (boardMatches.length > 1) throw new Error(`VCODE ${vcode} already appears more than once in On Board Database.`);
  let boardRowNumber: number;
  if (boardMatches.length) {
    boardRowNumber = boardMatches[0];
    const existingResult = await googleRequest(
      `spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent(`'On Board Database'!A${boardRowNumber}:AR${boardRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
    );
    if (!sameSheetValues(existingResult.values?.[0] || [], sourceRow, [14, 26])) {
      throw new Error(`VCODE ${vcode} already exists in On Board Database with different data; it was not overwritten.`);
    }
    boardVerified = true;
  } else {
    const occupiedRanges = boardRowValues.valueRanges || [];
    const lastOccupiedBoardRow = occupiedRanges.reduce((lastRow: number, range: any) =>
      Math.max(lastRow, ...(range.values || []).flatMap((row: unknown[], index: number) =>
        row.some(value => String(value ?? '').trim()) ? [index + 1] : []
      )), 0);
    boardRowNumber = lastOccupiedBoardRow + 1;
    const boardGrid = boardTab.properties.gridProperties || {};
    const boardGrowthRequests = [];
    const boardRowsToAdd = boardRowNumber - Number(boardGrid.rowCount || 0);
    const boardColumnsToAdd = 44 - Number(boardGrid.columnCount || 0);
    if (boardRowsToAdd > 0) {
      boardGrowthRequests.push({
        appendDimension: {
          sheetId: boardTab.properties.sheetId,
          dimension: 'ROWS',
          length: boardRowsToAdd
        }
      });
    }
    if (boardColumnsToAdd > 0) {
      boardGrowthRequests.push({
        appendDimension: {
          sheetId: boardTab.properties.sheetId,
          dimension: 'COLUMNS',
          length: boardColumnsToAdd
        }
      });
    }
    if (boardGrowthRequests.length) {
      await googleRequest(`spreadsheets/${sourceSpreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: boardGrowthRequests })
      });
    }
    const boardData = [
      { range: `'On Board Database'!A${boardRowNumber}:N${boardRowNumber}`, values: [sourceRow.slice(0, 14)] },
      { range: `'On Board Database'!P${boardRowNumber}:Z${boardRowNumber}`, values: [sourceRow.slice(15, 26)] },
      { range: `'On Board Database'!AB${boardRowNumber}:AR${boardRowNumber}`, values: [sourceRow.slice(27, 44)] }
    ];
    await googleRequest(`spreadsheets/${sourceSpreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'RAW', data: boardData })
    });
    const writtenBoardRow = await googleRequest(
      `spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent(`'On Board Database'!A${boardRowNumber}:AR${boardRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
    );
    if (!sameSheetValues(writtenBoardRow.values?.[0] || [], sourceRow, [14, 26])) {
      throw new Error(`The On Board Database copy for VCODE ${vcode} could not be verified.`);
    }
    boardVerified = true;
  }

  const emplocRow = [sourceRow[25], sourceRow[2], sourceRow[10], sourceRow[11], sourceRow[12], sourceRow[24], sourceRow[1]];
  const [emplocKeyResult, emplocRowValues] = await Promise.all([
    googleRequest(    `spreadsheets/${hrEmplocSpreadsheetId}/values/${sheetRange(hrSheetTab, 'G9:G')}?valueRenderOption=UNFORMATTED_VALUE`),
    googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}/values/${sheetRange(hrSheetTab, 'A9:G')}?valueRenderOption=UNFORMATTED_VALUE`)
  ]);
  const emplocKeys = emplocKeyResult.values || [];
  const emplocMatches = emplocKeys.flatMap((row: unknown[], index: number) =>
    String(row[0] ?? '').trim() === vcode ? [index + 9] : []
  );
  if (emplocMatches.length > 1) throw new Error(`VCODE ${vcode} already appears more than once in HR EMPLOC G1N.`);
  let emplocRowNumber: number;
  if (emplocMatches.length) {
    emplocRowNumber = emplocMatches[0];
    const existingResult = await googleRequest(
      `spreadsheets/${hrEmplocSpreadsheetId}/values/${sheetRange(hrSheetTab, `A${emplocRowNumber}:G${emplocRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
    );
    if (!sameSheetValues(existingResult.values?.[0] || [], emplocRow)) {
      throw new Error(`VCODE ${vcode} already exists in HR EMPLOC G1N with different data; it was not overwritten.`);
    }
    emplocVerified = true;
  } else {
    const lastOccupiedEmplocOffset = (emplocRowValues.values || []).reduce((lastRow: number, row: unknown[], index: number) =>
      row.some(value => String(value ?? '').trim()) ? index + 1 : lastRow, 0);
    emplocRowNumber = Math.max(9, lastOccupiedEmplocOffset + 9);
    const emplocGrid = hrTab.properties.gridProperties || {};
    const emplocRowsToAdd = emplocRowNumber - Number(emplocGrid.rowCount || 0);
    if (emplocRowsToAdd > 0) {
      await googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({
          requests: [{
            appendDimension: {
              sheetId: hrTab.properties.sheetId,
              dimension: 'ROWS',
              length: emplocRowsToAdd
            }
          }]
        })
      });
    }
    await googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}/values/${sheetRange(hrSheetTab, `A${emplocRowNumber}:G${emplocRowNumber}`)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [emplocRow] })
    });
    const writtenEmplocRow = await googleRequest(
      `spreadsheets/${hrEmplocSpreadsheetId}/values/${sheetRange(hrSheetTab, `A${emplocRowNumber}:G${emplocRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
    );
    if (!sameSheetValues(writtenEmplocRow.values?.[0] || [], emplocRow)) {
      throw new Error(`The HR EMPLOC G1N copy for VCODE ${vcode} could not be verified.`);
    }
    emplocVerified = true;
  }

  let sourceRowDeleted = false;
  for (let attempt = 0; attempt < 2 && !sourceRowDeleted; attempt += 1) {
    const currentMatchesResult = await googleRequest(
      `spreadsheets/${sourceSpreadsheetId}/values/${sheetRange(sourceSheetTab, 'B5:B')}?valueRenderOption=FORMATTED_VALUE`
    );
    const currentMatches = (currentMatchesResult.values || []).flatMap((value: unknown, index: number) =>
      String(value ?? '').trim() === vcode ? [index + 5] : []
    );
    if (!currentMatches.length) {
      sourceRowDeleted = true;
      break;
    }
    if (currentMatches.length > 1) throw new Error(`VCODE ${vcode} became duplicated before its VACANCY row could be deleted.`);
    const currentRowNumber = currentMatches[0];
    if (attempt === 1) {
      await googleRequest(`spreadsheets/${sourceSpreadsheetId}/values:batchClear`, {
        method: 'POST',
        body: JSON.stringify({
          ranges: [
            sheetA1(sourceSheetTab, `A${currentRowNumber}:N${currentRowNumber}`),
            sheetA1(sourceSheetTab, `P${currentRowNumber}:Z${currentRowNumber}`),
            sheetA1(sourceSheetTab, `AB${currentRowNumber}:AR${currentRowNumber}`)
          ]
        })
      });
    }
    await googleRequest(`spreadsheets/${sourceSpreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: vacancyTab.properties.sheetId,
              dimension: 'ROWS',
              startIndex: currentRowNumber - 1,
              endIndex: currentRowNumber
            }
          }
        }]
      })
    });
    const verifyMatchesResult = await googleRequest(
      `spreadsheets/${sourceSpreadsheetId}/values/${sheetRange(sourceSheetTab, 'B5:B')}?valueRenderOption=FORMATTED_VALUE`
    );
    const remainingMatches = (verifyMatchesResult.values || []).flat().filter((value: unknown) =>
      String(value ?? '').trim() === vcode
    );
    if (!remainingMatches.length) sourceRowDeleted = true;
  }
  if (!sourceRowDeleted) {
    throw new Error(`Both destination copies are verified, but VCODE ${vcode} is still present in VACANCY after retrying row deletion.`);
  }
  return { vcode, approved: true, sourceRowDeleted: true };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const copiedDestinations = [
      boardVerified ? 'On Board Database copy verified.' : '',
      emplocVerified ? 'HR EMPLOC G1N copy verified.' : ''
    ].filter(Boolean).join(' ');
    if (copiedDestinations) {
      throw new Error(`${error.message} ${copiedDestinations} The source row remains in VACANCY; retry after resolving the issue.`);
    }
    throw error;
  }
}

async function transferPlantillaRowToInactive(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string,
  plantillaSpreadsheetId: string,
  vcode: string,
  sourceTabName = 'PLANTILLA'
) {
  let inactiveWritten = false;
  let vacancyWritten = false;
  let transferStarted = false;
  try {
    const sourceMatches = await googleRequest(
      `spreadsheets/${plantillaSpreadsheetId}/values/${sheetRange(sourceTabName, 'B9:B')}?valueRenderOption=FORMATTED_VALUE`
    );
    const sourceRows = (sourceMatches.values || []).flat();
    const matchingRows = sourceRows.flatMap((value: unknown, index: number) =>
      String(value ?? '').trim() === vcode ? [index + 9] : []
    );
    if (matchingRows.length !== 1) {
      throw new Error(matchingRows.length ? `VCODE ${vcode} appears more than once in PLANTILLA.` : `VCODE ${vcode} is no longer in PLANTILLA.`);
    }
    const sourceRowNumber = matchingRows[0];
    const [sourceData, sourceState] = await Promise.all([
      googleRequest(`spreadsheets/${plantillaSpreadsheetId}/values/${sheetRange(sourceTabName, `A${sourceRowNumber}:AR${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      googleRequest(`spreadsheets/${plantillaSpreadsheetId}/values/${sheetRange(sourceTabName, `AG${sourceRowNumber}:AH${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`)
    ]);
    const sourceValues = sourceData.values?.[0] || [];
    const sourceClientName = String(sourceValues[34] ?? '').trim();
    if (!sourceClientName) throw new Error(`PLANTILLA row ${sourceRowNumber} has no client value in column AI.`);
    const separationDate = sourceState.values?.[0]?.[0];
    const status = String(sourceState.values?.[0]?.[1] ?? '').trim().toLocaleUpperCase();
    const hasSeparationDate = typeof separationDate === 'number'
      ? Number.isFinite(separationDate) && separationDate > 0
      : typeof separationDate === 'string' && Number.isFinite(Date.parse(separationDate));
    if (String(sourceValues[1] ?? '').trim() !== vcode) throw new Error(`PLANTILLA row ${sourceRowNumber} changed while it was being transferred.`);
    if (!hasSeparationDate || !inactiveTransferStatuses.has(status)) {
      return { transferred: false, reason: 'not-eligible' };
    }
    transferStarted = true;

    const { data: masterAdmin, error: masterAdminError } = await adminClient.from('profiles')
      .select('id')
      .eq('is_master_admin', true)
      .eq('role', 'admin')
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    if (masterAdminError || !masterAdmin) throw new Error('The active Master Admin profile could not be found.');
    const [inactiveAssignment, vacancyDestination] = await Promise.all([
      adminClient.from('dashboard_assignments').select('sheet_urls, sheet_tab').eq('user_id', masterAdmin.id).eq('dashboard_name', 'INACTIVE').maybeSingle(),
      getAssignedVacancyDestination(adminClient, targetUserId, sourceClientName)
    ]);
    if (inactiveAssignment.error) throw new Error('Could not load the Master Admin INACTIVE archive assignment.');
    const inactiveSpreadsheetId = spreadsheetIdFromAssignedUrl(inactiveAssignment.data?.sheet_urls?.[0], 'INACTIVE archive');
    const vacancySpreadsheetId = vacancyDestination.spreadsheetId;
    const inactiveTabName = String(inactiveAssignment.data?.sheet_tab || 'INACTIVE').trim();

    const [inactiveMetadata, plantillaMetadata, archivedRowsResult, vacancyVcodes] = await Promise.all([
      googleRequest(`spreadsheets/${inactiveSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`),
      googleRequest(`spreadsheets/${plantillaSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`),
      googleRequest(`spreadsheets/${inactiveSpreadsheetId}/values/${sheetRange(inactiveTabName, 'A:AR')}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      googleRequest(`spreadsheets/${vacancySpreadsheetId}/values/${sheetRange(vacancyDestination.sheetTab, 'B5:B')}?valueRenderOption=FORMATTED_VALUE`)
    ]);
    const inactiveTab = inactiveMetadata.sheets?.find((sheet: any) => sheet.properties?.title === inactiveTabName);
    const plantillaTab = plantillaMetadata.sheets?.find((sheet: any) => sheet.properties?.title === sourceTabName);
    if (!inactiveTab) throw new Error(`The archive spreadsheet needs a tab named ${inactiveTabName}.`);
    if (!plantillaTab) throw new Error('The source spreadsheet needs a tab named PLANTILLA.');

    const archivedRows = archivedRowsResult.values || [];
    const archivedMatches = archivedRows.flatMap((row: unknown[], index: number) =>
      String(row[1] ?? '').trim() === vcode ? [index + 1] : []
    );
    if (archivedMatches.length > 1) throw new Error(`VCODE ${vcode} already appears more than once in the INACTIVE archive.`);
    if (archivedMatches.length) {
      const archivedRowResult = await googleRequest(
        `spreadsheets/${inactiveSpreadsheetId}/values/${sheetRange(inactiveTabName, `A${archivedMatches[0]}:AR${archivedMatches[0]}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
      );
      const archivedRow = archivedRowResult.values?.[0] || [];
      const rowsMatch = Array.from({ length: 44 }, (_, index) =>
        String(archivedRow[index] ?? '') === String(sourceValues[index] ?? '')
      ).every(Boolean);
      if (!rowsMatch) throw new Error(`VCODE ${vcode} already exists in INACTIVE with different data; the existing archive row was not overwritten.`);
    } else {
      const lastOccupiedRow = archivedRows.reduce((lastRow: number, row: unknown[], index: number) =>
        row.some(value => String(value ?? '').trim()) ? index + 1 : lastRow, 0);
      const destinationRow = lastOccupiedRow + 1;
      const grid = inactiveTab.properties.gridProperties || {};
      const appendRequests = [];
      const missingRows = destinationRow - Number(grid.rowCount || 0);
      const missingColumns = 44 - Number(grid.columnCount || 0);
      if (missingRows > 0) {
        appendRequests.push({
          appendDimension: {
            sheetId: inactiveTab.properties.sheetId,
            dimension: 'ROWS',
            length: missingRows
          }
        });
      }
      if (missingColumns > 0) {
        appendRequests.push({
          appendDimension: {
            sheetId: inactiveTab.properties.sheetId,
            dimension: 'COLUMNS',
            length: missingColumns
          }
        });
      }
      if (appendRequests.length) {
        await googleRequest(`spreadsheets/${inactiveSpreadsheetId}:batchUpdate`, {
          method: 'POST',
          body: JSON.stringify({ requests: appendRequests })
        });
      }
      await googleRequest(`spreadsheets/${inactiveSpreadsheetId}/values/${sheetRange(inactiveTabName, `A${destinationRow}:AR${destinationRow}`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [Array.from({ length: 44 }, (_, index) => sourceValues[index] ?? '')] })
      });
      inactiveWritten = true;
    }

    const vacancyMatches = (vacancyVcodes.values || []).flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 5] : []
    );
    if (vacancyMatches.length > 1) throw new Error(`VCODE ${vcode} already appears more than once in VACANCY.`);
    if (!vacancyMatches.length) {
      await googleRequest(
        `spreadsheets/${vacancySpreadsheetId}/values/${sheetRange(vacancyDestination.sheetTab, 'B5:B')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: [[vcode]] }) }
      );
      vacancyWritten = true;
    }

    const currentSource = await googleRequest(
      `spreadsheets/${plantillaSpreadsheetId}/values/${sheetRange(sourceTabName, `B${sourceRowNumber}:AH${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE`
    );
    const currentRow = currentSource.values?.[0] || [];
    const currentDate = currentRow[31];
    const currentStatus = String(currentRow[32] ?? '').trim().toLocaleUpperCase();
    const stillHasDate = typeof currentDate === 'number'
      ? Number.isFinite(currentDate) && currentDate > 0
      : typeof currentDate === 'string' && Number.isFinite(Date.parse(currentDate));
    if (String(currentRow[0] ?? '').trim() !== vcode || !stillHasDate || !inactiveTransferStatuses.has(currentStatus)) {
      throw new Error(`PLANTILLA row ${sourceRowNumber} changed before it could be deleted.`);
    }
    await googleRequest(`spreadsheets/${plantillaSpreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: plantillaTab.properties.sheetId,
              dimension: 'ROWS',
              startIndex: sourceRowNumber - 1,
              endIndex: sourceRowNumber
            }
          }
        }]
      })
    });
    return { transferred: true, vcode, archived: true, vacancyUpdated: true, sourceRowDeleted: true };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (transferStarted) {
      const completedSteps = [
        inactiveWritten ? 'The row was copied to INACTIVE.' : '',
        vacancyWritten ? 'The VCODE was added to VACANCY.' : ''
      ].filter(Boolean).join(' ');
      throw new Error(`${error.message} ${completedSteps} The source PLANTILLA row was kept. Retry the update to safely finish.`);
    }
    throw error;
  }
}

async function readPlantilla(spreadsheetId: string, tabName = 'PLANTILLA') {
  const range = sheetRange(tabName, 'A9:AQ');
  const [raw, display] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  return { rawValues: raw.values || [], displayValues: display.values || [] };
}

async function readVcode(spreadsheetId: string, tabName = 'VCODE') {
  const range = sheetRange(tabName, 'A3:N');
  const result = await googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  return { displayValues: result.values || [] };
}

function attritionIsoDate(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
  }
  const text = String(value ?? '').trim();
  if (!text) return '';
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return '';
    return date.toISOString().slice(0, 10);
  }
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
    if (date.getUTCFullYear() !== Number(match[3]) || date.getUTCMonth() !== Number(match[1]) - 1 || date.getUTCDate() !== Number(match[2])) return '';
    return date.toISOString().slice(0, 10);
  }
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime())
    ? new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())).toISOString().slice(0, 10)
    : '';
}

function attritionDisplayDate(value: unknown) {
  const isoDate = attritionIsoDate(value);
  if (!isoDate) return String(value ?? '').trim();
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, day))).toLocaleUpperCase();
}

async function readAttritionRecords(
  spreadsheetId: string,
  sheetTab: string,
  assignedClients: string[],
  isMasterAdmin: boolean
) {
  const result = await readSheetGridRanges(spreadsheetId, sheetTab, [{
    startRowIndex: 2,
    startColumnIndex: 0,
    endColumnIndex: 47
  }]);
  const values: unknown[][] = result[0]?.valueRange?.values || [];
  const allowedClients = new Set(assignedClients.map(client => client.trim().toLocaleLowerCase()).filter(Boolean));
  if (!allowedClients.size && !isMasterAdmin) throw new Error('No clients are assigned to this ATTRITION dashboard.');
  const allowedStatuses = new Set(['AWOL', 'BACK OUT', 'ENDO', 'RESIGNED', 'TERMINATED']);
  const records = values.flatMap(row => {
    const account = String(row[46] ?? '').trim();
    const clientKey = account.toLocaleLowerCase();
    if (!account || (allowedClients.size && !allowedClients.has(clientKey))) return [];
    const status = String(row[33] ?? '').trim().toLocaleUpperCase();
    if (!allowedStatuses.has(status)) return [];
    const emploc = String(row[2] ?? '').trim();
    if (!emploc) return [];
    const dateHiredValue = row[14] ?? '';
    const separationValue = row[32] ?? '';
    return [{
      account,
      emploc,
      fullname: String(row[35] ?? '').trim(),
      outlet: String(row[9] ?? '').trim(),
      area: String(row[8] ?? '').trim(),
      tenure: String(row[15] ?? '').trim(),
      status,
      contactNo: String(row[20] ?? '').trim(),
      dateHired: attritionDisplayDate(dateHiredValue),
      dateSeparation: attritionDisplayDate(separationValue),
      separationDate: attritionIsoDate(separationValue)
    }];
  });
  return { records };
}

async function listAttritionClients(spreadsheetUrl: unknown, sheetTab: unknown) {
  const spreadsheetId = spreadsheetIdFromAssignedUrl(spreadsheetUrl, 'ATTRITION');
  const result = await readSheetGridRanges(spreadsheetId, String(sheetTab || 'ATTRITION'), [{
    startRowIndex: 2,
    startColumnIndex: 46,
    endColumnIndex: 47
  }]);
  const clientsByNormalizedName = new Map<string, string>();
  for (const row of result[0]?.valueRange?.values || []) {
    const client = String(row[0] ?? '').trim();
    const normalizedName = client.toLocaleLowerCase();
    if (normalizedName && !clientsByNormalizedName.has(normalizedName)) {
      clientsByNormalizedName.set(normalizedName, client);
    }
  }
  return {
    clients: [...clientsByNormalizedName.values()].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    )
  };
}

async function readVcodeVariance(spreadsheetId: string, tabName: string, clientName: string) {
  const result = await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${sheetRange(tabName, 'B3:F')}?valueRenderOption=FORMATTED_VALUE`
  );
  const targetClient = clientName.trim().toLocaleLowerCase();
  if (!targetClient) throw new Error('A client must be selected to load VCODE variance records.');
  const records = (result.values || []).flatMap((row: unknown[], index: number) => {
    const vcode = String(row[0] ?? '').trim();
    const client = String(row[4] ?? '').trim().toLocaleLowerCase();
    if (!vcode || client !== targetClient) return [];
    return [{
      rowNumber: index + 3,
      vcode,
      outlet: String(row[1] ?? '').trim(),
      position: String(row[2] ?? '').trim(),
      hc: String(row[3] ?? '').trim()
    }];
  });
  return { records, count: records.length };
}

function parseVcodeVarianceSelection(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 100) {
    throw new Error('Select between 1 and 100 VCODE records.');
  }
  const rows = value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('A selected VCODE row is invalid.');
    const rowNumber = Number((item as { rowNumber?: unknown }).rowNumber);
    const vcode = String((item as { vcode?: unknown }).vcode ?? '').trim();
    if (!Number.isInteger(rowNumber) || rowNumber < 3 || !vcode) throw new Error('A selected VCODE row is invalid. Refresh and try again.');
    return { rowNumber, vcode };
  });
  if (new Set(rows.map(row => row.rowNumber)).size !== rows.length) {
    throw new Error('A VCODE row was selected more than once. Refresh and try again.');
  }
  return rows;
}

async function validateVcodeVarianceSelection(
  spreadsheetId: string,
  sheetTab: string,
  clientName: string,
  rows: { rowNumber: number; vcode: string }[],
  columns: { start: number; vcode: number; client?: number } = { start: 1, vcode: 0, client: 4 }
) {
  const values = await readSheetGridRanges(
    spreadsheetId,
    sheetTab,
    rows.map(row => ({
      startRowIndex: row.rowNumber - 1,
      endRowIndex: row.rowNumber,
      startColumnIndex: columns.start,
      endColumnIndex: columns.start + Math.max(columns.vcode, columns.client ?? columns.vcode) + 1
    }))
  );
  const clientKey = clientName.trim().toLocaleLowerCase();
  return rows.map((row, index) => {
    const valuesAtRow = values[index]?.valueRange?.values?.[0] || [];
    const currentVcode = String(valuesAtRow[columns.vcode] ?? '').trim();
    const currentClient = columns.client === undefined
      ? clientKey
      : String(valuesAtRow[columns.client] ?? '').trim().toLocaleLowerCase();
    if (currentVcode !== row.vcode || currentClient !== clientKey) {
      throw new Error(`VCODE ${row.vcode} changed or no longer belongs to ${clientName}. Refresh the table and try again.`);
    }
    return row;
  });
}

async function appendVcodesToVacancy(
  sourceSpreadsheetId: string,
  sourceSheetTab: string,
  vacancySpreadsheetId: string,
  vacancySheetTab: string,
  clientName: string,
  selection: unknown
) {
  const rows = parseVcodeVarianceSelection(selection);
  await validateVcodeVarianceSelection(sourceSpreadsheetId, sourceSheetTab, clientName, rows);
  const [metadata, currentVcodes] = await Promise.all([
    googleRequest(`spreadsheets/${vacancySpreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`),
    googleRequest(`spreadsheets/${vacancySpreadsheetId}/values/${sheetRange(vacancySheetTab, 'B5:B')}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  const vacancySheet = (metadata.sheets || []).find((sheet: any) => sheet.properties?.title === vacancySheetTab);
  if (!vacancySheet) throw new Error(`The assigned VACANCY spreadsheet does not have a ${vacancySheetTab} tab.`);
  const vacancyRows = currentVcodes.values || [];
  const lastUsedRow = vacancyRows.reduce((lastRow: number, row: unknown[], index: number) =>
    row.some(value => String(value ?? '').trim()) ? index + 5 : lastRow, 4);
  const firstDestinationRow = lastUsedRow + 1;
  const lastDestinationRow = firstDestinationRow + rows.length - 1;
  await ensureDestinationRow(vacancySpreadsheetId, vacancySheet, lastDestinationRow, 2);
  await googleRequest(`spreadsheets/${vacancySpreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [{
        range: sheetA1(vacancySheetTab, `B${firstDestinationRow}:B${lastDestinationRow}`),
        values: rows.map(row => [row.vcode])
      }]
    })
  });
  const verification = await googleRequest(
    `spreadsheets/${vacancySpreadsheetId}/values/${sheetRange(vacancySheetTab, `B${firstDestinationRow}:B${lastDestinationRow}`)}?valueRenderOption=FORMATTED_VALUE`
  );
  if (!rows.every((row, index) => String(verification.values?.[index]?.[0] ?? '').trim() === row.vcode)) {
    throw new Error('The VCODE copy to VACANCY could not be verified.');
  }
  return { transferredCount: rows.length };
}

async function archiveAndDeleteVcodes(
  summarySpreadsheetId: string,
  sourceSpreadsheetId: string,
  summarySheetTab: string,
  sourceSheetTab: string,
  archiveSheetTab: string,
  clientName: string,
  selection: unknown
) {
  const selectedRows = parseVcodeVarianceSelection(selection);
  await validateVcodeVarianceSelection(summarySpreadsheetId, summarySheetTab, clientName, selectedRows);
  const sourceIndex = await readSheetGridRanges(sourceSpreadsheetId, sourceSheetTab, [{
    startRowIndex: 2,
    startColumnIndex: 0,
    endColumnIndex: 6
  }]);
  const sourceRowsByVcode: unknown[][] = sourceIndex[0]?.valueRange?.values || [];
  const clientKey = clientName.trim().toLocaleLowerCase();
  const rows = selectedRows.map(selected => {
    const codeMatches = sourceRowsByVcode.flatMap((row, index) =>
      String(row[0] ?? '').trim() === selected.vcode
        ? [{ rowNumber: index + 3, vcode: selected.vcode, client: String(row[5] ?? '').trim().toLocaleLowerCase() }]
        : []
    );
    if (!codeMatches.length) {
      throw new Error(`VCODE ${selected.vcode} was found in ${summarySheetTab}, but not in the ${sourceSheetTab} tab for ${clientName}.`);
    }
    const clientMatches = codeMatches.filter(row => row.client === clientKey);
    const matches = clientMatches.length === 1
      ? clientMatches
      : clientMatches.length > 1
        ? clientMatches
        : codeMatches;
    if (matches.length > 1) {
      throw new Error(`VCODE ${selected.vcode} appears more than once in ${sourceSheetTab} for ${clientName}; no rows were moved.`);
    }
    return { rowNumber: matches[0].rowNumber, vcode: matches[0].vcode };
  });
  await validateVcodeVarianceSelection(sourceSpreadsheetId, sourceSheetTab, clientName, rows, {
    start: 0,
    vcode: 0
  });
  const sourceValues = await readSheetGridRanges(
    sourceSpreadsheetId,
    sourceSheetTab,
    rows.map(row => ({
      startRowIndex: row.rowNumber - 1,
      endRowIndex: row.rowNumber,
      startColumnIndex: 0,
      endColumnIndex: 19
    }))
  );
  const sourceRows = sourceValues.map((item: any) => item.valueRange);
  if (sourceRows.length !== rows.length) throw new Error('Could not read all selected VCODE rows; no rows were deleted.');
  const archivedAt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date());
  const archiveRows = rows.map((selected, index) => {
    const sourceRow = sourceRows[index]?.values?.[0] || [];
    if (String(sourceRow[0] ?? '').trim() !== selected.vcode) {
      throw new Error(`VCODE ${selected.vcode} changed while preparing its archive; no rows were deleted.`);
    }
    return [...Array.from({ length: 19 }, (_, column) => sourceRow[column] ?? ''), archivedAt];
  });
  const metadata = await googleRequest(
    `spreadsheets/${sourceSpreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
  );
  const sheets = metadata.sheets || [];
  const sourceSheet = sheets.find((sheet: any) => sheet.properties?.title === sourceSheetTab);
  if (!sourceSheet) throw new Error(`The VCODE source tab ${sourceSheetTab} was not found.`);
  let archiveSheet = sheets.find((sheet: any) => sheet.properties?.title === archiveSheetTab);
  if (!archiveSheet) {
    try {
      const created = await googleRequest(`spreadsheets/${sourceSpreadsheetId}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: archiveSheetTab } } }] })
      });
      archiveSheet = { properties: created.replies?.[0]?.addSheet?.properties };
    } catch (error) {
      const refreshed = await googleRequest(`spreadsheets/${sourceSpreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId`);
      archiveSheet = (refreshed.sheets || []).find((sheet: any) => sheet.properties?.title === archiveSheetTab);
      if (!archiveSheet) throw error;
    }
  }
  if (!archiveSheet?.properties?.sheetId) throw new Error(`Could not prepare the ${archiveSheetTab} archive tab.`);
  try {
    const archiveColumn = await readSheetGridRanges(sourceSpreadsheetId, archiveSheetTab, [{
      startColumnIndex: 0,
      endColumnIndex: 1
    }]);
    const archiveColumnValues: unknown[][] = archiveColumn[0]?.valueRange?.values || [];
    const lastUsedIndex = archiveColumnValues.reduce((last, row, index) =>
      String(row[0] ?? '').trim() ? index : last, -1);
    const firstDestinationRow = lastUsedIndex + 2;
    const lastDestinationRow = firstDestinationRow + archiveRows.length - 1;
    await ensureDestinationRow(sourceSpreadsheetId, archiveSheet, lastDestinationRow, 20);
    const destinationRange = sheetA1(
      archiveSheetTab,
      `A${firstDestinationRow}:T${lastDestinationRow}`
    );
    await googleRequest(`spreadsheets/${sourceSpreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [{ range: destinationRange, values: archiveRows }]
      })
    });
    const verification = await googleRequest(
      `spreadsheets/${sourceSpreadsheetId}/values/${sheetRange(archiveSheetTab, `A${firstDestinationRow}:T${lastDestinationRow}`)}?valueRenderOption=FORMATTED_VALUE`
    );
    const copiedRows = verification.values || [];
    const sameArchive = archiveRows.every((expected: unknown[], index: number) =>
      expected.every((value, column) => String(copiedRows[index]?.[column] ?? '') === String(value ?? ''))
    );
    if (!sameArchive) throw new Error('The archived rows did not match the selected source rows.');
  } catch (error) {
    throw new Error(`The archive copy to ${archiveSheetTab} failed; the original VCODE rows were kept. ${error instanceof Error ? error.message : ''}`.trim());
  }
  try {
    await validateVcodeVarianceSelection(sourceSpreadsheetId, sourceSheetTab, clientName, rows, {
      start: 0,
      vcode: 0
    });
    await googleRequest(`spreadsheets/${sourceSpreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: rows
          .map(row => row.rowNumber - 1)
          .sort((left, right) => right - left)
          .map(rowIndex => ({
            deleteDimension: {
              range: {
                sheetId: sourceSheet.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowIndex,
                endIndex: rowIndex + 1
              }
            }
          }))
      })
    });
  } catch (error) {
    throw new Error(`The rows were safely copied to ${archiveSheetTab}, but deleting them from ${sourceSheetTab} failed. No archived copies were removed. ${error instanceof Error ? error.message : ''}`.trim());
  }
  return { deletedCount: rows.length, archiveSheetTab };
}

async function readBuffer(spreadsheetId: string, tabName = '-+5% GAP') {
  const range = sheetRange(tabName, 'C9:T');
  const [raw, display] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  return { rawValues: raw.values || [], displayValues: display.values || [] };
}

async function readBufferDetail(spreadsheetId: string, tabName: string, detailType: string, clientName: string) {
  const clientColumn = bufferDetailClientColumns[detailType];
  if (clientColumn === undefined) throw new Error('Choose a valid buffer detail dashboard.');
  const columns = bufferDetailDataColumns[detailType];
  const range = sheetRange(tabName, 'A7:X');
  const [raw, display] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  const rawRows: unknown[][] = raw.values || [];
  const displayRows: unknown[][] = display.values || [];
  const targetClient = clientName.trim().toLocaleLowerCase();
  if (!targetClient) throw new Error('A client must be selected to load buffer detail records.');
  const records = [];
  for (let rowIndex = 0; rowIndex < Math.max(rawRows.length, displayRows.length); rowIndex++) {
    const rawRow = rawRows[rowIndex] || [];
    const displayRow = displayRows[rowIndex] || [];
    const client = String(displayRow[clientColumn] ?? rawRow[clientColumn] ?? '').trim().toLocaleLowerCase();
    if (client !== targetClient) continue;
    const value = (field: keyof typeof columns) => String(displayRow[columns[field]] ?? rawRow[columns[field]] ?? '').trim();
    if (!value('emploc') && !value('fullname')) continue;
    records.push({
      emploc: value('emploc'),
      fullname: value('fullname'),
      dateHired: value('dateHired'),
      aging: value('aging')
    });
  }
  return { records, count: records.length };
}

async function readVacancy(spreadsheetId: string, clientNames: string[] = [], includeDeployers = true, tabName = 'VACANCY') {
  const activeClients = new Set(clientNames.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!activeClients.size) throw new Error('Select at least one client before loading vacancy records.');
  const metadata = await googleRequest(
    `spreadsheets/${spreadsheetId}?fields=sheets.properties.title,sheets.properties.gridProperties.rowCount`
  );
  const vacancySheet = metadata.sheets?.find((sheet: any) => sheet.properties?.title === tabName);
  if (!vacancySheet) throw new Error(`The assigned spreadsheet needs a tab named ${tabName}.`);
  const lastRow = Math.max(5, Number(vacancySheet.properties.gridProperties?.rowCount || 5));
  const sheetRange = `'${String(vacancySheet.properties.title).replace(/'/g, "''")}'`;
  const range = encodeURIComponent(`${sheetRange}!B5:AL${lastRow}`);
  const clientRange = encodeURIComponent(`${sheetRange}!C5:C${lastRow}`);
  const [raw, display, clientValues, deployers] = await Promise.all([
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`),
    googleRequest(`spreadsheets/${spreadsheetId}/values/${clientRange}?valueRenderOption=FORMATTED_VALUE`),
    includeDeployers ? readDeployers(spreadsheetId) : Promise.resolve([])
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

async function readForApproval(spreadsheetId: string, clientNames: string[] = [], tabName = 'VACANCY') {
  const result = await readVacancy(spreadsheetId, clientNames, false, tabName);
  const requiredColumns = [9, 10, 11, 12, 13, 14, 19, 20, 21, 30];
  const eligibleIndexes = result.displayValues.flatMap((displayRow, index) => {
    const rawRow = result.rawValues[index] || [];
    const hasRequiredFields = requiredColumns.every(column =>
      String(displayRow[column] ?? rawRow[column] ?? '').trim() !== ''
    );
    return hasRequiredFields ? [index] : [];
  });
  return {
    rawValues: eligibleIndexes.map(index => result.rawValues[index] || []),
    displayValues: eligibleIndexes.map(index => result.displayValues[index] || [])
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

async function readHrEmploc(spreadsheetId: string, clientNames: string[] = [], tabName = 'G1N') {
  const activeClients = new Set(clientNames.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!activeClients.size) throw new Error('Select at least one client before loading HR EMPLOC records.');
  const range = sheetRange(tabName, 'G9:AC');
  const clientRange = sheetRange(tabName, 'B9:B');
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

function formatDeactivationDate(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Choose an inactive date.');
  let date: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error('Choose a valid inactive date.');
    }
  } else {
    const serial = Number(text);
    if (Number.isFinite(serial)) {
      date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    } else {
      const parsed = new Date(text);
      if (!Number.isFinite(parsed.getTime())) throw new Error('Choose a valid inactive date.');
      date = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
    }
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(date).toLocaleUpperCase();
}

async function readDeactivationRecords(spreadsheetId: string, sheetTab: string) {
  const result = await readSheetGridRanges(spreadsheetId, sheetTab, [{
    startRowIndex: 2,
    startColumnIndex: 0,
    endColumnIndex: 4
  }]);
  const values: unknown[][] = result[0]?.valueRange?.values || [];
  const records = values.flatMap((row, index) => {
    const emploc = String(row[0] ?? '').trim();
    const fullname = String(row[1] ?? '').trim();
    const status = String(row[2] ?? '').trim();
    const inactiveDate = row[3] === undefined || row[3] === null || row[3] === ''
      ? ''
      : formatDeactivationDate(row[3]);
    if (!emploc && !fullname && !status && !inactiveDate) return [];
    return [{ rowNumber: index + 3, emploc, fullname, status, inactiveDate }];
  });
  return { records, count: records.length };
}

async function lookupDeactivationEmploc(spreadsheetId: string, mikaFileTab: string, emplocValue: unknown) {
  const emploc = String(emplocValue ?? '').trim().toLocaleUpperCase();
  if (!emploc || emploc.length > 100) throw new Error('Enter a valid EMPLOC.');
  const result = await readSheetGridRanges(spreadsheetId, mikaFileTab, [{
    startColumnIndex: 0,
    endColumnIndex: 2
  }]);
  const values: unknown[][] = result[0]?.valueRange?.values || [];
  const matches = values.flatMap((row, index) =>
    String(row[0] ?? '').trim().toLocaleUpperCase() === emploc
      ? [{ rowNumber: index + 1, fullname: String(row[1] ?? '').trim() }]
      : []
  );
  if (!matches.length) throw new Error(`EMPLOC ${emploc} was not found in the ${mikaFileTab} tab.`);
  if (matches.length > 1) throw new Error(`EMPLOC ${emploc} appears more than once in the ${mikaFileTab} tab.`);
  if (!matches[0].fullname) throw new Error(`EMPLOC ${emploc} has no name in the ${mikaFileTab} tab.`);
  return { emploc, fullname: matches[0].fullname };
}

async function saveDeactivationRecord(
  spreadsheetId: string,
  sheetTab: string,
  mikaFileTab: string,
  emplocValue: unknown,
  statusValue: unknown,
  inactiveDateValue: unknown
) {
  const { emploc, fullname } = await lookupDeactivationEmploc(spreadsheetId, mikaFileTab, emplocValue);
  const allowedStatuses = new Set([
    'AWOL', 'BACK OUT', 'ENDO', 'FLOATING', 'RESIGNED', 'TERMINATED',
    'TEMPORARY STORE CLOSED', 'PERMANENTLY STORE CLOSED', 'MOVEMENT'
  ]);
  const status = String(statusValue ?? '').trim().toLocaleUpperCase();
  if (!allowedStatuses.has(status)) throw new Error('Choose a valid deactivation status.');
  const inactiveDate = formatDeactivationDate(inactiveDateValue);
  const rowValues = [[emploc, fullname.toLocaleUpperCase(), status, inactiveDate]];
  const metadata = await googleRequest(
    `spreadsheets/${spreadsheetId}?fields=sheets.properties.title,sheets.properties.sheetId,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
  );
  const sheet = (metadata.sheets || []).find((item: any) => item.properties?.title === sheetTab);
  if (!sheet) throw new Error(`The assigned DEACTIVATION spreadsheet does not have a ${sheetTab} tab.`);
  const column = await readSheetGridRanges(spreadsheetId, sheetTab, [{
    startRowIndex: 2,
    startColumnIndex: 0,
    endColumnIndex: 1
  }]);
  const columnValues: unknown[][] = column[0]?.valueRange?.values || [];
  const lastUsedIndex = columnValues.reduce((last, row, index) =>
    String(row[0] ?? '').trim() ? index : last, -1);
  const rowNumber = lastUsedIndex < 0 ? 3 : lastUsedIndex + 4;
  await ensureDestinationRow(spreadsheetId, sheet, rowNumber, 4);
  const range = sheetA1(sheetTab, `A${rowNumber}:D${rowNumber}`);
  await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: [{ range, values: rowValues }] })
  });
  const verification = await googleRequest(
    `spreadsheets/${spreadsheetId}/values/${sheetRange(sheetTab, `A${rowNumber}:D${rowNumber}`)}?valueRenderOption=FORMATTED_VALUE`
  );
  const saved = verification.values?.[0] || [];
  if (rowValues[0].some((value, index) => String(saved[index] ?? '').trim() !== value)) {
    throw new Error('The DEACTIVATION row could not be verified after saving.');
  }
  return { rowNumber, emploc, fullname: fullname.toLocaleUpperCase(), status, inactiveDate, saved: true };
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
    if (!['read-plantilla', 'read-vcode', 'read-vcode-variance', 'transfer-vcodes', 'delete-vcodes', 'read-deactivation', 'lookup-deactivation-emploc', 'read-deactivation-mika-file', 'save-deactivation', 'read-attrition', 'list-attrition-clients', 'read-buffer', 'read-buffer-detail', 'read-vacancy', 'read-for-approval', 'approve-vacancy', 'update-vacancy', 'read-hr-emploc', 'update-hr-emploc', 'update-plantilla', 'fill-plantilla-newly-hired', 'list-client-options'].includes(body.action)) throw new Error('Unknown sheets action.');
    if (body.action === 'approve-vacancy' && !actor.is_master_admin && actor.role !== 'admin') {
      return respond({ error: 'Only Master Admins and Regular Admins can approve records.' }, 403);
    }
    if (body.action === 'approve-vacancy' &&
      !actor.is_master_admin && actor.role === 'admin' &&
      String(actor.username || '').trim().toLocaleLowerCase() === 'annie') {
      return respond({ error: 'ANNIE is not allowed to approve records.' }, 403);
    }
    if (body.action === 'list-client-options' && !actor.is_master_admin) {
      throw new Error('Only the Master Admin can load client options.');
    }
    if (body.action === 'list-attrition-clients') {
      if (actor.status !== 'active') throw new Error('This account is inactive.');
      if (!actor.is_master_admin) throw new Error('Only the Master Admin can load ATTRITION client options.');
      return respond(await listAttritionClients(body.spreadsheetUrl, body.sheetTab));
    }
    const { spreadsheetId, targetUserId, clientName, clientNames, targetRole, targetUsername, targetIsMasterAdmin, sheetTab, deactivationMikaTab, vcodeSourceSpreadsheetId, vcodeSourceTab, deletedVcodeTab } = await getAssignedSheet(adminClient, actor, body);
    if (body.action === 'approve-vacancy' && targetRole !== 'admin' && !targetIsMasterAdmin) {
      return respond({ error: 'Only Master Admins and Regular Admins can approve records.' }, 403);
    }
    if (body.action === 'approve-vacancy' && targetRole === 'admin' && !targetIsMasterAdmin &&
      targetUsername.toLocaleLowerCase() === 'annie') {
      return respond({ error: 'ANNIE is not allowed to approve records.' }, 403);
    }

    if (body.action === 'read-deactivation') return respond(await readDeactivationRecords(spreadsheetId, sheetTab));
    if (body.action === 'lookup-deactivation-emploc') {
      return respond(await lookupDeactivationEmploc(spreadsheetId, deactivationMikaTab, body.emploc));
    }
    if (body.action === 'read-deactivation-mika-file') {
      return respond(await readDeactivationMikaFile(spreadsheetId, deactivationMikaTab));
    }
    if (body.action === 'save-deactivation') {
      return respond(await saveDeactivationRecord(spreadsheetId, sheetTab, deactivationMikaTab, body.emploc, body.status, body.inactiveDate));
    }
    if (body.action === 'read-attrition') {
      return respond(await readAttritionRecords(spreadsheetId, sheetTab, clientNames, actor.is_master_admin));
    }
    if (body.action === 'transfer-vcodes') {
      const vacancyDestination = await getAssignedSheet(adminClient, actor, { ...body, action: 'read-vacancy' });
      return respond(await appendVcodesToVacancy(
        spreadsheetId,
        sheetTab,
        vacancyDestination.spreadsheetId,
        vacancyDestination.sheetTab,
        clientName,
        body.rows
      ));
    }
    if (body.action === 'delete-vcodes') {
      const normalizedArchiveTab = deletedVcodeTab.toLocaleLowerCase();
      if (normalizedArchiveTab === vcodeSourceTab.toLocaleLowerCase() ||
        (vcodeSourceSpreadsheetId === spreadsheetId && normalizedArchiveTab === sheetTab.toLocaleLowerCase())) {
        throw new Error('The deleted VCODE archive tab must be different from the VCODE source tab and, when both URLs are the same workbook, the fetch tab.');
      }
      return respond(await archiveAndDeleteVcodes(
        spreadsheetId,
        vcodeSourceSpreadsheetId,
        sheetTab,
        vcodeSourceTab,
        deletedVcodeTab,
        clientName,
        body.rows
      ));
    }

    if (body.action === 'approve-vacancy') {
      if (!Array.isArray(body.vcodes) || !body.vcodes.length || body.vcodes.length > 100) {
        throw new Error('Select between 1 and 100 approval records.');
      }
      const vcodes = body.vcodes.map((value: unknown) => String(value || '').trim());
      if (vcodes.some((value: string) => !value)) throw new Error('Every selected approval record must have a VCODE.');
      if (new Set(vcodes).size !== vcodes.length) throw new Error('A VCODE was selected more than once. Refresh the table and try again.');
      const hrDestination = await getAssignedHrEmplocDestination(adminClient, targetUserId, clientNames[0] || '');
      const results = [];
      const failures = [];
      for (const vcode of vcodes) {
        try {
          results.push(await approveVacancyRecord(
            spreadsheetId,
            hrDestination.spreadsheetId,
            clientNames,
            hrDestination.clientNames,
            vcode,
            sheetTab,
            hrDestination.sheetTab
          ));
        } catch (error) {
          failures.push({
            vcode,
            error: error instanceof Error ? error.message : 'Unexpected transfer error.'
          });
        }
      }
      return respond({
        approvedCount: results.length,
        results,
        failures
      });
    }
    if (body.action === 'list-client-options') return respond(await readClientOptions(spreadsheetId));
    if (body.action === 'fill-plantilla-newly-hired') {
      if (targetRole !== 'user') throw new Error('Only User accounts can fill blank PLANTILLA statuses.');
      const readRanges = [sheetRange(sheetTab, 'B9:B'), sheetRange(sheetTab, 'AH9:AH')]
        .map(range => `ranges=${range}`).join('&');
      const result = await googleRequest(`spreadsheets/${spreadsheetId}/values:batchGet?${readRanges}&valueRenderOption=FORMULA`);
      const vcodeRows = result.valueRanges?.[0]?.values || [];
      const statusRows = result.valueRanges?.[1]?.values || [];
      const pendingRows = Array.from({ length: Math.max(vcodeRows.length, statusRows.length) }, (_, index) => index + 9)
        .filter((row, index) => {
          const vcode = String(vcodeRows[index]?.[0] ?? '').trim();
          const status = statusRows[index]?.[0];
          return vcode && (status === undefined || status === null || String(status).trim() === '');
        });
      if (!pendingRows.length) return respond({ eligibleCount: 0, updatedCount: 0 });

      const updates: { range: string; values: string[][] }[] = [];
      let runStart = pendingRows[0];
      let previousRow = pendingRows[0];
      for (const row of pendingRows.slice(1)) {
        if (row !== previousRow + 1) {
          updates.push({
            range: `'${sheetTab.replace(/'/g, "''")}'!AH${runStart}:AH${previousRow}`,
            values: Array.from({ length: previousRow - runStart + 1 }, () => ['NEWLY HIRED'])
          });
          runStart = row;
        }
        previousRow = row;
      }
      updates.push({
        range: `'${sheetTab.replace(/'/g, "''")}'!AH${runStart}:AH${previousRow}`,
        values: Array.from({ length: previousRow - runStart + 1 }, () => ['NEWLY HIRED'])
      });
      const writeResult = await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: updates })
      });
      return respond({
        eligibleCount: pendingRows.length,
        updatedCount: writeResult.totalUpdatedCells ?? pendingRows.length,
        updatedRows: pendingRows.slice(0, writeResult.totalUpdatedCells ?? pendingRows.length)
      });
    }
    if (body.action === 'read-plantilla') return respond(await readPlantilla(spreadsheetId, sheetTab));
    if (body.action === 'read-vcode') return respond(await readVcode(spreadsheetId, sheetTab));
    if (body.action === 'read-vcode-variance') return respond(await readVcodeVariance(spreadsheetId, sheetTab, clientName));
    if (body.action === 'read-buffer') return respond(await readBuffer(spreadsheetId, sheetTab));
    if (body.action === 'read-buffer-detail') return respond(await readBufferDetail(spreadsheetId, sheetTab, String(body.detailType || ''), clientName));
    if (body.action === 'read-vacancy') return respond(await readVacancy(spreadsheetId, clientNames, true, sheetTab));
    if (body.action === 'read-for-approval') return respond(await readForApproval(spreadsheetId, clientNames, sheetTab));
    if (body.action === 'read-hr-emploc') {
      return respond(await readHrEmploc(spreadsheetId, clientNames, sheetTab));
    }

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
        const value = body[field] === undefined || body[field] === null ? '' : String(body[field]).trim().toLocaleUpperCase();
        if (value.length > 500) throw new Error(`${field} cannot exceed 500 characters.`);
        updates[field] = value;
      }
      if (!Object.keys(updates).length) throw new Error('Make at least one change before updating the vacancy record.');
      const deployerFields = ['coordinator', 'deployedBy'].filter(field => Object.hasOwn(updates, field) && updates[field]);
      if (deployerFields.length) {
        const deployerValues = await readDeployers(spreadsheetId);
        for (const field of deployerFields) {
          if (!deployerValues.some(value => value.toLocaleUpperCase() === String(updates[field]))) {
            throw new Error(`Choose ${field === 'coordinator' ? 'a Coordinator' : 'a Deployed By value'} from the Deployer sheet options.`);
          }
        }
      }
      const vcodeRange = sheetRange(sheetTab, 'B5:C');
      const values = await googleRequest(`spreadsheets/${spreadsheetId}/values/${vcodeRange}?valueRenderOption=FORMATTED_VALUE`);
      const matches = (values.values || []).map((rowValues: unknown[], index: number) =>
        String(rowValues[0] ?? '').trim() === vcode ? { row: index + 5, client: String(rowValues[1] ?? '').trim().toLocaleLowerCase() } : null
      ).filter(Boolean);
      if (!matches.length) throw new Error(`No VACANCY row found for VCODE ${vcode}.`);
      if (matches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in VACANCY; no changes were made.`);
      const { row, client: rowClient } = matches[0];
      if (!clientNames.some(name => name.toLocaleLowerCase() === rowClient)) {
        throw new Error(`VCODE ${vcode} is not assigned to your selected client(s).`);
      }
      const cellRanges = Object.keys(updates).map(field => `'${sheetTab.replace(/'/g, "''")}'!${fieldColumns[field].column}${row}`);
      const formulaQuery = cellRanges.map(range => `ranges=${encodeURIComponent(range)}`).join('&');
      const formulaResult = await googleRequest(`spreadsheets/${spreadsheetId}/values:batchGet?${formulaQuery}&valueRenderOption=FORMULA`);
      const formulaFields = Object.keys(updates).filter((_, index) =>
        String(formulaResult.valueRanges?.[index]?.values?.[0]?.[0] || '').startsWith('=')
      );
      if (formulaFields.length) {
        const columns = formulaFields.map(field => fieldColumns[field].column).join(', ');
        throw new Error(`Cannot overwrite a formula in column ${columns} for VCODE ${vcode}. Change the source data for that formula instead.`);
      }
      const data = Object.entries(updates).map(([field, value]) => ({
        range: `'${sheetTab.replace(/'/g, "''")}'!${fieldColumns[field].column}${row}`,
        values: [[value]]
      }));
      await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data })
      });
      return respond({ vcode, updated: true });
    }

    if (body.action === 'update-hr-emploc') {
      const vcode = String(body.vcode || '').trim();
      const hrcoRemarks = String(body.hrcoRemarks || '').trim().toLocaleUpperCase();
      if (!vcode) throw new Error('VCODE is required.');
      if (hrcoRemarks.length > 500) throw new Error('HRCO Remarks cannot exceed 500 characters.');
      const vcodeRange = sheetRange(sheetTab, 'G9:G');
      const values = await googleRequest(`spreadsheets/${spreadsheetId}/values/${vcodeRange}?valueRenderOption=FORMATTED_VALUE`);
      const matches = (values.values || []).flat().map((value: unknown, index: number) => String(value).trim() === vcode ? index + 9 : 0).filter(Boolean);
      if (!matches.length) throw new Error(`No G1N row found for VCODE ${vcode}.`);
      if (matches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in G1N; no changes were made.`);
      const row = matches[0];
      const clientValues = await googleRequest(`spreadsheets/${spreadsheetId}/values/${sheetRange(sheetTab, `B${row}`)}?valueRenderOption=FORMATTED_VALUE`);
      const rowClient = String(clientValues.values?.[0]?.[0] || '').trim().toLocaleLowerCase();
      if (!clientNames.some(name => name.toLocaleLowerCase() === rowClient)) {
        throw new Error(`VCODE ${vcode} is not assigned to your selected client(s).`);
      }
      await googleRequest(`spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data: [{ range: `'${sheetTab.replace(/'/g, "''")}'!J${row}`, values: [[hrcoRemarks]] }] })
      });
      const backoutTransfer = await transferHrEmplocBackout(
        adminClient,
        targetUserId,
        spreadsheetId,
        clientNames,
        vcode,
        row,
        hrcoRemarks,
        actor.is_master_admin && targetUserId === actor.id ? body.vacancySpreadsheetUrl : undefined,
        sheetTab
      );
      return respond({ vcode, updated: true, backoutTransfer });
    }

    const vcode = String(body.vcode || '').trim();
    const rate = Number(body.rate);
    const status = String(body.status || '').trim().toLocaleUpperCase();
    if (!vcode) throw new Error('VCODE is required.');
    if (!Number.isFinite(rate)) throw new Error('Rate must be a number.');
    if (!statuses.has(status)) throw new Error('Choose a valid status.');
    const vcodeRange = sheetRange(sheetTab, 'B9:B');
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
          { range: `'${sheetTab.replace(/'/g, "''")}'!H${rowNumber}`, values: [[rate]] },
          { range: `'${sheetTab.replace(/'/g, "''")}'!AG${rowNumber}`, values: [[separationDate]] },
          { range: `'${sheetTab.replace(/'/g, "''")}'!AH${rowNumber}`, values: [[status]] }
        ]
      })
    });
    let inactiveTransfer = { transferred: false, reason: 'not-a-user-account' };
    if (targetRole === 'user') {
      try {
        inactiveTransfer = await transferPlantillaRowToInactive(adminClient, targetUserId, spreadsheetId, vcode, sheetTab);
      } catch (error) {
        const details = error instanceof Error ? error.message : 'Unexpected transfer error.';
        throw new Error(`PLANTILLA was updated, but the INACTIVE transfer did not complete: ${details}`);
      }
    }
    return respond({ vcode, updated: true, inactiveTransfer });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Unexpected spreadsheet service error.' }, 400);
  }
});