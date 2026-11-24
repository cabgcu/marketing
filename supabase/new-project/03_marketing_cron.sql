-- ============================================================================
-- Scheduled reminders cron job  (run in the NEW project, at cutover)
-- ============================================================================
-- Same job the old project runs (supabase/migrations/20260615000000_...):
-- calls the scheduled-reminders Edge Function every 2 minutes.
--
-- Run this ONLY at cutover (step 6 of CUTOVER_RUNBOOK.md), after the Edge
-- Functions are deployed to the new project - and turn the old project's job
-- off at the same moment, or everyone gets every reminder twice:
--   (in the OLD project)  select cron.unschedule('scheduled-reminders-every-2min');
--
-- BEFORE running, store the new project's URL and service-role key in Vault
-- (SQL Editor, NEW project - fill in the two values):
--   select vault.create_secret('https://<NEW-PROJECT-REF>.supabase.co', 'project_url');
--   select vault.create_secret('<NEW-SERVICE-ROLE-KEY>', 'service_role_key');
-- If the old project used a CRON_SECRET, create it here too and set the same
-- CRON_SECRET in the new project's Edge Function secrets:
--   select vault.create_secret('<RANDOM-SECRET>', 'cron_secret');
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('scheduled-reminders-every-2min')
  where exists (select 1 from cron.job where jobname = 'scheduled-reminders-every-2min');

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
