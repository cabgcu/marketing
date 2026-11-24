const assert = require('assert');
const { G, sheets, sql, props, fetches } = require('./harness');

const site = G.SITES[0];
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures++; console.log('FAIL', name, '\n   ', e.message); }
}
const sync = () => G.syncSite_(site);
const tab = () => sheets['Marketing App'];
function sec(table) { return G.readTab_(tab()).byTable[table]; }
function rowOf(table, pk) {
  const s = sec(table); const i = s.header.indexOf(table === 'users' ? 'email' : 'id');
  return s.rows.find(r => String(r.data[i]) === String(pk));
}
function cellOf(table, pk, col) { const s = sec(table); return rowOf(table, pk).data[s.header.indexOf(col)]; }
// a person typing into a cell
function userEdit(table, pk, col, value) {
  const s = sec(table); const r = rowOf(table, pk); const c = 3 + s.header.indexOf(col);
  const range = tab().getRange(r.rowNum, c);
  const old = range.getValue();
  range.setValue(value);
  G.onEdit({ range, oldValue: old });
}
const appSave = payload => sql(`select marketing.save_app_state($j$${JSON.stringify(payload)}$j$::jsonb)`);

const payload = {
  boards: [{ id: 'board-1', year: '2026', settings: {} }],
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
  settings: { password: 'adminpw', users: [{ email: 'ann@x.com', name: 'Ann', password: 'secret', role: 'admin', lastActive: 1732480000000 }],
              passwordResetTokens: [], checklistTemplates: [], cabbieAi: { apiKey: 'KEY', enabled: true } },
  notifications: { Ann: [{ id: 'n1', title: 'Hello' }] },
  notifPrefs: { Ann: { sound: true } },
  pushSubscriptions: { Ann: { endpoint: 'e' } },
};

// fresh database
for (const t of ['task_labels', 'checklist_items', 'comments', 'attachments', 'custom_fields', 'tasks', 'columns', 'boards', 'users',
  'automations', 'notifications', 'notif_prefs', 'push_subscriptions', 'password_reset_tokens', 'checklist_templates', 'app_settings', 'user_activity_log'])
  sql(`delete from marketing.${t}`);
sql('delete from public.sheet_sync_deletions');
appSave(payload);

check('first sync builds the tab from Supabase', () => {
  sync();
  const t = G.readTab_(tab());
  assert.strictEqual(t.sections.map(s => s.table).slice(0, 4).join(), 'boards,columns,tasks,checklist_items');
  assert.ok(!t.byTable.push_subscriptions && !t.byTable.password_reset_tokens && !t.byTable.app_secrets && !t.byTable.app_state, 'secret tables kept out');
  assert.strictEqual(sec('tasks').rows.length, 2);
  assert.strictEqual(sec('checklist_items').rows.length, 2);
  assert.ok(props.WATERMARK_marketing);
});

check('secrets never reach the Sheet', () => {
  assert.ok(!sec('users').header.includes('password'));
  assert.ok(!sec('app_settings').header.includes('cabbie_ai'));
  assert.ok(!sec('app_settings').header.includes('password'));
  assert.ok(!JSON.stringify(tab().grid).includes('secret') && !JSON.stringify(tab().grid).includes('KEY'));
});

check('values: arrays/json as JSON text, numbers, leading zeros kept, oversized cell placeholder', () => {
  assert.strictEqual(cellOf('tasks', 't1', 'members'), '["Chris","Ann"]');
  assert.strictEqual(cellOf('tasks', 't2', 'due_date'), '00123');
  assert.strictEqual(cellOf('users', 'ann@x.com', 'last_active'), 1732480000000);
  assert.match(String(cellOf('tasks', 't1', 'activity_log')), /^⚠ TOO LARGE FOR SHEET/);
  assert.strictEqual(cellOf('checklist_items', 'ci2', 'done'), true);
});

check('sync with no changes anywhere writes nothing', () => {
  const before = JSON.stringify(tab().grid);
  const s = sync();
  assert.strictEqual(s.pulled, 0); assert.strictEqual(s.pushed, 0);
  assert.strictEqual(JSON.stringify(tab().grid), before);
});

check('Sheet edit goes to Supabase, only the edited column', () => {
  sql(`update marketing.tasks set description = 'newer app text' where id = 't1'`);   // app edit sheet hasn't seen
  userEdit('tasks', 't1', 'title', 'Fall promo (sheet)');
  assert.strictEqual(String(tab().getRange(rowOf('tasks', 't1').rowNum, 2).getValue()), 'title');
  const s = sync();
  assert.strictEqual(s.pushed, 1);
  assert.strictEqual(sql(`select title || '|' || description from marketing.tasks where id='t1'`), 'Fall promo (sheet)|newer app text');
  assert.strictEqual(cellOf('tasks', 't1', 'description'), 'newer app text', 'app edit pulled into sheet');
  assert.strictEqual(rowOf('tasks', 't1').pending, '');
  assert.ok(sql(`select activity_log::text from marketing.tasks where id='t1'`).length > 60000, 'oversized value untouched');
});

check('friendly list entry + checkbox-ish booleans', () => {
  userEdit('tasks', 't2', 'members', 'Ann, Bo');
  userEdit('tasks', 't2', 'completed', 'yes');
  sync();
  assert.strictEqual(sql(`select members::text || completed from marketing.tasks where id='t2'`), '{Ann,Bo}true');
  assert.strictEqual(cellOf('tasks', 't2', 'members'), '["Ann","Bo"]');
});

