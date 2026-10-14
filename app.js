/* ===========================================================================
   RO Ledger Link — app.js
   ---------------------------------------------------------------------------
   Everything below runs in your browser. Your DMS export is parsed here and
   never leaves the machine; the only network traffic is to your own Google
   Apps Script, and only when you explicitly load the ledger or press "Write".

   Pipeline:
       connect  ->  ping the Apps Script, pick a tab, map columns
       ledger   ->  pull the Sources Ledger rows into memory
       import   ->  parse the CSV/XLSX/PDF export locally
       match    ->  score every import row against every ledger row
       review   ->  you tick or untick what you agree with
       write    ->  one batched POST stamps the RO#s into the sheet

   Matching deliberately happens here rather than server-side so every proposed
   pair is visible and reversible before a single cell is touched.
   =========================================================================== */
(function () {
'use strict';

// pdf.js fetches its own worker script; the version must match the library
// loaded in index.html or the two refuse to talk to each other.
var PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ------------------------------------------------------------------ DOM */
var $  = function (sel) { return document.querySelector(sel); };
var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

function el(tag, attrs, kids) {
  var node = document.createElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (k) {
    if (k === 'class') node.className = attrs[k];
    else if (k === 'html') node.innerHTML = attrs[k];
    else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
      node.addEventListener(k.slice(2), attrs[k]);
    } else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
  });
  (kids || []).forEach(function (c) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, kind) {
  var t = el('div', { class: 'toast ' + (kind || ''), html: esc(msg) });
  $('#toastWrap').appendChild(t);
  setTimeout(function () {
    t.style.transition = 'opacity .3s'; t.style.opacity = '0';
    setTimeout(function () { t.remove(); }, 320);
  }, 4200);
}
function setStatus(node, msg, kind) {
  node.textContent = msg || '';
  node.className = 'status' + (kind ? ' ' + kind : '');
}
function setStep(n) {
  $$('#stepRail li').forEach(function (li) {
    var s = Number(li.dataset.step);
    li.classList.toggle('is-active', s === n);
    li.classList.toggle('is-done', s < n);
  });
}
function fmtDate(v) {
  var d = parseDate(v);
  if (!d) return v ? String(v) : '';
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return m + '/' + day + '/' + d.getFullYear();
}

/* ---------------------------------------------------------------- state */
var state = {
  endpoint: '', secret: '',
  tab: '', tabs: [],
  headers: [],           // ledger headers, in sheet order
  ledger: [],            // { _row, cells:{header:value} }
  ledgerMap: {},         // field -> header name
  roColIndex: 0,         // 1-based column in the sheet

  direction: 'write',    // 'write' = file supplies RO#, 'fetch' = ledger supplies it
  importName: '',
  importHeaders: [], importRows: [],
  importMap: {},

  matches: [],
  results: null
};

var STORE_KEY = 'ro-ledger-link.v1';

/** Deliberately does NOT persist the active tab: it is resolved by the
 *  server on every connect so it always lands on the current month's ledger.
 *  Remembering it would pin the site to whatever tab was open last time —
 *  last month's sheet, silently. roColIndex is derived, not stored. */
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      endpoint: state.endpoint, secret: state.secret,
      ledgerMap: state.ledgerMap, direction: state.direction
    }));
  } catch (e) { /* private mode / quota — the tool still works, just forgets */ }
}
function loadStored() {
  try {
    var raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    var v = JSON.parse(raw);
    ['endpoint', 'secret', 'direction'].forEach(function (k) {
      if (v[k]) state[k] = v[k];
    });
    if (v.ledgerMap) state.ledgerMap = v.ledgerMap;
  } catch (e) { /* corrupt store — start clean */ }
}

/* ------------------------------------------------- value normalisation */

/** Keep the last 10 digits, so "(555) 214-8890", "5552148890" and
 *  "1-555-214-8890" all collapse to the same key. */
function normPhone(v) {
  var d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length > 10 && d.charAt(0) === '1') d = d.slice(1);
  return d.length === 10 ? d : (d.length > 10 ? d.slice(-10) : d);
}

/** Lowercase, drop titles/suffixes/punctuation so "Mr. Robert A. King Jr."
 *  and "robert king" compare equal. */
var TITLES = /^(mr|mrs|ms|miss|dr|rev|prof)\.?$/i;
var SUFFIXES = /^(jr|sr|ii|iii|iv|v)$/i;
function normName(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[.,'`]/g, '')
    .split(/\s+/)
    .filter(function (w) { return w && !TITLES.test(w) && !SUFFIXES.test(w); })
    .join(' ');
}
function nameParts(v) {
  var raw = String(v == null ? '' : v);
  // "LAST, FIRST" is the usual DMS export order. The comma is the only signal
  // that the order is reversed, so flip it before normalising — normName()
  // strips punctuation and would otherwise destroy the evidence.
  if (raw.indexOf(',') > -1) {
    var bits = raw.split(',');
    raw = (bits[1] || '') + ' ' + (bits[0] || '');
  }
  var w = normName(raw).split(' ').filter(Boolean);
  if (!w.length) return { first: '', last: '', full: '' };
  return { first: w[0], last: w[w.length - 1], full: w.join(' ') };
}
function normVin(v) {
  var s = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 11 ? s : '';   // short strings aren't real VINs
}

/** Accepts Date objects, Google Sheets serials, and the handful of date
 *  formats DMS exports actually use. Returns a local Date or null. */
function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

  if (typeof v === 'number' && v > 20000 && v < 60000) {
    // Excel / Sheets serial date (days since 1899-12-30).
    return new Date(Math.round((v - 25569) * 86400000));
  }
  var s = String(v).trim();
  if (!s) return null;

  var m;
  if ((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/))) {           // 2026-10-12
    return mk(+m[1], +m[2], +m[3]);
  }
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/))) {          // 10/12/26 (US)
    var y = +m[3]; if (y < 100) y += 2000;
    return mk(y, +m[1], +m[2]);
  }
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}:\d{2})/))) {      // 10/12 8:30 AM
    return mk(new Date().getFullYear(), +m[1], +m[2]);
  }
  var t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
