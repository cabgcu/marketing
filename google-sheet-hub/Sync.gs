/**
 * Data Hub — the sync engine
 * ======================================================================
 * Layout of a site tab (e.g. "Marketing App"):
 *
 *   row 1   title
 *   row 2   how-to line
 *   ■ tasks                                    <- section row (one per table)
 *   delete | pending | id | title | due_date … <- header row
 *   [ ]    |         | t1 | Fall promo | …     <- data rows
 *   (blank)
 *   ■ comments
 *   …
 *
 * - "delete"  : tick it and the row is deleted everywhere on the next sync.
 * - "pending" : filled in automatically when you edit a row (which columns
 *               you changed). Those cells are pushed to Supabase on the next
 *               sync and the box clears. If Supabase rejects the edit, the
 *               box turns red and its note says why.
 * - Rows you add inside a section (leave id blank) are created on the next
 *   sync and get an id.
 * - Columns are matched by header name, so you can reorder them. Extra
 *   columns you add to the right of a section (after a blank column) are
 *   yours — the sync ignores them.
 *
 * Each sync: 1) push the Sheet's pending edits/deletes, 2) pull everything
 * that changed in Supabase since the last sync. If a row was changed in both
 * places, the Sheet's version wins.
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

/** Supabase value -> cell value */
function toCell_(v, type) {
  if (v === null || v === undefined) return '';
  if (isBoolType_(type)) return v === true || v === 'true';
  if (isNumType_(type)) return typeof v === 'number' ? v : Number(v);
  const out = (isJsonType_(type) || isArrayType_(type)) ? JSON.stringify(v) : String(v);
  if (out.length > HUB.MAX_CELL_CHARS) {
    return HUB.TOO_LARGE_PREFIX + ' — kept in Supabase only (' + out.length + ' characters)';
  }
  return out;
}

function cellFormat_(type) {
  return isNumType_(type) || isBoolType_(type) ? NUM_FMT : '@';
}

/** cell value -> Supabase value (throws with a readable message on bad input) */
function fromCell_(cell, col, pk) {
  const type = col.type;
  const name = col.name;
  if (typeof cell === 'string' && cell.indexOf(HUB.TOO_LARGE_PREFIX) === 0) return SKIP_;
  if (cell instanceof Date) cell = dateToText_(cell, type);
  if (cell === '' || cell === null || cell === undefined) {
    // Blank text stays '' (the app's default for text); blank anything else,
    // and blank ids / *_id references, become null.
    if (isPlainText_(type) && name !== pk && !/_id$/.test(name)) return '';
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

// ── Schema helpers ──────────────────────────────────────────────────────

function visibleColumns_(site, ts) {
  const skip = (site.skipColumns && site.skipColumns[ts.table]) || [];
  return ts.columns.filter(function (c) { return skip.indexOf(c.name) < 0; });
}

function orderedTables_(site, schema) {
  const all = Object.keys(schema).filter(function (t) {
    return site.skipTables.indexOf(t) < 0 && schema[t].pk;
  });
  const listed = site.tables.filter(function (t) { return all.indexOf(t) >= 0; });
  const extra = all.filter(function (t) { return listed.indexOf(t) < 0; }).sort();
  return listed.concat(extra);
}

function colIndex_(ts) {
  const m = {};
  ts.columns.forEach(function (c) { m[c.name] = c; });
  return m;
}

function newId_(site, table) {
  const prefix = (site.idPrefix && site.idPrefix[table]) || '';
  return prefix + Math.random().toString(36).substr(2, 9);
}

// ── Reading a site tab ──────────────────────────────────────────────────

function readTab_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), FIRST_DATA_COL);
  const values = lastRow ? sheet.getRange(1, 1, lastRow, lastCol).getValues() : [];
  const sections = [];
  const byTable = {};
  let cur = null;
  for (let i = 0; i < values.length; i++) {
    const a = values[i][0];
    if (typeof a === 'string' && a.indexOf(HUB.SECTION_MARK) === 0) {
      const headerCells = (values[i + 1] || []).slice(FIRST_DATA_COL - 1);
      const header = [];
      for (let j = 0; j < headerCells.length; j++) {
        const h = String(headerCells[j] || '').trim();
        if (!h) break;                       // header ends at the first blank
        header.push(h);
      }
      cur = {
        table: a.slice(HUB.SECTION_MARK.length).trim(),
        markerRow: i + 1, headerRow: i + 2, header: header, rows: [], lastRow: i + 2,
      };
      sections.push(cur);
      byTable[cur.table] = cur;
      i++;
      continue;
    }
    if (!cur) continue;
    const row = values[i];
    const data = row.slice(FIRST_DATA_COL - 1, FIRST_DATA_COL - 1 + cur.header.length);
    while (data.length < cur.header.length) data.push('');
    const pending = String(row[COL_PENDING - 1] || '').trim();
    const del = row[COL_DELETE - 1] === true;
    const empty = !pending && !del && data.every(function (v) { return v === '' || v === null; });
    if (empty) continue;
    cur.rows.push({ rowNum: i + 1, data: data, pending: pending, del: del });
    cur.lastRow = i + 1;
  }
  return { sections: sections, byTable: byTable, width: lastCol };
}

