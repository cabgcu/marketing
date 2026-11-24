#!/usr/bin/env bash
# Runs the Data Hub end-to-end tests: the real .gs files against a fake
# Google Sheet and two throwaway local Postgres databases loaded with
# supabase/new-project/01 + 02 ("t" = new project, "old" = old project).
# Needs Postgres 14+ binaries and Node 18+.
#   bash google-sheet-hub/test/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DIR="${PGTEST_HOST:-/tmp/pgt}"; PORT="${PGTEST_PORT:-5499}"

if ! psql -h "$DIR" -p "$PORT" -U postgres -c 'select 1' >/dev/null 2>&1; then
  mkdir -p "$DIR"
  if [ "$(id -u)" = 0 ]; then
    chown postgres "$DIR"
    su postgres -c "$PGBIN/initdb -D $DIR/data -A trust" >/dev/null
    su postgres -c "$PGBIN/pg_ctl -D $DIR/data -o '-k $DIR -p $PORT' -l $DIR/log start" >/dev/null
  else
    "$PGBIN/initdb" -D "$DIR/data" -A trust >/dev/null
    "$PGBIN/pg_ctl" -D "$DIR/data" -o "-k $DIR -p $PORT" -l "$DIR/log" start >/dev/null
  fi
fi
P=(psql -h "$DIR" -p "$PORT" -U postgres -X -q -v ON_ERROR_STOP=1)
for db in t old; do
  "${P[@]}" -c "drop database if exists $db" -c "create database $db" >/dev/null
  "${P[@]}" -d "$db" >/dev/null <<'SQL'
set client_min_messages = warning;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
-- stand-in for Supabase's http extension
create schema extensions;
create type extensions.http_header as (field text, value text);
create type extensions.http_request as (method text, uri text, headers extensions.http_header[], content_type text, content text);
create type extensions.http_response as (status int, content_type text, headers extensions.http_header[], content text);
create function extensions.http_header(f text, v text) returns extensions.http_header language sql as $f$ select row(f,v)::extensions.http_header $f$;
create function extensions.http(r extensions.http_request) returns extensions.http_response language sql as $f$ select row(200,'',null,'ok')::extensions.http_response $f$;
SQL
  "${P[@]}" -d "$db" -c "set client_min_messages = warning" -f "$ROOT/supabase/new-project/01_sheet_sync_core.sql" >/dev/null
  sed 's/^create extension if not exists http with schema extensions;//' "$ROOT/supabase/new-project/02_marketing_schema.sql" \
    | "${P[@]}" -d "$db" -c "set client_min_messages = warning" -f - >/dev/null
done
node "${TEST_FILE:-$HERE/e2e.test.js}"
