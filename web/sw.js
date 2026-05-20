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
