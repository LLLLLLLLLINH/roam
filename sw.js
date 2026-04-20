// Roam. Service Worker — v2
const CACHE = 'roam-v2';
const BASE = 'https://llllllllinh.github.io/roam/';
const SHELL = [
  BASE + 'index.html',
  BASE + 'icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(SHELL.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Wipe ALL old caches so stale 404s are gone
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = e.request.url;
  if(url.includes('allorigins') || url.includes('corsproxy') || url.includes('codetabs')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if(cached) return cached;
      return fetch(e.request).then(response => {
        if(response && response.status === 200) {
          caches.open(CACHE).then(cache => cache.put(e.request, response.clone()));
        }
        return response;
      }).catch(() => caches.match(BASE + 'index.html'));
    })
  );
});
