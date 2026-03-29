/**
 * CAB Marketing -> Google Calendar Full Sync Webhook
 *
 * Required payload shape from app:
 * {
 *   workspaceId: "...",
 *   workspaceName: "...",
 *   generatedAt: "...",
 *   syncMode: "full_replace",
 *   events: [
 *     {
 *       id: "task-...-due|story|photo|reel",
 *       source: "event_calendar|content_calendar",
 *       title: "...",
 *       start: "2026-04-07T18:00",
 *       location: "...",
 *       description: "...",
 *       taskId: "..."
 *     }
 *   ]
 * }
 */

const CALENDAR_ID = 'canyonactivitiesboard@gmail.com';
const SOURCE_TAG = 'CAB_SYNC';
const DEFAULT_DURATION_MINUTES = 60;

/**
 * Webhook entrypoint
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const result = runFullSync(payload);
    return jsonOut({ ok: true, ...result });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

/**
 * Full reconciliation:
 * - create missing events
 * - update existing managed events
 * - delete managed events not in incoming list (full_replace)
 */
function runFullSync(payload) {
  if (!payload || !Array.isArray(payload.events)) {
    throw new Error('Invalid payload: events[] is required');
  }

  const workspaceId = String(payload.workspaceId || 'default');
  const syncMode = String(payload.syncMode || 'full_replace');

  // Desired state (from app)
  const desired = {};
  payload.events.forEach(ev => {
    if (!ev || !ev.id || !ev.start) return;
    desired[String(ev.id)] = toGoogleEventResource(ev, payload);
  });

  // Existing managed events in this workspace
  const existingEvents = listManagedEvents(workspaceId);
  const existingByExternalId = {};
  existingEvents.forEach(item => {
    const extId = getPrivateProp(item, 'externalId');
    if (extId) existingByExternalId[extId] = item;
  });

  let created = 0;
  let updated = 0;
  let deleted = 0;

  // Upsert desired events
  Object.keys(desired).forEach(extId => {
    const desiredResource = desired[extId];
    const existing = existingByExternalId[extId];

    if (!existing) {
      Calendar.Events.insert(desiredResource, CALENDAR_ID);
      created++;
    } else {
      Calendar.Events.patch(desiredResource, CALENDAR_ID, existing.id);
      updated++;
    }
  });

  // Remove missing (full replace)
  if (syncMode === 'full_replace') {
    Object.keys(existingByExternalId).forEach(extId => {
      if (!desired[extId]) {
        Calendar.Events.remove(CALENDAR_ID, existingByExternalId[extId].id);
        deleted++;
      }
    });
  }

  return {
    workspaceId,
    incomingCount: Object.keys(desired).length,
    created,
    updated,
    deleted
  };
}

function toGoogleEventResource(ev, payload) {
  const start = parseDateTime(ev.start);
  const end = new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60 * 1000);

  const workspaceId = String(payload.workspaceId || 'default');
  const externalId = String(ev.id);

  return {
    summary: ev.title || 'Untitled Event',
    location: ev.location || '',
    description: ev.description || '',
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: {
      private: {
        sourceTag: SOURCE_TAG,
        workspaceId: workspaceId,
        externalId: externalId,
        taskId: String(ev.taskId || ''),
        source: String(ev.source || '')
      }
    }
  };
}

function listManagedEvents(workspaceId) {
  const all = [];
  let pageToken;

  do {
    const resp = Calendar.Events.list(CALENDAR_ID, {
      maxResults: 2500,
      singleEvents: true,
      showDeleted: false,
      privateExtendedProperty: [
        `sourceTag=${SOURCE_TAG}`,
        `workspaceId=${workspaceId}`
      ],
      pageToken: pageToken
    });

    (resp.items || []).forEach(item => all.push(item));
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return all;
}

function parseDateTime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return d;
}

function getPrivateProp(eventObj, key) {
  return eventObj &&
    eventObj.extendedProperties &&
    eventObj.extendedProperties.private &&
    eventObj.extendedProperties.private[key]
    ? String(eventObj.extendedProperties.private[key])
    : '';
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
