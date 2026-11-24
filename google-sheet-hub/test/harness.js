// Test harness (see run.sh). End-to-end: real .gs code, fake Google Sheet, real Postgres (sheet_sync_* via psql).
const fs = require('fs');
const vm = require('vm');
const { execFileSync } = require('child_process');

const PSQL = ['-h', process.env.PGTEST_HOST || '/tmp/pgt', '-p', process.env.PGTEST_PORT || '5499', '-U', 'postgres', '-d', process.env.PGTEST_DB || 't', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'];
function sql(q) { return execFileSync('psql', PSQL.concat(['-c', q]), { encoding: 'utf8' }).trim(); }

// ── fake sheet ─────────────────────────────────────────────────────────
class Sheet {
  constructor(name) { this.name = name; this.grid = []; this.maxRows = 1000; this.maxCols = 26; this.notes = {}; this.bg = {}; }
  cell(r, c) { return (this.grid[r - 1] || [])[c - 1]; }
  set(r, c, v) { while (this.grid.length < r) this.grid.push([]); const row = this.grid[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; if (r > this.maxRows) this.maxRows = r; if (c > this.maxCols) this.maxCols = c; }
  getName() { return this.name; }
  getIndex() { return 1; }
  getLastRow() { for (let r = this.grid.length; r >= 1; r--) if ((this.grid[r - 1] || []).some(v => v !== '' && v !== undefined)) return r; return 0; }
  getLastColumn() { let m = 0; this.grid.forEach(row => row.forEach((v, i) => { if (v !== '' && v !== undefined) m = Math.max(m, i + 1); })); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(r, n) { while (this.grid.length < r) this.grid.push([]); const rows = Array.from({ length: n }, () => []); this.grid.splice(r, 0, ...rows); this.maxRows += n; }
  insertColumnsAfter(c, n) { this.maxCols += n; }
  deleteRow(r) { this.grid.splice(r - 1, 1); this.maxRows--; }
  clear() { this.grid = []; }
  clearNotes() { this.notes = {}; }
  setFrozenRows() {} setColumnWidth() {}
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  dump() { return this.grid.map((row, i) => (i + 1) + ': ' + row.map(v => v === undefined ? '' : v).join(' | ')).join('\n'); }
}
class Range {
  constructor(s, r, c, nr, nc) { if (r < 1 || c < 1) throw new Error('bad range ' + r + ',' + c); Object.assign(this, { s, r, c, nr, nc }); }
  getSheet() { return this.s; } getRow() { return this.r; } getColumn() { return this.c; } getNumRows() { return this.nr; } getNumColumns() { return this.nc; }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = this.s.cell(this.r + i, this.c + j); row.push(v === undefined ? '' : v); } out.push(row); } return out; }
  getValue() { return this.getValues()[0][0]; }
  setValues(m) { if (m.length !== this.nr || m.some(r => r.length !== this.nc)) throw new Error('setValues size mismatch'); m.forEach((row, i) => row.forEach((v, j) => this.s.set(this.r + i, this.c + j, v))); return this; }
  setValue(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.s.set(this.r + i, this.c + j, v); return this; }
  setNumberFormats(m) { if (m.length !== this.nr || m.some(r => r.length !== this.nc)) throw new Error('setNumberFormats size mismatch'); return this; }
  insertCheckboxes() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) { const v = this.s.cell(this.r + i, this.c + j); if (v === '' || v === undefined) this.s.set(this.r + i, this.c + j, false); } return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.s.cell(this.r + i, this.c + j) !== undefined) this.s.set(this.r + i, this.c + j, ''); return this; }
  clearFormat() { return this; }
  setNote(n) { this.s.notes[this.r + ',' + this.c] = n; return this; }
  clearNote() { return this; }
  setBackground(b) { this.s.bg[this.r + ',' + this.c] = b; return this; }
}
['setFontWeight', 'setFontColor', 'setFontStyle', 'setFontSize', 'setWrapStrategy', 'clearDataValidations', 'setNumberFormat'].forEach(m => { Range.prototype[m] = function () { return this; }; });

const sheets = {};
const ss = {
  getSheetByName: n => sheets[n] || null,
  insertSheet: n => (sheets[n] = new Sheet(n)),
  getNumSheets: () => Object.keys(sheets).length,
  toast: (m) => { toasts.push(m); },
  getSpreadsheetTimeZone: () => 'UTC',
  setActiveSheet() {}, moveActiveSheet() {},
};
const toasts = [];
const props = {};
const cache = {};
const ctx = {
  console,
  SpreadsheetApp: { getActive: () => ss, getUi: () => ({}), WrapStrategy: { CLIP: 'CLIP' } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: k => { delete props[k]; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Session: { getScriptTimeZone: () => 'UTC' },
  Utilities: { formatDate: (d, tz, f) => f === 'HH:mm:ss' ? d.toISOString().slice(11, 19) : d.toISOString().slice(0, f.length > 10 ? 16 : 10) },
  UrlFetchApp: {
    fetch(url, req) {
      const m = url.match(/\/rest\/v1\/rpc\/(\w+)$/);
      if (!m) throw new Error('harness only supports rpc: ' + url);
      const args = JSON.parse(req.payload || '{}');
      const parts = Object.keys(args).map(k => {
        const v = args[k];
        let lit;
        if (v === null) lit = 'null';
        else if (k === 'p_skip_tables') lit = 'array[' + v.map(x => `'${x}'`).join(',') + ']::text[]';
        else if (typeof v === 'object') lit = `$j$${JSON.stringify(v)}$j$::jsonb`;
        else lit = `'${String(v).replace(/'/g, "''")}'`;
        return `${k} => ${lit}`;
      });
      fetches.push(m[1]);
      let out, code = 200;
      try { out = sql(`select coalesce(public.${m[1]}(${parts.join(', ')})::text, 'null')`); }
      catch (e) { code = 400; out = JSON.stringify({ message: String(e.stderr || e.message) }); }
      return { getResponseCode: () => code, getContentText: () => out, getHeaders: () => ({}) };
    },
  },
};
ctx.global = ctx;
vm.createContext(ctx);
const dir = require('path').join(__dirname, '..');
['Config.gs', 'Supabase.gs', 'Sync.gs', 'Menu.gs', 'Migrate.gs'].forEach(f => vm.runInContext(fs.readFileSync(dir + '/' + f, 'utf8'), ctx, { filename: f }));
// const declarations aren't on the context object; expose what tests need
const G = vm.runInContext('({ SITES, syncSite_, onEdit, readTab_, setSiteStatus_, syncAll })', ctx);
const fetches = [];
props.SUPABASE_URL = 'https://test.supabase.co';
props.SUPABASE_SERVICE_KEY = 'sb_secret_test';

module.exports = { G, sheets, sql, props, toasts, fetches, ctx };
