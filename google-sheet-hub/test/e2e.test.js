// Data Hub end-to-end tests. Run with: bash google-sheet-hub/test/run.sh
// The real .gs code against a fake Google Sheet and two real Postgres
// databases ('old' = old marketing project, 't' = new project).
const assert = require('assert');
const { G, sheets, sql, sqlOld, fetches } = require('./harness');

const site = G.SITES[0];
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures++; console.log('FAIL', name, '\n   ', e.stack.split('\n').slice(0, 3).join('\n    ')); }
}
const sync = () => G.syncSite_(site);
const main = () => sheets['Marketing App'];
const priv = () => sheets['🔒 Private'];
const sheetOf = tab => (tab === 'priv' ? priv() : main());
function sec(name, tab) { return G.readTab_(sheetOf(tab)).byName[name]; }
function rowOf(name, pk, tab) {
  const s = sec(name, tab); if (!s) return undefined;
  const pkCol = { users: 'email', 'marketing.users': 'email', 'marketing.push_subscriptions': 'user_name', notif_prefs: 'user_name', 'marketing.app_secrets': 'key' }[name] || 'id';
  const i = s.header.indexOf(pkCol);
  return s.rows.find(r => String(r.data[i]) === String(pk));
}
function cellOf(name, pk, col, tab) { const s = sec(name, tab); return rowOf(name, pk, tab).data[s.header.indexOf(col)]; }
function userEdit(name, pk, col, value, tab) {
  const s = sec(name, tab); const r = rowOf(name, pk, tab);
  const range = sheetOf(tab).getRange(r.rowNum, 3 + s.header.indexOf(col));
  const old = range.getValue();
  range.setValue(value);
  G.onEdit({ range, oldValue: old });
}
const inbox = () => Number(sql(`select count(*) from public.sheet_inbox`));
const appSave = (payload, db = sql) => db(`select marketing.save_app_state($j$${JSON.stringify(payload)}$j$::jsonb)`);
const loadNew = () => JSON.parse(sql(`select marketing.load_app_state()`));
const loadOld = () => JSON.parse(sqlOld(`select marketing.load_app_state()`));
function noTimes(o) { return JSON.parse(JSON.stringify(o, (k, v) => (k === 'created_at' ? undefined : v))); }

// ── The OLD project's data ──────────────────────────────────────────────
const bigBackup = { note: 'cloud backup', blob: 'b'.repeat(120000) };            // > 2 cells
const payload = {
  boards: [{ id: 'board-1', year: '2026', settings: { theme: 'dark' } }],
  columns: [{ id: 'c1', boardId: 'board-1', title: 'To do', order: 0, members: ['Chris'] }],
  tasks: [
    { id: 't1', boardId: 'board-1', columnId: 'c1', title: 'Fall promo', dueDate: '2026-12-01', description: 'd1',
      labels: [{ text: 'Urgent', color: 'red' }], members: ['Chris', 'Ann'],
      checklist: [{ id: 'ci1', text: 'Draft', done: false, assignedTo: ['Chris'] }, { id: 'ci2', text: 'Print', done: true }],
      comments: [{ id: 'cm1', user: 'Chris', text: 'hi', time: 'now' }],
      activity: [{ big: 'x'.repeat(60000) }] },
    { id: 't2', boardId: 'board-1', columnId: 'c1', title: 'Flyers', dueDate: '00123', labels: [] },
  ],
  automations: [],
  settings: { password: 'adminpw', logoUrl: 'logo.png',
    users: [{ email: 'ann@x.com', name: 'Ann', password: 'secret-pw', role: 'admin', lastActive: 1732480000000 }],
    passwordResetTokens: [{ token: 'tok1', email: 'ann@x.com', expiry: 1999999999999 }],
    checklistTemplates: [], cabbieAi: { apiKey: 'CABBIE-KEY', enabled: true } },
  notifications: { Ann: [{ id: 'n1', title: 'Hello' }] },
  notifPrefs: { Ann: { sound: true } },
  pushSubscriptions: { Ann: { endpoint: 'https://push/e', keys: { p256dh: 'P', auth: 'A' } } },
};
appSave(payload, sqlOld);
sqlOld(`insert into marketing.app_secrets values ('BREVO_API_KEY', 'brevo-secret')`);
sqlOld(`insert into marketing.app_state values (2, $j$${JSON.stringify(bigBackup)}$j$)`);
sqlOld(`insert into marketing.user_activity_log (user_email, action, detail) values ('ann@x.com', 'login', '')`);

