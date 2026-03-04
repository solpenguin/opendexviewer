// OpenDex Service Worker — lightweight app-shell caching
const CACHE_NAME = 'opendex-v5';

// App shell: static assets worth caching for offline/fast loads
const APP_SHELL = [
  '/',
  '/tokens.html',
  '/css/styles.css',
  '/js/config.js',
  '/js/api.js',
  '/js/tokens.js',
  '/js/wallet.js',
  '/js/watchlist.js',
  '/js/voting.js',
  '/js/bugReport.js',
  '/js/announcements.js',
  '/OpenDEX_Logo.png',
  '/manifest.json'
];

// Install: pre-cache app shell (individual fetches so one 404 doesn't kill the whole install)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(key => key !== CACHE_NAME)
        .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for HTML, stale-while-revalidate for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, external requests, or non-GET
  if (event.request.method !== 'GET' ||
      url.pathname.startsWith('/api/') ||
      url.origin !== self.location.origin) {
    return;
  }

  // HTML pages: network-first (always get fresh content, fall back to cache)
  if (event.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (JS, CSS, images): stale-while-revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed — return cached version if we have one, otherwise let the browser handle it
          if (cached) return cached;
          return new Response('', { status: 503, statusText: 'Offline' });
        });

      // Serve from cache immediately if available, otherwise wait for network
      return cached || fetchPromise;
    })
  );
});
