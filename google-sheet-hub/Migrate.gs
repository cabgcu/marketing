/**
 * Data Hub — move the old marketing Supabase project into the Sheet
 * ======================================================================
 * Hub -> Migrate from old marketing project…
 *
 *   old project ──read──► Google Sheet (the database) ──rebuild──► new Supabase (cache)
 *
 * 1. Reads every table from the OLD project (it is never written to).
 * 2. Writes it all into the "Marketing App" tab and the 🔒 Private tab.
 * 3. Rebuilds the new project's cache from the Sheet - the same thing
 *    Hub -> Rebuild Supabase does - so the switch-over itself proves Supabase
 *    can be rebuilt from the Sheet with nothing lost.
 * 4. Compares row counts: old project vs Sheet vs new cache.
 *
 * Safe to run again: each run replaces the Marketing App tab and the cache
 * with a fresh copy of the old project. Don't run it after the switch-over,
 * when the Sheet holds newer data than the old project.
 */

const MIGRATION_PAGE = 1000;           // PostgREST's default max rows per read

function migrateMarketingMenu() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  newConn_();                                            // must be connected first

  if (!props.getProperty('OLD_SUPABASE_URL') || !props.getProperty('OLD_SUPABASE_SERVICE_KEY')) {
    const u = ui.prompt('Old marketing project', 'OLD project URL (https://xxxx.supabase.co):', ui.ButtonSet.OK_CANCEL);
    if (u.getSelectedButton() !== ui.Button.OK) return;
    const k = ui.prompt('Old marketing project',
      'OLD project service_role / secret key (Supabase → Project Settings → API keys). Stored in this script\'s ' +
      'properties only; Hub → Forget old project key removes it.', ui.ButtonSet.OK_CANCEL);
    if (k.getSelectedButton() !== ui.Button.OK) return;
    props.setProperty('OLD_SUPABASE_URL', normalizeUrl_(u.getResponseText()));
    props.setProperty('OLD_SUPABASE_SERVICE_KEY', k.getResponseText().trim());
  }
  if (props.getProperty('OLD_SUPABASE_URL') === props.getProperty('SUPABASE_URL')) {
    ui.alert('The old and new project URLs are the same. Use Hub → Forget old project key and try again.');
    return;
  }
  if (ui.alert('Copy the old marketing project into the Sheet?',
    'This REPLACES everything in the "Marketing App" tab, the marketing part of the 🔒 Private tab, and the new ' +
    'Supabase project\'s marketing cache with a fresh copy of the old project.\n\n' +
    'Fine before the switch-over. Don\'t do this after it.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60 * 1000)) { ui.alert('A sync is running — try again in a minute.'); return; }
  let report;
  try {
    report = runMarketingMigration_();
  } finally {
    lock.releaseLock();
  }
  const bad = report.filter(function (r) { return r.status !== 'OK'; });
  ui.alert(bad.length
    ? 'Migration finished, but ' + bad.length + ' table(s) need a look — see the report on the Control Panel tab.'
    : 'Migration finished. Every table matches: old project = Sheet = new Supabase cache.');
}

function ss_() { return SpreadsheetApp.getActive(); }

function runMarketingMigration_() {
  const site = siteByKey_('marketing');
  const oldC = oldConn_();
  const newC = newConn_();
  const schema = getSchema_(newC, site.schema, true);
  if (!Object.keys(schema).length) throw new Error('The new project has no "marketing" tables yet — run 02_marketing_schema.sql and expose the schema.');

  // 1. Read the old project
  const tables = {};
  const rep = {};
  MARKETING_MIGRATION_TABLES.forEach(function (t) {
    const ts = schema[t];
    rep[t] = { old: null, dropped: [], note: '' };
    if (!ts) { rep[t].note = 'table missing in the NEW project'; return; }
    const keep = ts.columns.map(function (c) { return c.name; });
    const rows = [];
    for (let offset = 0; ; offset += MIGRATION_PAGE) {
      let page;
      try {
        page = sbRequest_(oldC, '/rest/v1/' + t + '?select=*&order=' + ts.pk + '.asc&limit=' + MIGRATION_PAGE + '&offset=' + offset, { profile: 'public' });
      } catch (e) {
        if (e.status === 404 || /PGRST205|does not exist|Could not find/i.test(String(e.body || e.message))) {
          rep[t].note = 'not in the old project (nothing to copy)';
          break;
        }
        throw e;
      }
      page.forEach(function (r) {
        const o = {};
        Object.keys(r).forEach(function (k) {
          if (keep.indexOf(k) >= 0) o[k] = r[k];
          else if (rep[t].dropped.indexOf(k) < 0) rep[t].dropped.push(k);
        });
        rows.push(o);
      });
      if (page.length < MIGRATION_PAGE) break;
    }
    tables[t] = rows;
    if (!rep[t].note) rep[t].old = sbCount_(oldC, 'public', t);
  });

  // 2. Into the Sheet. Anything in the new project's inbox predates this copy.
  sbRpc_(newC, 'sheet_inbox_ack', { p_schema: site.schema, p_upto: 9007199254740991 });
  writeSiteFromData_(site, schema, tables);

  // 3. New cache from the Sheet
  const counts = replaceCacheFromSheet_(newC, site, schema);

  // 4. Compare: row counts, and every value of every row (old project vs the
  //    cache rebuilt from the Sheet), so nothing changed on the way through.
  const sheetData = collectSiteData_(openWs_(site, schema));
  const cache = (sbRpc_(newC, 'sheet_sync_dump', { p_schema: site.schema }) || {}).tables || {};
  const report = MARKETING_MIGRATION_TABLES.map(function (t) {
    const r = rep[t];
    const inSheet = sheetData.tables[t] ? sheetData.tables[t].length : null;
    const inCache = counts[t] === undefined ? null : counts[t];
    const problems = [];
    if (!(r.note && r.old === null && !(tables[t] || []).length) && (r.old !== inSheet || inSheet !== inCache)) {
      problems.push('row counts differ');
    }
    const diffs = schema[t] ? compareRows_(tables[t] || [], cache[t] || [], schema[t].pk) : [];
    if (diffs.length) problems.push(diffs.length + ' value(s) differ, e.g. ' + diffs[0]);
    if (r.dropped.length) problems.push('columns not copied: ' + r.dropped.join(', '));
    return { table: t, old: r.old, sheet: inSheet, cache: inCache, status: problems.join('; ') || 'OK', note: r.note };
  });
  writeMigrationReport_(report);
  return report;
}

/** Every value of every old row must come out of the cache unchanged. */
function compareRows_(oldRows, newRows, pk) {
  const byPk = {};
  newRows.forEach(function (r) { byPk[String(r[pk])] = r; });
  const canon = function (v) {
    return JSON.stringify(v, function (k, x) {
      return x && typeof x === 'object' && !Array.isArray(x)
        ? Object.keys(x).sort().reduce(function (o, key) { o[key] = x[key]; return o; }, {}) : x;
    });
  };
  const diffs = [];
  oldRows.forEach(function (o) {
    const n = byPk[String(o[pk])];
    if (!n) { diffs.push(pk + ' ' + o[pk] + ' missing'); return; }
    Object.keys(o).forEach(function (col) {
      if (canon(o[col]) !== canon(n[col])) {
        diffs.push(pk + ' ' + o[pk] + ' ' + col + ': ' + String(canon(o[col])).slice(0, 40) + ' → ' + String(canon(n[col])).slice(0, 40));
      }
    });
  });
  return diffs;
}

function forgetOldMenu() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('OLD_SUPABASE_URL');
  p.deleteProperty('OLD_SUPABASE_SERVICE_KEY');
  SpreadsheetApp.getUi().alert('Old project URL and key removed from this script.');
}
