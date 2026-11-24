-- ============================================================================
-- Marketing App schema  (run SECOND in the NEW Supabase project, after
-- 01_sheet_sync_core.sql)
-- ============================================================================
-- Everything the marketing app stores, in its own `marketing` schema so other
-- sites can live in the same project without name clashes (each future site
-- gets its own schema the same way).
--
-- This is the old project's final state (all of supabase/migrations/ applied)
-- recreated in one file, plus:
--   * save_app_state() no longer clears-and-reinserts task_labels,
--     notif_prefs, push_subscriptions and password_reset_tokens on every save
--     (only rows that actually changed are touched), so the Sheet sync isn't
--     flooded with fake changes. What gets saved is unchanged.
--   * app_secrets is readable only by the service role (Edge Functions and
--     SECURITY DEFINER functions), not by the public key.
--   * Sheet sync is switched on for the schema: every save the app makes is
--     also dropped in the inbox for the Google Sheet (see 01_sheet_sync_core).
--
-- These tables are a CACHE of the Google Sheet, which is the real database.
-- They start empty; the Sheet's "Migrate from old marketing project" menu
-- item fills the Sheet from the old project and then fills these from the
-- Sheet.
--
-- AFTER RUNNING: Dashboard -> Project Settings -> Data API -> "Exposed
-- schemas" -> add `marketing`, then Save. Without that the app gets
-- "The schema must be one of the following..." errors.
--
-- Safe to run more than once.
-- ============================================================================

begin;

create schema if not exists marketing;

grant usage on schema marketing to anon, authenticated, service_role;

set local search_path = marketing, public;

-- ── Tables ──────────────────────────────────────────────────────────────

create table if not exists boards (
    id               text primary key,
    year             text,
    background_image text default '',
    assigned_to      text default '',
    settings         jsonb default '{}'::jsonb,
    created_at       timestamptz default now()
);

-- board_id/column_id are plain text (not enforced foreign keys), same as the
-- old project - see 20260808000000_normalize_app_state_schema.sql.
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
    id                   text primary key,
    board_id             text,
    column_id            text,
    title                text,
    description          text default '',
    legacy_text          text default '',
    due_date             text default '',
    event_location       text default '',
    priority             text default '',
    completed            boolean default false,
    posting_schedule     jsonb default '{"story":[],"photo":[],"reel":[]}'::jsonb,
    cover_image          text default '',
    members              text[] default '{}',
    sort_order           integer default 0,
    activity_log         jsonb default '[]'::jsonb,
    created_at           timestamptz default now(),
    monday_id            text,
    monday_attach_locked boolean not null default false
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
    id               text primary key,
    task_id          text not null references tasks(id) on delete cascade,
    user_name        text default '',
    text             text default '',
    time             text default '',
    monday_update_id text
);
create index if not exists idx_comments_task_id on comments(task_id);

