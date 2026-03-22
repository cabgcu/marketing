// CAB Marketing Service Worker — handles push notifications
const SUPABASE_URL = 'https://qcfntvqvcmshbbpcxmgo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cHrTtrkbSV3AtUD64tnRvA_Zd4iT_TK';

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {});

self.addEventListener('push', (e) => {
    let data = {};
    // Try to read payload (if encrypted payload was sent)
    if (e.data) {
        try { data = e.data.json(); } catch { try { data = { body: e.data.text() }; } catch {} }
    }

    // If we got a payload, show it directly
    if (data.title) {
        e.waitUntil(self.registration.showNotification(data.title, {
            body: data.body || '',
            icon: data.icon || '',
            tag: data.tag || 'cab-notif',
            data: data.data || {},
            renotify: true
        }));
        return;
    }

    // No payload — this is a wake-up push. Fetch latest notifications from Supabase.
    e.waitUntil(
        fetch(SUPABASE_URL + '/rest/v1/app_state?select=data&id=eq.1', {
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
        })
        .then(r => r.json())
        .then(rows => {
            if (!rows || !rows[0] || !rows[0].data) return;
            const appData = rows[0].data;
            // Find unread notifications for any user (SW doesn't know which user, show latest unread)
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
                    tag: 'cab-' + (latest.type || 'notif') + '-' + (latest.id || Date.now()),
                    data: { taskId: latest.taskId, type: latest.type },
                    renotify: true
                });
            } else {
                return self.registration.showNotification('CAB Marketing', {
                    body: 'You have a new notification',
                    tag: 'cab-notif-' + Date.now(),
                    renotify: true
                });
            }
        })
        .catch(() => {
            return self.registration.showNotification('CAB Marketing', {
                body: 'You have a new notification',
                tag: 'cab-notif-' + Date.now(),
                renotify: true
            });
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
