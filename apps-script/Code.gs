/**
 * RO Ledger Link — Google Apps Script backend
 * ---------------------------------------------------------------------------
 * A deliberately thin, safe bridge between the static site (index.html) and
 * your dealership's Sources Ledger spreadsheet. It does two things and
 * nothing else:
 *
 *   1. READ   — hand the browser the ledger's headers and rows so the site can
 *               match appointments client-side (fast, no writes, no guessing).
 *   2. WRITE  — accept a reviewed batch of RO# values and stamp them into the
 *               RO# column of the correct rows, with an overwrite guard.
 *
 * The matching logic deliberately lives in the browser (app.js), not here, so
 * you can see and correct every proposed match before a single cell changes.
 *
 * ---------------------------------------------------------------------------
 * SETUP (5 minutes)
 * ---------------------------------------------------------------------------
 *   A. EASIEST — bind the script to your ledger:
 *        1. Open your Sources Ledger spreadsheet.
 *        2. Extensions > Apps Script. Paste this file over Code.gs. Save.
 *        3. Deploy > New deployment > Type: Web app
 *             - Execute as: Me
 *             - Who has access: Anyone        <-- required for the site to call it
 *        4. Authorise when prompted, then copy the Web app URL.
 *
 *   B. STANDALONE — one script driving several spreadsheets:
 *        1. Go to script.google.com > New project. Paste this file.
 *        2. Set CONFIG.SPREADSHEET_ID below (the long ID in the sheet's URL).
 *        3. Deploy exactly as in A.3.
 *
 *   Then paste the Web app URL into the site's "Connect" panel. Done.
 *
 * SECURITY NOTE: the deployed URL is a bearer credential — anyone who has it
 * can read and write the ledger. Keep it private, and set CONFIG.SECRET below
 * (and the same value in the site) to add a second lock. To rotate, just
 * redeploy as a NEW deployment, which mints a fresh URL.
 * --------------------------------------------------------------------------- */

var CONFIG = {
  // Pinned to this spreadsheet so the script works no matter how it is
  // deployed (bound to the sheet, or pasted into script.google.com).
  // PUBLISHED COPY — blanked on purpose so this public repo never points at a
  // live sheet. Paste your own ID here (or clear it and run from inside the
  // spreadsheet via Extensions > Apps Script).
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',

  // Off — no shared secret is required to use the deployment.
  SECRET: '',

  // Tab the site opens on.
  //   ''  -> resolves automatically to the CURRENT month, e.g. "October 2026"
  //          (see resolveDefaultTab_ below), so it rolls over by itself.
  //   'October 2026' -> pins it to one specific tab.
  DEFAULT_TAB: '',

  // Row holding the column headings.
  HEADER_ROW: 1,

  // Hard ceiling on rows returned to the browser, so a 100k-row sheet can't
  // stall the tab. Raise it if your ledger is genuinely larger.
  MAX_READ_ROWS: 6000
};

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The ledger is filed one tab per month, named "Month Year" — e.g. the tab
 * for today is "October 2026". Recomputed on every request so the site opens
 * on the right month without this file being edited each month.
 *
 * Uses the SCRIPT timezone (Apps Script > Project Settings), not the
 * browser's — set it to your dealership's timezone so it flips over at
 * local midnight rather than UTC.
 */
function resolveDefaultTab_() {
  if (CONFIG.DEFAULT_TAB) return CONFIG.DEFAULT_TAB;
  var now = new Date();
  return MONTH_NAMES[now.getMonth()] + ' ' + now.getFullYear();
}

/* ========================================================================== *
 * Entry points
 * ========================================================================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!authOk_(p.secret)) return json_({ ok: false, error: 'unauthorised' });

  try {
    var action = p.action || 'ping';
    if (action === 'ping') return json_(ping_(p));
    if (action === 'read') return json_(read_(p));
    return json_({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postBody) || '{}');
  } catch (ignored) {
    body = (e && e.parameter) || {};
  }

  if (!authOk_(body.secret)) return json_({ ok: false, error: 'unauthorised' });

  try {
    var action = body.action || 'write';
    if (action === 'write') return json_(write_(body));
    return json_({ ok: false, error: 'Unknown POST action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ========================================================================== *
 * Actions
 * ========================================================================== */