create table if not exists attachments (
    id              text primary key,
    task_id         text not null references tasks(id) on delete cascade,
    name            text default '',
    url             text default '',
    viewer_url      text default '',
    is_link         boolean default false,
    size            text default '',
    date            text default '',
    mime_type       text default '',
    monday_asset_id text
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

create table if not exists user_activity_log (
    id         bigserial primary key,
    user_email text not null,
    user_name  text default '',
    action     text not null,
    detail     text default '',
    task_id    text,
    task_title text default '',
    created_at timestamptz not null default now()
);
create index if not exists idx_user_activity_log_user_email on user_activity_log(lower(user_email));
create index if not exists idx_user_activity_log_created_at on user_activity_log(created_at desc);

-- Brevo key etc. (read by send_password_reset_email and the
-- send-password-reset Edge Function). Service role only.
create table if not exists app_secrets (
    key   text primary key,
    value text
);

-- The old JSON blob. id = 1 is the pre-normalization snapshot (kept as a
-- backup), id = 2 is the app's Settings -> Data -> "Cloud backup".
create table if not exists app_state (
    id   bigint primary key,
    data jsonb
);

-- ── Row level security ──────────────────────────────────────────────────
-- Same posture as the old project: the app logs people in itself (not via
-- Supabase Auth) and always uses the one public key, so the app tables are
-- open to that key. app_secrets is the exception - no public policy.
do $$
declare tbl text;
begin
    foreach tbl in array array[
        'boards','columns','tasks','checklist_items','comments','attachments',
        'custom_fields','task_labels','users','automations','notifications',
        'notif_prefs','push_subscriptions','password_reset_tokens',
        'checklist_templates','app_settings','user_activity_log','app_state'
    ]
    loop
        execute format('alter table marketing.%I enable row level security', tbl);
        execute format('drop policy if exists allow_all on marketing.%I', tbl);
        execute format('create policy allow_all on marketing.%I for all to anon, authenticated using (true) with check (true)', tbl);
    end loop;
end $$;

alter table app_secrets enable row level security;

grant all on all tables in schema marketing to anon, authenticated, service_role;
grant all on all sequences in schema marketing to anon, authenticated, service_role;
revoke all on app_secrets from anon, authenticated;
alter default privileges in schema marketing grant all on tables to anon, authenticated, service_role;
alter default privileges in schema marketing grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema marketing grant execute on functions to anon, authenticated, service_role;

-- ── user_activity_log: keep each user's latest 300 rows ─────────────────
create or replace function marketing.trim_user_activity_log() returns trigger
language plpgsql set search_path = marketing, public as $$
begin
    delete from user_activity_log
    where id in (
        select id from user_activity_log
        where user_email = new.user_email
        order by created_at desc
        offset 300
    );
    return null;
end;
$$;

drop trigger if exists trg_trim_user_activity_log on user_activity_log;
create trigger trg_trim_user_activity_log
    after insert on user_activity_log
    for each row execute function marketing.trim_user_activity_log();

-- ── load_app_state / save_app_state ─────────────────────────────────────
create or replace function marketing.save_app_state(payload jsonb)
returns void
language plpgsql
set search_path = marketing, public
as $$
begin
    -- boards
    insert into boards (id, year, background_image, assigned_to, settings)
    select id, year, background_image, assigned_to, settings
    from (
        select distinct on (b->>'id')
            b->>'id' as id, b->>'year' as year,
            coalesce(b->>'backgroundImage','') as background_image,
            coalesce(b->>'assignedTo','') as assigned_to,
            coalesce(b->'settings','{}'::jsonb) as settings
        from jsonb_array_elements(coalesce(payload->'boards','[]'::jsonb)) with ordinality as arr(b, ord)
        order by b->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        year = excluded.year, background_image = excluded.background_image,
        assigned_to = excluded.assigned_to, settings = excluded.settings;

    delete from boards bd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'boards','[]'::jsonb)) as b
        where b->>'id' = bd.id
    );

    -- columns
    insert into columns (id, board_id, title, sort_order, assigned_to, hideable, members)
    select id, board_id, title, sort_order, assigned_to, hideable, members
    from (
        select distinct on (c->>'id')
            c->>'id' as id, c->>'boardId' as board_id, c->>'title' as title,
            coalesce((c->>'order')::int, 0) as sort_order,
            coalesce(c->>'assignedTo','') as assigned_to,
            coalesce((c->>'hideable')::boolean, true) as hideable,
            case when jsonb_typeof(c->'members') = 'array'
                 then array(select jsonb_array_elements_text(c->'members'))
                 else '{}'::text[] end as members
        from jsonb_array_elements(coalesce(payload->'columns','[]'::jsonb)) with ordinality as arr(c, ord)
        order by c->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        board_id = excluded.board_id, title = excluded.title, sort_order = excluded.sort_order,
        assigned_to = excluded.assigned_to, hideable = excluded.hideable, members = excluded.members;

    delete from columns cd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'columns','[]'::jsonb)) as c
        where c->>'id' = cd.id
    );

    -- tasks
    insert into tasks (id, board_id, column_id, title, description, legacy_text, due_date,
                        event_location, priority, completed, posting_schedule, cover_image,
                        members, sort_order, activity_log, monday_id, monday_attach_locked)
    select id, board_id, column_id, title, description, legacy_text, due_date,
           event_location, priority, completed, posting_schedule, cover_image,
           members, sort_order, activity_log, monday_id, monday_attach_locked
    from (
        select distinct on (t->>'id')
            t->>'id' as id, t->>'boardId' as board_id, t->>'columnId' as column_id, t->>'title' as title,
            coalesce(t->>'description','') as description, coalesce(t->>'text','') as legacy_text,
            coalesce(t->>'dueDate','') as due_date, coalesce(t->>'eventLocation','') as event_location,
            coalesce(t->>'priority','') as priority,
            coalesce((t->>'completed')::boolean, false) as completed,
            coalesce(t->'postingSchedule', '{"story":[],"photo":[],"reel":[]}'::jsonb) as posting_schedule,
            coalesce(t->>'coverImage','') as cover_image,
            case when jsonb_typeof(t->'members') = 'array'
                 then array(select jsonb_array_elements_text(t->'members'))
                 else '{}'::text[] end as members,
            (ord - 1)::int as sort_order,
            coalesce(t->'activity', '[]'::jsonb) as activity_log,
            t->>'_mondayId' as monday_id,
            coalesce((t->>'_mondayAttachLocked')::boolean, false) as monday_attach_locked,
            ord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) with ordinality as arr(t, ord)
        order by t->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        board_id = excluded.board_id, column_id = excluded.column_id, title = excluded.title,
        description = excluded.description, legacy_text = excluded.legacy_text, due_date = excluded.due_date,
        event_location = excluded.event_location, priority = excluded.priority, completed = excluded.completed,
        posting_schedule = excluded.posting_schedule, cover_image = excluded.cover_image,
        members = excluded.members, sort_order = excluded.sort_order, activity_log = excluded.activity_log,
        monday_id = excluded.monday_id, monday_attach_locked = excluded.monday_attach_locked;

    delete from tasks td where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t
        where t->>'id' = td.id
    );

    -- checklist_items
    insert into checklist_items (id, task_id, text, done, due_date, due_time, assigned_to, sort_order)
    select id, task_id, text, done, due_date, due_time, assigned_to, sort_order
    from (
        select distinct on (ci->>'id')
            ci->>'id' as id, t->>'id' as task_id, coalesce(ci->>'text','') as text,
            coalesce((ci->>'done')::boolean, false) as done,
            coalesce(ci->>'dueDate','') as due_date, coalesce(ci->>'dueTime','') as due_time,
            case when jsonb_typeof(ci->'assignedTo') = 'array'
                 then array(select jsonb_array_elements_text(ci->'assignedTo'))
                 when ci->>'assignedTo' is not null then array[ci->>'assignedTo']
                 else '{}'::text[] end as assigned_to,
            (ciord - 1)::int as sort_order,
            ciord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'checklist','[]'::jsonb)) with ordinality as arr2(ci, ciord)
        order by ci->>'id', ciord desc
    ) dedup
    on conflict (id) do update set
        task_id = excluded.task_id, text = excluded.text, done = excluded.done,
        due_date = excluded.due_date, due_time = excluded.due_time,
        assigned_to = excluded.assigned_to, sort_order = excluded.sort_order;

    delete from checklist_items cid where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'checklist','[]'::jsonb)) as ci
        where ci->>'id' = cid.id
    );

    -- comments
    insert into comments (id, task_id, user_name, text, time, monday_update_id)
    select id, task_id, user_name, text, time, monday_update_id
    from (
        select distinct on (c->>'id')
            c->>'id' as id, t->>'id' as task_id, coalesce(c->>'user','') as user_name,
            coalesce(c->>'text','') as text, coalesce(c->>'time','') as time,
            c->>'_mondayUpdateId' as monday_update_id, ord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'comments','[]'::jsonb)) with ordinality as arr(c, ord)
        order by c->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        task_id = excluded.task_id, user_name = excluded.user_name, text = excluded.text, time = excluded.time,
        monday_update_id = excluded.monday_update_id;

    delete from comments cd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'comments','[]'::jsonb)) as c
        where c->>'id' = cd.id
    );

    -- attachments
    insert into attachments (id, task_id, name, url, viewer_url, is_link, size, date, mime_type, monday_asset_id)
    select id, task_id, name, url, viewer_url, is_link, size, date, mime_type, monday_asset_id
    from (
        select distinct on (a->>'id')
            a->>'id' as id, t->>'id' as task_id, coalesce(a->>'name','') as name,
            coalesce(a->>'url','') as url, coalesce(a->>'viewerUrl','') as viewer_url,
            coalesce((a->>'isLink')::boolean, false) as is_link,
            coalesce(a->>'size','') as size, coalesce(a->>'date','') as date,
            coalesce(a->>'mimeType','') as mime_type, a->>'_mondayAssetId' as monday_asset_id, ord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'attachments','[]'::jsonb)) with ordinality as arr(a, ord)
        order by a->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        task_id = excluded.task_id, name = excluded.name, url = excluded.url, viewer_url = excluded.viewer_url,
        is_link = excluded.is_link, size = excluded.size, date = excluded.date, mime_type = excluded.mime_type,
        monday_asset_id = excluded.monday_asset_id;

    delete from attachments ad where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'attachments','[]'::jsonb)) as a
        where a->>'id' = ad.id
    );

    -- custom_fields
    insert into custom_fields (id, task_id, name, type, value, sort_order)
    select id, task_id, name, type, value, sort_order
    from (
        select distinct on (cf->>'id')
            cf->>'id' as id, t->>'id' as task_id, coalesce(cf->>'name','') as name,
            coalesce(cf->>'type','text') as type, coalesce(cf->>'value','') as value,
            (cford - 1)::int as sort_order, cford
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'customFields','[]'::jsonb)) with ordinality as arr3(cf, cford)
        order by cf->>'id', cford desc
    ) dedup
    on conflict (id) do update set
        task_id = excluded.task_id, name = excluded.name, type = excluded.type,
        value = excluded.value, sort_order = excluded.sort_order;

    delete from custom_fields cfd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'customFields','[]'::jsonb)) as cf
        where cf->>'id' = cfd.id
    );

    -- task_labels (no stable id in the source data). Only tasks whose label
    -- list actually changed get their labels replaced - replacing every
    -- task's labels on every save would look like constant changes to the
    -- Sheet sync.
    with incoming as (
        select distinct on (t->>'id') t->>'id' as task_id,
               coalesce((select jsonb_agg(jsonb_build_object('text', coalesce(l->>'text',''), 'color', coalesce(l->>'color','')) order by lord)
                         from jsonb_array_elements(coalesce(t->'labels','[]'::jsonb)) with ordinality as la(l, lord)), '[]'::jsonb) as labels
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) with ordinality as arr(t, ord)
        order by t->>'id', ord desc
    ),
    existing as (
        select task_id, jsonb_agg(jsonb_build_object('text', text, 'color', color) order by id) as labels
        from task_labels group by task_id
    ),
    changed as (
        select i.task_id, i.labels from incoming i
        left join existing e on e.task_id = i.task_id
        where coalesce(e.labels, '[]'::jsonb) <> i.labels
    ),
    del as (
        delete from task_labels tl using changed c where tl.task_id = c.task_id
    )
    insert into task_labels (task_id, text, color)
    select c.task_id, l->>'text', l->>'color'
    from changed c, jsonb_array_elements(c.labels) with ordinality as la(l, lord)
    order by c.task_id, lord;

    -- users
    insert into users (email, name, password, role, last_active, profile_picture)
    select email, name, password, role, last_active, profile_picture
    from (
        select distinct on (lower(u->>'email'))
            lower(u->>'email') as email, coalesce(u->>'name','') as name, u->>'password' as password,
            coalesce(u->>'role','user') as role, (u->>'lastActive')::bigint as last_active,
            coalesce(u->>'profilePicture','') as profile_picture, ord
        from jsonb_array_elements(coalesce(payload->'settings'->'users','[]'::jsonb)) with ordinality as arr(u, ord)
        order by lower(u->>'email'), ord desc
    ) dedup
    on conflict (email) do update set
        name = excluded.name, password = excluded.password, role = excluded.role,
        last_active = excluded.last_active, profile_picture = excluded.profile_picture;

    delete from users ud where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'settings'->'users','[]'::jsonb)) as u
        where lower(u->>'email') = ud.email
    );

    -- automations
    insert into automations (id, enabled, trigger_type, trigger_value, action_type, action_value)
    select id, enabled, trigger_type, trigger_value, action_type, action_value
    from (
        select distinct on (a->>'id')
            a->>'id' as id, coalesce((a->>'enabled')::boolean,false) as enabled,
            coalesce(a->>'trigger','') as trigger_type, coalesce(a->>'triggerValue','') as trigger_value,
            coalesce(a->>'action','') as action_type, coalesce(a->>'actionValue','') as action_value, ord
        from jsonb_array_elements(coalesce(payload->'automations','[]'::jsonb)) with ordinality as arr(a, ord)
        order by a->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        enabled = excluded.enabled, trigger_type = excluded.trigger_type,
        trigger_value = excluded.trigger_value, action_type = excluded.action_type,
        action_value = excluded.action_value;

    delete from automations ad where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'automations','[]'::jsonb)) as a
        where a->>'id' = ad.id
    );

    -- notifications (object keyed by user name -> array)
    insert into notifications (id, user_name, type, title, body, task_id, icon, icon_bg, read, timestamp)
    select id, user_name, type, title, body, task_id, icon, icon_bg, read, timestamp
    from (
        select distinct on (n->>'id')
            n->>'id' as id, kv.key as user_name, coalesce(n->>'type','') as type,
            coalesce(n->>'title','') as title, coalesce(n->>'body','') as body,
            n->>'taskId' as task_id, coalesce(n->>'icon','') as icon, coalesce(n->>'iconBg','') as icon_bg,
            coalesce((n->>'read')::boolean,false) as read, coalesce(n->>'timestamp','') as timestamp,
            nord
        from jsonb_each(coalesce(payload->'notifications','{}'::jsonb)) as kv,
             jsonb_array_elements(kv.value) with ordinality as arr(n, nord)
        order by n->>'id', nord desc
    ) dedup
    on conflict (id) do update set
        user_name = excluded.user_name, type = excluded.type, title = excluded.title, body = excluded.body,
        task_id = excluded.task_id, icon = excluded.icon, icon_bg = excluded.icon_bg,
        read = excluded.read, timestamp = excluded.timestamp;

    delete from notifications nd where not exists (
        select 1 from jsonb_each(coalesce(payload->'notifications','{}'::jsonb)) as kv,
             jsonb_array_elements(kv.value) as n
        where n->>'id' = nd.id
    );

    -- notif_prefs (object keyed by user name -> prefs object)
    -- (upsert + remove missing, rather than clear-and-reinsert, so unchanged
    -- rows stay unchanged for the Sheet sync)
    insert into notif_prefs (user_name, prefs)
    select kv.key, kv.value from jsonb_each(coalesce(payload->'notifPrefs','{}'::jsonb)) as kv
    on conflict (user_name) do update set prefs = excluded.prefs;
    delete from notif_prefs np where not (coalesce(payload->'notifPrefs','{}'::jsonb) ? np.user_name);

    -- push_subscriptions (object keyed by user name -> subscription object)
    insert into push_subscriptions (user_name, subscription)
    select kv.key, kv.value from jsonb_each(coalesce(payload->'pushSubscriptions','{}'::jsonb)) as kv
    on conflict (user_name) do update set subscription = excluded.subscription;
    delete from push_subscriptions ps where not (coalesce(payload->'pushSubscriptions','{}'::jsonb) ? ps.user_name);

    -- password_reset_tokens
    insert into password_reset_tokens (token, email, expiry)
    select distinct on (t->>'token') t->>'token', lower(t->>'email'), (t->>'expiry')::bigint
    from jsonb_array_elements(coalesce(payload->'settings'->'passwordResetTokens','[]'::jsonb)) as t
    where t->>'token' is not null
    on conflict (token) do update set email = excluded.email, expiry = excluded.expiry;
    delete from password_reset_tokens p where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'settings'->'passwordResetTokens','[]'::jsonb)) as t
        where t->>'token' = p.token
    );

    -- checklist_templates
    insert into checklist_templates (id, name, items)
    select id, name, items
    from (
        select distinct on (ct->>'id')
            ct->>'id' as id, coalesce(ct->>'name','') as name, coalesce(ct->'items','[]'::jsonb) as items, ord
        from jsonb_array_elements(coalesce(payload->'settings'->'checklistTemplates','[]'::jsonb)) with ordinality as arr(ct, ord)
        order by ct->>'id', ord desc
    ) dedup
    on conflict (id) do update set name = excluded.name, items = excluded.items;

    delete from checklist_templates ctd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'settings'->'checklistTemplates','[]'::jsonb)) as ct
        where ct->>'id' = ctd.id
    );

    -- app_settings (singleton)
    insert into app_settings (id, password, logo_url, app_icon_url, admin_profile_picture,
                               default_workspace_id, active_board_id, google_calendar_auto_sync,
                               google_calendar_webhook, cabbie_ai, scheduled_reminders_sent)
    values (
        1,
        payload->'settings'->>'password',
        coalesce(payload->'settings'->>'logoUrl',''),
        coalesce(payload->'settings'->>'appIconUrl',''),
        coalesce(payload->'settings'->>'adminProfilePicture',''),
        coalesce(payload->'settings'->>'defaultWorkspaceId',''),
        coalesce(payload->>'activeBoardId',''),
        coalesce((payload->'settings'->>'googleCalendarAutoSync')::boolean, false),
        coalesce(payload->'settings'->>'googleCalendarWebhook',''),
        coalesce(payload->'settings'->'cabbieAi', '{"apiKey":"","enabled":true}'::jsonb),
        coalesce(payload->'scheduledRemindersSent', '{}'::jsonb)
    )
    on conflict (id) do update set
        password = excluded.password, logo_url = excluded.logo_url, app_icon_url = excluded.app_icon_url,
        admin_profile_picture = excluded.admin_profile_picture, default_workspace_id = excluded.default_workspace_id,
        active_board_id = excluded.active_board_id, google_calendar_auto_sync = excluded.google_calendar_auto_sync,
        google_calendar_webhook = excluded.google_calendar_webhook, cabbie_ai = excluded.cabbie_ai,
        scheduled_reminders_sent = excluded.scheduled_reminders_sent;
