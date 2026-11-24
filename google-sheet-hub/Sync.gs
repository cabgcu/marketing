/**
 * Data Hub — the sync engine
 * ======================================================================
 * The Sheet is the database. Each sync run:
 *   1. INBOX -> SHEET: takes the saves the sites made (waiting in Supabase's
 *      inbox), writes them into the Sheet, then deletes them from the inbox.
 *   2. SHEET -> CACHE: sends the cells you edited in the Sheet to Supabase's
 *      cache so the sites see them.
 * If the same cell was changed in both places, the Sheet wins.
 *
 * Layout of a site tab (e.g. "Marketing App"):
 *   ■ tasks                                    <- section row, one per table
 *   delete | pending | id | title | due_date … <- header row
 *   [ ]    |         | t1 | Fall promo | …     <- one row per record
 *
 * - delete : tick it and the record is deleted everywhere on the next sync.
 * - pending: fills in by itself when you edit a row (which columns). Clears
 *            once the edit reached Supabase; turns red (with a note saying
 *            why) if Supabase rejected it.
 * - New row: insert a row inside a section, leave id blank.
 *
 * The hidden "🔒 Private" tab holds the same kind of sections for passwords,
 * keys and tokens (e.g. "■ marketing.users" = email + password), plus an
 * "overflow" section for values too long for one cell.
 */

const COL_DELETE = 1;
const COL_PENDING = 2;
const FIRST_DATA_COL = 3;
const NUM_FMT = '0.###############';
const SKIP_ = { skip: true };

// ── Value conversion ────────────────────────────────────────────────────

function isJsonType_(t) { return t === 'json' || t === 'jsonb'; }
function isArrayType_(t) { return /\[\]$/.test(t); }
function isNumType_(t) { return /^(smallint|integer|bigint|numeric|real|double precision)/.test(t); }
function isBoolType_(t) { return t === 'boolean'; }
function isTimeType_(t) { return /^(timestamp|date|time)/.test(t); }
function isPlainText_(t) { return !isJsonType_(t) && !isArrayType_(t) && !isNumType_(t) && !isBoolType_(t) && !isTimeType_(t); }

/** Supabase value -> cell value (may be longer than a cell allows) */
function toCellRaw_(v, type) {
  if (v === null || v === undefined) return '';
  if (isBoolType_(type)) return v === true || v === 'true';
  if (isNumType_(type)) return typeof v === 'number' ? v : Number(v);
  return (isJsonType_(type) || isArrayType_(type)) ? JSON.stringify(v) : String(v);
}

function cellFormat_(type) {
  return isNumType_(type) || isBoolType_(type) ? NUM_FMT : '@';
}

/** cell value -> Supabase value. overflowValue = the full text when the cell holds the overflow marker. */
function fromCell_(cell, col, pk, overflowValue) {
  const type = col.type;
  const name = col.name;
  if (cell === HUB.OVERFLOW_MARK) {
    if (overflowValue === undefined || overflowValue === null) return SKIP_;
    cell = overflowValue;
  }
  if (cell instanceof Date) cell = dateToText_(cell, type);
  if (cell === '' || cell === null || cell === undefined) {
    // A blank cell can mean '' or "no value". Follow the column: text columns
    // that default to something or are required mean ''; everything else
    // (optional references like monday_id / task_id, numbers, JSON) means
    // no value.
    if (isPlainText_(type) && name !== pk && (col.has_default || col.not_null)) return '';
    return null;
  }
  if (isBoolType_(type)) {
    if (cell === true || cell === false) return cell;
    const s = String(cell).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'x'].indexOf(s) >= 0) return true;
    if (['false', 'no', 'n', '0'].indexOf(s) >= 0) return false;
    throw new Error(name + ': expected TRUE or FALSE, got "' + cell + '"');
  }
  if (isNumType_(type)) {
    const n = Number(cell);
    if (isNaN(n)) throw new Error(name + ': expected a number, got "' + cell + '"');
    return n;
  }
  if (isJsonType_(type)) {
    try { return JSON.parse(String(cell)); } catch (e) { throw new Error(name + ': not valid JSON'); }
  }
  if (isArrayType_(type)) {
    const s = String(cell).trim();
    if (s.charAt(0) === '[') {
      try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch (e) { /* fall through */ }
      throw new Error(name + ': not a valid list — use ["a","b"] or a, b');
    }
    // Friendly entry: "Chris, Ann" -> ["Chris","Ann"]
    return s.split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
  }
  return String(cell);
}

