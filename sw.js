// Roam. Service Worker — v1
// Caches the app shell so it works offline after first visit

const CACHE = 'roam-v1';
const SHELL = [
  './bloom-calendar.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,500;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js',
];

// Install: cache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // Cache what we can, ignore failures (fonts may be blocked offline)
      return Promise.allSettled(SHELL.map(url => cache.add(url).catch(() => {})));
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', e => {
  // Only handle GET requests
  if(e.request.method !== 'GET') return;

  // For CORS proxy requests (URL auto-fill), always go to network
  const url = e.request.url;
  if(url.includes('allorigins') || url.includes('corsproxy') || url.includes('codetabs')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if(cached) return cached;
      return fetch(e.request).then(response => {
        // Cache successful responses for the app shell
        if(response && response.status === 200 && response.type !== 'opaque') {
          const toCache = response.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, toCache));
        }
        return response;
      }).catch(() => {
        // Offline fallback — serve the main app
        if(e.request.destination === 'document') {
          return caches.match('./bloom-calendar.html');
        }
      });
    })
  );
});