// ── Writing rows (grouped into contiguous blocks to keep it fast) ───────

/** items: [{ rowNum, cells: [...], formats: [...] }] - all cells start at FIRST_DATA_COL */
function writeRows_(sheet, items) {
  if (!items.length) return;
  items.sort(function (a, b) { return a.rowNum - b.rowNum; });
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
    if (items[i].rowNum === prev.rowNum + 1 && items[i].cells.length === prev.cells.length) {
      block.push(items[i]);
    } else {
      flush();
      block = [items[i]];
    }
  }
  flush();
}

function serverRowToCells_(header, cols, srv, existing) {
  const cells = [];
  const formats = [];
  header.forEach(function (name, i) {
    const c = cols[name];
    if (c) {
      cells.push(toCell_(srv[name], c.type));
      formats.push(cellFormat_(c.type));
    } else {
      cells.push(existing ? existing[i] : '');
      formats.push('@');
    }
  });
  return { cells: cells, formats: formats };
}

function styleSectionRows_(sheet, markerRow, width) {
  sheet.getRange(markerRow, 1, 1, width)
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#3c4043');
  sheet.getRange(markerRow + 1, 1, 1, width)
    .setFontWeight('bold').setFontColor('#202124').setBackground('#e8eaed');
}

function styleDataRows_(sheet, firstRow, n) {
  if (n <= 0) return;
  sheet.getRange(firstRow, COL_DELETE, n, 1).insertCheckboxes();
  sheet.getRange(firstRow, COL_PENDING, n, 1).setFontColor('#b06000').setFontStyle('italic');
}

// ── Push: Sheet -> Supabase ─────────────────────────────────────────────

/**
 * Builds the row to send for one sheet row.
 * forceAll: send every column (Hub -> Push whole tab).
 * Returns null when there's nothing to send (row was cleared).
 */
function buildServerRow_(site, table, ts, header, data, pending, forceAll) {
  const cols = colIndex_(ts);
  const pk = ts.pk;
  const pkIdx = header.indexOf(pk);
  const pkVal = pkIdx >= 0 ? cellKey_(data[pkIdx]).trim() : '';
  const row = {};
  const nonEmpty = [];
  header.forEach(function (name, i) {
    const c = cols[name];
    if (!c || name === 'updated_at') return;
    const v = fromCell_(data[i], c, pk);
    if (v === SKIP_) return;
    row[name] = v;
    if (data[i] !== '' && data[i] !== null) nonEmpty.push(name);
  });

  let edited;
  if (!pkVal || forceAll || pending === '*') {
    edited = nonEmpty;
  } else {
    edited = pending.split(',').map(function (s) { return s.trim(); })
      .filter(function (n) { return n && row.hasOwnProperty(n); });
  }

  if (!pkVal) {
    if (!nonEmpty.length) return null;          // an emptied-out new row
    if (/^(text|character varying)/.test((cols[pk] || {}).type || '')) {
      if (pk === 'email' || pk === 'user_name' || pk === 'key' || pk === 'token') {
        throw new Error(pk + ' is required for a new ' + table + ' row');
      }
      row[pk] = newId_(site, table);
    } else {
      delete row[pk];                            // numeric id: Supabase assigns it
    }
  }
  return { row: row, cols: edited };
}