end;
$$;

grant execute on function marketing.save_app_state(jsonb) to anon, authenticated;

create or replace function marketing.load_app_state()
returns jsonb
language sql
stable
set search_path = marketing, public
as $$
select jsonb_build_object(
    'boards', coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', b.id, 'year', b.year, 'backgroundImage', b.background_image,
            'assignedTo', b.assigned_to, 'settings', b.settings
        ) order by b.created_at)
        from boards b
    ), '[]'::jsonb),

    'columns', coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', c.id, 'boardId', c.board_id, 'title', c.title, 'order', c.sort_order,
            'assignedTo', c.assigned_to, 'hideable', c.hideable,
            'members', coalesce(to_jsonb(c.members), '[]'::jsonb)
        ) order by c.sort_order)
        from columns c
    ), '[]'::jsonb),

    'tasks', coalesce((
        select jsonb_agg(task_json order by sort_order)
        from (
            select
                t.sort_order,
                jsonb_build_object(
                    'id', t.id, 'boardId', t.board_id, 'columnId', t.column_id,
                    'title', t.title, 'description', t.description, 'text', t.legacy_text,
                    'dueDate', t.due_date, 'eventLocation', t.event_location, 'priority', t.priority,
                    'completed', t.completed, 'postingSchedule', t.posting_schedule,
                    'coverImage', t.cover_image,
                    'members', coalesce(to_jsonb(t.members), '[]'::jsonb),
                    'activity', t.activity_log,
                    '_mondayId', t.monday_id,
                    '_mondayAttachLocked', coalesce(t.monday_attach_locked, false),
                    'checklist', coalesce((
                        select jsonb_agg(jsonb_build_object(
                            'id', ci.id, 'text', ci.text, 'done', ci.done,
                            'dueDate', ci.due_date, 'dueTime', ci.due_time,
                            'assignedTo', coalesce(to_jsonb(ci.assigned_to), '[]'::jsonb)
                        ) order by ci.sort_order)
                        from checklist_items ci where ci.task_id = t.id
                    ), '[]'::jsonb),
                    'comments', coalesce((
                        select jsonb_agg(jsonb_build_object(
                            'id', cm.id, 'user', cm.user_name, 'text', cm.text, 'time', cm.time,
                            '_mondayUpdateId', cm.monday_update_id
                        ))
                        from comments cm where cm.task_id = t.id
                    ), '[]'::jsonb),
                    'attachments', coalesce((
                        select jsonb_agg(jsonb_build_object(
                            'id', a.id, 'name', a.name, 'url', a.url, 'viewerUrl', a.viewer_url,
                            'isLink', a.is_link, 'size', a.size, 'date', a.date, 'mimeType', a.mime_type,
                            '_mondayAssetId', a.monday_asset_id
                        ))
                        from attachments a where a.task_id = t.id
                    ), '[]'::jsonb),
                    'customFields', coalesce((
                        select jsonb_agg(jsonb_build_object('id', cf.id, 'name', cf.name, 'type', cf.type, 'value', cf.value) order by cf.sort_order)
                        from custom_fields cf where cf.task_id = t.id
                    ), '[]'::jsonb),
                    'labels', coalesce((
                        select jsonb_agg(jsonb_build_object('text', tl.text, 'color', tl.color))
                        from task_labels tl where tl.task_id = t.id
                    ), '[]'::jsonb)
                ) as task_json
            from tasks t
        ) as sub
    ), '[]'::jsonb),

    'automations', coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', a.id, 'enabled', a.enabled, 'trigger', a.trigger_type,
            'triggerValue', a.trigger_value, 'action', a.action_type, 'actionValue', a.action_value
        ))
        from automations a
    ), '[]'::jsonb),

    'settings', jsonb_build_object(
        'password', (select password from app_settings where id = 1),
        'logoUrl', (select logo_url from app_settings where id = 1),
        'appIconUrl', (select app_icon_url from app_settings where id = 1),
        'adminProfilePicture', (select admin_profile_picture from app_settings where id = 1),
        'defaultWorkspaceId', (select default_workspace_id from app_settings where id = 1),
        'googleCalendarAutoSync', (select coalesce(google_calendar_auto_sync, false) from app_settings where id = 1),
        'googleCalendarWebhook', (select google_calendar_webhook from app_settings where id = 1),
        'cabbieAi', (select coalesce(cabbie_ai, '{"apiKey":"","enabled":true}'::jsonb) from app_settings where id = 1),
        'users', coalesce((
            select jsonb_agg(jsonb_build_object(
                'email', u.email, 'name', u.name, 'password', u.password,
                'role', u.role, 'lastActive', u.last_active, 'profilePicture', u.profile_picture
            ))
            from users u
        ), '[]'::jsonb),
        'passwordResetTokens', coalesce((
            select jsonb_agg(jsonb_build_object('email', p.email, 'token', p.token, 'expiry', p.expiry))
            from password_reset_tokens p
        ), '[]'::jsonb),
        'checklistTemplates', coalesce((
            select jsonb_agg(jsonb_build_object('id', ct.id, 'name', ct.name, 'items', ct.items))
            from checklist_templates ct
        ), '[]'::jsonb)
    ),

    'notifications', coalesce((
        select jsonb_object_agg(n.user_name, n.notifs)
        from (
            select user_name, jsonb_agg(jsonb_build_object(
                'id', id, 'type', type, 'title', title, 'body', body, 'taskId', task_id,
                'icon', icon, 'iconBg', icon_bg, 'read', read, 'timestamp', timestamp
            ) order by timestamp desc) as notifs
            from notifications
            group by user_name
        ) n
    ), '{}'::jsonb),

    'notifPrefs', coalesce((
        select jsonb_object_agg(user_name, prefs) from notif_prefs
    ), '{}'::jsonb),

    'pushSubscriptions', coalesce((
        select jsonb_object_agg(user_name, subscription) from push_subscriptions
    ), '{}'::jsonb),

    'activeBoardId', (select active_board_id from app_settings where id = 1),
    'scheduledRemindersSent', (select coalesce(scheduled_reminders_sent, '{}'::jsonb) from app_settings where id = 1)
);
$$;

