/**
 * Data Hub — configuration
 * ======================================================================
 * The Google Sheet is the master copy of every site's data. Supabase is the
 * fast copy the sites read and write. This script keeps the two in step.
 *
 *   Tab 1  "Control Panel"  - status of every site, buttons in the Hub menu
 *   Tab 2  "Marketing App"  - everything the marketing app stores
 *   Tab 3+ one tab per additional site
 *
 * To add a site later: create its schema in Supabase, run
 *   select public.sheet_sync_enable('<schema>');
 * then add an entry to SITES below and use Hub -> Rebuild a site tab.
 */

const HUB = {
  CONTROL_TAB: 'Control Panel',
  // Each sync re-reads this many seconds before the last sync, so a change
  // that committed late is never missed. Re-read rows that haven't changed
  // are not rewritten.
  OVERLAP_SECONDS: 120,
  // A Google Sheets cell holds at most 50,000 characters. Anything longer
  // stays in Supabase only and the cell shows a placeholder (never pushed).
  MAX_CELL_CHARS: 49000,
  TOO_LARGE_PREFIX: '⚠ TOO LARGE FOR SHEET',
  // Section rows in a site tab start with this.
  SECTION_MARK: '■ ',
};

const SITES = [
  {
    key: 'marketing',
    name: 'Marketing App',
    tab: 'Marketing App',
    schema: 'marketing',
    // Section order in the tab. Edits are also pushed in this order, so
    // parents (boards, tasks) go before children (checklist items...).
    // Tables in the schema that aren't listed here or in skipTables are
    // added at the end automatically.
    tables: [
      'boards', 'columns', 'tasks', 'checklist_items', 'comments', 'attachments',
      'custom_fields', 'task_labels', 'checklist_templates', 'automations',
      'users', 'notif_prefs', 'notifications', 'app_settings', 'user_activity_log',
    ],
    // Kept in Supabase only — secrets, login tokens, push keys, and the old
    // JSON blob backup (which contains all of the above).
    skipTables: ['push_subscriptions', 'password_reset_tokens', 'app_secrets', 'app_state'],
    // Columns kept in Supabase only. Editing a row in the Sheet never
    // touches these.
    skipColumns: {
      users: ['password'],
      app_settings: ['password', 'cabbie_ai', 'google_calendar_webhook', 'scheduled_reminders_sent'],
    },
    // Prefix for ids of rows typed into the Sheet (matches the app's style).
    idPrefix: { boards: 'board-' },
  },
];

// Old marketing project -> new project copy order (parents first).
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