function pushSite_(conn, site, schema, sheet, stats, forceAll) {
  const tab = readTab_(sheet);
  const writes = [];
  const errors = [];
  const clears = [];
  const deleteRows = [];
  const pendingSeen = {};

  orderedTables_(site, schema).forEach(function (table) {
    const sec = tab.byTable[table];
    const ts = schema[table];
    if (!sec || !ts) return;
    const cols = colIndex_(ts);
    const pkIdx = sec.header.indexOf(ts.pk);
    const upserts = [];
    const delPks = [];

    sec.rows.forEach(function (r) {
      pendingSeen[r.rowNum] = r.pending;
      const pkVal = pkIdx >= 0 ? cellKey_(r.data[pkIdx]).trim() : '';
      if (r.del) {
        if (pkVal) delPks.push(pkVal);
        deleteRows.push(r.rowNum);
        return;
      }
      if (!r.pending && !forceAll) return;
      try {
        const built = buildServerRow_(site, table, ts, sec.header, r.data, r.pending, forceAll);
        if (!built) { clears.push(r.rowNum); return; }
        upserts.push({ ref: r.rowNum, row: built.row, cols: built.cols });
      } catch (e) {
        errors.push({ rowNum: r.rowNum, msg: e.message });
      }
    });

    // Send in chunks so one request never gets too big.
    const CHUNK = 300;
    for (let i = 0; i < Math.max(upserts.length, delPks.length ? 1 : 0); i += CHUNK) {
      const part = upserts.slice(i, i + CHUNK);
      const res = sbRpc_(conn, 'sheet_sync_apply', {
        p_schema: site.schema, p_table: table, p_upserts: part, p_deletes: i === 0 ? delPks : [],
      });
      (res.applied || []).forEach(function (a) {
        const rowNum = a.ref;
        const existing = (sec.rows.filter(function (r) { return r.rowNum === rowNum; })[0] || {}).data;
        const out = serverRowToCells_(sec.header, cols, a.row || {}, existing);
        writes.push({ rowNum: rowNum, cells: out.cells, formats: out.formats });
      });
      (res.errors || []).forEach(function (e) { errors.push({ rowNum: e.ref, msg: e.error }); });
      stats.pushed += (res.applied || []).length;
      stats.deleted += res.deleted || 0;
    }
  });

  if (!writes.length && !errors.length && !clears.length && !deleteRows.length) return;

  // Someone may have kept typing while we were talking to Supabase: if a
  // row's pending box changed since we read it, leave that row alone - the
  // newer edit goes out next sync.
  const last = sheet.getLastRow();
  const pendNow = sheet.getRange(1, COL_PENDING, last, 1).getValues();
  const stillSame = function (rowNum) {
    return String(pendNow[rowNum - 1][0] || '').trim() === (pendingSeen[rowNum] || '');
  };

  writeRows_(sheet, writes.filter(function (w) { return stillSame(w.rowNum); }));
  writes.concat(clears.map(function (n) { return { rowNum: n }; })).forEach(function (w) {
    if (!stillSame(w.rowNum)) return;
    sheet.getRange(w.rowNum, COL_PENDING).setValue('').setNote('').setBackground(null);
  });
  errors.forEach(function (e) {
    stats.errors++;
    sheet.getRange(e.rowNum, COL_PENDING).setBackground('#f4c7c3').setNote('Not saved to Supabase: ' + e.msg);
  });
  deleteRows.sort(function (a, b) { return b - a; }).forEach(function (n) { sheet.deleteRow(n); });
}

// ── Pull: Supabase -> Sheet ─────────────────────────────────────────────

