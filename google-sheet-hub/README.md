# Data Hub — the Google Sheet is the database

The **Google Sheet is the database** for every site. Supabase only does two
jobs, both for speed:

1. **Read cache.** A copy of the Sheet that the sites read from, so pages load
   fast.
2. **Short inbox.** When someone saves in a site, the save lands in Supabase
   instantly. The Sheet's script moves it into the Sheet within minutes, then
   **deletes it from the inbox**.

Supabase is never the record of truth. **Hub → Rebuild Supabase from Sheet**
wipes it and reloads it from the Sheet at any time, with nothing lost.

```
          save ──► Supabase inbox ──(script, every few min)──► Google Sheet  ◄── you edit here
 Sites                                                          (the database)
          read ◄── Supabase cache ◄──(your edits / Rebuild)──────────┘
```

## Tabs

| Tab | What's in it |
|---|---|
| **Control Panel** | Status of each site: last sync, counts, errors, migration report |
| **Marketing App** | Everything the marketing app stores, one labeled section per table (■ tasks, ■ comments, ■ users…) |
| *(one tab per site)* | Same layout as Marketing App |
| **🔒 Private** (hidden) | Passwords, API keys, reset tokens and push keys for every site, plus an **overflow** section for values longer than one cell allows (50,000 characters). Locked so only the Sheet's owner can edit it |

## Working in a site tab

- **Edit a cell.** The row's `pending` box fills in with the columns you
  changed. On the next sync just those cells go to Supabase, and the box
  clears.
- **Add a record.** Insert a row inside the right section and leave `id`
  blank. It gets an id on the next sync. A new user also gets a row in
  🔒 Private for their password.
- **Delete a record.** Tick its `delete` box. Right-click → Delete row only
  removes the Sheet row; the record still exists in Supabase.
- **Lists** (like `members`) can be typed as `Chris, Ann` or `["Chris","Ann"]`.
- **Red `pending` box:** Supabase rejected the edit, for example a `task_id`
  that doesn't exist. The cell's note says why. Fix the value and it retries.
- **Same cell changed in the Sheet and in a site at the same time:** the
  Sheet wins. Other cells the site changed in that row still come through.
- Don't change ids or the grey section and header rows.

## One-time setup

1. Create a Google Sheet. Open **Extensions → Apps Script**. Make five script
   files with these names and paste in each file's contents: `Config.gs`,
   `Supabase.gs`, `Sync.gs`, `Menu.gs`, `Migrate.gs`. Delete the starter
   `Code.gs` and save.
2. Reload the Sheet. A **Hub** menu appears. The first time you use it, Google
   asks you to authorize the script. It needs to edit this spreadsheet, call
   Supabase, and run on a schedule.
3. In the new Supabase project's SQL Editor, run
   `supabase/new-project/01_sheet_sync_core.sql`, then
   `02_marketing_schema.sql`. Then go to **Project Settings → Data API →
   Exposed schemas**, add `marketing`, and save.
4. **Hub → Connect to Supabase…**: paste the new project's URL and
   service_role / secret key.
5. **Hub → Migrate from old marketing project…**: paste the old project's URL
   and key. It reads the old project, writes everything into the Sheet,
   builds the new Supabase cache from the Sheet, and compares every value of
   every row. The report goes on the Control Panel.
6. **Hub → Auto-sync → Every 5 minutes.**

> **Who can see what.** Keys live in the script's properties, not in cells.
> Anyone with **edit** access to the Sheet can open the script and read them.
> A service key can do anything to the database, so only give edit access to
> people you'd trust with everything. The 🔒 Private tab is hidden and only
> the owner can edit it, but editors can still unhide and read it. View-only
> sharing doesn't expose the script.

## Quotas (free Gmail account)

Google allows about **90 minutes of script run time per day** and **20,000 web
requests per day**. A sync with nothing to do is one request per site and
takes a couple of seconds, so **every 5 minutes** is comfortable. **Every 1
minute** can run out of run time on busy days. Google Workspace accounts get
6 hours of run time per day.

Saves wait in the Supabase inbox until the next sync. With a 5-minute
schedule, a site save takes up to about 5 minutes to appear in the Sheet. The
site itself shows it immediately.

## Menu

| Item | What it does |
|---|---|
| Sync now | Inbox → Sheet, then your edits → Supabase |
| Connect to Supabase… | Sets the URL and key, then checks the connection |
| Auto-sync | Sets the schedule (1, 5 or 15 min, or off) |
| Rebuild Supabase from Sheet… | Takes in waiting saves, then replaces the site's Supabase data with exactly what's in the Sheet, in one step |
| Restore Sheet from Supabase (emergency)… | Only if a tab gets damaged: rewrites it from the cache |
| Migrate from old marketing project… | One-time move of the old project into the Sheet. Safe to re-run **before** the switch-over |
| Forget old project key | Removes the old project's key from the script |

## Adding another site later

1. In Supabase, create the site's tables in their own schema, e.g. `events`.
   Then run `select public.sheet_sync_enable('events');` and add `events` to
   the exposed schemas.
2. Point that site's Supabase client at the schema:
   `createClient(url, key, { db: { schema: 'events' } })`.
3. Add an entry to `SITES` in `Config.gs`: tab name, schema, section order,
   and which tables or columns are private.
4. Fill the tab. If the site already has data somewhere, write a migration
   like `Migrate.gs`. If it starts empty, just type into the tab.

## Tests

`bash google-sheet-hub/test/run.sh` runs the real `.gs` files against a fake
Sheet and two local Postgres databases (old project and new project). It
covers migration, the inbox, conflicts, private data, overflow, rebuild and
restore.