function mk(y, mo, d) {
  var dt = new Date(y, mo - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}
function dateKey(v) {
  var d = parseDate(v);
  if (!d) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
       + '-' + String(d.getDate()).padStart(2, '0');
}
function dayDiff(a, b) {
  var da = parseDate(a), db = parseDate(b);
  if (!da || !db) return null;
  var ms = new Date(da.getFullYear(), da.getMonth(), da.getDate())
         - new Date(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round(ms / 86400000);
}

/* ---------------------------------------------- column auto-detection */
var FIELDS = [
  { key: 'customer', label: 'Customer name', hints: [/customer/, /client/, /guest/, /^name$/, /cust\b/, /buyer/, /ro name/] },
  { key: 'first',    label: 'First name',    hints: [/first/, /\bfn\b/] },
  { key: 'last',     label: 'Last name',     hints: [/last\s*name/, /\bln\b/, /surname/] },
  { key: 'phone',    label: 'Phone',         hints: [/phone/, /mobile/, /cell/, /\btel/, /\bcontact\b/] },
  { key: 'vin',      label: 'VIN',           hints: [/\bvin\b/, /vin\s*#/, /vehicle.*id/] },
  { key: 'date',     label: 'Date',          hints: [/appt/, /appointment/, /scheduled/, /date/, /\bday\b/, /write.?up/, /checked.?in/] },
  { key: 'time',     label: 'Time',          hints: [/\btime\b/, /appt.*time/, /arriv/] },
  { key: 'ro',       label: 'RO#',           hints: [/^ro$/, /^ro\s*#$/, /^ro\s*(no\.?|number)$/, /repair\s*order/, /order\s*#/, /^ro\b/] },
  { key: 'source',   label: 'Source',        hints: [/source/, /lead/, /channel/, /how.*found/, /origin/, /market/] },
  { key: 'advisor',  label: 'Advisor',       hints: [/advisor/, /service.*writer/, /\bsa\b/, /csi/, /consult/] },
  { key: 'status',   label: 'Status',        hints: [/status/, /\bstate\b/, /\bstage\b/, /open.?closed/] },
  { key: 'vehicle',  label: 'Vehicle',       hints: [/vehicle/, /\bunit\b/, /\byear\b/, /make/, /model/, /\bcar\b/, /unit.*desc/] }
];
var REQUIRED_FOR_MATCH = ['date'];

/** Auto-map headings to fields.
 *
 *  Hints within each field are listed MOST SPECIFIC FIRST, and a heading is
 *  claimed by the field whose best hint is the most specific — not simply by
 *  whichever field asks first. That matters for a ledger headed
 *  "… DATE MADE | APPT DATE": the appt hint outranks the generic date hint,
 *  so matching keys off APPT DATE (when the customer is coming in) rather than
 *  DATE MADE (when someone tapped the keyboard). */
function autoMap(headers) {
  var map = {}, taken = {};
  FIELDS.forEach(function (f) {
    var best = null;
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if (taken[h]) continue;
      var low = String(h).toLowerCase().trim();
      for (var k = 0; k < f.hints.length; k++) {
        if (f.hints[k].test(low)) {
          if (!best || k < best.k) best = { h: h, k: k };
          break;   // first hint is the most specific match for this heading
        }
      }
    }
    if (best) { map[f.key] = best.h; taken[best.h] = true; }
    else map[f.key] = '';
  });
  return map;
}

/** Find the ledger's RO column BY HEADING — "RO" first, then the usual
 *  synonyms. Returns the heading string, or '' when there isn't one.
 *  Resolving by name rather than position means columns can be inserted or
 *  reordered without RO#s landing in the wrong cell. */
function resolveRoHeader(headers) {
  var wanted = [/^ro$/i, /^ro\s*#$/i, /^ro\s*(no\.?|number)$/i, /repair\s*order/i, /^ro\b/i];
  for (var w = 0; w < wanted.length; w++) {
    for (var i = 0; i < headers.length; i++) {
      if (wanted[w].test(String(headers[i]).trim())) return headers[i];
    }
  }
  return '';
}

/** 1-based column index of the heading currently mapped to RO#, or 0. */
function syncRoColIndex() {
  var h = state.ledgerMap.ro;
  var i = h ? state.headers.indexOf(h) : -1;
  state.roColIndex = i > -1 ? i + 1 : 0;
  return state.roColIndex;
}

/** Build a mapping editor. `target` is the state object to write into.
 *  Fields named in `locked` are rendered read-only — used to pin RO# to the
 *  actual "RO" heading so it can't be pointed anywhere else by accident. */
function renderMapGrid(container, headers, target, onDone, locked) {
  locked = locked || [];
  container.innerHTML = '';
  FIELDS.forEach(function (f) {
    var isLocked = locked.indexOf(f.key) > -1;
    var sel = el('select', { id: 'map-' + target.__id + '-' + f.key });
    if (isLocked) sel.disabled = true;
    sel.appendChild(el('option', { value: '' }, ['— not used —']));
    headers.forEach(function (h) {
      var o = el('option', { value: h }, [h]);
      if (target[f.key] === h) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      target[f.key] = sel.value;
      save();
      if (onDone) onDone(f.key, sel.value);
    });
    var label = el('label', { for: sel.id }, [f.label]);
    if (isLocked) {
      label.appendChild(el('span', { class: 'opt' }, ['pinned']));
    }
    container.appendChild(
      el('div', { class: 'field' }, [label, sel])
    );
  });
}

/* ---------------------------------------------------- ledger access */

function endpointUrl(extra) {
  var url = state.endpoint.trim();
  var q = [];
  Object.keys(extra || {}).forEach(function (k) {
    q.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k]));
  });
  if (state.secret) q.push('secret=' + encodeURIComponent(state.secret));
  return url + (url.indexOf('?') > -1 ? '&' : '?') + q.join('&');
}

/** Apps Script answers HTML error pages when a deployment is misconfigured,
 *  so always parse defensively and surface a readable cause. */
async function call(action, extra) {
  var res = await fetch(endpointUrl(Object.assign({ action: action }, extra || {})));
  var text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from the Apps Script.');
  try { return JSON.parse(text); }
  catch (e) {
    throw new Error('The Apps Script replied with something that isn\'t JSON — ' +
      'check it is deployed as a Web app with access set to "Anyone".');
  }
}

async function writeLedger(payload) {
  var res = await fetch(state.endpoint.trim(), {
    method: 'POST',
    // text/plain (not application/json) keeps this a simple request, so the
    // browser never sends a CORS preflight — which Apps Script can't answer.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ secret: state.secret, action: 'write' }, payload))
  });
  var text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from the Apps Script.');
  try { return JSON.parse(text); }
  catch (e) { throw new Error('The Apps Script returned a non-JSON response.'); }
}

async function connect() {
  var btn = $('#btnConnect'), st = $('#connectStatus');
  state.endpoint = $('#endpoint').value.trim();
  state.secret = $('#secret').value.trim();

  if (!/^https:\/\/script\.google\.com\//.test(state.endpoint)) {
    setStatus(st, 'That doesn\'t look like an Apps Script URL (should start with https://script.google.com/).', 'err');
    return;
  }
  btn.disabled = true; setStatus(st, 'Contacting the Apps Script…', 'busy');
  $('#connPill').dataset.state = 'busy'; $('#connText').textContent = 'Connecting…';

  try {
    var data = await call('ping', state.tab ? { tab: state.tab } : {});
    if (!data.ok) throw new Error(data.error || 'The script said no.');

    state.tabs = data.tabs || [];
    state.tab = data.tab;
    state.headers = data.headers || [];

    // Prefer the tab we already used; otherwise let auto-detection pick the
    // RO# column and seed the mapping.
    var sel = $('#tabSelect'); sel.innerHTML = '';
    state.tabs.forEach(function (t) {
      var o = el('option', { value: t }, [t]);
      if (t === state.tab) o.selected = true;
      sel.appendChild(o);
    });

    seedTabColumns(data);

    $('#sheetMeta').textContent = sheetMetaText(data);
    $('#sheetPicker').hidden = false;
    if (data.warning) {
      // The expected month's tab isn't there yet — make it loud rather than
      // letting someone load the wrong month's ledger without noticing.
      setStatus(st, data.warning, 'err');
      toast(data.warning, 'warn');
    } else {
      setStatus(st, 'Connected to "' + data.spreadsheet + '".', 'ok');
    }
    $('#connPill').dataset.state = 'on'; $('#connText').textContent = data.spreadsheet;
    save();
  } catch (err) {
    setStatus(st, err.message, 'err');
    $('#connPill').dataset.state = 'off'; $('#connText').textContent = 'Not connected';
    toast('Connection failed: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/** "Sheet name — N data rows, M columns". lastRow counts the header row, so
 *  subtract it before describing the sheet to a human. */
function sheetMetaText(data) {
  var dataRows = Math.max((data.lastRow || 0) - (data.headerRow || 1), 0);
  return data.spreadsheet + ' — ' + dataRows + ' data rows, ' +
         (data.headers || []).length + ' columns';
}

/** Re-draw the ledger preview after a mapping change, so picking a column
 *  shows up immediately instead of waiting for the next "Load ledger". */
function refreshLedgerPreview() {
  if (state.ledger.length && !$('#ledgerView').hidden) renderLedgerTable();
}

/** Wire up the ledger column mapping from a ping/read payload.
 *
 *  RO# is resolved straight from the "RO" heading and then pinned, because the
 *  requirement is unambiguous: the app always writes to the RO column. A saved
 *  or hand-picked choice is only honoured when no heading matches, so a
 *  renamed or reordered sheet can never silently redirect the write. */
function seedTabColumns(data) {
  state.headers = data.headers || [];
  var detected = autoMap(state.headers);
  var saved = state.ledgerMap || {};

  var byName = resolveRoHeader(state.headers);
  var savedRo = saved.ro;
  var roHeader = byName ||
    (savedRo && state.headers.indexOf(savedRo) > -1 ? savedRo : '') ||
    detected.ro || '';

  var merged = {};
  FIELDS.forEach(function (f) {
    if (f.key === 'ro') return;                       // always re-resolved above
    var v = saved[f.key];
    merged[f.key] = (v && state.headers.indexOf(v) > -1) ? v : detected[f.key];
  });
  merged.ro = roHeader;
  merged.__id = 'ledger';
  state.ledgerMap = merged;
  syncRoColIndex();

  renderMapGrid(
    $('#ledgerMapGrid'), state.headers, state.ledgerMap,
    function (key) {
      if (key === 'ro') syncRoColIndex();
      refreshLedgerPreview();
    },
    byName ? ['ro'] : []                              // pinned only when found by name
  );

  if (!roHeader) {
    toast('No column headed "RO" found on this tab — choose the RO# column in the mapping below.',
      'warn');
  }
}

async function loadLedger() {
  var btn = $('#btnLoadLedger'), st = $('#loadStatus');
  syncRoColIndex();
  if (!state.roColIndex) {
    setStatus(st, 'Pick the RO# column in the mapping above first.', 'err');
    return;
  }
  btn.disabled = true; setStatus(st, 'Reading the ledger…', 'busy');

  try {
    var data = await call('read', { tab: state.tab });
    if (!data.ok) throw new Error(data.error || 'Read failed.');

    state.headers = data.headers || [];
    state.ledger = (data.rows || []).map(function (r) {
      return { _row: r._row, cells: r };
    });

    if (data.truncated) {
      toast('Only the first ' + state.ledger.length + ' rows were read (Apps Script ceiling). ' +
            'Raise CONFIG.MAX_READ_ROWS in Code.gs if you need more.', 'warn');
    }
    if (!state.ledger.length) {
      setStatus(st, 'That tab has no data rows yet.', 'err');
      return;
    }

    renderLedgerTable();
    $('#ledgerView').hidden = false;
    setStatus(st, state.ledger.length + ' rows loaded.', 'ok');
    setStep(2);
    $('#panel-import').hidden = false;
    toast('Ledger loaded — ' + state.ledger.length + ' rows.', 'ok');
  } catch (err) {
    setStatus(st, err.message, 'err');
    toast('Could not read the ledger: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function ledgerCell(row, field) {
  var h = state.ledgerMap[field];
  return h ? row.cells[h] : '';
}
function ledgerName(row) {
  var c = ledgerCell(row, 'customer');
  if (c) return String(c);
  var f = ledgerCell(row, 'first'), l = ledgerCell(row, 'last');
  return [f, l].filter(Boolean).join(' ');
}
function ledgerRo(row) {
  var h = state.headers[state.roColIndex - 1];
  return h ? String(row.cells[h] == null ? '' : row.cells[h]).trim() : '';
}

function renderLedgerTable() {
  // Only columns that are both displayed and actually mapped appear, so an
  // unmapped field (like advisor, which is never auto-resolved) stays hidden
  // until you point it at a heading yourself.
  var shownFields = FIELDS.filter(function (f) {
    return ['customer', 'date', 'phone', 'source', 'vehicle', 'status', 'advisor'].indexOf(f.key) > -1
        && state.ledgerMap[f.key];
  }).map(function (f) { return f.key; });

  var thead = $('#ledgerTable thead'), tbody = $('#ledgerTable tbody');
  thead.innerHTML = '';
  var hr = el('tr', {}, [el('th', {}, ['#'])]);
  shownFields.forEach(function (f) { hr.appendChild(el('th', {}, [FIELDS.find(function (x) { return x.key === f; }).label])); });
  hr.appendChild(el('th', {}, ['RO#']));
  thead.appendChild(hr);

  tbody.innerHTML = '';
  renderLedgerRows(tbody, state.ledger, shownFields, $('#ledgerFilter').value);
  $('#ledgerCount').textContent = state.ledger.length + ' rows';
  $('#ledgerFilter').oninput = function () { renderLedgerRows(tbody, state.ledger, shownFields, this.value); };
}

function renderLedgerRows(tbody, rows, shownFields, filter) {
  tbody.innerHTML = '';
  var q = String(filter || '').toLowerCase().trim();
  var list = q ? rows.filter(function (r) {
    return ledgerName(r).toLowerCase().indexOf(q) > -1
        || ledgerRo(r).toLowerCase().indexOf(q) > -1;
  }) : rows;

  if (!list.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: String(shownFields.length + 2) }, ['No rows match that filter.'])]));
    return;
  }
  list.slice(0, 300).forEach(function (r) {
    var tr = el('tr', {}, [el('td', { class: 'rownum' }, [String(r._row)])]);
    shownFields.forEach(function (f) {
      var v = ledgerCell(r, f);
      tr.appendChild(el('td', f === 'date' ? { class: 'mono' } : {},
        [f === 'date' ? fmtDate(v) : String(v == null ? '' : v)]));
    });
    var ro = ledgerRo(r);
    tr.appendChild(el('td', { html: ro ? '<span class="ro">' + esc(ro) + '</span>' : '<span class="ro-empty">—</span>' }));
    tbody.appendChild(tr);
  });
}

/* ---------------------------------------------------- file importing */

function parseCsvFallback(text) {
  // Minimal RFC-4180 reader, used only if the PapaParse CDN is unreachable so
  // the tool still works offline.
  var rows = [], row = [], cell = '', quoted = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
}

/* ------------------------------------------------- PDF: DMS appointment blocks
 *
 * Some DMS exports arrive as PDF, and those reports are NOT tables — each
 * appointment is a block of "Label:  value" pairs drawn on a grid:
 *
 *   Appt Time:  Oct 5, 2026 07:00AM   Transport:  Drop Off Vehicle
 *   Customer:   JANE Q. PUBLIC        Customer DMS ID:  123456
 *   Year/Make/Model: 2022 Hyundai Tucson  VIN:  5NPET4JA7KH123456
 *
 * It still reconstructs reliably because of two invariants the DMS honours:
 * every label sits at a fixed X, and its value starts at the next X to the
 * right. Wrapped labels ("Mobile" / "Phone:") and wrapped values (a long
 * model name spilling a line) keep the same X, so neither breaks the grid.
 * We rebuild the blocks into a flat table and feed the ordinary pipeline. */
function pdfBlocksToRows(items) {
  var its = [];
  (items || []).forEach(function (it) {
    var s = String(it && it.s != null ? it.s : '').replace(/\s+/g, ' ').trim();
    if (!s) return;
    its.push({ s: s, x: +it.x || 0, y: +it.y || 0, page: it.page || 1 });
  });
  if (!its.length) return [];

  /** Which "Label:" strings actually open a field. Ending in a colon is NOT
   *  enough on its own: wrapped free text (Advisor Notes, for one) carries its
   *  own colons — "…, Status: Scheduled…" — and mistaking that for a field
   *  would invent a bogus column and truncate the real value beside it. */
  var FIELD_KEYS = {
    'appt time': 1, 'transport': 1, 'carry-over': 1, 'customer': 1,
    'customer dms id': 1, 'mobile phone': 1, 'phone': 1, 'home phone': 1,
    'work phone': 1, 'year/make/model': 1, 'vin': 1, 'mileage': 1,
    'advisor': 1, 'technician': 1, 'services': 1, 'advisor notes': 1,
    'customer comments': 1
  };
  function fieldKey(s) {
    return s.replace(/:$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // 1. Cluster every left edge into an X anchor = one grid column.
  var xs = its.map(function (t) { return t.x; }).sort(function (a, b) { return a - b; });
  var anchors = [];
  xs.forEach(function (x) {
    if (!anchors.length || x - anchors[anchors.length - 1] > 3) anchors.push(x);
  });
  function anchorOf(x) {
    var best = 0, bd = Infinity;
    for (var a = 0; a < anchors.length; a++) {
      var d = Math.abs(anchors[a] - x);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }
  its.forEach(function (t) { t.a = anchorOf(t.x); });

  // 2. Reading order: page, top to bottom, left to right. PDF Y grows
  //    upwards, hence the descending sort.
  its.sort(function (p, q) { return p.page - q.page || q.y - p.y || p.x - q.x; });

  // 3. Group into visual lines (Y wobbles by a fraction of a point).
  var lines = [], cur = null;
  its.forEach(function (t) {
    if (!cur || cur.page !== t.page || Math.abs(cur.y - t.y) > 2) {
      cur = { page: t.page, y: t.y, items: [] };
      lines.push(cur);
    }
    cur.items.push(t);
  });
  lines.forEach(function (l) { l.items.sort(function (a, b) { return a.x - b.x; }); });

  // 4. Re-join labels the renderer split across two lines.
  for (var li = 0; li < lines.length - 1; li++) {
    var la = lines[li], lb = lines[li + 1];
    if (la.page !== lb.page || lb.y > la.y || la.y - lb.y > 12) continue;
    la.items.forEach(function (t) {
      // A wrapped field label is short and colon-free up to this point.
      if (/:$/.test(t.s) || t.s.length > 20) return;
      for (var k = 0; k < lb.items.length; k++) {
        var u = lb.items[k];
        if (u.a !== t.a || u.skip || !/:$/.test(u.s) || /:.*:/.test(u.s)) continue;
        t.s = t.s + ' ' + u.s;
        u.skip = true;
        return;
      }
    });
  }

  // 5. Flatten, marking which fragments open a field.
  var seq = [];
  lines.forEach(function (l) {
    l.items.forEach(function (t) {
      if (t.skip) return;
      t.isLabel = /:$/.test(t.s) && !!FIELD_KEYS[fieldKey(t.s)];
      seq.push(t);
    });
  });

  // The X positions that ever open a field are the label columns of the grid.
  var labelXs = [];
  seq.forEach(function (t) {
    if (t.isLabel && labelXs.indexOf(t.x) < 0) labelXs.push(t.x);
  });
  labelXs.sort(function (p, q) { return p - q; });

  /** Text belonging to the label at index i. The value starts at the next X
   *  to the right and keeps running down the page until a label at our own
   *  column — or further left — begins the next field. That boundary is what
   *  stops one field bleeding into the next even though they share an X. */
  function takeValue(i, t) {
    var maxX = Infinity;
    for (var z = 0; z < labelXs.length; z++) {
      if (labelXs[z] > t.x) { maxX = labelXs[z]; break; }
    }
    var out = [];
    for (var j = i + 1; j < seq.length; j++) {
      var u = seq[j];
      if (u.isLabel && u.x <= t.x) break;
      if (u.x <= t.x || u.x >= maxX) continue;
      out.push(u.s);
    }
    return out.join(' ');
  }

  // 6. Walk in order, opening a new record at every "Appt Time:".
  var recs = [], rec = null;
  for (var i = 0; i < seq.length; i++) {
    var t = seq[i];
    if (!t.isLabel) continue;                       // page title / footer
    var key = fieldKey(t.s);
    if (key === 'appt time') { rec = { _appt: '' }; recs.push(rec); }
    if (!rec) continue;

    var v = takeValue(i, t);
    if (key === 'appt time') rec._appt = v;
    else if (key === 'customer') rec.name = v;
    else if (key === 'customer dms id') rec.dms = v;
    else if (key === 'mobile phone' || key === 'phone') rec.phone = v;
    else if (key === 'home phone') rec.home = v;
    else if (key === 'work phone') rec.work = v;
    else if (key === 'year/make/model') rec.vehicle = v;
    else if (key === 'vin') rec.vin = v;
    else if (key === 'mileage') rec.mileage = v;
    else if (key === 'advisor') rec.advisor = v;
    else if (key === 'technician') rec.tech = v;
    else if (key === 'services') rec.services = v;
    else if (key === 'transport') rec.transport = v;
    else if (key === 'carry-over') rec.carry = v;
  }

  var blank = function (v) {
    var s = String(v == null ? '' : v).trim();
    return /^(n\/?a|none|null|-|\u2014|not available)$/i.test(s) ? '' : s;
  };
  var rows = [[
    'CUSTOMER', 'PHONE', 'VIN', 'APPT DATE', 'APPT TIME', 'VEHICLE', 'ADVISOR',
    'SERVICES', 'DMS ID', 'MILEAGE', 'TECHNICIAN', 'HOME PHONE', 'WORK PHONE',
    'TRANSPORT', 'CARRY-OVER'
  ]];
  recs.forEach(function (r) {
    var ap = pdfApptSplit(r._appt);
    rows.push([
      blank(r.name), blank(r.phone), blank(r.vin), ap.date, ap.time,
      blank(r.vehicle), blank(r.advisor), blank(r.services), blank(r.dms),
      blank(r.mileage), blank(r.tech), blank(r.home), blank(r.work),
      blank(r.transport), blank(r.carry)
    ]);
  });
  return rows;
}

/** "Oct 5, 2026 07:00AM" -> { date: "10/05/2026", time: "07:00AM" }.
 *  The date is emitted in the US form parseDate already understands, so the
 *  month-name format the DMS prints never has to be taught to the matcher. */
function pdfApptSplit(v) {
  var s = String(v == null ? '' : v).trim();
  var m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(.*))?$/);
  if (!m) return { date: s, time: '' };
  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
              jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var mo = MON[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return { date: s, time: '' };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return { date: pad(mo) + '/' + pad(+m[2]) + '/' + m[3], time: (m[4] || '').trim() };
}

/** Collect positioned text from every page, in order. pdf.js renders a page
 *  at a time, so the pages are chained to keep them in sequence. */
function pdfReadAll(doc) {
  var items = [];
  var chain = Promise.resolve();
  for (var p = 1; p <= doc.numPages; p++) {
    (function (n) {
      chain = chain.then(function () { return doc.getPage(n); })
        .then(function (page) { return page.getTextContent(); })
        .then(function (tc) {
          tc.items.forEach(function (it) {
            items.push({ s: it.str, x: it.transform[4], y: it.transform[5], page: n });
          });
        });
    })(p);
  }
  return chain.then(function () { return items; });
}

function handleFile(file) {
  if (!file) return;
  var name = file.name.toLowerCase();

  var done = function (rows) {
    // Drop fully blank rows, then treat the first row as the header.
    rows = rows.filter(function (r) {
      return r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; });
    });
    if (rows.length < 2) {
      toast('That file has no data rows under the header.', 'err');
      return;
    }
    state.importHeaders = rows[0].map(function (h, i) {
      var t = String(h == null ? '' : h).trim();
      return t || 'Column ' + (i + 1);
    });
    state.importRows = rows.slice(1).map(function (r, i) {
      var cells = {};
      state.importHeaders.forEach(function (h, c) { cells[h] = r[c] == null ? '' : r[c]; });
      return { _row: i + 2, cells: cells };   // +2 = header row + 1-based
    });

    state.importName = file.name;
    state.importMap = Object.assign(autoMap(state.importHeaders), { __id: 'imp' });

    $('#fileName').textContent = file.name;
    $('#fileMeta').textContent = state.importRows.length + ' rows · ' +
      state.importHeaders.length + ' columns · parsed locally';
    $('#dropIdle').hidden = true; $('#dropLoaded').hidden = false;
    renderMapGrid($('#importMapGrid'), state.importHeaders, state.importMap);
    $('#importMap').hidden = false;
    setStep(2);
    toast('Imported ' + state.importRows.length + ' rows from ' + file.name, 'ok');
  };

  if (/\.xlsx?$/.test(name)) {
    if (typeof XLSX === 'undefined') {
      toast('Excel support needs the SheetJS library, which didn\'t load. Reconnect to the internet, or save the file as CSV.', 'err');
      return;
    }
    var fr = new FileReader();
    fr.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        var ws = wb.Sheets[wb.SheetNames[0]];
        // raw:false so date cells come back as formatted text we can re-parse.
        done(XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }));
      } catch (err) {
        toast('Could not read that Excel file: ' + err.message, 'err');
      }
    };
    fr.readAsArrayBuffer(file);
    return;
  }

  if (/\.pdf$/.test(name)) {
    if (typeof pdfjsLib === 'undefined') {
      toast('PDF support needs the pdf.js library, which didn\'t load. Reconnect to the internet, or ask the DMS for a CSV/Excel export.', 'err');
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    var frPdf = new FileReader();
    frPdf.onload = function (e) {
      var loading = pdfjsLib.getDocument({ data: new Uint8Array(e.target.result) });
      loading.promise
        .then(pdfReadAll)
        .then(function (items) {
          var rows = pdfBlocksToRows(items);
          if (rows.length < 2) {
            toast('That PDF has no readable text. If it is a scan or a photo of a screen, the DMS has to export a real PDF (or CSV) instead.', 'err');
            return;
          }
          done(rows);
        })
        .catch(function (err) {
          toast('Could not read that PDF: ' + (err && err.message ? err.message : err), 'err');
        });
    };
    frPdf.onerror = function () { toast('Could not open that file.', 'err'); };
    frPdf.readAsArrayBuffer(file);
    return;
  }

  if (typeof Papa !== 'undefined') {
    Papa.parse(file, {
      skipEmptyLines: 'greedy',
      complete: function (res) { done(res.data); },
      error: function (err) { toast('Could not read that file: ' + err.message, 'err'); }
    });
  } else {
    var fr2 = new FileReader();
    fr2.onload = function (e) { done(parseCsvFallback(String(e.target.result))); };
    fr2.readAsText(file);
  }
}