// ── Tests ───────────────────────────────────────────────────────────────

check('migration: old project -> Sheet -> new cache, counts all match', () => {
  const report = G.runMarketingMigration_();
  const bad = report.filter(r => r.status !== 'OK');
  assert.strictEqual(JSON.stringify(bad.map(r => r.table + ': ' + r.status)), '[]');
  const tasks = report.find(r => r.table === 'tasks');
  assert.strictEqual(tasks.old, 2); assert.strictEqual(tasks.sheet, 2); assert.strictEqual(tasks.cache, 2);
  assert.strictEqual(inbox(), 0, 'rebuilding the cache must not fill the inbox');
});

check('new cache is identical to the old project (app sees the same data)', () => {
  assert.deepStrictEqual(noTimes(loadNew()), noTimes(loadOld()));
  assert.strictEqual(sql(`select value from marketing.app_secrets`), 'brevo-secret');
  assert.strictEqual(sql(`select data::text = (select data::text from marketing.app_state where id = 2) from marketing.app_state where id = 2`), 't');
  assert.strictEqual(sql(`select length(data->>'blob') from marketing.app_state where id = 2`), '120000');
});

check('secrets only in the 🔒 Private tab, which is hidden', () => {
  const m = JSON.stringify(main().grid);
  ['secret-pw', 'adminpw', 'CABBIE-KEY', 'brevo-secret', 'tok1', 'p256dh'].forEach(x => assert.ok(!m.includes(x), x + ' leaked into main tab'));
  assert.strictEqual(cellOf('marketing.users', 'ann@x.com', 'password', 'priv'), 'secret-pw');
  assert.strictEqual(cellOf('marketing.app_secrets', 'BREVO_API_KEY', 'value', 'priv'), 'brevo-secret');
  assert.ok(rowOf('marketing.push_subscriptions', 'Ann', 'priv'));
  assert.ok(priv().hidden);
  assert.ok(!sec('users').header.includes('password'));
});

check('over-long values are split into the overflow section, nothing lost', () => {
  assert.strictEqual(cellOf('tasks', 't1', 'activity_log'), G.HUB.OVERFLOW_MARK);
  const ov = sec('overflow', 'priv');
  assert.strictEqual(ov.rows.length, 2);   // tasks.activity_log + app_state.data
  const ws = G.openWs_(site, G.getSchema_(G.newConn_(), 'marketing'));
  assert.deepStrictEqual(JSON.parse(ws.overflow['marketing.app_state.data|2'].value), bigBackup);
});

check('values: lists/JSON as text, numbers, leading zeros kept', () => {
  assert.strictEqual(cellOf('tasks', 't1', 'members'), '["Chris","Ann"]');
  assert.strictEqual(cellOf('tasks', 't2', 'due_date'), '00123');
  assert.strictEqual(cellOf('users', 'ann@x.com', 'last_active'), 1732480000000);
  assert.strictEqual(cellOf('checklist_items', 'ci2', 'done'), true);
});

check('idle sync = one request, nothing written', () => {
  const before = JSON.stringify([main().grid, priv().grid]);
  fetches.length = 0;
  const s = sync();
  assert.deepStrictEqual(fetches, ['sheet_inbox_read']);
  assert.strictEqual(s.pulled + s.pushed, 0);
  assert.strictEqual(JSON.stringify([main().grid, priv().grid]), before);
});

