-- ============================================================================
-- Per-user activity log, for the admin "click a user, see what they've been
-- doing" view (User Management -> click a user / "Activity" button).
-- ============================================================================
-- This is its own table, written to directly from the client (like
-- notifications and push_subscriptions already are) rather than a field on
-- the app_state JSON blob, so it never goes through load_app_state /
-- save_app_state and can't be clobbered by, or clobber, a save of the rest
-- of the app's data.
--
-- SAFE TO RUN: only creates a new table (IF NOT EXISTS) and a trigger. It
-- does not touch any existing table.
-- ============================================================================

begin;

create table if not exists user_activity_log (
    id         bigserial primary key,
    user_email text not null,
    user_name  text default '',
    action     text not null,       -- 'view' | 'edit' | 'create' | 'delete' | 'move' | 'comment' | 'comment_delete' | 'login' | 'logout'
    detail     text default '',
    task_id    text,
    task_title text default '',
    created_at timestamptz not null default now()
);
create index if not exists idx_user_activity_log_user_email on user_activity_log(lower(user_email));
create index if not exists idx_user_activity_log_created_at on user_activity_log(created_at desc);

-- Same posture as every other table in this app (see
-- 20260808000000_normalize_app_state_schema.sql): no Supabase Auth, one
-- shared anon key for every app user, so RLS just grants full access.
alter table user_activity_log enable row level security;
drop policy if exists allow_all on user_activity_log;
create policy allow_all on user_activity_log for all to anon, authenticated using (true) with check (true);

-- Keep the table bounded: after each insert, trim that user's history back
-- to the most recent 300 rows so activity logging can't grow unbounded.
create or replace function trim_user_activity_log() returns trigger as $$
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
$$ language plpgsql;

drop trigger if exists trg_trim_user_activity_log on user_activity_log;
create trigger trg_trim_user_activity_log
    after insert on user_activity_log
    for each row execute function trim_user_activity_log();

commit;
