// CAB Marketing Service Worker — handles push notifications
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {});

self.addEventListener('push', (e) => {
    const data = e.data ? e.data.json() : {};
    const title = data.title || 'CAB Marketing';
    const options = {
        body: data.body || '',
        icon: data.icon || '',
        badge: data.badge || '',
        tag: data.tag || 'cab-notif',
        data: data.data || {},
        renotify: true
    };
    e.waitUntil(self.registration.showNotification(title, options));
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
