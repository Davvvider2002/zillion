// Zillion PWA Service Worker
const CACHE = 'zillion-v1';
const ASSETS = ['/wallet/', '/wallet/index.html', '/wallet/manifest.json',
                '/wallet/icon-192.png', '/wallet/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for API calls, cache first for assets
  if (e.request.url.includes('/.netlify/functions/') ||
      e.request.url.includes('/api/v1/')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({error:'Offline — sync when connected'}),
        {headers:{'Content-Type':'application/json'}})));
    return;
  }
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
