const CACHE_NAME = 'grafiflow-static-v39';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=20261029-account-merge-v1',
  './app.js?v=20261029-account-merge-v1',
  './config.js?v=20261029-account-merge-v1',
  './manifest.webmanifest?v=20261029-account-merge-v1',
  './grafiflow-favicon-v3.png',
  './grafiflow-logo.jpg',
  './login-print-roll-v1.png',
  './grafiflow-icon-192-v3.png',
  './grafiflow-icon-512-v3.png',
  './grafiflow-icon-maskable-192-v3.png',
  './grafiflow-icon-maskable-512-v3.png',
];
const APP_SHELL_URLS = new Set(APP_SHELL.map((asset) => new URL(asset, self.location.href).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  const isAppShellAsset = APP_SHELL_URLS.has(requestUrl.href);
  const isNavigation = event.request.mode === 'navigate';
  if (!isAppShellAsset && !isNavigation) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (isAppShellAsset && response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (isNavigation) {
        const appShell = await cache.match(new URL('./index.html', self.location.href).href);
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
