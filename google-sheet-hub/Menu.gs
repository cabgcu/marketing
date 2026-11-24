/**
 * Data Hub — menu, Control Panel tab, auto-sync schedule
 */

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Hub')
    .addItem('Sync now', 'syncNowMenu')
    .addSeparator()
    .addItem('Connect to Supabase…', 'connectMenu')
    .addSubMenu(ui.createMenu('Auto-sync')
      .addItem('Every 1 minute', 'autoSync1')
      .addItem('Every 5 minutes (recommended)', 'autoSync5')
      .addItem('Every 15 minutes', 'autoSync15')
      .addItem('Off', 'autoSyncOff'))
    .addSeparator()
    .addItem('Rebuild Supabase from Sheet…', 'rebuildSupabaseMenu')
    .addItem('Restore Sheet from Supabase (emergency)…', 'restoreSheetMenu')
    .addSeparator()
    .addItem('Migrate from old marketing project…', 'migrateMarketingMenu')
    .addItem('Forget old project key', 'forgetOldMenu')
    .addToUi();
  ensureControlPanel_();
}

// ── Menu actions ────────────────────────────────────────────────────────

function syncNowMenu() {
  ss_().toast('Syncing…', 'Data Hub', 3);
  syncAll();
  ss_().toast('Done — see the Control Panel tab for details.', 'Data Hub', 5);
}

function connectMenu() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const u = ui.prompt('Connect to Supabase (NEW project)',
    'Project URL (https://xxxx.supabase.co)' + (props.getProperty('SUPABASE_URL') ? '\nNow: ' + props.getProperty('SUPABASE_URL') : ''),
    ui.ButtonSet.OK_CANCEL);
  if (u.getSelectedButton() !== ui.Button.OK) return;
  const url = normalizeUrl_(u.getResponseText());
  const k = ui.prompt('Connect to Supabase (NEW project)',
    'service_role / secret key (Supabase → Project Settings → API keys).\n' +
    'It is stored in this script\'s properties, never in a cell. Anyone with edit access to this Sheet can read it.',
    ui.ButtonSet.OK_CANCEL);
  if (k.getSelectedButton() !== ui.Button.OK) return;
  const conn = { url: url, key: k.getResponseText().trim() };

  let found;
  try {
    found = SITES.map(function (s) {
      return s.name + ': ' + Object.keys(getSchema_(conn, s.schema, true)).length + ' tables';
    });
  } catch (e) {
    ui.alert('Could not connect: ' + e.message + '\n\nCheck the URL/key, and that 01_sheet_sync_core.sql has been run.');
    return;
  }
  props.setProperty('SUPABASE_URL', url);
  props.setProperty('SUPABASE_SERVICE_KEY', conn.key);
  ensureControlPanel_();
  ui.alert('Connected.\n\n' + found.join('\n') +
    '\n\n(0 tables means that site\'s schema SQL hasn\'t been run yet, or the schema isn\'t in Project Settings → Data API → Exposed schemas.)');
}

function pickSite_(verb) {
  if (SITES.length === 1) return SITES[0];
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt(verb, 'Which tab? (' + SITES.map(function (s) { return s.tab; }).join(', ') + ')', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  const site = siteByTab_(r.getResponseText().trim());
  if (!site) ui.alert('No site uses a tab called "' + r.getResponseText() + '".');
  return site;
}

function rebuildSupabaseMenu() {
  const site = pickSite_('Rebuild Supabase from Sheet');
  if (!site) return;
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Rebuild the Supabase cache for "' + site.name + '"?',
    'Takes in any saves waiting in the inbox, then replaces everything in Supabase for this site with exactly ' +
    'what\'s in the Sheet, in one step. The site pauses for a few seconds while it runs.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  runSiteAction_(site, function () {
    const counts = rebuildSupabaseFromSheet_(site);
    return 'Rebuilt: ' + Object.keys(counts).map(function (t) { return t + ' ' + counts[t]; }).join(', ');
  });
}

function restoreSheetMenu() {
  const site = pickSite_('Restore Sheet from Supabase');
  if (!site) return;
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Overwrite the "' + site.tab + '" tab with Supabase\'s copy?',
    'EMERGENCY USE ONLY — e.g. the tab was damaged. The Sheet is the database: this replaces it with the cache. ' +
    'Unsynced edits in the tab are lost. Consider File → Make a copy first.', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  runSiteAction_(site, function () { restoreSheetFromSupabase_(site); return 'Sheet restored from Supabase'; });
}