function importCell(row, field) {
  var h = state.importMap[field];
  return h ? row.cells[h] : '';
}
function importName(row) {
  var c = importCell(row, 'customer');
  if (c) return String(c);
  return [importCell(row, 'first'), importCell(row, 'last')].filter(Boolean).join(' ');
}
function importRo(row) {
  return String(importCell(row, 'ro') == null ? '' : importCell(row, 'ro')).trim();
}

/* --------------------------------------------------------- matching */

var BANDS = { high: 85, medium: 65, low: 45 };
function bandOf(score) {
  if (score >= BANDS.high) return 'high';
  if (score >= BANDS.medium) return 'medium';
  if (score >= BANDS.low) return 'low';
  return 'none';
}

/** Score one import row against one ledger row. Higher is better.
 *  The ranking is intentionally conservative: a shared surname on its own is
 *  a hint, not a match, so it can never auto-select anything. */
function scorePair(imp, led) {
  var vinA = normVin(importCell(imp, 'vin')), vinB = normVin(ledgerCell(led, 'vin'));
  if (vinA && vinB && vinA === vinB) return { score: 100, why: 'VIN match' };

  var phA = normPhone(importCell(imp, 'phone')), phB = normPhone(ledgerCell(led, 'phone'));
  if (phA && phB && phA === phB) return { score: 96, why: 'Phone match' };

  var nameA = nameParts(importName(imp)), nameB = nameParts(ledgerName(led));
  if (!nameA.full || !nameB.full) return { score: 0, why: 'No name to compare' };

  var diff = dayDiff(importCell(imp, 'date'), ledgerCell(led, 'date'));
  var sameDay = diff === 0;
  var nearDay = diff !== null && Math.abs(diff) <= 1;

  if (nameA.first && nameB.first && nameA.first === nameB.first && nameA.last === nameB.last) {
    if (sameDay) return { score: 90, why: 'Full name + same day' };
    if (nearDay) return { score: 76, why: 'Full name + date ±1 day' };
    return { score: 62, why: 'Full name, different day' };
  }
  if (nameA.last && nameA.last === nameB.last) {
    if (sameDay) return { score: 74, why: 'Surname + same day' };
    if (nearDay) return { score: 68, why: 'Surname + date ±1 day' };
    return { score: 48, why: 'Surname only' };
  }
  return { score: 0, why: 'No name overlap' };
}

