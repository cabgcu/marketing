-- ============================================================================
-- Harden save_app_state() against duplicate ids within one payload
-- ============================================================================
-- A real bug (task copying reusing checklist/comment/customField/attachment
-- ids from the original task) showed how a client-side bug that produces two
-- rows with the same id in one save previously failed the WHOLE save with
-- Postgres error 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
-- second time"). That specific bug is fixed client-side, but this migration
-- makes save_app_state tolerate it regardless: each insert now collapses
-- duplicate ids down to the last occurrence in the payload before writing,
-- so a future bug like it degrades to "one of the duplicates wins" instead
-- of "nothing saves at all."
--
-- Run this AFTER 20260808000000_normalize_app_state_schema.sql and
-- 20260808000001_app_state_rpc_functions.sql. Safe to run more than once.
-- ============================================================================

create or replace function save_app_state(payload jsonb)
returns void
language plpgsql
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
                        members, sort_order, activity_log)
    select id, board_id, column_id, title, description, legacy_text, due_date,
           event_location, priority, completed, posting_schedule, cover_image,
           members, sort_order, activity_log
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
            ord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) with ordinality as arr(t, ord)
        order by t->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        board_id = excluded.board_id, column_id = excluded.column_id, title = excluded.title,
        description = excluded.description, legacy_text = excluded.legacy_text, due_date = excluded.due_date,
        event_location = excluded.event_location, priority = excluded.priority, completed = excluded.completed,
        posting_schedule = excluded.posting_schedule, cover_image = excluded.cover_image,
        members = excluded.members, sort_order = excluded.sort_order, activity_log = excluded.activity_log;

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
    insert into comments (id, task_id, user_name, text, time)
    select id, task_id, user_name, text, time
    from (
        select distinct on (c->>'id')
            c->>'id' as id, t->>'id' as task_id, coalesce(c->>'user','') as user_name,
            coalesce(c->>'text','') as text, coalesce(c->>'time','') as time, ord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'comments','[]'::jsonb)) with ordinality as arr(c, ord)
        order by c->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        task_id = excluded.task_id, user_name = excluded.user_name, text = excluded.text, time = excluded.time;

    delete from comments cd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'comments','[]'::jsonb)) as c
        where c->>'id' = cd.id
    );

    -- attachments
    insert into attachments (id, task_id, name, url, viewer_url, is_link, size, date, mime_type)
    select id, task_id, name, url, viewer_url, is_link, size, date, mime_type
    from (
        select distinct on (a->>'id')
            a->>'id' as id, t->>'id' as task_id, coalesce(a->>'name','') as name,
            coalesce(a->>'url','') as url, coalesce(a->>'viewerUrl','') as viewer_url,
            coalesce((a->>'isLink')::boolean, false) as is_link,
            coalesce(a->>'size','') as size, coalesce(a->>'date','') as date,
            coalesce(a->>'mimeType','') as mime_type, ord
        from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'attachments','[]'::jsonb)) with ordinality as arr(a, ord)
        order by a->>'id', ord desc
    ) dedup
    on conflict (id) do update set
        task_id = excluded.task_id, name = excluded.name, url = excluded.url, viewer_url = excluded.viewer_url,
        is_link = excluded.is_link, size = excluded.size, date = excluded.date, mime_type = excluded.mime_type;

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

    -- task_labels (no stable id in the source data — replace wholesale per task)
    delete from task_labels tl where exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t
        where t->>'id' = tl.task_id
    );
    insert into task_labels (task_id, text, color)
    select t->>'id', coalesce(l->>'text',''), coalesce(l->>'color','')
    from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
         jsonb_array_elements(coalesce(t->'labels','[]'::jsonb)) as l;

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
    delete from notif_prefs;
    insert into notif_prefs (user_name, prefs)
    select kv.key, kv.value from jsonb_each(coalesce(payload->'notifPrefs','{}'::jsonb)) as kv;

    -- push_subscriptions (object keyed by user name -> subscription object)
    delete from push_subscriptions;
    insert into push_subscriptions (user_name, subscription)
    select kv.key, kv.value from jsonb_each(coalesce(payload->'pushSubscriptions','{}'::jsonb)) as kv;

    -- password_reset_tokens
    delete from password_reset_tokens;
    insert into password_reset_tokens (token, email, expiry)
    select t->>'token', lower(t->>'email'), (t->>'expiry')::bigint
    from jsonb_array_elements(coalesce(payload->'settings'->'passwordResetTokens','[]'::jsonb)) as t;

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

grant execute on function save_app_state(jsonb) to anon, authenticated;
