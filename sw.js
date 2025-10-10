// A unique name for our cache.
const CACHE_NAME = 'elara-bgc-cache-v3'; // Updated the version again

// The list of files to cache. ONLY the files we know for sure exist.
const urlsToCache = [
  '/bgc-website/Elara_webpage.html'
];

/**
 * ------------------------------------------------------------------------------------
 * 1. Install Event
 * ------------------------------------------------------------------------------------
 */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache and caching files');
        return cache.addAll(urlsToCache);
      })
      .catch(error => {
        console.error('Failed to cache files during install:', error);
      })
  );
  self.skipWaiting();
});

/**
 * ------------------------------------------------------------------------------------
 * 2. Fetch Event
 * ------------------------------------------------------------------------------------
 */
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // If a cached response is found, return it.
        if (response) {
          return response;
        }
        // Otherwise, fetch from the network.
        return fetch(event.request);
      })
  );
});

/**
 * ------------------------------------------------------------------------------------
 * 3. Activate Event
 * ------------------------------------------------------------------------------------
 */
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