function runMatch() {
  var st = $('#matchStatus');
  REQUIRED_FOR_MATCH.forEach(function (f) {
    if (!state.importMap[f]) {
      setStatus(st, 'Map a date column in the import first — matching needs it to tell same-day bookings apart.', 'err');
      throw new Error('date column unmapped');
    }
  });
  if (!state.ledger.length) { setStatus(st, 'Load the ledger first.', 'err'); return; }

  setStatus(st, 'Matching ' + state.importRows.length + ' appointments against ' +
    state.ledger.length + ' ledger rows…', 'busy');

  var used = {};   // ledger row -> import row, so one ledger row can't be claimed twice
  state.matches = state.importRows.map(function (imp) {
    var best = null;
    state.ledger.forEach(function (led) {
      var r = scorePair(imp, led);
      if (!best || r.score > best.score) best = { score: r.score, why: r.why, ledger: led };
    });

    var m = {
      imp: imp,
      ledger: best && best.score >= BANDS.low ? best.ledger : null,
      score: best ? best.score : 0,
      why: best ? best.why : '',
      band: best ? bandOf(best.score) : 'none',
      conflict: false,
      existingRo: '',
      selected: false
    };

    if (m.ledger) {
      if (used[m.ledger._row]) {
        m.clash = used[m.ledger._row];
        m.band = 'low'; m.score = Math.min(m.score, 55);
        m.why += ' · also claimed by import row ' + m.clash;
      } else {
        used[m.ledger._row] = imp._row;
      }
      m.existingRo = ledgerRo(m.ledger);
      var ro = importRo(imp);
      if (state.direction === 'write' && m.existingRo && ro && m.existingRo !== ro) {
        m.conflict = true;
        m.why += ' · ledger already has ' + m.existingRo;
      }
      // Only auto-tick confident, conflict-free rows.
      m.selected = (m.band === 'high' || m.band === 'medium') && !m.conflict;
    }
    return m;
  });

  setStatus(st, '', null);
  renderMatches();
  $('#panel-review').hidden = false;
  $('#panel-write').hidden = false;
  setStep(3);
  var chosen = state.matches.filter(function (m) { return m.selected; }).length;
  toast(chosen + ' of ' + state.matches.length + ' rows matched.', chosen ? 'ok' : 'warn');
  $('#panel-review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderMatches() {
  var writing = state.direction === 'write';
  var thead = $('#matchTable thead'), tbody = $('#matchTable tbody');

  thead.innerHTML = '';
  thead.appendChild(el('tr', {}, [
    el('th', {}, ['']),
    el('th', {}, ['#']),
    el('th', {}, ['Appointment (file)']),
    el('th', {}, [writing ? 'RO# to write' : 'RO# in ledger']),
    el('th', {}, ['Matched ledger row']),
    el('th', {}, ['Confidence'])
  ]));

  tbody.innerHTML = '';
  if (!state.matches.length) {
    $('#matchEmpty').hidden = false;
    $('#matchEmpty').textContent = 'No rows to show.';
    return;
  }
  $('#matchEmpty').hidden = true;

  state.matches.forEach(function (m, i) {
    var tr = el('tr', { class: m.selected ? 'is-sel' : '' });

    var cb = el('input', { type: 'checkbox' });
    cb.checked = !!m.selected;
    cb.disabled = !m.ledger;
    cb.addEventListener('change', function () {
      m.selected = cb.checked;
      tr.classList.toggle('is-sel', cb.checked);
      updateTally();
    });
    tr.appendChild(el('td', {}, [cb]));

    tr.appendChild(el('td', { class: 'rownum' }, [String(m.imp._row)]));

    // Appointment side
    var ph = importCell(m.imp, 'phone');
    tr.appendChild(el('td', {}, [
      document.createTextNode(importName(m.imp) || '(no name)'),
      el('span', { class: 'sub' }, [
        fmtDate(importCell(m.imp, 'date')) + (ph ? ' · ' + ph : '')
      ])
    ]));

    // The RO# in play
    var ro = writing ? importRo(m.imp) : (m.existingRo || '');
    tr.appendChild(el('td', {
      html: ro ? '<span class="ro">' + esc(ro) + '</span>'
               : '<span class="ro-empty">' + (writing ? '(missing in file)' : '(blank)') + '</span>'
    }));

    // Ledger side
    if (m.ledger) {
      var src = ledgerCell(m.ledger, 'source');
      tr.appendChild(el('td', {}, [
        document.createTextNode(ledgerName(m.ledger) || '(no name)'),
        el('span', { class: 'sub' }, [
          'row ' + m.ledger._row + ' · ' + fmtDate(ledgerCell(m.ledger, 'date')) +
          (src ? ' · ' + src : '')
        ])
      ]));
    } else {
      tr.appendChild(el('td', { html: '<span class="ro-empty">no match found</span>' }));
    }

    // Confidence
    var badge = { high: 'tag high', medium: 'tag med', low: 'tag low', none: 'tag none' }[m.band];
    var label = { high: 'High', medium: 'Medium', low: 'Low', none: 'None' }[m.band];
    var cell = el('td', {}, [el('span', { class: badge }, [label])]);
    if (m.why) cell.appendChild(el('span', { class: 'sub' }, [m.why]));
    if (m.conflict) {
      cell.appendChild(el('span', { class: 'sub' }, [
        $('#allowOverwrite').checked
          ? '⚠ will replace the existing RO#'
          : '⚠ needs overwrite to change'
      ]));
    }
    tr.appendChild(cell);

    tbody.appendChild(tr);
  });

  updateTally();
  setStep(3);
}

function updateTally() {
  var chosen = state.matches.filter(function (m) { return m.selected; });
  // Only count a conflict as "held back" while it is genuinely being skipped —
  // once overwrite is on and the row is ticked, it is no longer held back.
  var conflicts = state.matches.filter(function (m) { return m.conflict && !m.selected; }).length;
  var blanks = chosen.filter(function (m) { return !importRo(m.imp); }).length;
  $('#matchTally').innerHTML =
    '<b>' + chosen.length + '</b> selected of ' + state.matches.length +
    (conflicts ? ' · <b>' + conflicts + '</b> conflict(s) held back' : '') +
    (blanks && state.direction === 'write' ? ' · <b>' + blanks + '</b> selected without an RO#' : '');

  var btn = $('#btnWrite');
  if (state.direction === 'fetch') {
    btn.disabled = true;
    btn.textContent = 'Ledger supplies the RO# — use "Download report"';
  } else {
    var ready = chosen.filter(function (m) { return importRo(m.imp); }).length;
    btn.disabled = !ready;
    btn.textContent = 'Write ' + ready + ' RO#' + (ready === 1 ? '' : 's') + ' to the ledger';
  }

  $('#writeBlurb').textContent = state.direction === 'write'
    ? 'Each selected appointment stamps its RO# into column "' +
      (state.headers[state.roColIndex - 1] || '?') + '" of tab "' + state.tab + '".'
    : 'Nothing is written to the sheet in this mode — the RO# is read out of the ledger instead.';

  $('#writeSummary').innerHTML = '';
  [
    ['Selected', chosen.length, ''],
    ['High confidence', state.matches.filter(function (m) { return m.band === 'high'; }).length, 's-ok'],
    ['Held back', conflicts, 's-skip'],
    ['Unmatched', state.matches.filter(function (m) { return m.band === 'none'; }).length, 's-bad']
  ].forEach(function (s) {
    $('#writeSummary').appendChild(
      el('div', { class: s[2] }, [el('b', {}, [String(s[1])]), el('span', {}, [s[0]])])
    );
  });
}

/* -------------------------------------------------------- the write */

async function doWrite() {
  var chosen = state.matches.filter(function (m) { return m.selected && importRo(m.imp); });
  if (!chosen.length) return;

  var btn = $('#btnWrite'), st = $('#writeStatus');
  btn.disabled = true;
  setStatus(st, 'Writing ' + chosen.length + ' RO#s…', 'busy');

  try {
    var res = await writeLedger({
      tab: state.tab,
      roCol: state.roColIndex,
      overwrite: $('#allowOverwrite').checked,
      updates: chosen.map(function (m) {
        return { row: m.ledger._row, value: importRo(m.imp) };
      })
    });
    if (!res.ok) throw new Error(res.error || 'The script refused the batch.');

    state.results = res;
    renderResults(res, chosen);
    setStatus(st, res.written + ' written.', 'ok');
    toast('Wrote ' + res.written + ' of ' + res.attempted + ' RO#s to "' + res.tab + '".', 'ok');
    setStep(4);

    // Refresh the in-memory ledger so a second pass sees what we just wrote.
    chosen.forEach(function (m) { m.existingRo = importRo(m.imp); });
    renderLedgerTable();
  } catch (err) {
    setStatus(st, err.message, 'err');
    toast('Write failed: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderResults(res, chosen) {
  var byRow = {};
  chosen.forEach(function (m) { byRow[m.ledger._row] = m; });

  var thead = $('#resultTable thead'), tbody = $('#resultTable tbody');
  thead.innerHTML = '';
  thead.appendChild(el('tr', {}, [
    el('th', {}, ['Sheet row']), el('th', {}, ['Customer']),
    el('th', {}, ['RO#']), el('th', {}, ['Outcome'])
  ]));
  tbody.innerHTML = '';

  var ICON = {
    written:        ['✓', 'tag high'],
    unchanged:      ['—', 'tag low'],
    skipped:        ['—', 'tag low'],
    conflict:       ['!', 'tag med'],
    'error':        ['✗', 'tag none']
  };

  res.results.forEach(function (r) {
    var m = byRow[r.row];
    var ic = ICON[r.status] || ['?', 'tag low'];
    var tr = el('tr', {}, [
      el('td', { class: 'rownum' }, [String(r.row)]),
      el('td', {}, [m ? ledgerName(m.ledger) : '']),
      el('td', { html: r.after ? '<span class="ro">' + esc(r.after) + '</span>' : '<span class="ro-empty">—</span>' }),
      el('td', {}, [
        el('span', { class: ic[1] }, [ic[0] + ' ' + r.status]),
        el('span', { class: 'sub' }, [r.message || (r.before ? 'was ' + r.before : '')])
      ])
    ]);
    tbody.appendChild(tr);
  });

  $('#writeResultMeta').textContent =
    res.written + ' written · ' + res.attempted + ' attempted · tab "' + res.tab + '"';
  $('#writeResults').hidden = false;
}

/* --------------------------------------------------------- exporting */

function download(name, text) {
  var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  var a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
function csvCell(v) {
  var s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportReport() {
  if (!state.matches.length) { toast('Nothing to export yet — run a match first.', 'warn'); return; }

  var cols = ['Import Row', 'Customer', 'Phone', 'Date', 'RO#']
    .concat(['Ledger Row', 'Ledger Customer', 'Ledger Date', 'Ledger RO# Before', 'Confidence', 'Why', 'Outcome']);

  var lines = [cols.map(csvCell).join(',')];
  state.matches.forEach(function (m) {
    var outcome = !m.ledger ? 'no match'
      : m.conflict ? 'conflict — held back'
      : m.selected ? 'selected'
      : 'not selected';
    lines.push([
      m.imp._row, importName(m.imp), importCell(m.imp, 'phone'), fmtDate(importCell(m.imp, 'date')),
      importRo(m.imp),
      m.ledger ? m.ledger._row : '', m.ledger ? ledgerName(m.ledger) : '',
      m.ledger ? fmtDate(ledgerCell(m.ledger, 'date')) : '', m.existingRo,
      m.band, m.why, outcome
    ].map(csvCell).join(','));
  });

  download('ro-ledger-report-' + new Date().toISOString().slice(0, 10) + '.csv', lines.join('\n'));
  toast('Report downloaded.', 'ok');
}

/* ------------------------------------------------------------ wiring */

function clearFile() {
  state.importRows = []; state.importHeaders = []; state.importName = '';
  state.matches = [];
  $('#dropIdle').hidden = false; $('#dropLoaded').hidden = true;
  $('#importMap').hidden = true; $('#fileInput').value = '';
  $('#panel-review').hidden = true; $('#panel-write').hidden = true;
  setStep(2);
}

function init() {
  loadStored();
  $('#endpoint').value = state.endpoint || '';
  $('#secret').value = state.secret || '';
  if (state.endpoint) $('#connText').textContent = 'Saved URL — connect to verify';

  // Direction toggle
  $$('#directionSeg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      state.direction = b.dataset.dir;
      $$('#directionSeg .seg-btn').forEach(function (x) {
        var on = x === b;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-checked', String(on));
      });
      save();
      if (state.matches.length) { renderMatches(); updateTally(); }
    });
  });
  if (state.direction === 'fetch') {
    $$('#directionSeg .seg-btn').forEach(function (x) {
      var on = x.dataset.dir === 'fetch';
      x.classList.toggle('is-on', on);
      x.setAttribute('aria-checked', String(on));
    });
  }

  $('#btnConnect').addEventListener('click', connect);
  $('#endpoint').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
  $('#secret').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });

  $('#tabSelect').addEventListener('change', async function () {
    state.tab = this.value; save();
    try {
      var data = await call('ping', { tab: state.tab });
      seedTabColumns(data);
      $('#sheetMeta').textContent = sheetMetaText(data);
    } catch (e) { toast('Could not read that tab: ' + e.message, 'err'); }
  });

  $('#btnLoadLedger').addEventListener('click', loadLedger);

  // File drop
  var zone = $('#dropZone');
  zone.addEventListener('click', function () { $('#fileInput').click(); });
  zone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
  });
  zone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  $('#fileInput').addEventListener('change', function () { handleFile(this.files[0]); });
  $('#btnClearFile').addEventListener('click', function (e) { e.stopPropagation(); clearFile(); });

  $('#btnMatch').addEventListener('click', function () {
    try { runMatch(); } catch (e) { /* status already shown */ }
  });

  $('#selHigh').addEventListener('change', function () { bulkSelect('high', this.checked); });
  $('#selMed').addEventListener('change', function () { bulkSelect('medium', this.checked); });
  $('#allowOverwrite').addEventListener('change', function () {
    var on = this.checked;
    state.matches.forEach(function (m) { if (m.conflict && m.ledger) m.selected = on && m.band !== 'none'; });
    renderMatches();
  });

  $('#btnWrite').addEventListener('click', doWrite);
  $('#btnExport').addEventListener('click', exportReport);

  $('#resetAll').addEventListener('click', function () {
    if (!confirm('Forget the saved URL, secret and column mappings on this computer?')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    location.reload();
  });

  if (state.endpoint) connect();
  setStep(1);
}

function bulkSelect(band, on) {
  state.matches.forEach(function (m) {
    if (m.band === band && m.ledger && !m.conflict) m.selected = on;
  });
  renderMatches();
}

document.addEventListener('DOMContentLoaded', init);
})();
