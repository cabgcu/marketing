-- ============================================================================
-- Sheet sync core  (run FIRST in the NEW Supabase project)
-- ============================================================================
-- The Google Sheet is the master copy of every site's data; Supabase is the
-- fast copy the sites actually talk to. This file adds the generic plumbing
-- the Sheet's Apps Script uses to keep the two in step. It is site-agnostic:
-- every site gets its own schema (marketing, ...), and one call to
-- public.sheet_sync_enable('<schema>') wires that schema up.
--
-- What it adds:
--   * public.sheet_sync_deletions   - a record of deleted rows, so the Sheet
--                                     can remove them too
--   * sheet_sync_enable(schema)     - gives every table in a schema an
--                                     updated_at column + the triggers that
--                                     maintain it and record deletes
--   * sheet_sync_schema(schema)     - column list/types/primary keys (the
--                                     Sheet builds its headers from this)
--   * sheet_sync_changes(schema, since) - everything changed/deleted since a
--                                     point in time, in ONE call (Apps Script
--                                     has a daily cap on web requests)
--   * sheet_sync_apply(...)         - applies Sheet edits: only the cells
--                                     that were edited are written, so a
--                                     Sheet edit never overwrites newer app
--                                     edits in other columns
--   * sheet_sync_fix_sequences(schema) - after a bulk copy with explicit ids
--
-- All of these are callable only with the service-role/secret key (the
-- Sheet's script). The sites' public key cannot call them.
--
-- Safe to run more than once.
-- ============================================================================

begin;

create table if not exists public.sheet_sync_deletions (
    id          bigserial primary key,
    schema_name text not null,
    table_name  text not null,
    row_pk      text not null,
    deleted_at  timestamptz not null default now()
);
create index if not exists idx_sheet_sync_deletions_lookup
    on public.sheet_sync_deletions (schema_name, deleted_at);

alter table public.sheet_sync_deletions enable row level security;
revoke all on public.sheet_sync_deletions from anon, authenticated;

-- ── Triggers ────────────────────────────────────────────────────────────
-- Only bump updated_at when something actually changed. save_app_state()
-- re-upserts every row on every save; without this check every save would
-- look like every row changed.
create or replace function public.sheet_sync_touch() returns trigger
language plpgsql as $$
begin
    if new is distinct from old then
        new.updated_at := now();
    end if;
    return new;
end $$;

-- TG_ARGV[0] = primary key column name
create or replace function public.sheet_sync_record_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    insert into public.sheet_sync_deletions (schema_name, table_name, row_pk)
    values (tg_table_schema, tg_table_name, to_jsonb(old) ->> tg_argv[0]);
    return null;
end $$;

-- ── Enable a schema ─────────────────────────────────────────────────────
-- Every table with a single-column primary key gets updated_at + triggers.
-- Run again after adding tables to a site's schema.
create or replace function public.sheet_sync_enable(p_schema text) returns text
language plpgsql as $$
declare
    r record;
    n int := 0;
begin
    for r in
        select c.relname as tbl, a.attname as pk
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        join pg_index i on i.indrelid = c.oid and i.indisprimary
        join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
        where ns.nspname = p_schema and c.relkind = 'r' and i.indnatts = 1
    loop
        execute format('alter table %I.%I add column if not exists updated_at timestamptz not null default now()', p_schema, r.tbl);
        execute format('create index if not exists %I on %I.%I (updated_at)', 'idx_' || r.tbl || '_updated_at', p_schema, r.tbl);
        execute format('drop trigger if exists sheet_sync_touch on %I.%I', p_schema, r.tbl);
        execute format('create trigger sheet_sync_touch before update on %I.%I for each row execute function public.sheet_sync_touch()', p_schema, r.tbl);
        execute format('drop trigger if exists sheet_sync_record_delete on %I.%I', p_schema, r.tbl);
        execute format('create trigger sheet_sync_record_delete after delete on %I.%I for each row execute function public.sheet_sync_record_delete(%L)', p_schema, r.tbl, r.pk);
        n := n + 1;
    end loop;
    return format('sheet sync enabled on %s tables in schema %s', n, p_schema);
end $$;

-- ── Schema description for the Sheet ────────────────────────────────────
create or replace function public.sheet_sync_schema(p_schema text) returns jsonb
language sql stable as $$
    select coalesce(jsonb_agg(t order by t->>'table'), '[]'::jsonb)
    from (
        select jsonb_build_object(
            'table', c.relname,
            'pk', (select a.attname from pg_index i
                   join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
                   where i.indrelid = c.oid and i.indisprimary and i.indnatts = 1),
            'columns', (select jsonb_agg(jsonb_build_object(
                                'name', a.attname,
                                'type', format_type(a.atttypid, a.atttypmod),
                                'has_default', a.atthasdef,
                                'not_null', a.attnotnull) order by a.attnum)
                        from pg_attribute a
                        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)
        ) as t
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = p_schema and c.relkind = 'r'
    ) s;
$$;

-- ── Changes since a point in time ───────────────────────────────────────
-- p_since null = everything (full rebuild). Returns
--   { server_now, tables: { <table>: [rows...] }, deleted: [{table, pk, deleted_at}] }
-- p_skip_tables: tables the Sheet doesn't hold (secrets etc.) - not sent.
create or replace function public.sheet_sync_changes(
    p_schema text, p_since timestamptz default null, p_skip_tables text[] default '{}'
) returns jsonb
language plpgsql stable as $$
declare
    r record;
    rows jsonb;
    tables jsonb := '{}'::jsonb;
    server_now timestamptz := now();
begin
    for r in
        select c.relname as tbl
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
        where ns.nspname = p_schema and c.relkind = 'r'
          and not (c.relname = any (coalesce(p_skip_tables, '{}')))
    loop
        execute format(
            'select coalesce(jsonb_agg(to_jsonb(t) order by t.updated_at), ''[]''::jsonb) from %I.%I t where $1 is null or t.updated_at >= $1',
            p_schema, r.tbl) into rows using p_since;
        if jsonb_array_length(rows) > 0 or p_since is null then
            tables := tables || jsonb_build_object(r.tbl, rows);
        end if;
    end loop;

    return jsonb_build_object(
        'server_now', server_now,
        'tables', tables,
        'deleted', case when p_since is null then '[]'::jsonb else coalesce((
            select jsonb_agg(jsonb_build_object('table', d.table_name, 'pk', d.row_pk, 'deleted_at', d.deleted_at) order by d.id)
            from public.sheet_sync_deletions d
            where d.schema_name = p_schema and d.deleted_at >= p_since
              and not (d.table_name = any (coalesce(p_skip_tables, '{}')))
        ), '[]'::jsonb) end
    );
end $$;

-- ── Apply Sheet edits ───────────────────────────────────────────────────
-- p_upserts: [{ "row": {col: value, ...}, "cols": ["edited", "columns"] }, ...]
--   * row has a primary key and it exists  -> UPDATE only the "cols" columns
--   * row has a primary key but it's gone  -> INSERT the whole row (the Sheet
--     is the master: a row someone deleted in an app while it was being
--     edited in the Sheet comes back)
--   * row has no primary key value         -> INSERT (key from its default)
-- p_deletes: ["pk", ...]
-- One bad row doesn't stop the rest: per-row errors are returned.
create or replace function public.sheet_sync_apply(
    p_schema text, p_table text, p_upserts jsonb default '[]', p_deletes jsonb default '[]'
) returns jsonb
language plpgsql as $$
declare
    v_pk text;
    v_cols text[];
    item jsonb;
    v_row jsonb;
    v_set text[];
    v_ins text[];
    v_result jsonb;
    applied jsonb := '[]'::jsonb;
    errors jsonb := '[]'::jsonb;
    n_deleted int := 0;