/** Cheap handshake: proves the deployment is live and returns tab names.
 *
 *  When the caller doesn't name a tab, it resolves to the current month
 *  ("October 2026"). If that tab doesn't exist yet we fall back to the first
 *  tab WITH A WARNING rather than failing — a brand-new month shouldn't lock
 *  you out. An explicitly named tab that is missing stays a hard error:
 *  silently reading a different month's ledger is how RO#s land on the wrong
 *  sheet. */
function ping_(p) {
  var ss = getSS_();
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  var wanted = p.tab || resolveDefaultTab_();
  var sheet = names.length ? ss.getSheetByName(wanted) : null;
  var warning = '';

  if (!sheet) {
    if (p.tab) throw new Error('Tab "' + p.tab + '" not found. Available: ' + names.join(', '));
    if (!names.length) throw new Error('This spreadsheet has no tabs.');
    sheet = ss.getSheets()[0];
    warning = 'Tab "' + wanted + '" does not exist yet — loaded "' + sheet.getName() +
              '" instead. Available: ' + names.join(', ');
  }

  var head = readHeader_(sheet);

  return {
    ok: true,
    spreadsheet: ss.getName(),
    tabs: names,
    tab: sheet.getName(),
    warning: warning,
    headerRow: CONFIG.HEADER_ROW,
    lastRow: sheet.getLastRow(),
    lastCol: sheet.getLastColumn(),
    headers: head.headers,
    // A few real rows so the site can preview and auto-map columns before you
    // commit to reading the whole ledger.
    sample: head.sample
  };
}

/** Full ledger read for client-side matching. */
function read_(p) {
  var ss = getSS_();
  var sheet = resolveTab_(ss, p.tab);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow <= CONFIG.HEADER_ROW) {
    return { ok: true, tab: sheet.getName(), headers: [], rows: [], truncated: false };
  }

  var bodyRows = lastRow - CONFIG.HEADER_ROW;
  var truncated = bodyRows > CONFIG.MAX_READ_ROWS;
  var readRows = truncated ? CONFIG.MAX_READ_ROWS : bodyRows;

  var values = sheet
    .getRange(CONFIG.HEADER_ROW + 1, 1, readRows, lastCol)
    .getValues();

  // Send a real array of row objects keyed by header, plus the absolute sheet
  // row number (the browser needs it to write back to the right cell). Blank
  // rows are dropped so the browser doesn't match against empty placeholders.
  var headers = readHeader_(sheet).headers;
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var raw = values[i];
    if (isBlankRow_(raw)) continue;
    var obj = { _row: CONFIG.HEADER_ROW + 1 + i, _cells: raw };
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = raw[c];
    }
    rows.push(obj);
  }

  return {
    ok: true,
    tab: sheet.getName(),
    headers: headers,
    rows: rows,
    truncated: truncated,
    availableRows: bodyRows
  };
}

/**
 * Stamp RO# values into the ledger.
 *
 * body = {
 *   tab:       'Ledger',
 *   roCol:     7,                       // 1-based column index of the RO# column
 *   overwrite: false,                   // false = never clobber an existing RO#
 *   updates:   [ { row: 12, value: '102341' }, ... ]
 * }
 *
 * Every update returns an explicit status so the site can show you exactly
 * what happened rather than a vague "saved!".
 */
