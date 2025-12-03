// Service Worker for AB Control Hub
// Strategy: Network First, falling back to Cache
// This ensures Ads/Analytics run fresh when online, but app works offline.

const CACHE_NAME = 'ab-control-hub-v19-network-first';

// Files to cache (Basic app shell)
const urlsToCache = [
  './',             // Cache root for GitHub Pages
  'index.html',
  'js/core.js',
  'js/utils.js',
  'js/controller-manager.js',
  'css/main.css',
  'css/finetune.css',
  'lang/ar_ar.json',
  'lang/en_us.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache app shell immediately
      return Promise.all(
        urlsToCache.map(url => {
          return cache.add(url).catch(err => {
             console.warn("Failed to cache:", url, err);
             // Ignore individual file failures to not break install
          });
        })
      );
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Ignore non-http requests
  if (!event.request.url.startsWith('http')) return;
  
  // Only handle requests to our own origin (GitHub Pages) for caching
  // Let external requests (Google Ads, Analytics) go straight to network
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
     return; // Browser handles this as normal network request
  }

  // For our own files: Network First Strategy
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // If we got a valid response from network
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            // Clone it and update cache for next time we are offline
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseToCache);
            });
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed (Offline mode) -> Fallback to Cache
        return caches.match(event.request).then(response => {
            if (response) return response;
            // Fallback for root path if exact match fails
            if (url.pathname.endsWith('/')) {
                return caches.match('index.html');
            }
        });
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            // Clean up old caches
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});