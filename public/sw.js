// Minimal service worker — fetch passthrough only.
// Enables PWA installability without adding caching.
// A read-it-later app's content must always be fresh from the server.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Only intercept same-origin requests. Cross-origin resource fetches (images from
  // external CDNs) must pass through natively so the browser honours the
  // referrerpolicy attribute on <img> elements — SW re-fetch loses that context,
  // causing hotlink-protected CDNs to block the request with ERR_FAILED.
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(fetch(event.request));
});