check('app changes, additions and deletions flow into the Sheet', () => {
  const p = JSON.parse(JSON.stringify(payload));
  p.tasks[0].title = 'Fall promo (sheet)'; p.tasks[0].description = 'newer app text';
  p.tasks[1].members = ['Ann', 'Bo']; p.tasks[1].completed = true;
  p.tasks[0].checklist = [p.tasks[0].checklist[0]];                    // ci2 deleted
  p.tasks[0].comments.push({ id: 'cm2', user: 'Ann', text: 'new from app', time: 'later' });
  p.tasks[1].title = 'Flyers v2';
  appSave(p);
  const s = sync();
  assert.ok(!rowOf('checklist_items', 'ci2'), 'deleted row removed');
  assert.strictEqual(cellOf('comments', 'cm2', 'text'), 'new from app');
  assert.strictEqual(cellOf('tasks', 't2', 'title'), 'Flyers v2');
  assert.strictEqual(sec('comments').rows.length, 2);
  // sections below still intact after row inserts/deletes
  assert.strictEqual(cellOf('users', 'ann@x.com', 'name'), 'Ann');
  assert.ok(s.deleted >= 1);
});

check('same row changed in both places: Sheet wins', () => {
  userEdit('tasks', 't2', 'title', 'Sheet says this');
  sql(`update marketing.tasks set title = 'App says this' where id = 't2'`);
  const s = sync();
  assert.ok(s.conflicts >= 1 || s.pushed >= 1);
  assert.strictEqual(sql(`select title from marketing.tasks where id='t2'`), 'Sheet says this');
  assert.strictEqual(cellOf('tasks', 't2', 'title'), 'Sheet says this');
});

check('new row typed into the Sheet gets created with an id', () => {
  const s = sec('comments');
  const after = s.lastRow;
  tab().insertRowsAfter(after, 1);
  const r = after + 1;
  const put = (col, v) => { const range = tab().getRange(r, 3 + s.header.indexOf(col)); range.setValue(v); G.onEdit({ range }); };
  put('task_id', 't1'); put('user_name', 'Chris'); put('text', 'typed in the sheet');
  sync();
  const id = sql(`select id from marketing.comments where text = 'typed in the sheet'`);
  assert.match(id, /^[a-z0-9]{6,9}$/);
  assert.strictEqual(cellOf('comments', id, 'text'), 'typed in the sheet');
});

check('new row with numeric id (task_labels) gets the database id', () => {
  const s = sec('task_labels');
  tab().insertRowsAfter(s.lastRow, 1);
  const r = s.lastRow + 1;
  const put = (col, v) => { const range = tab().getRange(r, 3 + s.header.indexOf(col)); range.setValue(v); G.onEdit({ range }); };
  put('task_id', 't2'); put('text', 'From sheet'); put('color', 'green');
  sync();
  const id = sql(`select id from marketing.task_labels where text = 'From sheet'`);
  assert.ok(Number(id) > 0);
  assert.strictEqual(cellOf('task_labels', id, 'color'), 'green');
});

check('bad edit is flagged red with the reason and kept pending; other rows still sync', () => {
  userEdit('comments', 'cm1', 'task_id', 'no-such-task');
  userEdit('tasks', 't1', 'priority', 'high');
  const s = sync();
  assert.strictEqual(s.errors, 1);
  const r = rowOf('comments', 'cm1');
  assert.strictEqual(r.pending, 'task_id');
  assert.match(tab().notes[r.rowNum + ',2'], /foreign key/);
  assert.strictEqual(sql(`select priority from marketing.tasks where id='t1'`), 'high');
  // fix it
  userEdit('comments', 'cm1', 'task_id', 't1');
  const s2 = sync();
  assert.strictEqual(s2.errors, 0);
  assert.strictEqual(rowOf('comments', 'cm1').pending, '');
});

check('tick delete -> deleted in Supabase and the row removed', () => {
  const r = rowOf('comments', 'cm2');
  tab().getRange(r.rowNum, 1).setValue(true);
  sync();
  assert.strictEqual(sql(`select count(*) from marketing.comments where id='cm2'`), '0');
  assert.ok(!rowOf('comments', 'cm2'));
});

check('app deletes a row the Sheet is editing: Sheet wins, row comes back', () => {
  userEdit('checklist_items', 'ci1', 'text', 'keep me');
  sql(`delete from marketing.checklist_items where id = 'ci1'`);
  sync();
  assert.strictEqual(sql(`select text from marketing.checklist_items where id='ci1'`), 'keep me');
  assert.ok(rowOf('checklist_items', 'ci1'));
});

check('app saves its unchanged state: nothing changes in the Sheet', () => {
  sql(`select marketing.save_app_state(marketing.load_app_state())`);
  const before = JSON.stringify(tab().grid);
  const s = sync();
  assert.strictEqual(s.pulled, 0, 'pulled ' + s.pulled);
  assert.strictEqual(JSON.stringify(tab().grid), before);
});

check('a sync is one request when nothing is pending', () => {
  fetches.length = 0;
  sync();
  assert.deepStrictEqual(fetches, ['sheet_sync_changes']);
});

check('rebuild from Supabase matches incremental state', () => {
  const norm = () => G.readTab_(tab()).sections.map(s => s.table + ':' + s.rows.map(r => r.data.slice(0, -1).join('|')).sort().join('/')).join('\n');
  const incremental = norm();
  G.syncSite_(site, { rebuild: true });
  assert.strictEqual(norm(), incremental);
});

check('push whole tab (Supabase restore from Sheet)', () => {
  // drift Supabase without triggers, so the pull can't see it - only a full push fixes it
  sql(`set session_replication_role = replica; update marketing.tasks set title = 'drifted', updated_at = now() - interval '1 day' where id = 't1'`);
  G.syncSite_(site, { forceAll: true });
  assert.strictEqual(sql(`select title from marketing.tasks where id='t1'`), 'Fall promo (sheet)');
});

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
