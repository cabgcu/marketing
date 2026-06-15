-- Enable pg_cron and pg_net if not already enabled
-- (These are available on Supabase Pro and above)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove any existing job with this name before (re)creating it
select cron.unschedule('scheduled-reminders-every-2min')
  where exists (
    select 1 from cron.job where jobname = 'scheduled-reminders-every-2min'
  );

-- Schedule the Edge Function every 2 minutes.
--
-- SETUP REQUIRED in Supabase Dashboard → Project Settings → Edge Functions:
--   1. Note your project ref (e.g. abcxyzproject)
--   2. Go to Settings → API and copy the "service_role" key
--   3. Run these two SQL statements in the SQL Editor to store them as Vault secrets:
--
--      select vault.create_secret('https://<YOUR-PROJECT-REF>.supabase.co', 'project_url');
--      select vault.create_secret('<YOUR-SERVICE-ROLE-KEY>', 'service_role_key');
--
--   Optionally add a CRON_SECRET for security:
--      select vault.create_secret('<RANDOM-SECRET>', 'cron_secret');
--      -- Then add CRON_SECRET = <RANDOM-SECRET> in Edge Function secrets.
--
select cron.schedule(
  'scheduled-reminders-every-2min',
  '*/2 * * * *',
  $$
  select net.http_post(
    url        := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/scheduled-reminders',
    headers    := jsonb_build_object(
                    'Content-Type',  'application/json',
                    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
                  ),
    body       := '{}'::jsonb
  ) as request_id;
  $$
);