function pullSite_(conn, site, schema, sheet, sinceIso, stats) {
  const res = sbRpc_(conn, 'sheet_sync_changes', {
    p_schema: site.schema, p_since: sinceIso, p_skip_tables: site.skipTables,
  });
  const changedTables = Object.keys(res.tables || {});
  if (changedTables.some(function (t) { return !schema[t]; })) {
    schema = getSchema_(conn, site.schema, true);   // a table was added
  }
  const tab = readTab_(sheet);
  const updates = [];
  const appendsByTable = {};
  const deleteRowsByTable = {};
  const newSections = [];

  changedTables.forEach(function (table) {
    const ts = schema[table];
    if (!ts || !ts.pk || site.skipTables.indexOf(table) >= 0) return;
    const cols = colIndex_(ts);
    const sec = tab.byTable[table];
    const rows = res.tables[table];
    if (!sec) { newSections.push(table); return; }

    // New columns in Supabase -> add them to the end of the header.
    const missing = visibleColumns_(site, ts).map(function (c) { return c.name; })
      .filter(function (n) { return sec.header.indexOf(n) < 0; });
    if (missing.length) {
      sheet.getRange(sec.headerRow, FIRST_DATA_COL + sec.header.length, 1, missing.length).setValues([missing]);
      sec.rows.forEach(function (r) { missing.forEach(function () { r.data.push(''); }); });
      sec.header = sec.header.concat(missing);
      styleSectionRows_(sheet, sec.markerRow, FIRST_DATA_COL + sec.header.length - 1);
    }

    const pkIdx = sec.header.indexOf(ts.pk);
    const index = {};
    sec.rows.forEach(function (r) { if (pkIdx >= 0) index[cellKey_(r.data[pkIdx]).trim()] = r; });

    rows.forEach(function (srv) {
      const key = cellKey_(srv[ts.pk]);
      const existing = index[key];
      const out = serverRowToCells_(sec.header, cols, srv, existing && existing.data);
      if (existing) {
        if (existing.pending || existing.del) { stats.conflicts++; return; }   // Sheet wins
        const differs = out.cells.some(function (c, i) { return cellKey_(c) !== cellKey_(existing.data[i]); });
        if (differs) { updates.push({ rowNum: existing.rowNum, cells: out.cells, formats: out.formats }); stats.pulled++; }
      } else {
        (appendsByTable[table] = appendsByTable[table] || []).push(out);
        stats.pulled++;
      }
    });
  });

  // Deletions made in the apps
  (res.deleted || []).forEach(function (d) {
    const sec = tab.byTable[d.table];
    const ts = schema[d.table];
    if (!sec || !ts) return;
    const back = (res.tables[d.table] || []).some(function (r) {
      return cellKey_(r[ts.pk]) === d.pk && Date.parse(r.updated_at) >= Date.parse(d.deleted_at);
    });
    if (back) return;                                   // re-created since
    const pkIdx = sec.header.indexOf(ts.pk);
    sec.rows.forEach(function (r) {
      if (pkIdx < 0 || cellKey_(r.data[pkIdx]).trim() !== d.pk) return;
      if (r.pending) { stats.conflicts++; return; }     // Sheet wins: it'll be re-created
      (deleteRowsByTable[d.table] = deleteRowsByTable[d.table] || []).push(r.rowNum);
      stats.deleted++;
    });
  });

  // 1) in-place updates (no rows move)
  writeRows_(sheet, updates);

  // 2) inserts/deletes, bottom section first so row numbers above stay valid
  tab.sections.slice().sort(function (a, b) { return b.markerRow - a.markerRow; }).forEach(function (sec) {
    const adds = appendsByTable[sec.table] || [];
    if (adds.length) {
      sheet.insertRowsAfter(sec.lastRow, adds.length);
      const first = sec.lastRow + 1;
      // inserted rows inherit formatting from the row above (maybe the grey header)
      sheet.getRange(first, 1, adds.length, 2).clearDataValidations().clearContent().clearNote();
      sheet.getRange(first, 1, adds.length, sheet.getMaxColumns())
        .setBackground(null).setFontWeight('normal').setFontColor(null).setFontStyle('normal');
      writeRows_(sheet, adds.map(function (a, i) { return { rowNum: first + i, cells: a.cells, formats: a.formats }; }));
      styleDataRows_(sheet, first, adds.length);
    }
    (deleteRowsByTable[sec.table] || []).sort(function (a, b) { return b - a; })
      .forEach(function (n) { sheet.deleteRow(n); });
  });

  // 3) tables the tab doesn't have a section for yet go at the bottom
  newSections.forEach(function (table) {
    appendSection_(sheet, site, schema[table], res.tables[table]);
  });

  return res.server_now;
}

function appendSection_(sheet, site, ts, rows) {
  const header = visibleColumns_(site, ts).map(function (c) { return c.name; });
  const cols = colIndex_(ts);
  const width = FIRST_DATA_COL - 1 + header.length;
  const start = Math.max(sheet.getLastRow(), 2) + 2;   // one blank spacer row
  const need = start + 1 + rows.length;
  if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

  sheet.getRange(start, 1, 2, width).setValues([
    [HUB.SECTION_MARK + ts.table].concat(new Array(width - 1).fill('')),
    ['delete', 'pending'].concat(header),
  ]);
  styleSectionRows_(sheet, start, width);
  if (rows.length) {
    const items = rows.map(function (srv, i) {
      const out = serverRowToCells_(header, cols, srv, null);
      return { rowNum: start + 2 + i, cells: out.cells, formats: out.formats };
    });
    writeRows_(sheet, items);
    styleDataRows_(sheet, start + 2, rows.length);
  }
}

// ── Full rebuild of a site tab from Supabase ────────────────────────────

