// Supabase Edge Function: scheduled-reminders
// Runs on a pg_cron schedule (every 2 min) to send due-date reminders and
// event notifications server-side — even when no users are on the site.
//
// Replicates the client-side checkDueDateReminders() logic from index.html.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Optional: set CRON_SECRET in Supabase secrets and use it in the pg_net call
// to prevent unauthorized invocations.
const CRON_SECRET = Deno.env.get("CRON_SECRET");

// ── helpers ────────────────────────────────────────────────────────────────

function generateId(): string {
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

function getNotifIcon(type: string): string {
  const map: Record<string, string> = {
    assign: "👤", comment: "💬", due: "⏰", move: "📦",
    checklist: "☑️", checklist_assign: "📋", label: "🏷", complete: "✅", create: "✨",
  };
  return map[type] || "🔔";
}

function getNotifIconBg(type: string): string {
  const map: Record<string, string> = {
    assign: "rgba(10,132,255,0.15)", comment: "rgba(52,199,89,0.15)",
    due: "rgba(255,149,0,0.15)", move: "rgba(191,90,242,0.15)",
    checklist: "rgba(52,199,89,0.15)", checklist_assign: "rgba(10,132,255,0.15)",
    label: "rgba(255,55,95,0.15)", complete: "rgba(52,199,89,0.15)",
    create: "rgba(10,132,255,0.15)",
  };
  return map[type] || "rgba(255,255,255,0.08)";
}

function getChecklistAssignees(item: Record<string, unknown>): string[] {
  if (Array.isArray(item.assignedTo)) return item.assignedTo as string[];
  if (item.assignedTo) return [item.assignedTo as string];
  return [];
}

// ── main ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Verify cron secret when configured
  if (CRON_SECRET) {
    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Read full app state
  const { data: row, error } = await supabase
    .from("app_state")
    .select("data")
    .eq("id", 1)
    .single();

  if (error || !row?.data) {
    console.error("[scheduled-reminders] Could not read app_state:", error);
    return new Response(JSON.stringify({ error: "Could not read app_state" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // deno-lint-ignore no-explicit-any
  const appData: Record<string, any> = row.data;
  const tasks: Record<string, unknown>[] = appData.tasks || [];
  const settings: Record<string, unknown> = appData.settings || {};
  const allUsers: string[] = ((settings.users || []) as { name: string }[]).map((u) => u.name);
  const notifPrefs: Record<string, Record<string, unknown>> = appData.notifPrefs || {};
  const globalPrefs: Record<string, unknown> = notifPrefs._global || {};

  function isGlobalNotifEnabled(type: string): boolean {
    return globalPrefs[type] !== false;
  }

  // Per-user notification pref check
  function isUserNotifEnabled(userName: string, type: string): boolean {
    const userPrefs = notifPrefs[userName] || {};
    return userPrefs[type] !== false;
  }

  // Mutable notification store and sent-reminders tracker
  const notifications: Record<string, Record<string, unknown>[]> = appData.notifications || {};

  // sentReminders tracks which reminders were already dispatched.
  // Keys encode enough info to be unique per event; values store the date sent.
  let sentReminders: Record<string, string> = appData.scheduledRemindersSent || {};

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split("T")[0];

  // Purge reminder keys older than 2 days to keep the object small
  const twoDaysAgo = new Date(now);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const twoDaysAgoStr = twoDaysAgo.toISOString().split("T")[0];
  for (const key of Object.keys(sentReminders)) {
    const m = key.match(/(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] < twoDaysAgoStr) delete sentReminders[key];
  }

  // Batched push targets: { targets: string[], notif: object }
  const pushBatch: { targets: string[]; notif: Record<string, unknown> }[] = [];

  function addInAppNotif(
    userName: string,
    type: string,
    title: string,
    body: string,
    taskId: string,
  ) {
    if (!isGlobalNotifEnabled(type)) return;
    if (!isUserNotifEnabled(userName, type)) return;
    if (!notifications[userName]) notifications[userName] = [];
    notifications[userName].unshift({
      id: generateId(),
      type,
      title,
      body,
      taskId,
      icon: getNotifIcon(type),
      iconBg: getNotifIconBg(type),
      read: false,
      timestamp: now.toISOString(),
    });
    // Cap per-user notifications at 100
    notifications[userName] = notifications[userName].slice(0, 100);
  }

  function queuePush(targets: string[], notif: Record<string, unknown>) {
    if (targets.length === 0) return;
    pushBatch.push({ targets, notif });
  }

  // ── task due-date checks ──────────────────────────────────────────────────

  for (const task of tasks as Record<string, unknown>[]) {
    if (!task.dueDate || task.completed) continue;

    const dueDateStr = (task.dueDate as string).slice(0, 10);
    const hasTime =
      (task.dueDate as string).includes("T") &&
      (task.dueDate as string).length > 10 &&
      (task.dueDate as string).slice(11, 16) !== "00:00";
    const members = (task.members as string[]) || [];

    // 24-hour reminder: due tomorrow — notify all card members
    if (dueDateStr === tomorrowStr && isGlobalNotifEnabled("due")) {
      const key = `due_tomorrow_${tomorrowStr}_${task.id}`;
      if (!sentReminders[key]) {
        const title = "Due tomorrow: " + ((task.title as string) || "Untitled");
        const body = "This card is due tomorrow.";
        for (const member of members) {
          addInAppNotif(member, "due", title, body, task.id as string);
        }
        queuePush(members, { title, body, type: "due", taskId: task.id, id: generateId() });
        sentReminders[key] = todayStr;
      }
    }

    // Starting-soon reminder: has a time and starts within 30 minutes — notify ALL users
    if (hasTime && isGlobalNotifEnabled("due")) {
      const eventDate = new Date(task.dueDate as string);
      const diffMs = eventDate.getTime() - now.getTime();
      // Use minute-precision key so it fires once per scheduled time
      const key = `starting_soon_${task.id}_${(task.dueDate as string).slice(0, 16)}`;
      if (diffMs > 0 && diffMs <= 30 * 60 * 1000 && !sentReminders[key]) {
        const timeStr = eventDate.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        const title = "Starting soon: " + ((task.title as string) || "Untitled");
        const body = "Event starts at " + timeStr;
        for (const user of allUsers) {
          addInAppNotif(user, "due", title, body, task.id as string);
        }
        queuePush(allUsers, { title, body, type: "due", taskId: task.id, id: generateId() });
        sentReminders[key] = todayStr;
      }
    }

    // ── checklist item checks ───────────────────────────────────────────────

    const checklist = (task.checklist as Record<string, unknown>[]) || [];
    for (const item of checklist) {
      if (!item.dueDate || item.done) continue;
      const assignees = getChecklistAssignees(item);
      if (assignees.length === 0) continue;

      const itemDate = new Date(item.dueDate as string);
      const itemTime = item.dueTime
        ? (item.dueTime as string).split(":")
        : ["0", "0"];
      itemDate.setHours(parseInt(itemTime[0]) || 0, parseInt(itemTime[1]) || 0, 0);

      // Tomorrow reminder for checklist items
      if ((item.dueDate as string) === tomorrowStr && isGlobalNotifEnabled("due")) {
        const key = `cl_tomorrow_${tomorrowStr}_${item.id}`;
        if (!sentReminders[key]) {
          const title = "Due tomorrow: " + ((item.text as string) || "Checklist item");
          const body = "In: " + ((task.title as string) || "Untitled");
          for (const assignee of assignees) {
            addInAppNotif(assignee, "due", title, body, task.id as string);
          }
          queuePush(assignees, { title, body, type: "due", taskId: task.id, id: generateId() });
          sentReminders[key] = todayStr;
        }
      }

      // Starting-soon reminder for checklist items with a time
      if (item.dueTime && isGlobalNotifEnabled("due")) {
        const diffMs = itemDate.getTime() - now.getTime();
        const key = `cl_soon_${item.id}_${(item.dueDate as string)}_${item.dueTime}`;
        if (diffMs > 0 && diffMs <= 30 * 60 * 1000 && !sentReminders[key]) {
          const timeStr = itemDate.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          });
          const title = "Due soon: " + ((item.text as string) || "Checklist item");
          const body =
            "Due at " + timeStr + " — In: " + ((task.title as string) || "Untitled");
          for (const assignee of assignees) {
            addInAppNotif(assignee, "due", title, body, task.id as string);
          }
          queuePush(assignees, { title, body, type: "due", taskId: task.id, id: generateId() });
          sentReminders[key] = todayStr;
        }
      }
    }
  }

  // ── persist updated state ─────────────────────────────────────────────────

  const updatedData = {
    ...appData,
    notifications,
    scheduledRemindersSent: sentReminders,
  };

  const { error: saveError } = await supabase
    .from("app_state")
    .update({ data: updatedData })
    .eq("id", 1);

  if (saveError) {
    console.error("[scheduled-reminders] Failed to save app_state:", saveError);
    return new Response(JSON.stringify({ error: "Failed to save notifications" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── send push notifications via the existing send-push Edge Function ──────

  const pushResults: Record<string, unknown>[] = [];
  for (const { targets, notif } of pushBatch) {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/functions/v1/send-push`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ targets, notification: notif }),
        },
      );
      const result = await resp.json();
      pushResults.push(result);
    } catch (err) {
      console.error("[scheduled-reminders] Push batch failed:", err);
      pushResults.push({ error: (err as Error).message });
    }
  }

  console.log(
    `[scheduled-reminders] Done. pushBatches=${pushBatch.length}`,
    pushResults,
  );

  return new Response(
    JSON.stringify({ ok: true, pushBatches: pushBatch.length, pushResults }),
    { headers: { "Content-Type": "application/json" } },
  );
});