function write_(body) {
  var ss = getSS_();
  var sheet = resolveTab_(ss, body.tab);

  var roCol = Number(body.roCol);
  if (!roCol || roCol < 1) throw new Error('roCol is required (1-based column index).');

  var updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) throw new Error('No updates supplied.');

  var allowOverwrite = !!body.overwrite;
  var baseRow = CONFIG.HEADER_ROW + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < baseRow) throw new Error('Sheet "' + sheet.getName() + '" has no data rows.');

  // Read the RO# column once, decide everything in memory, then write only the
  // cells that actually changed. One read + N targeted writes beats N reads.
  var height = lastRow - baseRow + 1;
  var col = sheet.getRange(baseRow, roCol, height, 1).getValues();

  var results = [];
  var pending = {}; // row -> new value

  for (var i = 0; i < updates.length; i++) {
    var u = updates[i] || {};
    var row = Number(u.row);
    var value = u.value == null ? '' : String(u.value).trim();

    if (!row) { results.push({ row: row, status: 'skipped', message: 'Missing row number' }); continue; }
    if (!value) { results.push({ row: row, status: 'skipped', message: 'Empty RO#' }); continue; }

    var idx = row - baseRow;
    if (idx < 0 || idx >= height) {
      results.push({ row: row, status: 'error', message: 'Row outside the sheet' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(pending, row)) {
      results.push({ row: row, status: 'skipped', message: 'Duplicate update in this batch' });
      continue;
    }

    var before = col[idx][0];
    var beforeText = String(before).trim();

    if (beforeText !== '' && beforeText === value) {
      results.push({ row: row, status: 'unchanged', before: beforeText, after: value });
      continue;
    }
    if (beforeText !== '' && !allowOverwrite) {
      results.push({ row: row, status: 'conflict', before: beforeText, after: value,
                     message: 'Ledger already has an RO#; enable overwrite to replace it' });
      continue;
    }

    pending[row] = value;
    col[idx][0] = value;
    results.push({ row: row, status: 'written', before: beforeText, after: value });
  }

  var dirtyRows = Object.keys(pending);
  for (var d = 0; d < dirtyRows.length; d++) {
    var r = Number(dirtyRows[d]);
    sheet.getRange(r, roCol).setValue(col[r - baseRow][0]);
  }
  SpreadsheetApp.flush();

  var written = 0;
  for (var w = 0; w < results.length; w++) if (results[w].status === 'written') written++;

  return {
    ok: true,
    tab: sheet.getName(),
    roCol: roCol,
    written: written,
    attempted: updates.length,
    results: results
  };
}

/* ========================================================================== *
 * Helpers
 * ========================================================================== */

function authOk_(secret) {
  if (!CONFIG.SECRET) return true;
  return String(secret || '') === String(CONFIG.SECRET);
}

function getSS_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No spreadsheet found. Either run this from Extensions > Apps Script ' +
                    'inside the ledger, or set CONFIG.SPREADSHEET_ID.');
  }
  return ss;
}

/** Strict on purpose: read_() and write_() always pass an explicit tab, and a
 *  missing one must never fall through to "whatever the first sheet is". */
function resolveTab_(ss, tab) {
  if (!tab) tab = resolveDefaultTab_();
  var found = ss.getSheetByName(tab);
  if (found) return found;
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  throw new Error('Tab "' + tab + '" not found in ' + ss.getName() +
                  '. Available: ' + names.join(', '));
}

function readHeader_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return { headers: [], sample: [] };

  var raw = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  var headers = [];
  var seen = {};

  for (var i = 0; i < raw.length; i++) {
    var text = String(raw[i] == null ? '' : raw[i]).trim();
    // Blank or duplicate headings would collide as object keys, so give them
    // stable generated names. Column POSITION is what we write by, never the
    // heading text, so this is cosmetic.
    if (!text) text = 'Column ' + (i + 1);
    if (seen[text]) { text = text + ' (' + (i + 1) + ')'; }
    seen[text] = true;
    headers.push(text);
  }

  var previewRows = Math.min(5, Math.max(sheet.getLastRow() - CONFIG.HEADER_ROW, 0));
  var sample = [];
  if (previewRows > 0) {
    sample = sheet
      .getRange(CONFIG.HEADER_ROW + 1, 1, previewRows, lastCol)
      .getValues();
  }

  return { headers: headers, sample: sample };
}

function isBlankRow_(cells) {
  for (var i = 0; i < cells.length; i++) {
    if (String(cells[i]).trim() !== '') return false;
  }
  return true;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
