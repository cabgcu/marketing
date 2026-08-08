-- ============================================================================
-- Normalize app_state into real tables
-- ============================================================================
-- Today everything (boards, columns, tasks, comments, checklists, users,
-- settings, notifications, ...) lives inside one JSON blob in app_state.data.
-- This migration creates one table per entity and copies every row out of
-- that blob into them.
--
-- SAFE TO RUN: this script never modifies or deletes app_state. It only
-- creates new tables (IF NOT EXISTS) and copies data into them. If you run
-- it more than once, each data-copy step starts by clearing just the new
-- tables (never app_state) and re-copying from app_state, so re-running is
-- harmless and always reflects the current app_state contents.
--
-- Run this whole file once in the Supabase SQL Editor BEFORE deploying the
-- updated index.html / edge functions that read from these new tables.
-- ============================================================================

begin;

-- ── 1. Tables ────────────────────────────────────────────────────────────

create table if not exists boards (
    id               text primary key,
    year             text,
    background_image text default '',
    assigned_to      text default '',
    settings         jsonb default '{}'::jsonb,
    created_at       timestamptz default now()
);

-- board_id/column_id below are deliberately plain text, not enforced foreign
-- keys: this migration must succeed even if your live data has an orphaned
-- reference somewhere (e.g. a task pointing at a since-deleted column) —
-- losing all your data to one bad row because of a strict FK is worse than
-- an occasional dangling reference, which is exactly the state that data is
-- already in today inside the JSON blob.
create table if not exists columns (
    id          text primary key,
    board_id    text,
    title       text,
    sort_order  integer default 0,
    assigned_to text default '',
    hideable    boolean default true,
    members     text[] default '{}'
);
create index if not exists idx_columns_board_id on columns(board_id);

create table if not exists tasks (
    id               text primary key,
    board_id         text,
    column_id        text,
    title            text,
    description      text default '',
    legacy_text      text default '',
    due_date         text default '',
    event_location   text default '',
    priority         text default '',
    completed        boolean default false,
    posting_schedule jsonb default '{"story":[],"photo":[],"reel":[]}'::jsonb,
    cover_image      text default '',
    members          text[] default '{}',
    sort_order       integer default 0,
    activity_log     jsonb default '[]'::jsonb,
    created_at       timestamptz default now()
);
create index if not exists idx_tasks_column_id on tasks(column_id);
create index if not exists idx_tasks_board_id  on tasks(board_id);

create table if not exists checklist_items (
    id          text primary key,
    task_id     text not null references tasks(id) on delete cascade,
    text        text default '',
    done        boolean default false,
    due_date    text default '',
    due_time    text default '',
    assigned_to text[] default '{}',
    sort_order  integer default 0
);
create index if not exists idx_checklist_items_task_id on checklist_items(task_id);

create table if not exists comments (
    id        text primary key,
    task_id   text not null references tasks(id) on delete cascade,
    user_name text default '',
    text      text default '',
    time      text default ''
);
create index if not exists idx_comments_task_id on comments(task_id);

create table if not exists attachments (
    id         text primary key,
    task_id    text not null references tasks(id) on delete cascade,
    name       text default '',
    url        text default '',
    viewer_url text default '',
    is_link    boolean default false,
    size       text default '',
    date       text default '',
    mime_type  text default ''
);
create index if not exists idx_attachments_task_id on attachments(task_id);

create table if not exists custom_fields (
    id         text primary key,
    task_id    text not null references tasks(id) on delete cascade,
    name       text default '',
    type       text default 'text',
    value      text default '',
    sort_order integer default 0
);
create index if not exists idx_custom_fields_task_id on custom_fields(task_id);

create table if not exists task_labels (
    id      bigserial primary key,
    task_id text not null references tasks(id) on delete cascade,
    text    text default '',
    color   text default ''
);
create index if not exists idx_task_labels_task_id on task_labels(task_id);

create table if not exists users (
    email           text primary key,
    name            text default '',
    password        text,
    role            text default 'user',
    last_active     bigint,
    profile_picture text default ''
);

create table if not exists automations (
    id            text primary key,
    enabled       boolean default false,
    trigger_type  text default '',
    trigger_value text default '',
    action_type   text default '',
    action_value  text default ''
);

create table if not exists notifications (
    id        text primary key,
    user_name text not null,
    type      text default '',
    title     text default '',
    body      text default '',
    task_id   text,
    icon      text default '',
    icon_bg   text default '',
    read      boolean default false,
    timestamp text default ''
);
create index if not exists idx_notifications_user_name on notifications(user_name);

create table if not exists notif_prefs (
    user_name text primary key,
    prefs     jsonb default '{}'::jsonb
);

