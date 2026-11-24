# Data Hub — Google Sheet ⇄ Supabase

The Google Sheet is the **master copy** of every site's data. Supabase is the
**fast copy** the sites actually read and write. An Apps Script inside the
Sheet keeps the two in step.

```
   Marketing app ─┐                         ┌─ Tab 1  Control Panel
   Site 2 ────────┼──► Supabase (fast) ◄───►│  Tab 2  Marketing App
   Site 3 ────────┘    one schema per site  │  Tab 3+ one tab per site
                                            └─ (Apps Script, every few min)
```

## How the sync behaves

- **Each run:** first your Sheet edits go to Supabase, then whatever changed in
  Supabase (made in the apps) comes into the Sheet. One request per site when
  nothing changed.
- **Edit a cell:** the row's `pending` box fills in with the column you changed.
  On the next sync only *those* cells are sent, so you never overwrite newer
  app edits in other columns. The box clears when it's saved.
- **A row changed in both places:** the Sheet wins.
- **Delete a row:** tick its `delete` box. (Right-click → Delete row only removes
  it from the Sheet; it will come back.)
- **Add a row:** insert a row inside the right section, fill it in, and leave
  `id` blank. It gets an id on the next sync.
- **Lists** (like `members`) can be typed as `Chris, Ann` or `["Chris","Ann"]`.
- **If Supabase rejects an edit** (for example a `task_id` that doesn't exist),
  the `pending` box turns red and its note says why. Fix the cell and it retries.
- **Kept out of the Sheet on purpose:** passwords, API keys, reset tokens, push
  keys, and the old JSON backup blob. They stay in Supabase only. Edits in the
  Sheet never touch them.
- **Cells over 50,000 characters** (Google's limit) show
  `⚠ TOO LARGE FOR SHEET` and stay in Supabase only.

## One-time setup

1. Create a Google Sheet. Open **Extensions → Apps Script**.
2. Create five script files with these names, and paste each file's contents in:
   `Config.gs`, `Supabase.gs`, `Sync.gs`, `Menu.gs`, `Migrate.gs`.
   Delete the starter `Code.gs`. Save.
3. Reload the Sheet. A **Hub** menu appears. The first time you use it, Google
   asks you to authorize the script. It needs to edit this spreadsheet, call
   Supabase, and run on a schedule.
4. In Supabase (the new project), in the SQL Editor, run in order:
   `supabase/new-project/01_sheet_sync_core.sql`, then
   `supabase/new-project/02_marketing_schema.sql`.
   Then go to **Project Settings → Data API → Exposed schemas**, add
   `marketing`, and save.
5. **Hub → Connect to Supabase…** and paste the new project's URL and its
   service_role / secret key.
6. **Hub → Migrate from old marketing project…** and paste the old project's URL
   and service_role / secret key. Choose **YES (fresh copy)**. The script copies
   every table, compares row counts, and builds the **Marketing App** tab.
   Check the report on the Control Panel.
7. **Hub → Auto-sync → Every 5 minutes.**

> **Who can see the keys:** the keys live in the script's properties, not in any
> cell. But anyone with **edit** access to this Sheet can open the script and
> read them, and a service key can read and change everything in the
> database. Only give edit access to people you'd trust with the whole
> database. View-only sharing is safe.

## Quotas (free Gmail account)

Google allows about **90 minutes of script run time per day** and **20,000
web requests per day**. A sync with nothing to do takes a couple of seconds
and one request per site, so **every 5 minutes** is comfortable. **Every 1
minute** can run out of run time on busy days. Google Workspace accounts get
6 hours per day.

## Adding another site later

1. In Supabase, create the site's tables in their own schema, e.g. `events`.
   Then run `select public.sheet_sync_enable('events');` and add `events` to the
   exposed schemas.
2. Point that site's Supabase client at the schema:
   `createClient(url, key, { db: { schema: 'events' } })`.
3. Add an entry to `SITES` in `Config.gs` with its tab name, schema, section
   order, and any tables or columns to keep out of the Sheet.
4. **Hub → Rebuild a site tab from Supabase…**. The tab is created and filled.

## Menu reference

| Item | What it does |
|---|---|
| Sync now | Runs a sync immediately |
| Connect to Supabase… | Sets the URL and key, then checks the connection |
| Auto-sync | Sets the schedule (1, 5 or 15 min, or off) |
| Rebuild a site tab | Pushes pending edits, then rewrites the tab from Supabase |
| Push a whole site tab | Writes every row of the tab to Supabase, so you can restore Supabase from the Sheet |
| Migrate from old marketing project… | Copies the old project into the new one. Resumable and safe to re-run |
| Forget old project key | Removes the old project's key from the script |

## Tests

`test/` runs the real `.gs` files against a fake Sheet and a real Postgres
that has the `supabase/new-project` SQL loaded. See `test/run.sh`.