function dateToText_(d, type) {
  if (/^timestamp/.test(type)) return d.toISOString();
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const hasTime = Utilities.formatDate(d, tz, 'HH:mm:ss') !== '00:00:00';
  return Utilities.formatDate(d, tz, hasTime ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd');
}

function cellKey_(v) {
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return '';
  return String(v);
}

function splitPending_(p) {
  return String(p || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}

// ── Where each table's columns live ─────────────────────────────────────

function orderedTables_(site, schema) {
  const all = Object.keys(schema).filter(function (t) { return schema[t].pk; });
  const listed = site.tables.concat(site.privateTables).filter(function (t) { return all.indexOf(t) >= 0; });
  const extra = all.filter(function (t) { return listed.indexOf(t) < 0; }).sort();
  return listed.concat(extra);
}

/** table -> [{ tab: 'main'|'priv', name: section name, cols: [column], subset }] */
function placements_(site, schema) {
  const by = {};
  orderedTables_(site, schema).forEach(function (t) {
    const ts = schema[t];
    if (site.privateTables.indexOf(t) >= 0) {
      by[t] = [{ tab: 'priv', name: site.schema + '.' + t, cols: ts.columns, subset: false }];
      return;
    }
    const pc = (site.privateColumns || {})[t] || [];
    by[t] = [{ tab: 'main', name: t, cols: ts.columns.filter(function (c) { return pc.indexOf(c.name) < 0; }), subset: false }];
    if (pc.length) {
      by[t].push({
        tab: 'priv', name: site.schema + '.' + t, subset: true,
        cols: ts.columns.filter(function (c) { return c.name === ts.pk || pc.indexOf(c.name) >= 0; }),
      });
    }
  });
  return by;
}

function colsByName_(cols) {
  const m = {};
  cols.forEach(function (c) { m[c.name] = c; });
  return m;
}

function newId_(site, table) {
  const prefix = (site.idPrefix && site.idPrefix[table]) || '';
  return prefix + Math.random().toString(36).substr(2, 9);
}

function ovRef_(site, table, col, pk) { return site.schema + '.' + table + '.' + col + '|' + pk; }

// ── Reading a tab ───────────────────────────────────────────────────────

function isMarker_(v) { return typeof v === 'string' && v.indexOf(HUB.SECTION_MARK) === 0; }

function readTab_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), FIRST_DATA_COL);
  const values = lastRow ? sheet.getRange(1, 1, lastRow, lastCol).getValues() : [];
  const sections = [];
  const byName = {};
  let cur = null;
  for (let i = 0; i < values.length; i++) {
    const a = values[i][0];
    if (isMarker_(a)) {
      const headerCells = (values[i + 1] || []).slice(FIRST_DATA_COL - 1);
      const header = [];
      for (let j = 0; j < headerCells.length; j++) {
        const h = String(headerCells[j] || '').trim();
        if (!h) break;                       // header ends at the first blank
        header.push(h);
      }
      cur = { name: a.slice(HUB.SECTION_MARK.length).trim(), markerRow: i + 1, headerRow: i + 2,
              header: header, rows: [], lastRow: i + 2, endRow: i + 2 };
      sections.push(cur);
      byName[cur.name] = cur;
      i++;
      continue;
    }
    if (!cur) continue;
    cur.endRow = i + 1;
    const row = values[i];
    const data = row.slice(FIRST_DATA_COL - 1, FIRST_DATA_COL - 1 + cur.header.length);
    while (data.length < cur.header.length) data.push('');
    const pending = String(row[COL_PENDING - 1] || '').trim();
    const del = row[COL_DELETE - 1] === true;
    const rest = row.slice(FIRST_DATA_COL - 1);
    const empty = !pending && !del && rest.every(function (v) { return v === '' || v === null; });
    if (empty) continue;
    cur.rows.push({ rowNum: i + 1, data: data, raw: row, pending: pending, del: del });
    cur.lastRow = i + 1;
  }
  return { sections: sections, byName: byName };
}

function rowIndex_(sec, pkName) {
  if (!sec._index || sec._indexPk !== pkName) {
    const i = sec.header.indexOf(pkName);
    sec._index = {};
    sec._indexPk = pkName;
    if (i >= 0) sec.rows.forEach(function (r) { sec._index[cellKey_(r.data[i]).trim()] = r; });
  }
  return sec._index;
}

// ── A working view of one site's tabs, with queued writes ───────────────

