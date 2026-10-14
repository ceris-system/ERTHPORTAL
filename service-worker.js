const CACHE_NAME = 'erth-portal-shell-v2';
const APP_URLS = Array.from(new Set([
  new URL('./', self.registration.scope).href,
  new URL('./index.html', self.registration.scope).href
]));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_URLS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('erth-portal-shell-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith((async () => {
    const requestUrl = new URL(request.url);
    const isSameOrigin = requestUrl.origin === self.location.origin;
    if (!isSameOrigin) return fetch(request);

    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        for (const appUrl of APP_URLS) {
          await cache.put(appUrl, response.clone());
        }
      }
      return response;
    } catch (error) {
      const cachedPage = await caches.match(request);
      if (cachedPage) return cachedPage;
      for (const appUrl of APP_URLS) {
        const fallbackPage = await caches.match(appUrl);
        if (fallbackPage) return fallbackPage;
      }
      throw error;
    }
  })());
});
