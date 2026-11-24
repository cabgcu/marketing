/**
 * Data Hub — copy the old marketing Supabase project into the new one
 * ======================================================================
 * Hub -> Migrate from old marketing project…
 *
 * Reads every table from the OLD project (public schema) and writes it into
 * the NEW project's `marketing` schema, table by table, then compares row
 * counts and rebuilds the Marketing App tab from the result.
 *
 * - It never writes to the old project.
 * - Columns the new tables don't have are reported, not silently lost.
 * - Apps Script stops a run after 6 minutes. If there's more to copy, the
 *   run stops cleanly and tells you; run it again and it continues where it
 *   left off.
 * - Safe to run again. For the FINAL run at cutover, choose "fresh copy" so
 *   anything deleted in the old project since the last run is gone in the
 *   new one too.
 */

const MIGRATION_PAGE = 1000;           // PostgREST's default max rows per read
const MIGRATION_TIME_LIMIT_MS = 4.5 * 60 * 1000;

function migrateMarketingMenu() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  newConn_();                                            // must be connected first

  const inProgress = props.getProperty('MIGRATION_PROGRESS');
  if (!inProgress) {
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
    const fresh = ui.alert('Fresh copy?',
      'YES = empty the NEW project\'s marketing tables first, then copy everything (recommended, and required for the final run at cutover).\n\n' +
      'NO = copy on top of what\'s already there.',
      ui.ButtonSet.YES_NO_CANCEL);
    if (fresh === ui.Button.CANCEL) return;
    props.setProperty('MIGRATION_PROGRESS', JSON.stringify({ i: 0, offset: 0, fresh: fresh === ui.Button.YES, wiped: false, report: {} }));
  } else {
    ss_().toast('Continuing the migration where it stopped…', 'Data Hub', 5);
  }

  // Hold the sync lock so an auto-sync can't run in the middle of the copy.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(60 * 1000)) { ui.alert('A sync is running — try again in a minute.'); return; }
  let result;
  try {
    result = runMarketingMigration_();
  } finally {
    lock.releaseLock();
  }
  if (!result.done) {
    ui.alert('Migration paused (Google limits a run to 6 minutes). Run Hub → Migrate again to continue — nothing is lost or duplicated.');
    return;
  }
  const bad = result.report.filter(function (r) { return r.status !== 'OK'; });
  ui.alert(bad.length
    ? 'Migration finished, but ' + bad.length + ' table(s) need a look — see the report on the Control Panel tab.'
    : 'Migration finished: every table\'s row count matches. The Marketing App tab has been rebuilt from the new project.');
}

function ss_() { return SpreadsheetApp.getActive(); }

function runMarketingMigration_() {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  const progress = JSON.parse(props.getProperty('MIGRATION_PROGRESS') || '{"i":0,"offset":0,"report":{}}');
  const oldC = oldConn_();
  const newC = newConn_();
  const target = getSchema_(newC, 'marketing', true);
  const save = function () { props.setProperty('MIGRATION_PROGRESS', JSON.stringify(progress)); };

  if (progress.fresh && !progress.wiped) {
    MARKETING_MIGRATION_TABLES.slice().reverse().forEach(function (t) {
      const ts = target[t];
      if (!ts) return;
      sbRequest_(newC, '/rest/v1/' + t + '?' + ts.pk + '=not.is.null', {
        method: 'delete', profile: 'marketing', prefer: 'return=minimal',
      });
    });
    progress.wiped = true;
    save();
  }

  for (; progress.i < MARKETING_MIGRATION_TABLES.length; progress.i++, progress.offset = 0) {
    const t = MARKETING_MIGRATION_TABLES[progress.i];
    const ts = target[t];
    const rep = progress.report[t] = progress.report[t] || { copied: 0, dropped: [] };
    if (!ts) { rep.note = 'table missing in the NEW project — run 02_marketing_schema.sql'; continue; }
    const keep = ts.columns.map(function (c) { return c.name; }).filter(function (n) { return n !== 'updated_at'; });

    while (true) {
      if (Date.now() - started > MIGRATION_TIME_LIMIT_MS) { save(); return { done: false }; }
      let rows;
      try {
        rows = sbRequest_(oldC, '/rest/v1/' + t + '?select=*&order=' + ts.pk + '.asc&limit=' + MIGRATION_PAGE + '&offset=' + progress.offset, { profile: 'public' });
      } catch (e) {
        if (e.status === 404 || /PGRST205|does not exist|Could not find/i.test(String(e.body || e.message))) {
          rep.note = 'not in the old project (nothing to copy)';
          break;
        }
        throw e;
      }
      if (!rows.length) break;
      Object.keys(rows[0]).forEach(function (k) {
        if (keep.indexOf(k) < 0 && k !== 'updated_at' && rep.dropped.indexOf(k) < 0) rep.dropped.push(k);
      });
      const clean = rows.map(function (r) {
        const o = {};
        keep.forEach(function (k) { if (r.hasOwnProperty(k)) o[k] = r[k]; });
        return o;
      });
      postInBatches_(newC, t, ts.pk, clean);
      rep.copied += rows.length;
      progress.offset += rows.length;
      save();
      if (rows.length < MIGRATION_PAGE) break;
    }
  }

  sbRpc_(newC, 'sheet_sync_fix_sequences', { p_schema: 'marketing' });

  // Verify
  const report = MARKETING_MIGRATION_TABLES.map(function (t) {
    const rep = progress.report[t] || {};
    let oldCount = null;
    let newCount = null;
    try { oldCount = sbCount_(oldC, 'public', t); } catch (e) { oldCount = null; }
    try { newCount = target[t] ? sbCount_(newC, 'marketing', t) : null; } catch (e) { newCount = null; }
    let status = 'OK';
    if (rep.note && oldCount === null) status = 'OK';
    else if (oldCount !== newCount) status = 'COUNT MISMATCH';
    if (rep.dropped && rep.dropped.length) status = (status === 'OK' ? '' : status + '; ') + 'columns not copied: ' + rep.dropped.join(', ');
    return { table: t, old: oldCount, new: newCount, status: status || 'OK', note: rep.note || '' };
  });
  writeMigrationReport_(report);
  props.deleteProperty('MIGRATION_PROGRESS');

  // Fresh Sheet copy of the migrated data
  const site = siteByKey_('marketing');
  props.deleteProperty(wmKey_(site));
  const r = rebuildTab_(newC, site, ensureSiteTab_(site));
  props.setProperty(wmKey_(site), r.serverNow);
  return { done: true, report: report };
}

function postInBatches_(conn, table, pk, rows) {
  const MAX_ROWS = 500;
  const MAX_CHARS = 4 * 1024 * 1024;
  let batch = [];
  let size = 0;
  const send = function () {
    if (!batch.length) return;
    sbRequest_(conn, '/rest/v1/' + table + '?on_conflict=' + pk, {
      method: 'post', profile: 'marketing', body: batch,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    batch = [];
    size = 0;
  };
  rows.forEach(function (r) {
    const len = JSON.stringify(r).length;
    if (batch.length && (batch.length >= MAX_ROWS || size + len > MAX_CHARS)) send();
    batch.push(r);
    size += len;
  });
  send();
}

function forgetOldMenu() {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty('OLD_SUPABASE_URL');
  p.deleteProperty('OLD_SUPABASE_SERVICE_KEY');
  p.deleteProperty('MIGRATION_PROGRESS');
  SpreadsheetApp.getUi().alert('Old project URL and key removed from this script.');
}