function ensureSiteTab_(site) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(site.tab);
  if (!sheet) {
    sheet = ss.insertSheet(site.tab, Math.min(SITES.indexOf(site) + 1, ss.getNumSheets()));
    sheet.getRange(1, 1, 2, 1).setValues([
      [site.name + ' — this tab is the database for this site'],
      ['Edit any cell and it reaches the site on the next sync. To delete a record tick "delete". To add one, insert a row ' +
       'inside a section and leave id blank. Don\'t change ids or the grey rows. Passwords and keys are in the hidden 🔒 Private tab.'],
    ]);
    sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
    sheet.getRange(2, 1).setFontColor('#5f6368');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensurePrivateTab_() {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(HUB.PRIVATE_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(HUB.PRIVATE_TAB, ss.getNumSheets());
    sheet.getRange(1, 1, 2, 1).setValues([
      ['🔒 Private — passwords, keys, tokens and over-long values for every site'],
      ['Hidden and locked to the Sheet\'s owner. Same rules as the site tabs. Records are added/removed from their site tab, not here.'],
    ]);
    sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
    sheet.getRange(2, 1).setFontColor('#5f6368');
    try {
      const prot = sheet.protect().setDescription('Data Hub private data — owner only');
      const me = Session.getEffectiveUser();
      prot.addEditor(me);
      prot.removeEditors(prot.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
      if (prot.canDomainEdit()) prot.setDomainEdit(false);
    } catch (e) { console.warn('Could not lock the private tab: ' + e); }
    sheet.hideSheet();
  }
  return sheet;
}

function newOps_() { return { updates: [], appends: {}, deletes: {}, newSections: {}, newOrder: [], clears: [], errors: [] }; }

function openWs_(site, schema, stats) {
  const ws = {
    site: site, schema: schema, pl: placements_(site, schema),
    stats: stats || { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, errors: 0 },
    tabs: {
      main: { sheet: ensureSiteTab_(site), ops: newOps_() },
      priv: { sheet: ensurePrivateTab_(), ops: newOps_() },
    },
    overflow: {}, ovDone: {},
  };
  ws.tabs.main.parsed = readTab_(ws.tabs.main.sheet);
  ws.tabs.priv.parsed = readTab_(ws.tabs.priv.sheet);
  const ov = ws.tabs.priv.parsed.byName[HUB.OVERFLOW_SECTION];
  if (ov) {
    ov.rows.forEach(function (r) {
      const ref = String(r.raw[FIRST_DATA_COL - 1] || '');
      const parts = r.raw.slice(FIRST_DATA_COL).map(function (v) { return v === undefined || v === null ? '' : String(v); });
      if (ref) ws.overflow[ref] = { rowNum: r.rowNum, value: parts.join('') };
    });
  }
  return ws;
}

function sectionFor_(ws, p) { return ws.tabs[p.tab].parsed.byName[p.name] || null; }

function queueAppend_(ws, tabKey, name, header, item) {
  const t = ws.tabs[tabKey];
  if (t.parsed.byName[name]) {
    (t.ops.appends[name] = t.ops.appends[name] || []).push(item);
  } else {
    if (!t.ops.newSections[name]) { t.ops.newSections[name] = { header: header, rows: [] }; t.ops.newOrder.push(name); }
    t.ops.newSections[name].rows.push(item);
  }
}

function queueDelete_(ws, tabKey, name, rowNum) {
  const t = ws.tabs[tabKey];
  (t.ops.deletes[name] = t.ops.deletes[name] || []).push(rowNum);
}

/** Cell for a value, routing over-long text to the overflow section. */
function cellFor_(ws, table, col, pk, v) {
  const raw = toCellRaw_(v, col.type);
  const ref = ovRef_(ws.site, table, col.name, pk);
  if (typeof raw === 'string' && raw.length > HUB.MAX_CELL_CHARS) {
    ovSet_(ws, ref, raw);
    return HUB.OVERFLOW_MARK;
  }
  ovDrop_(ws, ref);
  return raw;
}

function ovSet_(ws, ref, value) {
  if (ws.ovDone[ref] === value) return;
  ws.ovDone[ref] = value;
  const parts = [];
  for (let i = 0; i < value.length; i += HUB.CHUNK_CHARS) parts.push(value.slice(i, i + HUB.CHUNK_CHARS));
  const cells = [ref].concat(parts);
  const item = { cells: cells, formats: cells.map(function () { return '@'; }) };
  const cur = ws.overflow[ref];
  if (cur) {
    if (cur.value === value) return;
    // clear any old trailing chunks by padding to the old width
    const oldWidth = Math.ceil(cur.value.length / HUB.CHUNK_CHARS) + 1;
    while (item.cells.length < oldWidth) { item.cells.push(''); item.formats.push('@'); }
    ws.tabs.priv.ops.updates.push({ rowNum: cur.rowNum, cells: item.cells, formats: item.formats });
  } else {
    queueAppend_(ws, 'priv', HUB.OVERFLOW_SECTION, ['ref', 'value (continues to the right)'], item);
  }
  ws.overflow[ref] = { rowNum: cur ? cur.rowNum : null, value: value };
}

function ovDrop_(ws, ref) {
  const cur = ws.overflow[ref];
  if (!cur || ws.ovDone[ref] === null) return;
  ws.ovDone[ref] = null;
  if (cur.rowNum) queueDelete_(ws, 'priv', HUB.OVERFLOW_SECTION, cur.rowNum);
  delete ws.overflow[ref];
}

function ovValue_(ws, table, col, pk) {
  const o = ws.overflow[ovRef_(ws.site, table, col, pk)];
  return o ? o.value : undefined;
}

// ── Putting Supabase values into the Sheet ──────────────────────────────

/**
 * src: column -> value (a whole row if isFull, else just changed columns).
 * opts.origin = { tab, rowNum }: the Sheet row that produced this value
 * (push result) - written in full and its pending box cleared.
 * Columns the Sheet has pending edits for are left alone (the Sheet wins).
 */
function applyServer_(ws, table, pk, src, isFull, opts) {
  const ts = ws.schema[table];
  (ws.pl[table] || []).forEach(function (p) {
    const t = ws.tabs[p.tab];
    const sec = sectionFor_(ws, p);
    const cols = colsByName_(p.cols);
    const touches = Object.keys(src).some(function (k) { return cols[k] && k !== ts.pk; });
    if (!isFull && !touches) return;

    const origin = opts && opts.origin && opts.origin.tab === p.tab ? opts.origin : null;
    let row = null;
    if (sec && origin) row = sec.rows.filter(function (r) { return r.rowNum === origin.rowNum; })[0] || null;
    if (sec && !row) row = rowIndex_(sec, ts.pk)[pk] || null;

    if (row) {
      const isOrigin = !!(origin && origin.rowNum === row.rowNum);
      if (row.del && !isOrigin) { ws.stats.conflicts++; return; }
      const pend = isOrigin ? [] : splitPending_(row.pending);
      const cells = row.data.slice();
      const formats = sec.header.map(function (n) { return cols[n] ? cellFormat_(cols[n].type) : '@'; });
      let changed = false;
      sec.header.forEach(function (name, i) {
        const c = cols[name];
        if (!c || !src.hasOwnProperty(name)) return;
        if (pend.indexOf(name) >= 0) { ws.stats.conflicts++; return; }
        const cell = cellFor_(ws, table, c, pk, src[name]);
        if (cellKey_(cell) !== cellKey_(row.data[i])) { cells[i] = cell; changed = true; }
      });
      if (changed || isOrigin) {
        t.ops.updates.push({ rowNum: row.rowNum, cells: cells, formats: formats,
                             clearPending: isOrigin, expectPending: row.pending });
        row.data = cells;
      }
    } else if (isFull) {
      const header = sec ? sec.header : p.cols.map(function (c) { return c.name; });
      const cells = header.map(function (n) { return cols[n] ? cellFor_(ws, table, cols[n], pk, src[n]) : ''; });
      const formats = header.map(function (n) { return cols[n] ? cellFormat_(cols[n].type) : '@'; });
      queueAppend_(ws, p.tab, p.name, header, { cells: cells, formats: formats });
    }
  });
}

/** A record was deleted in a site. Kept if the Sheet is editing it (Sheet wins). */
function deleteServer_(ws, table, pk) {
  const ts = ws.schema[table];
  const hits = [];
  let editing = false;
  (ws.pl[table] || []).forEach(function (p) {
    const sec = sectionFor_(ws, p);
    const row = sec ? rowIndex_(sec, ts.pk)[pk] : null;
    if (!row) return;
    if (row.pending) editing = true;
    hits.push({ p: p, row: row });
  });
  if (editing) { ws.stats.conflicts++; return; }
  hits.forEach(function (h) { queueDelete_(ws, h.p.tab, h.p.name, h.row.rowNum); });
  ts.columns.forEach(function (c) { ovDrop_(ws, ovRef_(ws.site, table, c.name, pk)); });
  if (hits.length) ws.stats.deleted++;
}

// ── Writing queued changes to the Sheet ─────────────────────────────────

/** items: [{ rowNum, cells: [...], formats: [...] }] - cells start at FIRST_DATA_COL */
function writeRows_(sheet, items) {
  if (!items.length) return;
  items = items.slice().sort(function (a, b) { return a.rowNum - b.rowNum; });
  let block = [items[0]];
  const flush = function () {
    const width = Math.max.apply(null, block.map(function (b) { return b.cells.length; }));
    const pad = function (arr, fill) { const c = arr.slice(); while (c.length < width) c.push(fill); return c; };
    const range = sheet.getRange(block[0].rowNum, FIRST_DATA_COL, block.length, width);
    // formats first, so text like 2026-12-01 isn't turned into a date
    range.setNumberFormats(block.map(function (b) { return pad(b.formats, '@'); }));
    range.setValues(block.map(function (b) { return pad(b.cells, ''); }));
  };
  for (let i = 1; i < items.length; i++) {
    const prev = block[block.length - 1];
    if (items[i].rowNum === prev.rowNum + 1 && items[i].cells.length === prev.cells.length) block.push(items[i]);
    else { flush(); block = [items[i]]; }
  }
  flush();
}

function styleSectionRows_(sheet, markerRow, width) {
  sheet.getRange(markerRow, 1, 1, width).setFontWeight('bold').setFontColor('#ffffff').setBackground('#3c4043');
  sheet.getRange(markerRow + 1, 1, 1, width).setFontWeight('bold').setFontColor('#202124').setBackground('#e8eaed');
}

function styleDataRows_(sheet, firstRow, n) {
  if (n <= 0) return;
  sheet.getRange(firstRow, COL_DELETE, n, 1).insertCheckboxes();
  sheet.getRange(firstRow, COL_PENDING, n, 1).setFontColor('#b06000').setFontStyle('italic');
}

function appendSection_(sheet, name, header, rows) {
  const width = FIRST_DATA_COL - 1 + Math.max(header.length, 1);
  const start = Math.max(sheet.getLastRow(), 2) + 2;          // one blank spacer row
  const need = start + 1 + rows.length;
  if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
  const maxW = Math.max.apply(null, [width].concat(rows.map(function (r) { return FIRST_DATA_COL - 1 + r.cells.length; })));
  if (sheet.getMaxColumns() < maxW) sheet.insertColumnsAfter(sheet.getMaxColumns(), maxW - sheet.getMaxColumns());
  const marker = [HUB.SECTION_MARK + name];
  while (marker.length < width) marker.push('');
  sheet.getRange(start, 1, 2, width).setValues([marker, ['delete', 'pending'].concat(header)]);
  styleSectionRows_(sheet, start, width);
  if (rows.length) {
    writeRows_(sheet, rows.map(function (r, i) { return { rowNum: start + 2 + i, cells: r.cells, formats: r.formats }; }));
    styleDataRows_(sheet, start + 2, rows.length);
  }
}

function flush_(ws) {
  flushTab_(ws.tabs.main);
  flushTab_(ws.tabs.priv);
}

function flushTab_(t) {
  const sh = t.sheet;
  const o = t.ops;
  const hasStructure = Object.keys(o.appends).length || Object.keys(o.deletes).length || o.newOrder.length;
  if (!o.updates.length && !o.clears.length && !o.errors.length && !hasStructure) return;

  // A person may have kept typing while we talked to Supabase: if a row's
  // pending box changed since we read it, leave the row for the next sync.
  const last = sh.getLastRow();
  const pendNow = last ? sh.getRange(1, COL_PENDING, last, 1).getValues() : [];
  const same = function (rowNum, expect) {
    return expect === undefined || String((pendNow[rowNum - 1] || [''])[0] || '').trim() === (expect || '');
  };

  const ups = o.updates.filter(function (u) { return same(u.rowNum, u.expectPending); });
  writeRows_(sh, ups);
  ups.filter(function (u) { return u.clearPending; }).concat(o.clears.filter(function (c) { return same(c.rowNum, c.expectPending); }))
    .forEach(function (u) { sh.getRange(u.rowNum, COL_PENDING).setValue('').setNote('').setBackground(null); });
  o.errors.forEach(function (e) {
    sh.getRange(e.rowNum, COL_PENDING).setBackground('#f4c7c3').setNote('Not saved to Supabase: ' + e.msg);
  });

  // Inserts and deletes, bottom section first so row numbers above stay valid.
  t.parsed.sections.slice().sort(function (a, b) { return b.markerRow - a.markerRow; }).forEach(function (sec) {
    const adds = o.appends[sec.name] || [];
    if (adds.length) {
      sh.insertRowsAfter(sec.lastRow, adds.length);
      const first = sec.lastRow + 1;
      // inserted rows inherit formatting from the row above (maybe the grey header)
      sh.getRange(first, 1, adds.length, 2).clearDataValidations().clearContent().clearNote();
      sh.getRange(first, 1, adds.length, sh.getMaxColumns())
        .setBackground(null).setFontWeight('normal').setFontColor(null).setFontStyle('normal');
      const maxW = FIRST_DATA_COL - 1 + Math.max.apply(null, adds.map(function (a) { return a.cells.length; }));
      if (sh.getMaxColumns() < maxW) sh.insertColumnsAfter(sh.getMaxColumns(), maxW - sh.getMaxColumns());
      writeRows_(sh, adds.map(function (a, i) { return { rowNum: first + i, cells: a.cells, formats: a.formats }; }));
      styleDataRows_(sh, first, adds.length);
    }
    const dels = (o.deletes[sec.name] || []).filter(function (n, i, arr) { return arr.indexOf(n) === i; })
      .sort(function (a, b) { return b - a; });
    dels.forEach(function (n) { sh.deleteRow(n); });
  });

  o.newOrder.forEach(function (name) {
    const ns = o.newSections[name];
    appendSection_(sh, name, ns.header, ns.rows);
  });
}

// ── 1. Inbox -> Sheet ───────────────────────────────────────────────────

function drain_(conn, site, schema, stats) {
  const started = Date.now();
  while (Date.now() - started < HUB.DRAIN_BUDGET_MS) {
    const res = sbRpc_(conn, 'sheet_inbox_read', { p_schema: site.schema, p_limit: 2000 });
    const entries = res.entries || [];
    if (!entries.length) return schema;

    if (entries.some(function (e) { return !schema[e.table]; })) {
      schema = getSchema_(conn, site.schema, true);             // a table was added
    }
    const ws = openWs_(site, schema, stats);

    // Several saves to the same record collapse into one change.
    const states = {};
    const order = [];
    entries.forEach(function (e) {
      const k = e.table + '|' + e.pk;
      let s = states[k];
      if (!s) { s = states[k] = { table: e.table, pk: e.pk, deleted: false, full: null, changes: {} }; order.push(k); }
      if (e.op === 'I') { s.deleted = false; s.full = e.data; s.changes = {}; }
      else if (e.op === 'U') { if (s.full) Object.assign(s.full, e.data); else Object.assign(s.changes, e.data); }
      else { s.deleted = true; s.full = null; s.changes = {}; }
    });

    // An update to a record the Sheet doesn't have: fetch the whole record.
    const need = {};
    order.forEach(function (k) {
      const s = states[k];
      if (s.deleted || s.full || !schema[s.table]) return;
      const p0 = ws.pl[s.table][0];
      const sec = sectionFor_(ws, p0);
      if (!sec || !rowIndex_(sec, schema[s.table].pk)[s.pk]) (need[s.table] = need[s.table] || []).push(s.pk);
    });
    Object.keys(need).forEach(function (t) {
      (sbRpc_(conn, 'sheet_sync_rows', { p_schema: site.schema, p_table: t, p_pks: need[t] }) || []).forEach(function (r) {
        const s = states[t + '|' + cellKey_(r[schema[t].pk])];
        if (s) s.full = r;
      });
    });

    order.forEach(function (k) {
      const s = states[k];
      if (!schema[s.table]) return;
      if (s.deleted) deleteServer_(ws, s.table, s.pk);
      else { applyServer_(ws, s.table, s.pk, s.full || s.changes, !!s.full); stats.pulled++; }
    });
    flush_(ws);

    // Only now - it's in the Sheet - remove it from the inbox.
    sbRpc_(conn, 'sheet_inbox_ack', { p_schema: site.schema, p_upto: entries[entries.length - 1].id });
    if (res.remaining <= entries.length) return schema;
  }
  return schema;
}

// ── 2. Sheet -> cache ───────────────────────────────────────────────────

/** Row to send for one sheet row (only this placement's columns). null = nothing to send. */
function buildServerRow_(ws, table, p, header, data, pending, all) {
  const ts = ws.schema[table];
  const cols = colsByName_(p.cols);
  const pk = ts.pk;
  const pkIdx = header.indexOf(pk);
  const pkVal = pkIdx >= 0 ? cellKey_(data[pkIdx]).trim() : '';
  const row = {};
  const nonEmpty = [];
  header.forEach(function (name, i) {
    const c = cols[name];
    if (!c) return;
    const v = fromCell_(data[i], c, pk, pkVal ? ovValue_(ws, table, name, pkVal) : undefined);
    if (v === SKIP_) return;
    row[name] = v;
    if (data[i] !== '' && data[i] !== null) nonEmpty.push(name);
  });

  let edited;
  if (!pkVal || all || pending === '*') edited = nonEmpty;
  else edited = splitPending_(pending).filter(function (n) { return row.hasOwnProperty(n); });

  if (!pkVal) {
    if (!nonEmpty.length) return null;                           // an emptied-out new row
    if (/^(text|character varying)/.test((cols[pk] || {}).type || '')) {
      if (pk === 'email' || pk === 'user_name' || pk === 'key' || pk === 'token') {
        throw new Error(pk + ' is required for a new ' + table + ' record');
      }
      row[pk] = newId_(ws.site, table);
    } else {
      delete row[pk];                                            // numeric id: Supabase assigns it
    }
  }
  return { row: row, cols: edited, pk: pkVal };
}

function push_(conn, site, schema, stats) {
  const ws = openWs_(site, schema, stats);
  orderedTables_(site, schema).forEach(function (table) {
    const ts = schema[table];
    const upserts = [];
    const delPks = [];
    const origins = {};

    ws.pl[table].forEach(function (p) {
      const t = ws.tabs[p.tab];
      const sec = sectionFor_(ws, p);
      if (!sec) return;
      const pkIdx = sec.header.indexOf(ts.pk);
      sec.rows.forEach(function (r) {
        const pkVal = pkIdx >= 0 ? cellKey_(r.data[pkIdx]).trim() : '';
        if (r.del) {
          if (p.subset) { t.ops.errors.push({ rowNum: r.rowNum, msg: 'delete this record from its row in the "' + site.tab + '" tab' }); stats.errors++; return; }
          if (pkVal) delPks.push(pkVal);
          queueDelete_(ws, p.tab, p.name, r.rowNum);
          return;
        }
        if (!r.pending) return;
        try {
          if (p.subset && !pkVal) throw new Error('add new records in the "' + site.tab + '" tab');
          const built = buildServerRow_(ws, table, p, sec.header, r.data, r.pending, false);
          if (!built) { t.ops.clears.push({ rowNum: r.rowNum, expectPending: r.pending }); return; }
          const ref = p.tab + ':' + r.rowNum;
          origins[ref] = { tab: p.tab, rowNum: r.rowNum };
          upserts.push({ ref: ref, row: built.row, cols: built.cols });
        } catch (e) {
          t.ops.errors.push({ rowNum: r.rowNum, msg: e.message });
          stats.errors++;
        }
      });
    });
    if (!upserts.length && !delPks.length) return;

    const CHUNK = 300;
    for (let i = 0; i < Math.max(upserts.length, 1); i += CHUNK) {
      const res = sbRpc_(conn, 'sheet_sync_apply', {
        p_schema: site.schema, p_table: table, p_upserts: upserts.slice(i, i + CHUNK), p_deletes: i === 0 ? delPks : [],
      });
      (res.applied || []).forEach(function (a) {
        const o = origins[a.ref];
        applyServer_(ws, table, cellKey_(a.row[ts.pk]), a.row, true, { origin: o });
      });
      (res.errors || []).forEach(function (e) {
        const o = origins[e.ref];
        ws.tabs[o.tab].ops.errors.push({ rowNum: o.rowNum, msg: e.error });
        stats.errors++;
      });
      stats.pushed += (res.applied || []).length;
      stats.deleted += res.deleted || 0;
    }
    // A deleted record also leaves the Private tab and overflow.
    delPks.forEach(function (pk) {
      ws.pl[table].forEach(function (p) {
        if (!p.subset) return;
        const sec = sectionFor_(ws, p);
        const row = sec ? rowIndex_(sec, ts.pk)[pk] : null;
        if (row) queueDelete_(ws, p.tab, p.name, row.rowNum);
      });
      ts.columns.forEach(function (c) { ovDrop_(ws, ovRef_(site, table, c.name, pk)); });
    });
  });
  flush_(ws);
}

// ── Whole-site operations ───────────────────────────────────────────────

/** Every record of the site, as Supabase rows, read from the Sheet. */
function collectSiteData_(ws) {
  const out = { tables: {}, errors: [] };
  orderedTables_(ws.site, ws.schema).forEach(function (table) {
    const ts = ws.schema[table];
    const rows = [];
    const byPk = {};
    ws.pl[table].forEach(function (p) {
      const sec = sectionFor_(ws, p);
      if (!sec) return;
      sec.rows.forEach(function (r) {
        if (r.del) return;
        try {
          const built = buildServerRow_(ws, table, p, sec.header, r.data, '', true);
          if (!built || !built.pk) return;                         // not created yet
          if (!p.subset) {
            if (byPk[built.pk]) throw new Error('duplicate ' + ts.pk + ' "' + built.pk + '"');
            byPk[built.pk] = built.row;
            rows.push(built.row);
          } else if (byPk[built.pk]) {
            Object.assign(byPk[built.pk], built.row);
          }
        } catch (e) {
          out.errors.push(p.name + ' row ' + r.rowNum + ': ' + e.message);
        }
      });
    });
    out.tables[table] = rows;
  });
  return out;
}

/** Rewrites a site's tab (and its Private sections) from whole tables of rows. */
function writeSiteFromData_(site, schema, tables) {
  const main = ensureSiteTab_(site);
  const priv = ensurePrivateTab_();

  // clear this site's data, keep the title rows
  if (main.getLastRow() > 2) {
    main.getRange(3, 1, main.getMaxRows() - 2, main.getMaxColumns()).clearDataValidations();
    main.deleteRows(3, main.getLastRow() - 2);
  }
  const pt = readTab_(priv);
  const cut = [];
  pt.sections.forEach(function (sec) {
    if (sec.name.indexOf(site.schema + '.') === 0) cut.push([sec.markerRow, sec.endRow - sec.markerRow + 1]);
    if (sec.name === HUB.OVERFLOW_SECTION) {
      sec.rows.forEach(function (r) {
        if (String(r.raw[FIRST_DATA_COL - 1] || '').indexOf(site.schema + '.') === 0) cut.push([r.rowNum, 1]);
      });
    }
  });
  cut.sort(function (a, b) { return b[0] - a[0]; }).forEach(function (c) { priv.deleteRows(c[0], c[1]); });

  const ws = openWs_(site, schema);
  orderedTables_(site, schema).forEach(function (table) {
    const ts = schema[table];
    ws.pl[table].forEach(function (p) {
      const header = p.cols.map(function (c) { return c.name; });
      const t = ws.tabs[p.tab];
      if (!t.ops.newSections[p.name]) { t.ops.newSections[p.name] = { header: header, rows: [] }; t.ops.newOrder.push(p.name); }
    });
    (tables[table] || []).forEach(function (srv) { applyServer_(ws, table, cellKey_(srv[ts.pk]), srv, true); });
  });
  flush_(ws);
  [main, priv].forEach(function (sh) {
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sh.setColumnWidth(COL_DELETE, 60);
    sh.setColumnWidth(COL_PENDING, 90);
  });
}

/** Hub -> Rebuild Supabase from Sheet. Returns { table: rows }. */
function rebuildSupabaseFromSheet_(site) {
  const conn = newConn_();
  const schema = getSchema_(conn, site.schema, true);
  const stats = syncSite_(site, { schema: schema });              // take the inbox in first
  if (stats.errors) throw new Error(stats.errors + ' row(s) are red in the Sheet — fix those first.');
  return replaceCacheFromSheet_(conn, site, schema);
}

function replaceCacheFromSheet_(conn, site, schema) {
  const ws = openWs_(site, schema);
  const data = collectSiteData_(ws);
  if (data.errors.length) throw new Error('Can\'t read these rows: ' + data.errors.slice(0, 5).join('; '));
  const counts = sbRpc_(conn, 'sheet_sync_replace', {
    p_schema: site.schema, p_tables: data.tables, p_order: orderedTables_(site, schema),
  });
  Object.keys(data.tables).forEach(function (t) {
    if ((counts[t] || 0) !== data.tables[t].length) {
      throw new Error('Supabase has ' + counts[t] + ' ' + t + ' rows but the Sheet has ' + data.tables[t].length);
    }
  });
  return counts;
}

/** Hub -> Restore Sheet from Supabase (emergency only). */
function restoreSheetFromSupabase_(site) {
  const conn = newConn_();
  const schema = getSchema_(conn, site.schema, true);
  const dump = sbRpc_(conn, 'sheet_sync_dump', { p_schema: site.schema });
  writeSiteFromData_(site, schema, dump.tables || {});
  // everything in the inbox is already in the dump
  sbRpc_(conn, 'sheet_inbox_ack', { p_schema: site.schema, p_upto: 9007199254740991 });
}

// ── Entry points ────────────────────────────────────────────────────────

function syncSite_(site, opts) {
  opts = opts || {};
  const conn = newConn_();
  const stats = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, errors: 0 };
  let schema = opts.schema || getSchema_(conn, site.schema, !!opts.refreshSchema);
  schema = drain_(conn, site, schema, stats);
  push_(conn, site, schema, stats);
  return stats;
}

/** Runs every few minutes (Hub -> Auto-sync) and from Hub -> Sync now. */
function syncAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;                // a sync is already running
  try {
    SITES.forEach(function (site) {
      if (!isSiteEnabled_(site)) return;
      const started = new Date();
      try {
        setSiteStatus_(site, started, 'OK', syncSite_(site));
      } catch (e) {
        console.error(site.key + ': ' + (e.stack || e));
        setSiteStatus_(site, started, 'ERROR: ' + e.message, null);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ── Marking edits (simple trigger - runs on every edit by a person) ─────

function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const name = sheet.getName();
  if (!siteByTab_(name) && name !== HUB.PRIVATE_TAB) return;

  const r0 = e.range.getRow();
  const nr = e.range.getNumRows();
  const c0 = e.range.getColumn();
  const cLast = c0 + e.range.getNumColumns() - 1;
  if (cLast < FIRST_DATA_COL) return;                    // only delete/pending touched

  const colA = sheet.getRange(1, 1, r0 + nr - 1, 1).getValues();
  let marker = 0;
  for (let i = 0; i < r0 - 1; i++) if (isMarker_(colA[i][0])) marker = i + 1;
  const headers = {};
  const headerFor = function (m) {
    if (!headers[m]) headers[m] = sheet.getRange(m + 1, 1, 1, Math.max(sheet.getLastColumn(), FIRST_DATA_COL)).getValues()[0];
    return headers[m];
  };

  const pendRange = sheet.getRange(r0, COL_PENDING, nr, 1);
  const pend = pendRange.getValues();
  let changed = false;
  let warned = false;
  for (let k = 0; k < nr; k++) {
    const row = r0 + k;
    if (isMarker_(colA[row - 1][0])) { marker = row; continue; }
    if (!marker || row <= marker + 1) {
      if (!warned && marker && row === marker + 1) {
        SpreadsheetApp.getActive().toast('Header rows hold the column names the sync uses — renaming one disconnects that column.', 'Data Hub');
        warned = true;
      }
      continue;
    }
    if (String(colA[marker - 1][0]).slice(HUB.SECTION_MARK.length).trim() === HUB.OVERFLOW_SECTION) continue;
    const header = headerFor(marker);
    const names = [];
    for (let c = Math.max(c0, FIRST_DATA_COL); c <= cLast; c++) {
      const n = String(header[c - 1] || '').trim();
      if (n) names.push(n);
    }
    if (!names.length) continue;
    const existing = splitPending_(pend[k][0]);
    names.forEach(function (n) { if (existing.indexOf(n) < 0) existing.push(n); });
    pend[k][0] = existing.join(', ');
    changed = true;
    if (!warned && names.indexOf('id') >= 0 && e.oldValue) {
      SpreadsheetApp.getActive().toast('Changing an id makes a NEW record. To remove the old one, tick "delete" on it.', 'Data Hub');
      warned = true;
    }
  }
  if (changed) pendRange.setValues(pend);
}