create table if not exists push_subscriptions (
    user_name    text primary key,
    subscription jsonb not null
);

create table if not exists password_reset_tokens (
    token  text primary key,
    email  text not null,
    expiry bigint not null
);

create table if not exists checklist_templates (
    id    text primary key,
    name  text default '',
    items jsonb default '[]'::jsonb
);

-- Singleton row (id is always 1) for the handful of loose/global app settings
-- that don't really warrant their own table.
create table if not exists app_settings (
    id                        smallint primary key default 1 check (id = 1),
    password                  text,
    logo_url                  text default '',
    app_icon_url              text default '',
    admin_profile_picture     text default '',
    default_workspace_id      text default '',
    active_board_id           text default '',
    google_calendar_auto_sync boolean default false,
    google_calendar_webhook   text default '',
    cabbie_ai                 jsonb default '{"apiKey":"","enabled":true}'::jsonb,
    scheduled_reminders_sent  jsonb default '{}'::jsonb
);

-- ── 2. Row Level Security ───────────────────────────────────────────────
-- This app authenticates itself (not via Supabase Auth) and always talks to
-- Supabase with the same anon/publishable key regardless of which app user
-- is logged in client-side. To keep the app working exactly as it does
-- today against app_state, these policies grant the anon/authenticated
-- roles full access — the SAME effective posture app_state already has
-- (whatever that is). This migration does not change your security
-- posture, just where the bytes live. Tightening this later requires
-- moving login to real Supabase Auth, which is a separate project.

do $$
declare
    tbl text;
begin
    foreach tbl in array array[
        'boards','columns','tasks','checklist_items','comments','attachments',
        'custom_fields','task_labels','users','automations','notifications',
        'notif_prefs','push_subscriptions','password_reset_tokens',
        'checklist_templates','app_settings'
    ]
    loop
        execute format('alter table %I enable row level security', tbl);
        execute format('drop policy if exists allow_all on %I', tbl);
        execute format(
            'create policy allow_all on %I for all to anon, authenticated using (true) with check (true)',
            tbl
        );
    end loop;
end $$;

-- ── 3. Copy data out of app_state (id = 1) into the new tables ─────────
-- Each block clears just that new table, then re-copies from app_state, so
-- this whole script is safe to run again later (e.g. after fixing data in
-- app_state) without creating duplicates.

truncate table checklist_items, comments, attachments, custom_fields, task_labels,
    tasks, columns, boards, users, automations, notifications, notif_prefs,
    push_subscriptions, password_reset_tokens, checklist_templates
    restart identity cascade;

insert into boards (id, year, background_image, assigned_to, settings)
select
    b->>'id',
    b->>'year',
    coalesce(b->>'backgroundImage', ''),
    coalesce(b->>'assignedTo', ''),
    coalesce(b->'settings', '{}'::jsonb)
from app_state, jsonb_array_elements(coalesce(data->'boards', '[]'::jsonb)) as b
where id = 1;

insert into columns (id, board_id, title, sort_order, assigned_to, hideable, members)
select
    c->>'id',
    c->>'boardId',
    c->>'title',
    coalesce((c->>'order')::int, 0),
    coalesce(c->>'assignedTo', ''),
    coalesce((c->>'hideable')::boolean, true),
    case when jsonb_typeof(c->'members') = 'array'
         then array(select jsonb_array_elements_text(c->'members'))
         else '{}'::text[] end
from app_state, jsonb_array_elements(coalesce(data->'columns', '[]'::jsonb)) as c
where id = 1;

insert into tasks (id, board_id, column_id, title, description, legacy_text, due_date,
                    event_location, priority, completed, posting_schedule, cover_image,
                    members, sort_order, activity_log)
select
    t->>'id',
    t->>'boardId',
    t->>'columnId',
    t->>'title',
    coalesce(t->>'description', ''),
    coalesce(t->>'text', ''),
    coalesce(t->>'dueDate', ''),
    coalesce(t->>'eventLocation', ''),
    coalesce(t->>'priority', ''),
    coalesce((t->>'completed')::boolean, false),
    coalesce(t->'postingSchedule', '{"story":[],"photo":[],"reel":[]}'::jsonb),
    coalesce(t->>'coverImage', ''),
    case when jsonb_typeof(t->'members') = 'array'
         then array(select jsonb_array_elements_text(t->'members'))
         else '{}'::text[] end,
    (ord - 1)::int,
    coalesce(t->'activity', '[]'::jsonb)
from app_state, jsonb_array_elements(coalesce(data->'tasks', '[]'::jsonb)) with ordinality as arr(t, ord)
where id = 1;