begin
    select a.attname into v_pk
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_index i on i.indrelid = c.oid and i.indisprimary and i.indnatts = 1
    join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
    where ns.nspname = p_schema and c.relname = p_table;
    if v_pk is null then
        raise exception 'sheet_sync_apply: %.% not found or has no single-column primary key', p_schema, p_table;
    end if;

    select array_agg(a.attname::text) into v_cols
    from pg_attribute a
    where a.attrelid = format('%I.%I', p_schema, p_table)::regclass and a.attnum > 0 and not a.attisdropped;

    for item in select * from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb))
    loop
        v_row := item->'row';
        v_result := null;
        begin
            -- edited columns that really exist (never the pk or updated_at)
            select array_agg(c) into v_set
            from jsonb_array_elements_text(coalesce(item->'cols', '[]'::jsonb)) c
            where c = any (v_cols) and c <> v_pk and c <> 'updated_at' and v_row ? c;

            if coalesce(v_row->>v_pk, '') <> '' and v_set is not null then
                execute format(
                    'update %I.%I t set (%s) = (select %s from jsonb_populate_record(null::%I.%I, $1) r) where t.%I::text = $1->>%L returning to_jsonb(t)',
                    p_schema, p_table,
                    (select string_agg(format('%I', c), ', ') from unnest(v_set) c),
                    (select string_agg(format('r.%I', c), ', ') from unnest(v_set) c),
                    p_schema, p_table, v_pk, v_pk)
                into v_result using v_row;
            elsif coalesce(v_row->>v_pk, '') <> '' then
                -- nothing editable changed; just report the current row if present
                execute format('select to_jsonb(t) from %I.%I t where t.%I::text = $1->>%L', p_schema, p_table, v_pk, v_pk)
                into v_result using v_row;
            end if;

            if v_result is null then
                if coalesce(v_row->>v_pk, '') = '' then
                    v_row := v_row - v_pk;   -- let the column default fill it
                end if;
                select array_agg(c) into v_ins
                from jsonb_object_keys(v_row) c
                where c = any (v_cols) and c <> 'updated_at'
                  and not (c = v_pk and coalesce(v_row->>v_pk, '') = '');
                if v_ins is null then
                    raise exception 'row has no values';
                end if;
                execute format(
                    'insert into %I.%I as x (%s) select %s from jsonb_populate_record(null::%I.%I, $1) r returning to_jsonb(x)',
                    p_schema, p_table,
                    (select string_agg(format('%I', c), ', ') from unnest(v_ins) c),
                    (select string_agg(format('r.%I', c), ', ') from unnest(v_ins) c),
                    p_schema, p_table)
                into v_result using v_row;
            end if;

            applied := applied || jsonb_build_array(jsonb_build_object('ref', item->'ref', 'row', v_result));
        exception when others then
            errors := errors || jsonb_build_array(jsonb_build_object('ref', item->'ref', 'pk', v_row->>v_pk, 'error', sqlerrm));
        end;
    end loop;

    if jsonb_array_length(coalesce(p_deletes, '[]'::jsonb)) > 0 then
        execute format('delete from %I.%I t where t.%I::text in (select jsonb_array_elements_text($1))', p_schema, p_table, v_pk)
        using p_deletes;
        get diagnostics n_deleted = row_count;
    end if;

    return jsonb_build_object('applied', applied, 'errors', errors, 'deleted', n_deleted);
