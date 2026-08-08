-- ============================================================================
-- load_app_state() / save_app_state(payload)
-- ============================================================================
-- These two functions are the ongoing read/write API the app uses instead of
-- app_state. The client still works with one JSON object in memory (that
-- part of the app doesn't need to change), but that object is now assembled
-- from / torn down into the real tables created in the previous migration,
-- not a single text blob.
--
-- save_app_state upserts every row from the payload and deletes rows that
-- are no longer present in it (so edits and deletions both persist), rather
-- than blindly truncating and reinserting everything on every save — that
-- would reset created_at timestamps and needlessly touch unrelated rows on
-- every autosave.
--
-- Run this AFTER 20260808000000_normalize_app_state_schema.sql.
-- ============================================================================

create or replace function save_app_state(payload jsonb)
returns void
language plpgsql
as $$
begin
    -- boards
    insert into boards (id, year, background_image, assigned_to, settings)
    select b->>'id', b->>'year', coalesce(b->>'backgroundImage',''), coalesce(b->>'assignedTo',''), coalesce(b->'settings','{}'::jsonb)
    from jsonb_array_elements(coalesce(payload->'boards','[]'::jsonb)) as b
    on conflict (id) do update set
        year = excluded.year, background_image = excluded.background_image,
        assigned_to = excluded.assigned_to, settings = excluded.settings;

    delete from boards bd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'boards','[]'::jsonb)) as b
        where b->>'id' = bd.id
    );

    -- columns
    insert into columns (id, board_id, title, sort_order, assigned_to, hideable, members)
    select
        c->>'id', c->>'boardId', c->>'title', coalesce((c->>'order')::int, 0),
        coalesce(c->>'assignedTo',''), coalesce((c->>'hideable')::boolean, true),
        case when jsonb_typeof(c->'members') = 'array'
             then array(select jsonb_array_elements_text(c->'members'))
             else '{}'::text[] end
    from jsonb_array_elements(coalesce(payload->'columns','[]'::jsonb)) as c
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
    select
        t->>'id', t->>'boardId', t->>'columnId', t->>'title',
        coalesce(t->>'description',''), coalesce(t->>'text',''), coalesce(t->>'dueDate',''),
        coalesce(t->>'eventLocation',''), coalesce(t->>'priority',''),
        coalesce((t->>'completed')::boolean, false),
        coalesce(t->'postingSchedule', '{"story":[],"photo":[],"reel":[]}'::jsonb),
        coalesce(t->>'coverImage',''),
        case when jsonb_typeof(t->'members') = 'array'
             then array(select jsonb_array_elements_text(t->'members'))
             else '{}'::text[] end,
        (ord - 1)::int,
        coalesce(t->'activity', '[]'::jsonb)
    from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) with ordinality as arr(t, ord)
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
    select
        ci->>'id', t->>'id', coalesce(ci->>'text',''), coalesce((ci->>'done')::boolean, false),
        coalesce(ci->>'dueDate',''), coalesce(ci->>'dueTime',''),
        case when jsonb_typeof(ci->'assignedTo') = 'array'
             then array(select jsonb_array_elements_text(ci->'assignedTo'))
             when ci->>'assignedTo' is not null then array[ci->>'assignedTo']
             else '{}'::text[] end,
        (ciord - 1)::int
    from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
         jsonb_array_elements(coalesce(t->'checklist','[]'::jsonb)) with ordinality as arr2(ci, ciord)
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
    select c->>'id', t->>'id', coalesce(c->>'user',''), coalesce(c->>'text',''), coalesce(c->>'time','')
    from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
         jsonb_array_elements(coalesce(t->'comments','[]'::jsonb)) as c
    on conflict (id) do update set
        task_id = excluded.task_id, user_name = excluded.user_name, text = excluded.text, time = excluded.time;

    delete from comments cd where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
             jsonb_array_elements(coalesce(t->'comments','[]'::jsonb)) as c
        where c->>'id' = cd.id
    );

    -- attachments
    insert into attachments (id, task_id, name, url, viewer_url, is_link, size, date, mime_type)
    select
        a->>'id', t->>'id', coalesce(a->>'name',''), coalesce(a->>'url',''), coalesce(a->>'viewerUrl',''),
        coalesce((a->>'isLink')::boolean, false), coalesce(a->>'size',''), coalesce(a->>'date',''),
        coalesce(a->>'mimeType','')
    from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
         jsonb_array_elements(coalesce(t->'attachments','[]'::jsonb)) as a
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
    select cf->>'id', t->>'id', coalesce(cf->>'name',''), coalesce(cf->>'type','text'), coalesce(cf->>'value',''), (cford - 1)::int
    from jsonb_array_elements(coalesce(payload->'tasks','[]'::jsonb)) as t,
         jsonb_array_elements(coalesce(t->'customFields','[]'::jsonb)) with ordinality as arr3(cf, cford)
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
    select lower(u->>'email'), coalesce(u->>'name',''), u->>'password', coalesce(u->>'role','user'),
           (u->>'lastActive')::bigint, coalesce(u->>'profilePicture','')
    from jsonb_array_elements(coalesce(payload->'settings'->'users','[]'::jsonb)) as u
    on conflict (email) do update set
        name = excluded.name, password = excluded.password, role = excluded.role,
        last_active = excluded.last_active, profile_picture = excluded.profile_picture;

    delete from users ud where not exists (
        select 1 from jsonb_array_elements(coalesce(payload->'settings'->'users','[]'::jsonb)) as u
        where lower(u->>'email') = ud.email
    );

    -- automations
    insert into automations (id, enabled, trigger_type, trigger_value, action_type, action_value)
    select a->>'id', coalesce((a->>'enabled')::boolean,false), coalesce(a->>'trigger',''),
           coalesce(a->>'triggerValue',''), coalesce(a->>'action',''), coalesce(a->>'actionValue','')
    from jsonb_array_elements(coalesce(payload->'automations','[]'::jsonb)) as a
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
    select n->>'id', kv.key, coalesce(n->>'type',''), coalesce(n->>'title',''), coalesce(n->>'body',''),
           n->>'taskId', coalesce(n->>'icon',''), coalesce(n->>'iconBg',''),
           coalesce((n->>'read')::boolean,false), coalesce(n->>'timestamp','')
    from jsonb_each(coalesce(payload->'notifications','{}'::jsonb)) as kv,
         jsonb_array_elements(kv.value) as n
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
    select ct->>'id', coalesce(ct->>'name',''), coalesce(ct->'items','[]'::jsonb)
    from jsonb_array_elements(coalesce(payload->'settings'->'checklistTemplates','[]'::jsonb)) as ct
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

create or replace function load_app_state()
returns jsonb
language sql
stable
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
                    'checklist', coalesce((
                        select jsonb_agg(jsonb_build_object(
                            'id', ci.id, 'text', ci.text, 'done', ci.done,
                            'dueDate', ci.due_date, 'dueTime', ci.due_time,
                            'assignedTo', coalesce(to_jsonb(ci.assigned_to), '[]'::jsonb)
                        ) order by ci.sort_order)
                        from checklist_items ci where ci.task_id = t.id
                    ), '[]'::jsonb),
                    'comments', coalesce((
                        select jsonb_agg(jsonb_build_object('id', cm.id, 'user', cm.user_name, 'text', cm.text, 'time', cm.time))
                        from comments cm where cm.task_id = t.id
                    ), '[]'::jsonb),
                    'attachments', coalesce((
                        select jsonb_agg(jsonb_build_object(
                            'id', a.id, 'name', a.name, 'url', a.url, 'viewerUrl', a.viewer_url,
                            'isLink', a.is_link, 'size', a.size, 'date', a.date, 'mimeType', a.mime_type
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

grant execute on function load_app_state() to anon, authenticated;
grant execute on function save_app_state(jsonb) to anon, authenticated;
