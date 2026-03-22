// CAB Marketing Service Worker — handles push notifications
const SUPABASE_URL = 'https://qcfntvqvcmshbbpcxmgo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cHrTtrkbSV3AtUD64tnRvA_Zd4iT_TK';

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {});

self.addEventListener('push', (e) => {
    // iOS REQUIRES showing a notification from every push event.
    // Always show immediately — never skip or defer.
    let data = {};
    if (e.data) {
        try { data = e.data.json(); } catch { try { data = { body: e.data.text() }; } catch {} }
    }

    // If we have payload data (encrypted push), show it directly — no fetch needed
    if (data.title) {
        e.waitUntil(self.registration.showNotification(data.title, {
            body: data.body || '',
            icon: data.icon || '',
            tag: data.tag || 'cab-notif-' + Date.now(),
            data: data.data || {},
            renotify: true
        }));
        return;
    }

    // Fallback: if somehow we got an empty push, show a generic notification immediately
    // then try to fetch details (but don't block on it)
    const fallbackTag = 'cab-notif-' + Date.now();
    e.waitUntil(
        // Show generic notification FIRST (iOS will kill SW if we don't show quickly)
        self.registration.showNotification('CAB Marketing', {
            body: 'You have a new notification',
            tag: fallbackTag,
            renotify: true
        }).then(() => {
            // Then try to fetch and update with real content
            return fetch(SUPABASE_URL + '/rest/v1/app_state?select=data&id=eq.1', {
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
            })
            .then(r => r.json())
            .then(rows => {
                if (!rows || !rows[0] || !rows[0].data) return;
                const appData = rows[0].data;
                const allNotifs = appData.notifications || {};
                let latest = null;
                for (const user in allNotifs) {
                    const userNotifs = allNotifs[user] || [];
                    for (const n of userNotifs) {
                        if (!n.read && (!latest || new Date(n.timestamp) > new Date(latest.timestamp))) {
                            latest = n;
                        }
                    }
                }
                if (latest) {
                    return self.registration.showNotification(latest.title || 'CAB Marketing', {
                        body: latest.body || 'You have a new notification',
                        tag: fallbackTag, // Replace the generic one
                        data: { taskId: latest.taskId, type: latest.type },
                        renotify: true
                    });
                }
            })
            .catch(() => {}); // Generic notification already shown, so failing here is OK
        })
    );
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            if (clients.length > 0) {
                clients[0].focus();
                clients[0].postMessage({ type: 'NOTIF_CLICK', data: e.notification.data });
            } else {
                self.clients.openWindow('./');
            }
        })
    );
});
