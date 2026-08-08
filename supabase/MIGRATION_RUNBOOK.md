# Moving off the app_state blob: deployment runbook

This describes how to cut over from the single `app_state` JSON blob to the
normalized tables, without losing data and with a safe rollback path at every
step. Do these in order — each step assumes the previous one is done.

## What changed

- `supabase/migrations/20260808000000_normalize_app_state_schema.sql` creates
  16 real tables (boards, columns, tasks, checklist_items, comments,
  attachments, custom_fields, task_labels, users, automations, notifications,
  notif_prefs, push_subscriptions, password_reset_tokens,
  checklist_templates, app_settings) and copies every row out of
  `app_state.data` (id = 1) into them. **It never modifies or deletes
  `app_state`.**
- `supabase/migrations/20260808000001_app_state_rpc_functions.sql` adds two
  functions, `load_app_state()` and `save_app_state(payload)`, which is how
  the app now reads/writes — it still works with one JSON object in memory,
  that object just isn't stored as one blob anymore.
- `index.html` now calls those two functions instead of reading/writing
  `app_state` directly (see `initData()` / `saveData()` and a handful of
  smaller spots — `sendPushNotification`, `clearAllNotifs`, and
  `pollNotifications` also got simpler now that push subscriptions and
  notifications are their own tables, since they no longer need the
  read-merge-write dance they used to avoid clobbering other users).
- `supabase/functions/send-password-reset/index.ts`,
  `supabase/functions/scheduled-reminders/index.ts`, and
  `supabase/functions/send-push/index.ts` are all updated to read/write the
  new tables instead of `app_state` directly. **These need to be redeployed**
  — merging the code isn't enough, Edge Functions are a separate deploy.
- `app_state` itself is left in place as a read-only backup. Nothing deletes
  it. The "cloud backup" feature (Settings → Data → Backup/Restore) still
  uses it exactly as before (id = 2), unchanged.

## 1. Back up first

Even though nothing here deletes `app_state`, take an explicit snapshot
before touching anything:

```sql
select data from app_state where id = 1;
```

Copy that JSON output somewhere safe (or use Supabase's own database backup
feature if you're on a plan that has it).

## 2. Run the SQL migrations

In the Supabase SQL Editor, run these two files **in order**, in full:

1. `supabase/migrations/20260808000000_normalize_app_state_schema.sql`
2. `supabase/migrations/20260808000001_app_state_rpc_functions.sql`

The first file ends with a `select` showing row counts per table — compare
those against what you'd expect (how many boards, roughly how many tasks,
etc.). If a count looks wrong, **stop here** — `app_state` is untouched, so
there's no urgency, and the whole script can be re-run safely after you
figure out what looked off (it clears and re-copies from `app_state`, not
additive).

Optional: read the comment block at the bottom of the first file about
tightening `board_id`/`column_id` into real foreign keys once you've spot
checked the data. Not required, but worth doing eventually.

## 3. Spot-check the data

A few quick sanity queries:

```sql
-- Do your real boards show up with the right titles?
select id, year, title from boards b join columns c on c.board_id = b.id limit 20;

-- Pick a task you know well and check its nested data came across
select t.title, t.description,
       (select count(*) from checklist_items where task_id = t.id) as checklist_count,
       (select count(*) from comments where task_id = t.id) as comment_count
from tasks t where t.title = 'PUT A REAL TASK TITLE HERE';

-- Are your users there?
select email, name, role from users;
```

## 4. Redeploy the 3 Edge Functions

Via the Supabase CLI (from the repo root):

```sh
supabase functions deploy send-password-reset
supabase functions deploy scheduled-reminders
supabase functions deploy send-push
```

Or redeploy each one from the Supabase Dashboard → Edge Functions if you
don't use the CLI. No secrets or environment variables need to change —
these functions still use the same `SUPABASE_SERVICE_ROLE_KEY` etc. they
already had.

## 5. Deploy the updated index.html

Merge/deploy this branch's `index.html` normally, however you deploy today.

**Order matters**: steps 2–4 must happen *before* this, since the new
`index.html` calls `load_app_state()`/`save_app_state()`, which don't exist
until step 2 runs. If you deploy the new `index.html` before running the SQL,
the app will fail to load with a "could not find function" error from
Supabase — reversible by just running the SQL migrations, no data at risk.

## 6. Verify live

After deploying:

- Load the app, confirm your boards/tasks/columns show up correctly.
- Log in as a couple of different users if you can, confirm auth still works.
- Make a small edit (rename a task) and confirm it persists after a refresh.
- Add a checklist item, a comment, and an attachment link; refresh; confirm
  they're still there.
- Check Settings → Notifications still shows badges/updates.
- If you use Web Push, trigger a test notification and confirm delivery.

## Rollback

If something's wrong after deploying the new `index.html` and Edge
Functions, the fastest rollback is reverting `index.html` and the 3 Edge
Functions back to their previous versions — `app_state` was never modified,
so the old code path works immediately with zero data loss the moment it's
back in place. You do not need to reverse the SQL migrations to roll back;
the new tables can just sit there unused.

## Known limitations of this migration (by design, not oversights)

- **Notifications table grows unbounded.** The old blob capped each user at
  their most recent 100 notifications. The new `scheduled-reminders`
  function no longer enforces that cap when inserting (it wasn't worth the
  added complexity for what's a cosmetic limit, not a correctness one) — the
  in-app "Clear All" button still works fine, this only affects long-term
  row count. A periodic cleanup job (delete notifications older than N days,
  or beyond the 100 most recent per user) is a reasonable follow-up if this
  ever matters.
- **RLS is wide open**, matching whatever `app_state` already allowed the
  anon/publishable key to do. This migration does not change your security
  posture — it was already flagged separately (API keys and secrets are
  readable by anyone who can query these tables with the anon key, same as
  before) and fixing that requires moving auth to Supabase Auth, which is a
  separate, bigger project.