check('app save -> inbox -> Sheet, then removed from inbox', () => {
  const p = loadNew();
  p.tasks[1].title = 'Flyers v2';
  p.tasks[0].comments.push({ id: 'cm2', user: 'Ann', text: 'new from app', time: 'later' });
  p.tasks[0].checklist = p.tasks[0].checklist.filter(c => c.id !== 'ci2');
  appSave(p);
  assert.ok(inbox() >= 3);
  sync();
  assert.strictEqual(inbox(), 0);
  assert.strictEqual(cellOf('tasks', 't2', 'title'), 'Flyers v2');
  assert.strictEqual(cellOf('comments', 'cm2', 'text'), 'new from app');
  assert.ok(!rowOf('checklist_items', 'ci2'));
  assert.strictEqual(cellOf('users', 'ann@x.com', 'name'), 'Ann', 'sections below intact');
});

check('app saving unchanged data puts nothing in the inbox', () => {
  sql(`select marketing.save_app_state(marketing.load_app_state())`);
  assert.strictEqual(inbox(), 0);
});

check('Sheet edit -> cache (only that cell), and it does not bounce back into the inbox', () => {
  userEdit('tasks', 't1', 'title', 'Fall promo (sheet)');
  sql(`update marketing.tasks set description = 'app edit' where id = 't1'`);   // app edits another column meanwhile
  sync();
  assert.strictEqual(sql(`select title || '|' || description from marketing.tasks where id='t1'`), 'Fall promo (sheet)|app edit');
  assert.strictEqual(cellOf('tasks', 't1', 'description'), 'app edit');
  assert.strictEqual(rowOf('tasks', 't1').pending, '');
  assert.strictEqual(inbox(), 0);
  assert.ok(sql(`select length(activity_log::text) from marketing.tasks where id='t1'`) > 60000, 'overflow value untouched');
});

check('same cell changed in both places: Sheet wins, other app changes still arrive', () => {
  userEdit('tasks', 't2', 'title', 'Sheet title');
  sql(`update marketing.tasks set title = 'App title', priority = 'high' where id = 't2'`);
  const s = sync();
  assert.ok(s.conflicts >= 1);
  assert.strictEqual(cellOf('tasks', 't2', 'title'), 'Sheet title');
  assert.strictEqual(cellOf('tasks', 't2', 'priority'), 'high');
  assert.strictEqual(sql(`select title || '|' || priority from marketing.tasks where id='t2'`), 'Sheet title|high');
});

check('race: site saves between inbox read and push -> Sheet and cache still agree', () => {
  userEdit('tasks', 't2', 'title', 'Sheet again');
  const conn = G.newConn_(); const schema = G.getSchema_(conn, 'marketing');
  const stats = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, errors: 0 };
  G.drain_(conn, site, schema, stats);
  sql(`update marketing.tasks set title = 'App sneaks in', due_date = '2027-01-01' where id = 't2'`);
  G.push_(conn, site, schema, stats);
  sync();
  assert.strictEqual(cellOf('tasks', 't2', 'title'), 'Sheet again');
  assert.strictEqual(sql(`select title from marketing.tasks where id='t2'`), 'Sheet again');
  assert.strictEqual(cellOf('tasks', 't2', 'due_date'), '2027-01-01');
  assert.strictEqual(inbox(), 0);
});

check('new row typed into the Sheet gets an id; new user gets a password row in Private', () => {
  const s = sec('comments');
  main().insertRowsAfter(s.lastRow, 1);
  const r = s.lastRow + 1;
  const put = (col, v) => { const range = main().getRange(r, 3 + s.header.indexOf(col)); range.setValue(v); G.onEdit({ range }); };
  put('task_id', 't1'); put('user_name', 'Chris'); put('text', 'typed in the sheet');
  const u = sec('users');
  main().insertRowsAfter(u.lastRow, 1);
  const ur = u.lastRow + 1;
  const putU = (col, v) => { const range = main().getRange(ur, 3 + u.header.indexOf(col)); range.setValue(v); G.onEdit({ range }); };
  putU('email', 'bo@x.com'); putU('name', 'Bo');
  sync();
  const id = sql(`select id from marketing.comments where text = 'typed in the sheet'`);
  assert.match(id, /^[a-z0-9]{6,9}$/);
  assert.strictEqual(cellOf('comments', id, 'text'), 'typed in the sheet');
  assert.ok(rowOf('marketing.users', 'bo@x.com', 'priv'), 'private row created');
  userEdit('marketing.users', 'bo@x.com', 'password', 'bo-pw', 'priv');
  sync();
  assert.strictEqual(sql(`select password from marketing.users where email='bo@x.com'`), 'bo-pw');
  assert.strictEqual(inbox(), 0);
});

