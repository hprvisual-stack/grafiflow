const CACHE_NAME = 'grafiflow-static-v50';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=20261103-metriflow-rebrand',
  './app.js?v=20261103-metriflow-rebrand',
  './offline-billing.js',
  './cloud-sync-policy.js',
  './api/config?v=20261103-metriflow-rebrand',
  './manifest.webmanifest?v=20261103-metriflow-rebrand',
  './metriflow-favicon.png',
  './metriflow-logo.png',
  './login-print-roll-v1.png',
  './metriflow-icon-192.png',
  './metriflow-icon-512.png',
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
