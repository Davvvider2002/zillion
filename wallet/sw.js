// Zillion Wallet — Service Worker
// Offline-first: app shell cached, API calls network-first
'use strict';

const CACHE_NAME    = 'zillion-wallet-v1.0.46';
const OFFLINE_QUEUE = 'zillion-wallet-offline-queue';

// App shell files — same origin only
const SHELL_FILES = [
  '/wallet/',
  '/wallet/index.html',
  '/wallet/manifest.json',
  '/wallet/icon-192.png',
  '/wallet/icon-512.png',
  '/wallet/icon.svg'
];

// ── INSTALL ───────────────────────────────────────────────────────
// cache.addAll() uses a plain fetch() internally, which does NOT
// bypass the browser's own HTTP cache (a layer separate from this
// Service Worker's Cache Storage). Android WebView's HTTP cache is
// more aggressive than desktop browsers about reusing responses —
// meaning cache.addAll could silently pull a STALE HTTP-cached copy
// of index.html into what's supposed to be the fresh v1.0.32+ cache,
// making the cache confidently wrong rather than actually current.
// Explicit {cache:'reload'} on every shell-file fetch forces a real
// network round-trip every install, closing that gap.
self.addEventListener('install', event => {
  console.log('[SW] Installing wallet ' + CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.allSettled(
        SHELL_FILES.map(url =>
          fetch(url, { cache: 'reload' })
            .then(resp => cache.put(url, resp))
            .catch(err => console.warn('[SW] Shell fetch failed for', url, err.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: delete ALL old caches ──────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating wallet ' + CACHE_NAME);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== OFFLINE_QUEUE)
            .map(k => {
              console.log('[SW] Deleting old cache:', k);
              return caches.delete(k);
            })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // IMPORTANT: Skip ALL cross-origin requests entirely
  // Fonts, CDNs, etc. are blocked by CSP — letting them through
  // causes TypeError crashes that break the entire SW fetch handler
  if (url.origin !== self.location.origin) {
    return; // let browser handle normally, no SW interception
  }

  // API / Netlify functions: always network-first, never cache
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/.netlify/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(
          JSON.stringify({ error: 'Offline — will sync when reconnected.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // App shell: cache-first, network fallback, then cache update
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Serve from cache and refresh in background — cache:'reload'
        // forces a genuine network fetch here too, so a stale entry
        // can actually self-heal on the next load instead of the
        // background "refresh" itself pulling the same stale HTTP-
        // cached response back in.
        const networkFetch = fetch(req, { cache: 'reload' }).then(resp => {
          if (resp && resp.status === 200 && resp.type !== 'opaque') {
            caches.open(CACHE_NAME).then(c => c.put(req, resp.clone()));
          }
          return resp;
        }).catch(() => {});
        return cached;
      }
      // Not in cache — fetch from network
      return fetch(req, { cache: 'reload' }).then(resp => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return resp;
      }).catch(() => {
        // Offline fallback
        if (url.pathname.startsWith('/wallet')) {
          return caches.match('/wallet/index.html') ||
                 caches.match('/wallet/');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ── MESSAGE: force update ─────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'Zillion', {
        body:    data.body || '',
        icon:    '/wallet/icon-192.png',
        badge:   '/wallet/icon-192.png',
        vibrate: [200, 100, 200],
        data:    data,
      })
    );
  } catch(e) {}
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/wallet/'));
});

console.log('[SW] Wallet Service Worker loaded — cache: ' + CACHE_NAME);
