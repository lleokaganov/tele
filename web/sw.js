// Minimal Service Worker. Exists so the browser allows PWA install.
// No caching of our own — every request falls through to network.
// nginx serves with Cache-Control: no-store, so the user always gets
// the latest build. While the project is in heavy iteration, that's
// safer than baking a wrong version into the user's SW cache.

self.addEventListener('install',  (e) => { self.skipWaiting() })
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

// Defensively unregister any cache that an older SW build may have
// created — keep the user's storage clean during the iteration phase.
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.map(n => caches.delete(n)))
  })())
})

// Explicit network passthrough — bypass any HTTP cache, always go to
// the origin. Ensures fresh assets even if the PWA was opened from a
// stale splash screen.
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => fetch(e.request)))
})

// Web Push: the server wakes us when a peer messaged/called while offline.
// The payload (if any) carries a title/body; fall back to a generic notice.
self.addEventListener('push', (event) => {
  let title = 'telefon'
  let body  = 'New message or incoming call'
  let data  = {}
  if (event.data) {
    try {
      const p = event.data.json()
      if (p && typeof p === 'object') {
        title = p.title || title
        body  = p.body  || body
        data  = p
      }
    } catch {
      // Not JSON — use the raw text as the body if present.
      try { const t = event.data.text(); if (t) body = t } catch {}
    }
  }
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'telefon',
    renotify: true,
    data,
  }))
})

// Tapping a notification focuses an already-open app window, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus()
      }
      if (clients.openWindow) return clients.openWindow('/')
    })
  )
})