grant execute on function marketing.load_app_state() to anon, authenticated;

-- ── send_password_reset_email (called by the app via rpc) ───────────────
-- Needs the `http` extension (Dashboard -> Database -> Extensions, or the
-- line below) and a BREVO_API_KEY row in marketing.app_secrets (copied over
-- by the migration).
create extension if not exists http with schema extensions;

create or replace function marketing.send_password_reset_email(p_email text, p_app_url text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to marketing, extensions, public
as $function$
declare
  v_brevo_key   text;
  v_user_email  text;
  v_user_name   text;
  v_token       text;
  v_expiry      bigint;
  v_reset_url   text;
  v_body        text;
  v_http_resp   http_response;
begin
  select value into v_brevo_key from app_secrets where key = 'BREVO_API_KEY';
  if v_brevo_key is null then return '{"error":"Email service not configured"}'::jsonb; end if;

  select email, name into v_user_email, v_user_name
  from users where lower(email) = lower(p_email) limit 1;

  -- Return success regardless to avoid email enumeration
  if not found then return '{"success":true}'::jsonb; end if;

  v_token     := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  v_expiry    := (extract(epoch from now()) * 1000)::bigint + 3600000;
  v_user_name := coalesce(nullif(v_user_name,''), split_part(lower(p_email),'@',1));
  v_reset_url := p_app_url || '?reset=' || v_token;

  delete from password_reset_tokens where email = lower(p_email);
  insert into password_reset_tokens (token, email, expiry) values (v_token, lower(p_email), v_expiry);

  v_body := json_build_object(
    'sender',      json_build_object('name','CAB Marketing','email','noreply@cabgcu.com'),
    'to',          json_build_array(json_build_object('email',lower(p_email),'name',v_user_name)),
    'subject',     'Reset Your Password – CAB Marketing',
    'htmlContent', '<html><body style="margin:0;padding:0;background:#0a0a0a;font-family:sans-serif"><table width="100%" style="padding:40px 20px"><tr><td align="center"><table width="100%" style="max-width:480px;background:#111;border-radius:20px;border:1px solid rgba(255,255,255,0.1)"><tr><td style="padding:36px;text-align:center;background:linear-gradient(135deg,#6c63ff,#e056fd)"><h1 style="margin:0;color:#fff;font-size:1.6rem;font-weight:800">Reset Your Password</h1></td></tr><tr><td style="padding:32px"><p style="color:#ccc;margin:0 0 16px">Hi ' || v_user_name || ',</p><p style="color:#ccc;margin:0 0 24px">Click below to reset the password for <strong style="color:#fff">' || lower(p_email) || '</strong>. Expires in 1 hour.</p><div style="text-align:center;margin-bottom:24px"><a href="' || v_reset_url || '" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6c63ff,#e056fd);color:#fff;text-decoration:none;border-radius:12px;font-weight:700">Reset Password</a></div><p style="font-size:0.8rem;color:#555;text-align:center;margin:0">If you did not request this, ignore this email.</p></td></tr></table></td></tr></table></body></html>'
  )::text;

  select * into v_http_resp from http((
    'POST',
    'https://api.brevo.com/v3/smtp/email',
    array[
      http_header('api-key', v_brevo_key),
      http_header('Content-Type', 'application/json')
    ],
    'application/json',
    v_body
  )::http_request);

  if v_http_resp.status not between 200 and 299 then
    raise log 'Brevo error %: %', v_http_resp.status, v_http_resp.content;
    return jsonb_build_object('error', 'Email delivery failed: ' || v_http_resp.status);
  end if;

  return '{"success":true}'::jsonb;
exception when others then
  raise log 'send_password_reset_email error: %', sqlerrm;
  return jsonb_build_object('error', sqlerrm);
end;
$function$;

grant execute on function marketing.send_password_reset_email(text, text) to anon, authenticated;

-- ── Switch on the Sheet inbox for every table in the schema ─────────────
select public.sheet_sync_enable('marketing');

commit;

-- Optional sanity check: should list 19 tables.
-- select event_object_table from information_schema.triggers
-- where trigger_schema = 'marketing' and trigger_name = 'sheet_sync_capture'
-- group by 1 order by 1;
