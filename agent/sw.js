// Zillion Agent — Service Worker v1.0.0
// Offline-first: app shell cached, API calls network-first with offline queue
'use strict';

const CACHE_NAME    = 'zillion-agent-v1.0.0';
const OFFLINE_QUEUE = 'zillion-agent-offline-queue';

// App shell — cache these on install
const SHELL_FILES = [
  "/agent/",
  "/agent/index.html",
  "/agent/manifest.json",
  "/agent/icon.svg"
];

// ── INSTALL: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing agent v1.0.0');
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
  console.log('[SW] Activating agent v1.0.0');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k.startsWith('zillion-agent-') && k !== CACHE_NAME)
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
        if (url.pathname.includes('agent') || url.pathname === '/') {
          return caches.match('/agent/') ||
                 caches.match('/agent/index.html');
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
      icon:    '/agent/icon-192.png',
      badge:   '/agent/icon-192.png',
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
    clients.openWindow('/agent/')
  );
});

console.log('[SW] Agent Service Worker loaded — cache: ' + CACHE_NAME);
