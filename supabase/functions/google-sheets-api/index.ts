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
  return {
    spreadsheetId: match[1],
    targetUserId: target.id,
    clientName: String(target.client_name || '').trim(),
    clientNames,
    targetRole: target.role
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

async function getAssignedHrEmplocDestination(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string
) {
  const [assignmentResult, profileResult] = await Promise.all([
    adminClient.from('dashboard_assignments').select('sheet_urls, client_names')
      .eq('user_id', targetUserId).eq('dashboard_name', 'HR EMPLOC MONITORING').maybeSingle(),
    adminClient.from('profiles').select('client_name, client_names').eq('id', targetUserId).single()
  ]);
  if (assignmentResult.error) throw new Error('Could not load the assigned HR EMPLOC spreadsheet.');
  if (profileResult.error || !profileResult.data) throw new Error('Could not load the account client scope for HR EMPLOC.');
  const assignment = assignmentResult.data;
  const spreadsheetId = spreadsheetIdFromAssignedUrl(assignment?.sheet_urls?.[0], 'HR EMPLOC');
  const assignedClients = Array.isArray(assignment?.client_names) && assignment.client_names.length
    ? assignment.client_names
    : Array.isArray(profileResult.data.client_names) && profileResult.data.client_names.length
      ? profileResult.data.client_names
      : [profileResult.data.client_name];
  const clientNames = assignedClients.map((name: unknown) => String(name || '').trim().toLocaleLowerCase()).filter(Boolean);
  if (!clientNames.length) throw new Error('No clients are assigned to the HR EMPLOC spreadsheet.');
  return { spreadsheetId, clientNames };
}

const approvalRequiredSourceColumns = [10, 11, 12, 13, 14, 15, 20, 21, 22, 31];

function sameSheetValues(actual: unknown[], expected: unknown[], ignoredIndexes: number[] = []) {
  const ignored = new Set(ignoredIndexes);
  return Array.from({ length: expected.length }, (_, index) => index)
    .filter(index => !ignored.has(index))
    .every(index => String(actual[index] ?? '') === String(expected[index] ?? ''));
}

function sheetColumnName(columnNumber: number) {
  let name = '';
  let remaining = columnNumber;
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

async function getAssignedPlantillaDestinations(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string
) {
  const [assignmentResult, profileResult] = await Promise.all([
    adminClient.from('dashboard_assignments').select('sheet_urls, client_names')
      .eq('user_id', targetUserId).eq('dashboard_name', 'PLANTILLA').maybeSingle(),
    adminClient.from('profiles').select('sheet_url, client_name, client_names').eq('id', targetUserId).single()
  ]);
  if (assignmentResult.error) throw new Error('Could not load the assigned PLANTILLA spreadsheet.');
  if (profileResult.error || !profileResult.data) throw new Error('Could not load the account client scope for PLANTILLA.');
  const assignment = assignmentResult.data;
  const urls = Array.isArray(assignment?.sheet_urls) && assignment.sheet_urls.length
    ? assignment.sheet_urls
    : [profileResult.data.sheet_url].filter(Boolean);
  if (!urls.length) throw new Error('No PLANTILLA spreadsheet is assigned to this account.');
  const assignedClients = Array.isArray(assignment?.client_names) && assignment.client_names.length
    ? assignment.client_names
    : Array.isArray(profileResult.data.client_names) && profileResult.data.client_names.length
      ? profileResult.data.client_names
      : [profileResult.data.client_name];
  const clientNames = assignedClients.map((name: unknown) => String(name || '').trim().toLocaleLowerCase()).filter(Boolean);
  if (!clientNames.length) throw new Error('No clients are assigned to the PLANTILLA spreadsheet.');
  return urls.map((url: unknown) => ({
    spreadsheetId: spreadsheetIdFromAssignedUrl(url, 'PLANTILLA'),
    clientNames
  }));
}

async function ensureSheetGridSize(spreadsheetId: string, sheet: any, rowNumber: number, columnNumber: number) {
  const grid = sheet.properties.gridProperties || {};
  const requests = [];
  const rowsToAdd = rowNumber - Number(grid.rowCount || 0);
  const columnsToAdd = columnNumber - Number(grid.columnCount || 0);
  if (rowsToAdd > 0) {
    requests.push({
      appendDimension: {
        sheetId: sheet.properties.sheetId,
        dimension: 'ROWS',
        length: rowsToAdd
      }
    });
  }
  if (columnsToAdd > 0) {
    requests.push({
      appendDimension: {
        sheetId: sheet.properties.sheetId,
        dimension: 'COLUMNS',
        length: columnsToAdd
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

async function transferEligibleHrEmplocRows(
  adminClient: ReturnType<typeof createClient>,
  targetUserId: string,
  hrSpreadsheetId: string,
  activeClientNames: string[]
) {
  const activeClients = new Set(activeClientNames.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  if (!activeClients.size) return;
  const hrMetadata = await googleRequest(
    `spreadsheets/${hrSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
  );
  const g1nTab = hrMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'G1N');
  if (!g1nTab) throw new Error('The assigned HR EMPLOC spreadsheet needs a tab named G1N.');
  const sourceWidth = Math.max(29, Number(g1nTab.properties.gridProperties?.columnCount || 29));
  const sourceLastColumn = sheetColumnName(sourceWidth);
  const sourceRange = `G1N!A9:${sourceLastColumn}`;
  const [sourceRawResult, sourceDisplayResult] = await Promise.all([
    googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(sourceRange)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(sourceRange)}?valueRenderOption=FORMATTED_VALUE`)
  ]);
  const sourceRawRows = sourceRawResult.values || [];
  const sourceDisplayRows = sourceDisplayResult.values || [];
  const eligibleVcodes = new Set<string>();
  for (let index = 0; index < Math.max(sourceRawRows.length, sourceDisplayRows.length); index += 1) {
    const rawRow = sourceRawRows[index] || [];
    const displayRow = sourceDisplayRows[index] || [];
    const vcode = String(displayRow[6] ?? rawRow[6] ?? '').trim();
    const clientName = String(displayRow[1] ?? rawRow[1] ?? '').trim().toLocaleLowerCase();
    const employeeNumber = String(displayRow[13] ?? rawRow[13] ?? '');
    const status = String(displayRow[24] ?? rawRow[24] ?? '').trim().toLocaleUpperCase();
    if (vcode && activeClients.has(clientName) && /^\d{4}-\d{5}$/.test(employeeNumber) && status !== 'PENDING') {
      eligibleVcodes.add(vcode);
    }
  }
  if (!eligibleVcodes.size) return;

  const plantillaDestinations = await getAssignedPlantillaDestinations(adminClient, targetUserId);
  const [bumpTab, plantillaTabs] = await Promise.all([
    Promise.resolve(hrMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'BUMP')),
    Promise.all(plantillaDestinations.map(async destination => {
      const metadata = await googleRequest(
        `spreadsheets/${destination.spreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`
      );
      const tab = metadata.sheets?.find((sheet: any) => sheet.properties?.title === 'PLANTILLA');
      if (!tab) throw new Error('The assigned PLANTILLA spreadsheet needs a tab named PLANTILLA.');
      return { ...destination, tab };
    }))
  ]);
  if (!bumpTab) throw new Error('The assigned HR EMPLOC spreadsheet needs a tab named BUMP.');

  const bumpLastColumn = sheetColumnName(Math.max(sourceWidth, Number(bumpTab.properties.gridProperties?.columnCount || 1)));
  const [bumpRowsResult, plantillaRowsResults] = await Promise.all([
    googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'BUMP'!A:${bumpLastColumn}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
    Promise.all(plantillaTabs.map(destination =>
      googleRequest(`spreadsheets/${destination.spreadsheetId}/values/${encodeURIComponent('PLANTILLA!A9:AR')}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`)
    ))
  ]);
  const bumpRows = bumpRowsResult.values || [];
  const plantillaRows = plantillaRowsResults.map(result => result.values || []);

  for (const vcode of eligibleVcodes) {
    const freshVcodesResult = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent('G1N!G9:G')}?valueRenderOption=FORMATTED_VALUE`
    );
    const sourceMatches = (freshVcodesResult.values || []).flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 9] : []
    );
    if (sourceMatches.length !== 1) {
      if (sourceMatches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in G1N; no source row was deleted.`);
      continue;
    }
    const sourceRowNumber = sourceMatches[0];
    const sourceRowResult = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`G1N!A${sourceRowNumber}:${sourceLastColumn}${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
    );
    const sourceRow = Array.from({ length: sourceWidth }, (_, index) => sourceRowResult.values?.[0]?.[index] ?? '');
    const employeeNumberResult = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`G1N!N${sourceRowNumber}:N${sourceRowNumber}`)}?valueRenderOption=FORMATTED_VALUE`
    );
    const statusResult = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`G1N!Y${sourceRowNumber}:Y${sourceRowNumber}`)}?valueRenderOption=FORMATTED_VALUE`
    );
    const employeeNumber = String(employeeNumberResult.values?.[0]?.[0] ?? '');
    const status = String(statusResult.values?.[0]?.[0] ?? '').trim().toLocaleUpperCase();
    const sourceClient = String(sourceRow[1] ?? '').trim().toLocaleLowerCase();
    if (!activeClients.has(sourceClient) || !/^\d{4}-\d{5}$/.test(employeeNumber) || status === 'PENDING') continue;

    const bumpMatches = bumpRows.flatMap((row: unknown[], index: number) =>
      String(row[6] ?? '').trim() === vcode ? [index + 1] : []
    );
    if (bumpMatches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in BUMP.`);
    let bumpRowNumber: number;
    if (bumpMatches.length) {
      bumpRowNumber = bumpMatches[0];
      const existingBumpResult = await googleRequest(
        `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'BUMP'!A${bumpRowNumber}:${bumpLastColumn}${bumpRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
      );
      const existingBumpRow = Array.from({ length: sourceWidth }, (_, index) => existingBumpResult.values?.[0]?.[index] ?? '');
      if (!sameSheetValues(existingBumpRow, sourceRow)) {
        throw new Error(`VCODE ${vcode} already exists in BUMP with different data; the G1N source row was kept.`);
      }
    } else {
      const lastBumpRow = bumpRows.reduce((lastRow: number, row: unknown[], index: number) =>
        row.some(value => String(value ?? '').trim()) ? index + 1 : lastRow, 0);
      bumpRowNumber = lastBumpRow + 1;
      await ensureSheetGridSize(hrSpreadsheetId, bumpTab, bumpRowNumber, sourceWidth);
      await googleRequest(`spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'BUMP'!A${bumpRowNumber}:${sourceLastColumn}${bumpRowNumber}`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [sourceRow] })
      });
      const verifyBumpResult = await googleRequest(
        `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent(`'BUMP'!A${bumpRowNumber}:${sourceLastColumn}${bumpRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
      );
      if (!sameSheetValues(verifyBumpResult.values?.[0] || [], sourceRow)) {
        throw new Error(`The BUMP copy for VCODE ${vcode} could not be verified; the G1N source row was kept.`);
      }
      bumpRows[bumpRowNumber - 1] = sourceRow;
    }

    const destination = plantillaTabs.find(item => item.clientNames.includes(sourceClient));
    if (!destination) throw new Error(`No PLANTILLA spreadsheet is assigned for client ${sourceRow[1]}.`);
    const destinationIndex = plantillaTabs.indexOf(destination);
    const plantillaRowsForSheet = plantillaRows[destinationIndex];
    const plantillaMatches = plantillaRowsForSheet.flatMap((row: unknown[], index: number) =>
      String(row[1] ?? '').trim() === vcode ? [index + 9] : []
    );
    if (plantillaMatches.length > 1) throw new Error(`VCODE ${vcode} appears more than once in the assigned PLANTILLA sheet.`);
    const plantillaValues = [sourceRow[6], sourceRow[13], sourceRow[2], sourceRow[3], sourceRow[4]];
    let plantillaRowNumber: number;
    if (plantillaMatches.length) {
      plantillaRowNumber = plantillaMatches[0];
      const existingPlantilla = (plantillaRowsForSheet[plantillaRowNumber - 9] || []).slice(1, 6);
      if (!sameSheetValues(existingPlantilla, plantillaValues)) {
        throw new Error(`VCODE ${vcode} already exists in PLANTILLA with different data; the G1N source row was kept.`);
      }
    } else {
      const lastPlantillaIndex = plantillaRowsForSheet.reduce((lastIndex: number, row: unknown[], index: number) =>
        row.some(value => String(value ?? '').trim()) ? index : lastIndex, -1);
      plantillaRowNumber = Math.max(9, lastPlantillaIndex + 10);
      await ensureSheetGridSize(destination.spreadsheetId, destination.tab, plantillaRowNumber, 6);
      await googleRequest(`spreadsheets/${destination.spreadsheetId}/values/${encodeURIComponent(`PLANTILLA!B${plantillaRowNumber}:F${plantillaRowNumber}`)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [plantillaValues] })
      });
      const verifyPlantillaResult = await googleRequest(
        `spreadsheets/${destination.spreadsheetId}/values/${encodeURIComponent(`PLANTILLA!B${plantillaRowNumber}:F${plantillaRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
      );
      if (!sameSheetValues(verifyPlantillaResult.values?.[0] || [], plantillaValues)) {
        throw new Error(`The PLANTILLA copy for VCODE ${vcode} could not be verified; the G1N source row was kept.`);
      }
      const appendedPlantillaRow = [...(plantillaRowsForSheet[plantillaRowNumber - 9] || [])];
      appendedPlantillaRow.splice(1, 5, ...plantillaValues);
      plantillaRowsForSheet[plantillaRowNumber - 9] = appendedPlantillaRow;
    }

    const currentVcodes = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent('G1N!G9:G')}?valueRenderOption=FORMATTED_VALUE`
    );
    const currentMatches = (currentVcodes.values || []).flatMap((row: unknown[], index: number) =>
      String(row[0] ?? '').trim() === vcode ? [index + 9] : []
    );
    if (currentMatches.length > 1) throw new Error(`VCODE ${vcode} became duplicated in G1N before deletion.`);
    if (!currentMatches.length) continue;
    const rowNumber = currentMatches[0];
    await googleRequest(`spreadsheets/${hrSpreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId: g1nTab.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber
            }
          }
        }]
      })
    });
    const verifyDelete = await googleRequest(
      `spreadsheets/${hrSpreadsheetId}/values/${encodeURIComponent('G1N!G9:G')}?valueRenderOption=FORMATTED_VALUE`
    );
    if ((verifyDelete.values || []).some((row: unknown[]) => String(row[0] ?? '').trim() === vcode)) {
      throw new Error(`Both destination copies were verified, but VCODE ${vcode} remains in G1N after source-row deletion.`);
    }
  }
}