check('password changed in the app lands in Private only', () => {
  sql(`update marketing.users set password = 'changed-in-app' where email = 'ann@x.com'`);
  sync();
  assert.strictEqual(cellOf('marketing.users', 'ann@x.com', 'password', 'priv'), 'changed-in-app');
  assert.ok(!JSON.stringify(main().grid).includes('changed-in-app'));
});

check('bad edit turns red with the reason; fixing it retries', () => {
  userEdit('comments', 'cm1', 'task_id', 'no-such-task');
  const s = sync();
  assert.strictEqual(s.errors, 1);
  const r = rowOf('comments', 'cm1');
  assert.strictEqual(r.pending, 'task_id');
  assert.match(main().notes[r.rowNum + ',2'], /foreign key/);
  userEdit('comments', 'cm1', 'task_id', 't1');
  assert.strictEqual(sync().errors, 0);
  assert.strictEqual(rowOf('comments', 'cm1').pending, '');
});

check('tick delete -> gone from cache, Sheet, and Private', () => {
  main().getRange(rowOf('users', 'bo@x.com').rowNum, 1).setValue(true);
  sync();
  assert.strictEqual(sql(`select count(*) from marketing.users where email='bo@x.com'`), '0');
  assert.ok(!rowOf('users', 'bo@x.com'));
  assert.ok(!rowOf('marketing.users', 'bo@x.com', 'priv'));
  assert.strictEqual(inbox(), 0);
});

check('app deletes a record the Sheet is editing: Sheet wins, record comes back', () => {
  userEdit('checklist_items', 'ci1', 'text', 'keep me');
  sql(`delete from marketing.checklist_items where id = 'ci1'`);
  sync();
  assert.strictEqual(sql(`select text from marketing.checklist_items where id='ci1'`), 'keep me');
  assert.ok(rowOf('checklist_items', 'ci1'));
  sync();
  assert.ok(rowOf('checklist_items', 'ci1'), 'still there next sync');
  assert.strictEqual(inbox(), 0);
});

check('app deletes a record -> removed from the Sheet', () => {
  sql(`delete from marketing.comments where id = 'cm2'`);
  sync();
  assert.ok(!rowOf('comments', 'cm2'));
});

check('Rebuild Supabase from Sheet: wipe the cache, rebuild, app sees identical data', () => {
  const before = noTimes(loadNew());
  const blob = sql(`select data::text from marketing.app_state where id = 2`);
  sql(`set session_replication_role = replica; delete from marketing.tasks; delete from marketing.users; delete from marketing.app_state;`);
  G.rebuildSupabaseFromSheet_(site);
  assert.deepStrictEqual(noTimes(loadNew()), before);
  assert.strictEqual(sql(`select data::text from marketing.app_state where id = 2`), blob);
  assert.strictEqual(sql(`select password from marketing.users where email='ann@x.com'`), 'changed-in-app');
  assert.strictEqual(inbox(), 0);
  sql(`insert into marketing.task_labels (task_id, text) values ('t1', 'seq-check')`);   // sequence was fixed
});

check('Rebuild takes in waiting inbox saves before replacing the cache', () => {
  sql(`select marketing.save_app_state(marketing.load_app_state())`);
  assert.ok(inbox() >= 1);           // the label added above
  G.rebuildSupabaseFromSheet_(site);  // drains the inbox first, then rebuilds
  assert.ok(rowOf('task_labels', sql(`select id from marketing.task_labels where text='seq-check'`)));
});

check('Restore Sheet from Supabase (emergency) reproduces the Sheet', () => {
  const norm = () => {
    const ws = G.openWs_(site, G.getSchema_(G.newConn_(), 'marketing'));
    return JSON.stringify(G.collectSiteData_(ws).tables, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, x) => (o[x] = v[x], o), {}) : v));
  };
  const before = norm();
  G.restoreSheetFromSupabase_(site);
  assert.strictEqual(norm(), before);
});

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