end $$;

-- ── After a bulk copy with explicit ids ─────────────────────────────────
create or replace function public.sheet_sync_fix_sequences(p_schema text) returns jsonb
language plpgsql as $$
declare
    r record;
    v_max bigint;
    out jsonb := '{}'::jsonb;
begin
    for r in
        select c.relname as tbl, a.attname as col, pg_get_serial_sequence(format('%I.%I', ns.nspname, c.relname), a.attname) as seq
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where ns.nspname = p_schema and c.relkind = 'r'
          and pg_get_serial_sequence(format('%I.%I', ns.nspname, c.relname), a.attname) is not null
    loop
        execute format('select max(%I) from %I.%I', r.col, p_schema, r.tbl) into v_max;
        if v_max is not null then
            perform setval(r.seq, v_max);
            out := out || jsonb_build_object(r.tbl, v_max);
        end if;
    end loop;
    return out;
end $$;

-- Housekeeping: deletion records older than 30 days are no longer needed
-- (the Sheet syncs every minute). Called by the sync on each run.
create or replace function public.sheet_sync_prune() returns void
language sql as $$
    delete from public.sheet_sync_deletions where deleted_at < now() - interval '30 days';
$$;

-- Lock everything down to the service role (the Sheet's script).
revoke all on function public.sheet_sync_enable(text) from public, anon, authenticated;
revoke all on function public.sheet_sync_schema(text) from public, anon, authenticated;
revoke all on function public.sheet_sync_changes(text, timestamptz, text[]) from public, anon, authenticated;
revoke all on function public.sheet_sync_apply(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sheet_sync_fix_sequences(text) from public, anon, authenticated;
revoke all on function public.sheet_sync_prune() from public, anon, authenticated;
grant execute on function public.sheet_sync_schema(text) to service_role;
grant execute on function public.sheet_sync_changes(text, timestamptz, text[]) to service_role;
grant execute on function public.sheet_sync_apply(text, text, jsonb, jsonb) to service_role;
grant execute on function public.sheet_sync_fix_sequences(text) to service_role;
grant execute on function public.sheet_sync_prune() to service_role;
grant all on public.sheet_sync_deletions to service_role;
grant usage on sequence public.sheet_sync_deletions_id_seq to service_role;

commit;
