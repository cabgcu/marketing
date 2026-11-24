-- ============================================================================
-- Sheet sync core  (run FIRST in the NEW Supabase project)
-- ============================================================================
-- The Google Sheet is THE database. Supabase is only:
--   1. a fast read cache of the Sheet, so pages load quickly, and
--   2. a short-lived INBOX for saves made in the sites, which the Sheet's
--      Apps Script moves into the Sheet (usually within minutes) and then
--      deletes from the inbox.
-- Supabase can be wiped and rebuilt from the Sheet at any time
-- (sheet_sync_replace, Hub -> Rebuild Supabase from Sheet).
--
-- This file is site-agnostic: every site gets its own schema (marketing, ...)
-- and one call to public.sheet_sync_enable('<schema>') wires it up.
--
--   sheet_inbox                 - saves from the sites, waiting for the Sheet.
--                                 Insert = whole row, update = only the
--                                 columns that changed, delete = just the key.
--   sheet_sync_enable(schema)   - adds the inbox trigger to every table
--   sheet_sync_schema(schema)   - columns / types / primary keys
--   sheet_inbox_read(schema)    - oldest waiting saves
--   sheet_inbox_ack(schema, id) - "these are in the Sheet now" -> deleted
--   sheet_sync_apply(...)       - writes Sheet edits into the cache (only the
--                                 edited cells; never echoes into the inbox)
--   sheet_sync_rows(...)        - fetch specific rows
--   sheet_sync_dump(schema)     - the whole cache (emergency restore only)
--   sheet_sync_replace(...)     - atomically replace the cache with the Sheet
--
-- All callable only with the service-role/secret key (the Sheet's script).
-- Safe to run more than once.
-- ============================================================================

begin;

create table if not exists public.sheet_inbox (
    id          bigserial primary key,
    schema_name text not null,
    table_name  text not null,
    op          char(1) not null check (op in ('I', 'U', 'D')),
    row_pk      text not null,
    data        jsonb,
    created_at  timestamptz not null default now()
);
create index if not exists idx_sheet_inbox_schema on public.sheet_inbox (schema_name, id);

alter table public.sheet_inbox enable row level security;
revoke all on public.sheet_inbox from anon, authenticated;

-- ── Inbox trigger ───────────────────────────────────────────────────────
-- TG_ARGV[0] = primary key column. Writes made by the Sheet's script set
-- sheet_sync.applying = on, so they don't bounce back into the inbox.
create or replace function public.sheet_sync_capture() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    pk text := tg_argv[0];
    n jsonb;
    o jsonb;
    diff jsonb;
begin
    if coalesce(current_setting('sheet_sync.applying', true), '') = 'on' then
        return null;
    end if;
    if tg_op = 'INSERT' then
        n := to_jsonb(new);
        insert into public.sheet_inbox (schema_name, table_name, op, row_pk, data)
        values (tg_table_schema, tg_table_name, 'I', n ->> pk, n);
    elsif tg_op = 'UPDATE' then
        n := to_jsonb(new);
        o := to_jsonb(old);
        if (n ->> pk) is distinct from (o ->> pk) then
            insert into public.sheet_inbox (schema_name, table_name, op, row_pk, data)
            values (tg_table_schema, tg_table_name, 'D', o ->> pk, null),
                   (tg_table_schema, tg_table_name, 'I', n ->> pk, n);
        else
            select jsonb_object_agg(e.key, e.value) into diff
            from jsonb_each(n) e
            where (o -> e.key) is distinct from e.value;
            -- save_app_state re-saves every row; unchanged rows produce nothing
            if diff is not null then
                insert into public.sheet_inbox (schema_name, table_name, op, row_pk, data)
                values (tg_table_schema, tg_table_name, 'U', n ->> pk, diff);
            end if;
        end if;
    else
        insert into public.sheet_inbox (schema_name, table_name, op, row_pk, data)
        values (tg_table_schema, tg_table_name, 'D', to_jsonb(old) ->> pk, null);
    end if;
    return null;
end $$;

-- ── Enable a schema (run again after adding tables) ─────────────────────
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
        execute format('drop trigger if exists sheet_sync_capture on %I.%I', p_schema, r.tbl);
        execute format('create trigger sheet_sync_capture after insert or update or delete on %I.%I for each row execute function public.sheet_sync_capture(%L)', p_schema, r.tbl, r.pk);
        n := n + 1;
    end loop;
    return format('sheet sync enabled on %s tables in schema %s', n, p_schema);
end $$;

-- ── Schema description ──────────────────────────────────────────────────
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

-- ── Inbox read / acknowledge ────────────────────────────────────────────
create or replace function public.sheet_inbox_read(p_schema text, p_limit int default 2000) returns jsonb
language sql stable as $$
    select jsonb_build_object(
        'entries', coalesce(jsonb_agg(jsonb_build_object(
            'id', e.id, 'table', e.table_name, 'op', e.op, 'pk', e.row_pk, 'data', e.data) order by e.id), '[]'::jsonb),
        'remaining', (select count(*) from public.sheet_inbox where schema_name = p_schema))
    from (select * from public.sheet_inbox where schema_name = p_schema order by id limit p_limit) e;
$$;

create or replace function public.sheet_inbox_ack(p_schema text, p_upto bigint) returns int
language plpgsql as $$
declare n int;
begin
    delete from public.sheet_inbox where schema_name = p_schema and id <= p_upto;
    get diagnostics n = row_count;
    return n;
end $$;

-- ── Helpers for building column lists ───────────────────────────────────
-- Select-list expression for a column read out of jsonb_populate_record(set)
-- alias r: a missing/null value in a NOT NULL column with a default gets the
-- default (e.g. a blank checkbox-ish cell -> false).
create or replace function public.sheet_sync_col_expr(p_rel regclass, p_col text) returns text
language sql stable as $$
    select case when a.attnotnull and d.adbin is not null
                then format('coalesce(r.%I, %s)', a.attname, pg_get_expr(d.adbin, d.adrelid))
                else format('r.%I', a.attname) end
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = p_rel and a.attname = p_col;
$$;

-- ── Apply Sheet edits to the cache ──────────────────────────────────────
-- p_upserts: [{ "ref": any, "row": {col: value, ...}, "cols": ["edited", ...] }]
--   * key exists in the cache   -> UPDATE only the "cols" columns
--   * key not in the cache      -> INSERT the whole row
--   * no key value              -> INSERT (key from its default)
-- p_deletes: ["key", ...]
-- One bad row doesn't stop the rest: per-row errors are returned.
create or replace function public.sheet_sync_apply(
    p_schema text, p_table text, p_upserts jsonb default '[]', p_deletes jsonb default '[]'
) returns jsonb
language plpgsql as $$
declare
    v_rel regclass := format('%I.%I', p_schema, p_table)::regclass;
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
    perform set_config('sheet_sync.applying', 'on', true);

    select a.attname into v_pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = v_rel and i.indisprimary and i.indnatts = 1;
    if v_pk is null then
        raise exception 'sheet_sync_apply: %.% has no single-column primary key', p_schema, p_table;
    end if;

    select array_agg(a.attname::text) into v_cols
    from pg_attribute a where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped;

    for item in select * from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb))
    loop
        v_row := item->'row';
        v_result := null;
        begin
            select array_agg(c) into v_set
            from jsonb_array_elements_text(coalesce(item->'cols', '[]'::jsonb)) c
            where c = any (v_cols) and c <> v_pk and v_row ? c;

            if coalesce(v_row->>v_pk, '') <> '' and v_set is not null then
                execute format(
                    'update %s t set (%s) = (select %s from jsonb_populate_record(null::%s, $1) r) where t.%I::text = $1->>%L returning to_jsonb(t)',
                    v_rel,
                    (select string_agg(format('%I', c), ', ') from unnest(v_set) c),
                    (select string_agg(format('r.%I', c), ', ') from unnest(v_set) c),
                    v_rel, v_pk, v_pk)
                into v_result using v_row;
            elsif coalesce(v_row->>v_pk, '') <> '' then
                execute format('select to_jsonb(t) from %s t where t.%I::text = $1->>%L', v_rel, v_pk, v_pk)
                into v_result using v_row;
            end if;

            if v_result is null then
                if coalesce(v_row->>v_pk, '') = '' then
                    v_row := v_row - v_pk;   -- let the column default fill it
                end if;
                select array_agg(c) into v_ins
                from jsonb_object_keys(v_row) c where c = any (v_cols);
                if v_ins is null then
                    raise exception 'row has no values';
                end if;
                execute format(
                    'insert into %s as x (%s) select %s from jsonb_populate_record(null::%s, $1) r returning to_jsonb(x)',
                    v_rel,
                    (select string_agg(format('%I', c), ', ') from unnest(v_ins) c),
                    (select string_agg(public.sheet_sync_col_expr(v_rel, c), ', ') from unnest(v_ins) c),
                    v_rel)
                into v_result using v_row;
            end if;

            -- The Sheet wins: a site save to these same cells that arrived
            -- after the Sheet last read the inbox must not come back later
            -- and overwrite the Sheet's value (the cache now has the Sheet's).
            if v_set is not null and (v_result->>v_pk) = (v_row->>v_pk) then
                update public.sheet_inbox set data = data - v_set
                where schema_name = p_schema and table_name = p_table and row_pk = v_result->>v_pk and op = 'U';
            else
                delete from public.sheet_inbox
                where schema_name = p_schema and table_name = p_table and row_pk = v_result->>v_pk and op = 'U';
            end if;
            delete from public.sheet_inbox
            where schema_name = p_schema and table_name = p_table and row_pk = v_result->>v_pk
              and (op = 'D' or (op = 'U' and data = '{}'::jsonb));

            applied := applied || jsonb_build_array(jsonb_build_object('ref', item->'ref', 'row', v_result));
        exception when others then
            errors := errors || jsonb_build_array(jsonb_build_object('ref', item->'ref', 'pk', v_row->>v_pk, 'error', sqlerrm));
        end;
    end loop;

    if jsonb_array_length(coalesce(p_deletes, '[]'::jsonb)) > 0 then
        execute format('delete from %s t where t.%I::text in (select jsonb_array_elements_text($1))', v_rel, v_pk)
        using p_deletes;
        get diagnostics n_deleted = row_count;
        -- deleted in the Sheet: any waiting site saves for them are moot
        delete from public.sheet_inbox
        where schema_name = p_schema and table_name = p_table
          and row_pk in (select jsonb_array_elements_text(p_deletes));
    end if;

    return jsonb_build_object('applied', applied, 'errors', errors, 'deleted', n_deleted);