insert into checklist_items (id, task_id, text, done, due_date, due_time, assigned_to, sort_order)
select
    ci->>'id',
    t->>'id',
    coalesce(ci->>'text', ''),
    coalesce((ci->>'done')::boolean, false),
    coalesce(ci->>'dueDate', ''),
    coalesce(ci->>'dueTime', ''),
    case when jsonb_typeof(ci->'assignedTo') = 'array'
         then array(select jsonb_array_elements_text(ci->'assignedTo'))
         when ci->>'assignedTo' is not null then array[ci->>'assignedTo']
         else '{}'::text[] end,
    (ciord - 1)::int
from app_state,
     jsonb_array_elements(coalesce(data->'tasks', '[]'::jsonb)) as t,
     jsonb_array_elements(coalesce(t->'checklist', '[]'::jsonb)) with ordinality as arr2(ci, ciord)
where id = 1;

insert into comments (id, task_id, user_name, text, time)
select
    c->>'id',
    t->>'id',
    coalesce(c->>'user', ''),
    coalesce(c->>'text', ''),
    coalesce(c->>'time', '')
from app_state,
     jsonb_array_elements(coalesce(data->'tasks', '[]'::jsonb)) as t,
     jsonb_array_elements(coalesce(t->'comments', '[]'::jsonb)) as c
where id = 1;

insert into attachments (id, task_id, name, url, viewer_url, is_link, size, date, mime_type)
select
    a->>'id',
    t->>'id',
    coalesce(a->>'name', ''),
    coalesce(a->>'url', ''),
    coalesce(a->>'viewerUrl', ''),
    coalesce((a->>'isLink')::boolean, false),
    coalesce(a->>'size', ''),
    coalesce(a->>'date', ''),
    coalesce(a->>'mimeType', '')
from app_state,
     jsonb_array_elements(coalesce(data->'tasks', '[]'::jsonb)) as t,
     jsonb_array_elements(coalesce(t->'attachments', '[]'::jsonb)) as a
where id = 1;

insert into custom_fields (id, task_id, name, type, value, sort_order)
select
    cf->>'id',
    t->>'id',
    coalesce(cf->>'name', ''),
    coalesce(cf->>'type', 'text'),
    coalesce(cf->>'value', ''),
    (cford - 1)::int
from app_state,
     jsonb_array_elements(coalesce(data->'tasks', '[]'::jsonb)) as t,
     jsonb_array_elements(coalesce(t->'customFields', '[]'::jsonb)) with ordinality as arr3(cf, cford)
where id = 1;

insert into task_labels (task_id, text, color)
select
    t->>'id',
    coalesce(l->>'text', ''),
    coalesce(l->>'color', '')
from app_state,
     jsonb_array_elements(coalesce(data->'tasks', '[]'::jsonb)) as t,
     jsonb_array_elements(coalesce(t->'labels', '[]'::jsonb)) as l
where id = 1;

insert into users (email, name, password, role, last_active, profile_picture)
select
    lower(u->>'email'),
    coalesce(u->>'name', ''),
    u->>'password',
    coalesce(u->>'role', 'user'),
    (u->>'lastActive')::bigint,
    coalesce(u->>'profilePicture', '')
from app_state, jsonb_array_elements(coalesce(data->'settings'->'users', '[]'::jsonb)) as u
where id = 1
on conflict (email) do nothing;

insert into automations (id, enabled, trigger_type, trigger_value, action_type, action_value)
select
    a->>'id',
    coalesce((a->>'enabled')::boolean, false),
    coalesce(a->>'trigger', ''),
    coalesce(a->>'triggerValue', ''),
    coalesce(a->>'action', ''),
    coalesce(a->>'actionValue', '')
from app_state, jsonb_array_elements(coalesce(data->'automations', '[]'::jsonb)) as a
where id = 1;

insert into notifications (id, user_name, type, title, body, task_id, icon, icon_bg, read, timestamp)
select
    n->>'id',
    kv.key,
    coalesce(n->>'type', ''),
    coalesce(n->>'title', ''),
    coalesce(n->>'body', ''),
    n->>'taskId',
    coalesce(n->>'icon', ''),
    coalesce(n->>'iconBg', ''),
    coalesce((n->>'read')::boolean, false),
    coalesce(n->>'timestamp', '')
from app_state,
     jsonb_each(coalesce(data->'notifications', '{}'::jsonb)) as kv,
     jsonb_array_elements(kv.value) as n
where id = 1
on conflict (id) do nothing;

