const PLANTILLA_TAB_NAME = 'PLANTILLA';
const PLANTILLA_START_ROW = 9;
const PLANTILLA_COLUMN_COUNT = 36;
const PLANTILLA_STATUSES = [
  'ACTIVE', 'AWOL', 'BACK OUT', 'ENDO', 'FLOATING', 'MATERNITY LEAVE',
  'NEWLY HIRED', 'PATERNITY LEAVE', 'QUARANTINE', 'RE-HIRED', 'RELIEVER',
  'RESIGNED', 'SEASONAL', 'SICK LEAVE', 'VACATION LEAVE', 'TERMINATED',
  'TEMPORARY STORE CLOSED', 'PERMANENTLY STORE CLOSED', 'NAME DIFFER',
  'PREVENTIVE SUSPENSION', 'DOUBLE ENTRY', 'HC ISSUE', 'LATE DTR',
  'RESHUFFLE', 'MOVEMENT'
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ERTH PORTAL | Operations Dashboard');
}

function saveMyPlantillaUrl(url) {
  const match = String(url || '').trim().match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (!match) throw new Error('Enter a Google Sheets spreadsheet URL.');

  const spreadsheet = SpreadsheetApp.openById(match[1]);
  if (!spreadsheet.getSheetByName(PLANTILLA_TAB_NAME)) {
    throw new Error(`The spreadsheet must contain a tab named ${PLANTILLA_TAB_NAME}.`);
  }

  PropertiesService.getUserProperties().setProperty('plantillaSpreadsheetId', match[1]);
  return { connected: true, spreadsheetName: spreadsheet.getName() };
}

function getMyPlantillaUrlStatus() {
  const spreadsheetId = PropertiesService.getUserProperties().getProperty('plantillaSpreadsheetId');
  if (!spreadsheetId) return { connected: false };

  try {
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    return { connected: true, spreadsheetName: spreadsheet.getName() };
  } catch (error) {
    return { connected: false, error: 'The saved spreadsheet is no longer accessible.' };
  }
}

function getPlantillaRecords() {
  const sheet = getMyPlantillaSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < PLANTILLA_START_ROW) return [];

  const range = sheet.getRange(
    PLANTILLA_START_ROW,
    1,
    lastRow - PLANTILLA_START_ROW + 1,
    PLANTILLA_COLUMN_COUNT
  );
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  return values
    .map((row, index) => mapPlantillaRow_(row, displayValues[index], PLANTILLA_START_ROW + index))
    .filter(record => record.vcode);
}

function updatePlantillaRecord(vcode, rate, separationDate, status) {
  const normalizedVcode = String(vcode || '').trim();
  if (!normalizedVcode) throw new Error('A VCODE is required to update a record.');
  if (!PLANTILLA_STATUSES.includes(String(status || ''))) throw new Error('Choose a valid status.');

  const numericRate = Number(rate);
  if (!Number.isFinite(numericRate)) throw new Error('Rate must be a number.');

  const sheet = getMyPlantillaSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < PLANTILLA_START_ROW) throw new Error(`No rows with VCODEs were found in ${PLANTILLA_TAB_NAME}.`);
  const matches = sheet.getRange(PLANTILLA_START_ROW, 2, lastRow - PLANTILLA_START_ROW + 1, 1)
    .getDisplayValues()
    .map((row, index) => row[0].trim() === normalizedVcode ? PLANTILLA_START_ROW + index : 0)
    .filter(Boolean);
  if (!matches.length) throw new Error(`No row found for VCODE ${normalizedVcode}.`);
  if (matches.length > 1) throw new Error(`VCODE ${normalizedVcode} appears more than once; no changes were made.`);

  const rowNumber = matches[0];
  sheet.getRange(rowNumber, 8).setValue(numericRate);
  const parsedSeparationDate = parseDateInput_(separationDate);
  if (parsedSeparationDate) sheet.getRange(rowNumber, 33).setValue(parsedSeparationDate);
  else sheet.getRange(rowNumber, 33).clearContent();
  sheet.getRange(rowNumber, 34).setValue(status);
  sheet.getRange(rowNumber, 33).setNumberFormat('mmmm d, yyyy');

  const updatedRange = sheet.getRange(rowNumber, 1, 1, PLANTILLA_COLUMN_COUNT);
  return mapPlantillaRow_(updatedRange.getValues()[0], updatedRange.getDisplayValues()[0], rowNumber);
}

function getMyPlantillaSheet_() {
  const spreadsheetId = PropertiesService.getUserProperties().getProperty('plantillaSpreadsheetId');
  if (!spreadsheetId) throw new Error('Connect your PLANTILLA spreadsheet first.');

  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(PLANTILLA_TAB_NAME);
  if (!sheet) throw new Error(`The connected spreadsheet has no ${PLANTILLA_TAB_NAME} tab.`);
  return sheet;
}

function mapPlantillaRow_(row, displayRow, rowNumber) {
  return {
    rowNumber,
    vcode: cellText_(displayRow[1]),
    emploc: cellText_(displayRow[2]),
    memberName: cellText_(displayRow[35]),
    position: cellText_(displayRow[6]),
    outlet: cellText_(displayRow[9]),
    hc: cellText_(displayRow[28]),
    separationDate: displayDate_(row[32], displayRow[32]),
    separationDateInput: inputDate_(row[32], displayRow[32]),
    status: cellText_(displayRow[33]),
    contactNo: cellText_(displayRow[20]),
    birthday: displayDate_(row[21], displayRow[21]),
    age: cellText_(displayRow[22]),
    civilStatus: cellText_(displayRow[23]),
    atamNo: cellText_(displayRow[19]),
    coordinator: cellText_(displayRow[25]),
    address: cellText_(displayRow[24]),
    sssNo: cellText_(displayRow[16]),
    philhealthNo: cellText_(displayRow[17]),
    pagibigNo: cellText_(displayRow[18]),
    rate: cellText_(row[7]),
    area: cellText_(displayRow[8]),
    restday: cellText_(displayRow[10]),
    dateHired: displayDate_(row[14], displayRow[14]),
    designation: cellText_(displayRow[12])
  };
}

function cellText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function displayDate_(value, displayValue) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return cellText_(displayValue).toUpperCase();
  return Utilities.formatDate(value, Session.getScriptTimeZone(), 'MMMM d, yyyy').toUpperCase();
}

function inputDate_(value, displayValue) {
  const parsed = value instanceof Date ? value : new Date(displayValue || value);
  if (Number.isNaN(parsed.getTime())) return '';
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function parseDateInput_(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Choose a valid separation date.');
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}