end $$;

-- ── Fetch specific rows ─────────────────────────────────────────────────
create or replace function public.sheet_sync_rows(p_schema text, p_table text, p_pks jsonb) returns jsonb
language plpgsql stable as $$
declare
    v_rel regclass := format('%I.%I', p_schema, p_table)::regclass;
    v_pk text;
    out jsonb;
begin
    select a.attname into v_pk
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = v_rel and i.indisprimary and i.indnatts = 1;
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %s t where t.%I::text in (select jsonb_array_elements_text($1))', v_rel, v_pk)
    into out using p_pks;
    return out;
end $$;

-- ── Whole cache (emergency "restore Sheet from Supabase" / verification) ─
create or replace function public.sheet_sync_dump(p_schema text) returns jsonb
language plpgsql stable as $$
declare
    r record;
    rows jsonb;
    tables jsonb := '{}'::jsonb;
begin
    for r in
        select c.relname as tbl from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = p_schema and c.relkind = 'r'
    loop
        execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I.%I t', p_schema, r.tbl) into rows;
        tables := tables || jsonb_build_object(r.tbl, rows);
    end loop;
    return jsonb_build_object('tables', tables);
end $$;

-- ── Replace the cache with the Sheet's contents (one transaction) ───────
-- p_tables: { "<table>": [ {row}, ... ], ... }  - every table of the site
-- p_order:  parents first (deleted in reverse, inserted in order)
-- Refuses if the inbox still has saves the Sheet hasn't taken yet, so a
-- rebuild can never throw away a site's save.
create or replace function public.sheet_sync_replace(p_schema text, p_tables jsonb, p_order text[]) returns jsonb
language plpgsql as $$
declare
    t text;
    v_rel regclass;
    v_cols text[];
    counts jsonb := '{}'::jsonb;
    n int;
