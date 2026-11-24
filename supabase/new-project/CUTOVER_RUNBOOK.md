# Moving the marketing app to the new shared Supabase project

The end state:

- **The Google Sheet is the database.** See `google-sheet-hub/README.md`.
- **The new Supabase project is only a cache plus a short inbox,** used so the
  sites load and save fast. Saves land in the inbox and the Sheet's script
  moves them into the Sheet. Each site has its own schema; the marketing
  app's is `marketing`.
- **The old project** (`qcfntvqvcmshbbpcxmgo`) is never modified. It stays as
  a rollback until you're confident, and then you can pause it.

Steps 1–4 can happen any time; the app keeps running on the old project
throughout. Only step 6 is the actual switch, and it takes about 10 minutes.

## 1. Prepare the new project

In the new project's SQL Editor, run each file in full, in this order:

1. `01_sheet_sync_core.sql`
2. `02_marketing_schema.sql`

Then go to **Project Settings → Data API → Exposed schemas**, add
`marketing`, and save.

## 2. Set up the Google Sheet

Follow `google-sheet-hub/README.md`, steps 1–5: paste in the script, add the
Hub menu, and connect to the new project.

## 3. Rehearse the move

**Hub → Migrate from old marketing project…**. It reads the old project,
writes everything into the Sheet, builds the new Supabase cache from the
Sheet, and compares every value of every row: old project vs. the new cache.

- Check the report on the Control Panel. Every table should say **OK**. If a
  row says "value(s) differ", stop and send me the example it shows.
- Look through the **Marketing App** tab and the hidden **🔒 Private** tab
  (right-click any tab → Show hidden sheets). Are the boards, tasks, comments
  and users you'd expect all there?
- **Don't edit the Sheet yet.** Each migration run replaces the Marketing App
  tab with a fresh copy of the old project, so edits made now would be lost.
  Leave auto-sync off until step 6.

You can rehearse as many times as you like.

## 4. Deploy the Edge Functions to the new project

The functions now read their schema from a `DB_SCHEMA` secret. It defaults to
`public`, so they still work on the old project unchanged.

In the new project, under **Edge Functions → Secrets**, set:

| Secret | Value |
|---|---|
| `DB_SCHEMA` | `marketing` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | **The same values as the old project.** Existing push subscriptions only work with the same key pair. New keys mean everyone has to turn notifications back on. |
| `CRON_SECRET` | The same as the old project, if it has one |

Then deploy all three functions from the repo root:

```sh
supabase functions deploy send-password-reset --project-ref <NEW-REF>
supabase functions deploy scheduled-reminders --project-ref <NEW-REF>
supabase functions deploy send-push --project-ref <NEW-REF>
```

## 5. Prepare the app change (don't deploy yet)

In `index.html`, near the top of the main `<script>`:

```js
const SUPABASE_URL = 'https://<NEW-REF>.supabase.co';
const SUPABASE_KEY = '<NEW publishable key>';   // Project Settings → API keys
const SUPABASE_SCHEMA = 'marketing';
```

## 6. Switch over

1. Tell people to close the marketing app for about 10 minutes. Anything saved
   in the old project after the next step won't be copied.
2. **Old project** SQL Editor: stop reminders there.
   `select cron.unschedule('scheduled-reminders-every-2min');`
3. **Hub → Migrate from old marketing project…**. This is the final copy.
   Check that the report is all **OK**. **Never run Migrate again after
   this.** From now on the Sheet holds newer data than the old project.
4. **New project** SQL Editor: create the two Vault secrets described at the
   top of `03_marketing_cron.sql`, then run that file.
5. Deploy the `index.html` change from step 5.
6. **Hub → Auto-sync → Every 5 minutes.**

## 7. Check it works

- Load the app and log in. Your boards, tasks and columns should be there.
- Rename a task in the app. After the next sync it shows in the Sheet, and
  `select count(*) from public.sheet_inbox;` in the new project is back to 0.
- Change a task title in the Sheet. **Hub → Sync now**, then refresh the app:
  the new title is there.
- Add a comment, a checklist item and an attachment link in the app, refresh,
  and confirm they stuck.
- Try **Forgot password** with your own email (uses `send_password_reset_email`
  and the Brevo key that was copied into `marketing.app_secrets`).
- Trigger a test push notification.
- Within 2 minutes, `select * from cron.job_run_details order by start_time desc limit 5;`
  in the new project shows the reminders job running.
- Once you're happy: **Hub → Forget old project key**.

## Rollback

The old project was never changed, so rolling back means pointing the app
back at it:

1. Revert the three `index.html` constants and deploy.
2. **Old project:** re-run `supabase/migrations/20260615000000_schedule_reminders_cron.sql`
   to restart reminders.
3. **New project:** `select cron.unschedule('scheduled-reminders-every-2min');`

Anything created after the switch is in the Sheet, not in the old project. If
you roll back, re-enter those changes by hand.

## What's different in the new project (on purpose)

- **Tables live in the `marketing` schema**, not `public`, so other sites can
  share the project.
- **Every table has an inbox trigger.** Each save the app makes is also put in
  `public.sheet_inbox`: the whole row for a new record, only the changed
  columns for an edit, just the id for a delete. The Sheet's script moves
  those into the Sheet and deletes them. The app never sees the inbox.
- **`save_app_state()` saves exactly what it did before**, but it no longer
  deletes and re-inserts labels, notification preferences, push subscriptions
  and reset tokens on every save. Only rows that actually changed are
  touched, so the inbox only gets real changes.
- **`app_secrets` (the Brevo key) can only be read by the server side.** The
  Edge Functions and `send_password_reset_email` can read it; the public key
  can't. Everything else keeps the old open-to-the-app access. Moving logins
  to Supabase Auth is still the separate, bigger fix for that.
- **Passwords, API keys, reset tokens, push keys and the cloud-backup blob are
  in the Sheet's hidden, owner-only 🔒 Private tab**, not the Marketing App
  tab.
