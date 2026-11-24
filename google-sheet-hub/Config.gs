/**
 * Data Hub — configuration
 * ======================================================================
 * The Google Sheet IS the database. Supabase is only a fast cache of it plus
 * a short-lived inbox: sites save to Supabase instantly, this script moves
 * each save into the Sheet and deletes it from the inbox. Supabase can be
 * wiped and rebuilt from the Sheet at any time (Hub -> Rebuild Supabase).
 *
 *   Tab 1  "Control Panel"  - status of every site
 *   Tab 2  "Marketing App"  - everything the marketing app stores
 *   Tab 3+ one tab per additional site
 *   "🔒 Private" (hidden, locked to the owner) - passwords, keys, tokens,
 *          and values too big for one cell, for every site
 *
 * To add a site later: create its schema in Supabase, run
 *   select public.sheet_sync_enable('<schema>');
 * then add an entry to SITES below.
 */

const HUB = {
  CONTROL_TAB: 'Control Panel',
  PRIVATE_TAB: '🔒 Private',
  OVERFLOW_SECTION: 'overflow',
  // Google Sheets cells hold at most 50,000 characters. Longer values are
  // split across cells in the Private tab's "overflow" section.
  MAX_CELL_CHARS: 49000,
  CHUNK_CHARS: 45000,
  OVERFLOW_MARK: '⚠ TOO LARGE FOR ONE CELL — stored in 🔒 Private › overflow',
  SECTION_MARK: '■ ',
  // Stop pulling from the inbox after this long; the rest comes next run.
  DRAIN_BUDGET_MS: 3 * 60 * 1000,
};

const SITES = [
  {
    key: 'marketing',
    name: 'Marketing App',
    tab: 'Marketing App',
    schema: 'marketing',
    // Section order in the tab. Also the order saves are applied and the
    // order Supabase is rebuilt in, so parents (boards, tasks) come before
    // children (checklist items...). Tables in the schema that aren't listed
    // here or in privateTables are added at the end automatically.
    tables: [
      'boards', 'columns', 'tasks', 'checklist_items', 'comments', 'attachments',
      'custom_fields', 'task_labels', 'checklist_templates', 'automations',
      'users', 'notif_prefs', 'notifications', 'app_settings', 'user_activity_log',
    ],
    // Whole tables kept in the 🔒 Private tab instead of the site tab.
    // (app_state is the app's "cloud backup" blob, which contains passwords.)
    privateTables: ['push_subscriptions', 'password_reset_tokens', 'app_secrets', 'app_state'],
    // Columns kept in the 🔒 Private tab (next to the row's key) instead of
    // the site tab.
    privateColumns: {
      users: ['password'],
      app_settings: ['password', 'cabbie_ai', 'google_calendar_webhook'],
    },
    // Prefix for ids of rows typed into the Sheet (matches the app's style).
    idPrefix: { boards: 'board-' },
  },
];

// Tables read from the OLD marketing project during the migration.
const MARKETING_MIGRATION_TABLES = [
  'boards', 'columns', 'tasks', 'checklist_items', 'comments', 'attachments',
  'custom_fields', 'task_labels', 'users', 'automations', 'notifications',
  'notif_prefs', 'push_subscriptions', 'password_reset_tokens',
  'checklist_templates', 'app_settings', 'user_activity_log', 'app_secrets', 'app_state',
];

function siteByKey_(key) {
  return SITES.filter(function (s) { return s.key === key; })[0] || null;
}

function siteByTab_(tabName) {
  return SITES.filter(function (s) { return s.tab === tabName; })[0] || null;
}