function rebuildTab_(conn, site, sheet) {
  const schema = getSchema_(conn, site.schema, true);
  const res = sbRpc_(conn, 'sheet_sync_changes', {
    p_schema: site.schema, p_since: null, p_skip_tables: site.skipTables,
  });

  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).clearDataValidations();
  sheet.clear();
  sheet.clearNotes();
  sheet.getRange(1, 1, 2, 1).setValues([
    [site.name + ' — synced with Supabase (schema "' + site.schema + '")'],
    ['Edit any cell and it syncs. To delete a row tick "delete". To add a row, insert one inside a section and leave id blank. ' +
     'Don\'t change ids or the grey rows. Passwords and API keys stay in Supabase only.'],
  ]);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.getRange(2, 1).setFontColor('#5f6368');
  sheet.setFrozenRows(1);

  let total = 0;
  orderedTables_(site, schema).forEach(function (table) {
    const rows = (res.tables || {})[table] || [];
    appendSection_(sheet, site, schema[table], rows);
    total += rows.length;
  });
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.setColumnWidth(COL_DELETE, 60);
  sheet.setColumnWidth(COL_PENDING, 90);
  return { serverNow: res.server_now, rows: total };
}

// ── Entry points ────────────────────────────────────────────────────────

function wmKey_(site) { return 'WATERMARK_' + site.key; }

function ensureSiteTab_(site) {
  const ss = SpreadsheetApp.getActive();
  let sheet = ss.getSheetByName(site.tab);
  if (!sheet) {
    const idx = SITES.indexOf(site) + 1;                 // after Control Panel
    sheet = ss.insertSheet(site.tab, Math.min(idx, ss.getNumSheets()));
  }
  return sheet;
}

function syncSite_(site, opts) {
  opts = opts || {};
  const conn = newConn_();
  const props = PropertiesService.getScriptProperties();
  const sheet = ensureSiteTab_(site);
  const stats = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, errors: 0 };
  let schema = getSchema_(conn, site.schema, !!opts.refreshSchema);
  const wm = props.getProperty(wmKey_(site));
  const hasSections = readTab_(sheet).sections.length > 0;

  if (hasSections) pushSite_(conn, site, schema, sheet, stats, !!opts.forceAll);

  let serverNow;
  if (!wm || !hasSections || opts.rebuild) {
    const r = rebuildTab_(conn, site, sheet);
    serverNow = r.serverNow;
    stats.pulled = r.rows;
  } else {
    const since = new Date(Date.parse(wm) - HUB.OVERLAP_SECONDS * 1000).toISOString();
    serverNow = pullSite_(conn, site, schema, sheet, since, stats);
  }
  props.setProperty(wmKey_(site), serverNow);

  // Housekeeping at most once an hour
  const lastPrune = Number(props.getProperty('LAST_PRUNE') || 0);
  if (Date.now() - lastPrune > 60 * 60 * 1000) {
    try { sbRpc_(conn, 'sheet_sync_prune', {}); } catch (e) { /* not important */ }
    props.setProperty('LAST_PRUNE', String(Date.now()));
  }
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
        const s = syncSite_(site);
        setSiteStatus_(site, started, 'OK', s);
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
  const site = siteByTab_(sheet.getName());
  if (!site) return;

  const r0 = e.range.getRow();
  const nr = e.range.getNumRows();
  const c0 = e.range.getColumn();
  const nc = e.range.getNumColumns();
  const cLast = c0 + nc - 1;
  if (cLast < FIRST_DATA_COL) return;                    // only delete/pending touched

  const colA = sheet.getRange(1, 1, r0 + nr - 1, 1).getValues();
  // nearest section row at or above each edited row
  let marker = 0;
  for (let i = 0; i < r0 - 1; i++) {
    const a = colA[i][0];
    if (typeof a === 'string' && a.indexOf(HUB.SECTION_MARK) === 0) marker = i + 1;
  }
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
    const a = colA[row - 1][0];
    if (typeof a === 'string' && a.indexOf(HUB.SECTION_MARK) === 0) { marker = row; continue; }
    if (!marker || row <= marker + 1) {
      if (!warned && marker && row === marker + 1) {
        SpreadsheetApp.getActive().toast('Header rows hold the column names the sync uses — renaming one disconnects that column.', 'Data Hub');
        warned = true;
      }
      continue;
    }
    const header = headerFor(marker);
    const names = [];
    for (let c = Math.max(c0, FIRST_DATA_COL); c <= cLast; c++) {
      const name = String(header[c - 1] || '').trim();
      if (name) names.push(name);
    }
    if (!names.length) continue;
    const existing = String(pend[k][0] || '').split(',').map(function (s) { return s.trim(); }).filter(String);
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