function runSiteAction_(site, action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) { SpreadsheetApp.getUi().alert('A sync is running — try again in a minute.'); return; }
  const started = new Date();
  try {
    const msg = action();
    setSiteStatus_(site, started, 'OK — ' + msg, null);
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    setSiteStatus_(site, started, 'ERROR: ' + e.message, null);
    SpreadsheetApp.getUi().alert('Failed: ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

// ── Auto-sync schedule ──────────────────────────────────────────────────
// Free Google accounts get 90 minutes of script run time per day. A sync
// takes a few seconds, so every 5 minutes is comfortable; every minute can
// run out on busy days. (Google Workspace accounts get 6 hours.)

function autoSync1() { setAutoSync_(1); }
function autoSync5() { setAutoSync_(5); }
function autoSync15() { setAutoSync_(15); }
function autoSyncOff() { setAutoSync_(0); }

function setAutoSync_(minutes) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
  if (minutes) ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(minutes).create();
  PropertiesService.getScriptProperties().setProperty('AUTO_SYNC_MINUTES', String(minutes));
  ensureControlPanel_();
  ss_().toast(minutes ? 'Auto-sync every ' + minutes + ' min.' : 'Auto-sync off.', 'Data Hub', 5);
}

// ── Control Panel tab ───────────────────────────────────────────────────

const CP_HEADER_ROW = 4;
const CP_HEADER = ['Site', 'Tab', 'Supabase schema', 'Sync on', 'Last sync', 'Result',
  'Sheet → Supabase', 'Inbox → Sheet', 'Deleted', 'Sheet won', 'Errors'];

function ensureControlPanel_() {
  const ss = ss_();
  let sh = ss.getSheetByName(HUB.CONTROL_TAB);
  if (!sh) {
    sh = ss.insertSheet(HUB.CONTROL_TAB, 0);
  }
  if (sh.getIndex() !== 1) { ss.setActiveSheet(sh); ss.moveActiveSheet(1); }
  const props = PropertiesService.getScriptProperties();
  const mins = Number(props.getProperty('AUTO_SYNC_MINUTES') || 0);
  sh.getRange(1, 1).setValue('Data Hub — Control Panel').setFontSize(16).setFontWeight('bold');
  sh.getRange(2, 1).setValue(
    'Supabase: ' + (props.getProperty('SUPABASE_URL') || 'not connected (Hub → Connect to Supabase)') +
    '   ·   Auto-sync: ' + (mins ? 'every ' + mins + ' min' : 'off (Hub → Auto-sync)'));
  sh.getRange(2, 1).setFontColor('#5f6368');
  sh.getRange(CP_HEADER_ROW, 1, 1, CP_HEADER.length).setValues([CP_HEADER])
    .setFontWeight('bold').setBackground('#e8eaed');
  SITES.forEach(function (site) {
    if (siteRow_(sh, site)) return;
    let r = CP_HEADER_ROW + 1;
    while (sh.getRange(r, 2).getValue() !== '') r++;
    sh.getRange(r, 1, 1, 3).setValues([[site.name, site.tab, site.schema]]);
    sh.getRange(r, 4).insertCheckboxes().setValue(true);
  });
  sh.setFrozenRows(CP_HEADER_ROW);
  return sh;
}

function siteRow_(sh, site) {
  const n = Math.max(sh.getLastRow() - CP_HEADER_ROW, 0);
  if (!n) return 0;
  const tabs = sh.getRange(CP_HEADER_ROW + 1, 2, n, 1).getValues();
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i][0] === site.tab) return CP_HEADER_ROW + 1 + i;
  }
  return 0;
}

function isSiteEnabled_(site) {
  const sh = ensureControlPanel_();
  return sh.getRange(siteRow_(sh, site), 4).getValue() === true;
}

function setSiteStatus_(site, started, result, stats) {
  const sh = ensureControlPanel_();
  const r = siteRow_(sh, site);
  const vals = [started, String(result).slice(0, 500)];
  if (stats) vals.push(stats.pushed, stats.pulled, stats.deleted, stats.conflicts, stats.errors);
  sh.getRange(r, 5, 1, vals.length).setValues([vals]);
  sh.getRange(r, 6).setFontColor(/^ERROR/.test(result) ? '#c5221f' : '#188038');
}

function writeMigrationReport_(report) {
  const sh = ensureControlPanel_();
  const startRow = CP_HEADER_ROW + SITES.length + 3;
  sh.getRange(startRow, 1, sh.getMaxRows() - startRow + 1, 6).clearContent().clearFormat();
  sh.getRange(startRow, 1).setValue('Migration report — ' + new Date()).setFontWeight('bold');
  const dash = function (v) { return v === null || v === undefined ? '—' : v; };
  const rows = [['Table', 'Old project', 'Sheet', 'Supabase cache', 'Status', 'Note']].concat(report.map(function (r) {
    return [r.table, dash(r.old), dash(r.sheet), dash(r.cache), r.status, r.note];
  }));
  sh.getRange(startRow + 1, 1, rows.length, 6).setValues(rows);
  sh.getRange(startRow + 1, 1, 1, 6).setFontWeight('bold').setBackground('#e8eaed');
  report.forEach(function (r, i) {
    sh.getRange(startRow + 2 + i, 5).setFontColor(r.status === 'OK' ? '#188038' : '#c5221f');
  });
}
