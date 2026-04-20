// Roam. Service Worker — v5
const CACHE = 'roam-v5';

self.addEventListener('install', e => {
  // Take over immediately — don't wait for old SW to die
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.add(self.registration.scope).catch(() => {}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // Take control of all open tabs immediately
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = e.request.url;
  if(url.includes('allorigins') || url.includes('corsproxy') || url.includes('codetabs')) return;

  // Network-first for HTML (always get latest version)
  // Cache-first for everything else (fonts, scripts)
  const isHTML = e.request.destination === 'document' || url.endsWith('.html') || url.endsWith('/');

  if(isHTML) {
    e.respondWith(
      fetch(e.request)
        .then(response => {
          if(response && response.status === 200) {
            caches.open(CACHE).then(cache => cache.put(e.request, response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(e.request)) // Offline fallback
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if(cached) return cached;
        return fetch(e.request).then(response => {
          if(response && response.status === 200) {
            caches.open(CACHE).then(cache => cache.put(e.request, response.clone()));
          }
          return response;
        }).catch(() => caches.match(self.registration.scope));
      })
    );
  }
});

// Tell all open clients to reload when a new version activates
self.addEventListener('message', e => {
  if(e.data === 'skipWaiting') self.skipWaiting();
});
