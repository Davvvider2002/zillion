// Zillion Ajo Collector — Service Worker
// Offline-first: app shell cached (same pattern as the main wallet's sw.js), and — the addition this app
// needed that the wallet doesn't — the read data a collector actually needs mid-round (their scheme list,
// a scheme's member list) is cached too, stale-while-revalidate, so a signal gap partway through a
// collection round doesn't leave the screen blank. Cash-recording itself (the one action that genuinely
// can't fail silently) uses its own separate localStorage queue in index.html, not this cache — a write
// needs a durable queue with explicit sync/retry semantics, not a "serve what's cached" read strategy.
'use strict';

const CACHE_NAME  = 'zillion-ajo-collector-v1';
const DATA_CACHE  = 'zillion-ajo-collector-data-v1';

const SHELL_FILES = [
  '/ajo-collector/',
  '/ajo-collector/index.html',
  '/ajo-collector/manifest.json',
  '/ajo-collector/icon-192.png',
  '/ajo-collector/icon-512.png',
  '/ajo-collector/icon.svg',
];

// Only these GET endpoints are safe to serve stale — a collector's own scheme list and a scheme's member
// list. Nothing involving money balances, reconciliation state, or anything else that must be current is
// ever cached here; those stay network-only, same as before.
const STALE_WHILE_REVALIDATE_PATHS = [
  '/.netlify/functions/ajo-collector-my-schemes',
  '/.netlify/functions/ajo-collector-scheme-members',
];

self.addEventListener('install', event => {
  console.log('[SW] Installing Ajo Collector ' + CACHE_NAME);
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

self.addEventListener('activate', event => {
  console.log('[SW] Activating Ajo Collector ' + CACHE_NAME);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== DATA_CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: let the browser handle it normally

  // Stale-while-revalidate for the specific read endpoints listed above.
  if (STALE_WHILE_REVALIDATE_PATHS.some(p => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async cache => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req).then(resp => {
          if (resp && resp.status === 200) cache.put(req, resp.clone());
          return resp;
        }).catch(() => null);

        if (cached) {
          // Serve the cached copy immediately, refresh in the background — the app marks this data as
          // "may be a few minutes old" when it notices X-From-Cache below, rather than presenting it as live.
          networkFetch; // fire and forget - next load picks up the refreshed copy
          const staleResp = cached.clone();
          const headers = new Headers(staleResp.headers);
          headers.set('X-From-Cache', 'true');
          return new Response(staleResp.body, { status: staleResp.status, headers });
        }
        // Nothing cached yet - this is the first load, must come from the network.
        const fresh = await networkFetch;
        if (fresh) return fresh;
        return new Response(JSON.stringify({ error: 'Offline, and nothing cached yet for this — connect once first.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // Every other API/function call: network-first, never cached — same as the wallet's sw.js.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — will sync when reconnected.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // App shell: cache-first, network refresh in the background (identical pattern to the wallet's sw.js,
  // including forcing a real network round-trip via {cache:'reload'} so a stale HTTP-cached response can't
  // quietly get pulled into the Cache Storage as if it were fresh).
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        fetch(req, { cache: 'reload' }).then(resp => {
          if (resp && resp.status === 200 && resp.type !== 'opaque') {
            caches.open(CACHE_NAME).then(c => c.put(req, resp.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req, { cache: 'reload' }).then(resp => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          caches.open(CACHE_NAME).then(c => c.put(req, resp.clone()));
        }
        return resp;
      }).catch(() => {
        if (url.pathname.startsWith('/ajo-collector')) return caches.match('/ajo-collector/index.html');
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

console.log('[SW] Ajo Collector Service Worker loaded — cache: ' + CACHE_NAME);
