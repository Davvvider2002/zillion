// Zillion Wallet — Service Worker v1.0.4
// Offline-first: app shell cached, API calls network-first with offline queue
'use strict';

const CACHE_NAME    = 'zillion-wallet-v1.0.4';
const OFFLINE_QUEUE = 'zillion-wallet-offline-queue';

// App shell — cache these on install
const SHELL_FILES = [
  "/wallet/",
  "/wallet/index.html",
  "/wallet/manifest.json",
  "/wallet/icon-192.png",
  "/wallet/icon-512.png",
  "/wallet/icon.svg"
];

// ── INSTALL: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing wallet v1.0.4');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_FILES).catch(err => {
        console.warn('[SW] Some shell files failed to cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating wallet v1.0.4');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('zillion-wallet-') && k !== CACHE_NAME)
            .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: network-first for API, cache-first for shell ───────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET, non-http requests
  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // API calls: network-first, no caching
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'You are offline. This action will sync when reconnected.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // App shell: cache-first with network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses for the app shell
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index if available
        if (url.pathname.includes('wallet') || url.pathname === '/') {
          return caches.match('/wallet/') ||
                 caches.match('/wallet/index.html');
        }
      });
    })
  );
});

// ── PUSH NOTIFICATIONS (for future use) ──────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Zillion', {
      body:    data.body    || '',
      icon:    '/wallet/icon-192.png',
      badge:   '/wallet/icon-192.png',
      vibrate: [200, 100, 200],
      data:    data,
      actions: data.actions || [],
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/wallet/')
  );
});

console.log('[SW] Wallet Service Worker loaded — cache: ' + CACHE_NAME);

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