insert into notif_prefs (user_name, prefs)
select kv.key, kv.value
from app_state, jsonb_each(coalesce(data->'notifPrefs', '{}'::jsonb)) as kv
where id = 1;

insert into push_subscriptions (user_name, subscription)
select kv.key, kv.value
from app_state, jsonb_each(coalesce(data->'pushSubscriptions', '{}'::jsonb)) as kv
where id = 1;

insert into password_reset_tokens (token, email, expiry)
select
    t->>'token',
    lower(t->>'email'),
    (t->>'expiry')::bigint
from app_state, jsonb_array_elements(coalesce(data->'settings'->'passwordResetTokens', '[]'::jsonb)) as t
where id = 1
on conflict (token) do nothing;

insert into checklist_templates (id, name, items)
select
    ct->>'id',
    coalesce(ct->>'name', ''),
    coalesce(ct->'items', '[]'::jsonb)
from app_state, jsonb_array_elements(coalesce(data->'settings'->'checklistTemplates', '[]'::jsonb)) as ct
where id = 1;

insert into app_settings (id, password, logo_url, app_icon_url, admin_profile_picture,
                           default_workspace_id, active_board_id, google_calendar_auto_sync,
                           google_calendar_webhook, cabbie_ai, scheduled_reminders_sent)
select
    1,
    data->'settings'->>'password',
    coalesce(data->'settings'->>'logoUrl', ''),
    coalesce(data->'settings'->>'appIconUrl', ''),
    coalesce(data->'settings'->>'adminProfilePicture', ''),
    coalesce(data->'settings'->>'defaultWorkspaceId', ''),
    coalesce(data->>'activeBoardId', ''),
    coalesce((data->'settings'->>'googleCalendarAutoSync')::boolean, false),
    coalesce(data->'settings'->>'googleCalendarWebhook', ''),
    coalesce(data->'settings'->'cabbieAi', '{"apiKey":"","enabled":true}'::jsonb),
    coalesce(data->'scheduledRemindersSent', '{}'::jsonb)
from app_state
where id = 1
on conflict (id) do update set
    password                  = excluded.password,
    logo_url                  = excluded.logo_url,
    app_icon_url              = excluded.app_icon_url,
    admin_profile_picture     = excluded.admin_profile_picture,
    default_workspace_id      = excluded.default_workspace_id,
    active_board_id           = excluded.active_board_id,
    google_calendar_auto_sync = excluded.google_calendar_auto_sync,
    google_calendar_webhook   = excluded.google_calendar_webhook,
    cabbie_ai                 = excluded.cabbie_ai,
    scheduled_reminders_sent  = excluded.scheduled_reminders_sent;

commit;

-- ── 4. Quick sanity check ────────────────────────────────────────────────
-- Compare these counts against what you'd expect from your current board(s).
-- (Run this separately/after — it's outside the transaction on purpose.)
select 'boards' as table_name, count(*) from boards
union all select 'columns', count(*) from columns
union all select 'tasks', count(*) from tasks
union all select 'checklist_items', count(*) from checklist_items
union all select 'comments', count(*) from comments
union all select 'attachments', count(*) from attachments
union all select 'custom_fields', count(*) from custom_fields
union all select 'task_labels', count(*) from task_labels
union all select 'users', count(*) from users
union all select 'automations', count(*) from automations
union all select 'notifications', count(*) from notifications
union all select 'notif_prefs', count(*) from notif_prefs
union all select 'push_subscriptions', count(*) from push_subscriptions
union all select 'password_reset_tokens', count(*) from password_reset_tokens
union all select 'checklist_templates', count(*) from checklist_templates
union all select 'app_settings', count(*) from app_settings;

-- ============================================================================
-- OPTIONAL, DO NOT RUN YET: tighten board_id/column_id into real foreign keys
-- ============================================================================
-- Once you've spot-checked the data above and are confident there are no
-- dangling references, you can enforce real foreign keys on columns.board_id,
-- tasks.board_id, and tasks.column_id. First check for orphans:
--
--   select id, board_id from columns where board_id is not null
--     and board_id not in (select id from boards);
--   select id, board_id from tasks where board_id is not null
--     and board_id not in (select id from boards);
--   select id, column_id from tasks where column_id is not null
--     and column_id not in (select id from columns);
--
-- If all three return zero rows, you can add the constraints:
--
--   alter table columns add constraint columns_board_id_fkey
--     foreign key (board_id) references boards(id) on delete cascade;
--   alter table tasks add constraint tasks_board_id_fkey
--     foreign key (board_id) references boards(id) on delete cascade;
--   alter table tasks add constraint tasks_column_id_fkey
--     foreign key (column_id) references columns(id) on delete cascade;
-- ============================================================================