async function approveVacancyRecord(
  sourceSpreadsheetId: string,
  hrEmplocSpreadsheetId: string,
  sourceClientNames: string[],
  hrClientNames: string[],
  vcode: string
) {
  let boardVerified = false;
  let emplocVerified = false;
  try {
  const sourceIndex = new Set(sourceClientNames.map(name => name.toLocaleLowerCase()));
  const sourceMatchesResult = await googleRequest(
    `spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent('VACANCY!B5:C')}?valueRenderOption=FORMATTED_VALUE`
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
    `spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent(`VACANCY!A${originalRowNumber}:AR${originalRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
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
  const vacancyTab = sourceMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'VACANCY');
  const hrTab = hrMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'G1N');
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
    googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}/values/${encodeURIComponent('G1N!G9:G')}?valueRenderOption=UNFORMATTED_VALUE`),
    googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}/values/${encodeURIComponent('G1N!A9:G')}?valueRenderOption=UNFORMATTED_VALUE`)
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
      `spreadsheets/${hrEmplocSpreadsheetId}/values/${encodeURIComponent(`G1N!A${emplocRowNumber}:G${emplocRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
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
    await googleRequest(`spreadsheets/${hrEmplocSpreadsheetId}/values/${encodeURIComponent(`G1N!A${emplocRowNumber}:G${emplocRowNumber}`)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [emplocRow] })
    });
    const writtenEmplocRow = await googleRequest(
      `spreadsheets/${hrEmplocSpreadsheetId}/values/${encodeURIComponent(`G1N!A${emplocRowNumber}:G${emplocRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
    );
    if (!sameSheetValues(writtenEmplocRow.values?.[0] || [], emplocRow)) {
      throw new Error(`The HR EMPLOC G1N copy for VCODE ${vcode} could not be verified.`);
    }
    emplocVerified = true;
  }

  let sourceRowDeleted = false;
  for (let attempt = 0; attempt < 2 && !sourceRowDeleted; attempt += 1) {
    const currentMatchesResult = await googleRequest(
      `spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent('VACANCY!B5:B')}?valueRenderOption=FORMATTED_VALUE`
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
            `VACANCY!A${currentRowNumber}:N${currentRowNumber}`,
            `VACANCY!P${currentRowNumber}:Z${currentRowNumber}`,
            `VACANCY!AB${currentRowNumber}:AR${currentRowNumber}`
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
      `spreadsheets/${sourceSpreadsheetId}/values/${encodeURIComponent('VACANCY!B5:B')}?valueRenderOption=FORMATTED_VALUE`
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
  vcode: string
) {
  let inactiveWritten = false;
  let vacancyWritten = false;
  let transferStarted = false;
  try {
    const sourceMatches = await googleRequest(
      `spreadsheets/${plantillaSpreadsheetId}/values/${encodeURIComponent('PLANTILLA!B9:B')}?valueRenderOption=FORMATTED_VALUE`
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
      googleRequest(`spreadsheets/${plantillaSpreadsheetId}/values/${encodeURIComponent(`PLANTILLA!A${sourceRowNumber}:AR${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      googleRequest(`spreadsheets/${plantillaSpreadsheetId}/values/${encodeURIComponent(`PLANTILLA!AG${sourceRowNumber}:AH${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`)
    ]);
    const sourceValues = sourceData.values?.[0] || [];
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
    const [inactiveAssignment, vacancyAssignment] = await Promise.all([
      adminClient.from('dashboard_assignments').select('sheet_urls').eq('user_id', masterAdmin.id).eq('dashboard_name', 'INACTIVE').maybeSingle(),
      adminClient.from('dashboard_assignments').select('sheet_urls').eq('user_id', targetUserId).eq('dashboard_name', 'VACANCY MONITORING').maybeSingle()
    ]);
    if (inactiveAssignment.error) throw new Error('Could not load the Master Admin INACTIVE archive assignment.');
    if (vacancyAssignment.error) throw new Error('Could not load the user VACANCY assignment.');
    const inactiveSpreadsheetId = spreadsheetIdFromAssignedUrl(inactiveAssignment.data?.sheet_urls?.[0], 'INACTIVE archive');
    const vacancySpreadsheetId = spreadsheetIdFromAssignedUrl(vacancyAssignment.data?.sheet_urls?.[0], 'VACANCY');

    const [inactiveMetadata, vacancyMetadata, plantillaMetadata, archivedRowsResult, vacancyVcodes] = await Promise.all([
      googleRequest(`spreadsheets/${inactiveSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title,sheets.properties.gridProperties.rowCount,sheets.properties.gridProperties.columnCount`),
      googleRequest(`spreadsheets/${vacancySpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`),
      googleRequest(`spreadsheets/${plantillaSpreadsheetId}?fields=sheets.properties.sheetId,sheets.properties.title`),
      googleRequest(`spreadsheets/${inactiveSpreadsheetId}/values/${encodeURIComponent('INACTIVE!A:AR')}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`),
      googleRequest(`spreadsheets/${vacancySpreadsheetId}/values/${encodeURIComponent('VACANCY!B5:B')}?valueRenderOption=FORMATTED_VALUE`)
    ]);
    const inactiveTab = inactiveMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'INACTIVE');
    const plantillaTab = plantillaMetadata.sheets?.find((sheet: any) => sheet.properties?.title === 'PLANTILLA');
    if (!inactiveTab) throw new Error('The archive spreadsheet needs a tab named INACTIVE.');
    if (!plantillaTab) throw new Error('The source spreadsheet needs a tab named PLANTILLA.');
    if (!vacancyMetadata.sheets?.some((sheet: any) => sheet.properties?.title === 'VACANCY')) {
      throw new Error('The assigned vacancy spreadsheet needs a tab named VACANCY.');
    }

    const archivedRows = archivedRowsResult.values || [];
    const archivedMatches = archivedRows.flatMap((row: unknown[], index: number) =>
      String(row[1] ?? '').trim() === vcode ? [index + 1] : []
    );
    if (archivedMatches.length > 1) throw new Error(`VCODE ${vcode} already appears more than once in the INACTIVE archive.`);
    if (archivedMatches.length) {
      const archivedRowResult = await googleRequest(
        `spreadsheets/${inactiveSpreadsheetId}/values/${encodeURIComponent(`INACTIVE!A${archivedMatches[0]}:AR${archivedMatches[0]}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
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
      await googleRequest(`spreadsheets/${inactiveSpreadsheetId}/values/${encodeURIComponent(`INACTIVE!A${destinationRow}:AR${destinationRow}`)}?valueInputOption=RAW`, {
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
        `spreadsheets/${vacancySpreadsheetId}/values/${encodeURIComponent('VACANCY!B5:B')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: JSON.stringify({ values: [[vcode]] }) }
      );
      vacancyWritten = true;
    }

    const currentSource = await googleRequest(
      `spreadsheets/${plantillaSpreadsheetId}/values/${encodeURIComponent(`PLANTILLA!B${sourceRowNumber}:AH${sourceRowNumber}`)}?valueRenderOption=UNFORMATTED_VALUE`
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
  const range = encodeURIComponent('VACANCY!B5:AL');
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

async function readForApproval(spreadsheetId: string, clientNames: string[] = []) {
  const result = await readVacancy(spreadsheetId, clientNames);
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
    if (!['read-plantilla', 'read-vcode', 'read-vacancy', 'read-for-approval', 'approve-vacancy', 'update-vacancy', 'read-hr-emploc', 'update-hr-emploc', 'update-plantilla', 'fill-plantilla-newly-hired', 'list-client-options'].includes(body.action)) throw new Error('Unknown sheets action.');
    if (body.action === 'approve-vacancy' && actor.role !== 'admin') {
      return respond({ error: 'Only Master Admins and Regular Admins can approve records.' }, 403);
    }
    if (body.action === 'list-client-options' && !actor.is_master_admin) {
      throw new Error('Only the Master Admin can load client options.');
    }
    const { spreadsheetId, targetUserId, clientName, clientNames, targetRole } = await getAssignedSheet(adminClient, actor, body);

    if (body.action === 'approve-vacancy') {
      if (!Array.isArray(body.vcodes) || !body.vcodes.length || body.vcodes.length > 100) {
        throw new Error('Select between 1 and 100 approval records.');
      }
      const vcodes = body.vcodes.map((value: unknown) => String(value || '').trim());
      if (vcodes.some((value: string) => !value)) throw new Error('Every selected approval record must have a VCODE.');
      if (new Set(vcodes).size !== vcodes.length) throw new Error('A VCODE was selected more than once. Refresh the table and try again.');
      const hrDestination = await getAssignedHrEmplocDestination(adminClient, targetUserId);
      const results = [];
      const failures = [];
      for (const vcode of vcodes) {
        try {
          results.push(await approveVacancyRecord(spreadsheetId, hrDestination.spreadsheetId, clientNames, hrDestination.clientNames, vcode));
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
      const readRanges = ['PLANTILLA!B9:B', 'PLANTILLA!AH9:AH']
        .map(range => `ranges=${encodeURIComponent(range)}`).join('&');
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
            range: `PLANTILLA!AH${runStart}:AH${previousRow}`,
            values: Array.from({ length: previousRow - runStart + 1 }, () => ['NEWLY HIRED'])
          });
          runStart = row;
        }
        previousRow = row;
      }
      updates.push({
        range: `PLANTILLA!AH${runStart}:AH${previousRow}`,
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
    if (body.action === 'read-plantilla') return respond(await readPlantilla(spreadsheetId));
    if (body.action === 'read-vcode') return respond(await readVcode(spreadsheetId));
    if (body.action === 'read-vacancy') return respond(await readVacancy(spreadsheetId, clientNames));
    if (body.action === 'read-for-approval') return respond(await readForApproval(spreadsheetId, clientNames));
    if (body.action === 'read-hr-emploc') {
      await transferEligibleHrEmplocRows(adminClient, targetUserId, spreadsheetId, clientNames);
      return respond(await readHrEmploc(spreadsheetId, clientNames));
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
      const vcodeRange = encodeURIComponent('VACANCY!B5:C');
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
      const cellRanges = Object.keys(updates).map(field => `VACANCY!${fieldColumns[field].column}${row}`);
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
        range: `VACANCY!${fieldColumns[field].column}${row}`,
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
    const status = String(body.status || '').trim().toLocaleUpperCase();
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
    let inactiveTransfer = { transferred: false, reason: 'not-a-user-account' };
    if (targetRole === 'user') {
      try {
        inactiveTransfer = await transferPlantillaRowToInactive(adminClient, targetUserId, spreadsheetId, vcode);
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