begin
    perform set_config('sheet_sync.applying', 'on', true);
    -- block the sites' writes for the few seconds this takes
    foreach t in array p_order loop
        execute format('lock table %I.%I in exclusive mode', p_schema, t);
    end loop;
    if exists (select 1 from public.sheet_inbox where schema_name = p_schema) then
        raise exception 'The inbox has saves the Sheet has not taken yet - run a sync first, then rebuild.';
    end if;

    foreach t in array (select array_agg(x order by o desc) from unnest(p_order) with ordinality u(x, o)) loop
        execute format('delete from %I.%I where true', p_schema, t);
    end loop;

    foreach t in array p_order loop
        v_rel := format('%I.%I', p_schema, t)::regclass;
        if jsonb_array_length(coalesce(p_tables->t, '[]'::jsonb)) = 0 then
            counts := counts || jsonb_build_object(t, 0);
            continue;
        end if;
        select array_agg(a.attname::text order by a.attnum) into v_cols
        from pg_attribute a
        where a.attrelid = v_rel and a.attnum > 0 and not a.attisdropped
          and exists (select 1 from jsonb_array_elements(p_tables->t) e where e ? a.attname);
        execute format('insert into %s (%s) select %s from jsonb_populate_recordset(null::%s, $1) r',
            v_rel,
            (select string_agg(format('%I', c), ', ') from unnest(v_cols) c),
            (select string_agg(public.sheet_sync_col_expr(v_rel, c), ', ') from unnest(v_cols) c),
            v_rel)
        using p_tables->t;
        get diagnostics n = row_count;
        counts := counts || jsonb_build_object(t, n);
    end loop;

    perform public.sheet_sync_fix_sequences(p_schema);
    return counts;
end $$;

-- ── Sequences after loading rows with explicit ids ──────────────────────
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

-- ── Lock it all down to the service role (the Sheet's script) ───────────
do $$
declare f text;
begin
    foreach f in array array[
        'sheet_sync_enable(text)', 'sheet_sync_schema(text)', 'sheet_inbox_read(text,integer)',
        'sheet_inbox_ack(text,bigint)', 'sheet_sync_col_expr(regclass,text)',
        'sheet_sync_apply(text,text,jsonb,jsonb)', 'sheet_sync_rows(text,text,jsonb)',
        'sheet_sync_dump(text)', 'sheet_sync_replace(text,jsonb,text[])', 'sheet_sync_fix_sequences(text)'
    ] loop
        execute format('revoke all on function public.%s from public, anon, authenticated', f);
        execute format('grant execute on function public.%s to service_role', f);
    end loop;
end $$;
grant all on public.sheet_inbox to service_role;
grant usage on sequence public.sheet_inbox_id_seq to service_role;

commit;
