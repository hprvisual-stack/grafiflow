const CACHE_NAME = 'grafiflow-static-v16';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=20261003-grafiflow-cloud-sync-v1',
  './app.js?v=20261003-grafiflow-cloud-sync-v1',
  './config.js?v=20261003-grafiflow-cloud-sync-v1',
  './manifest.webmanifest?v=20261003-grafiflow-cloud-sync-v1',
  './grafiflow-favicon-v3.png',
  './grafiflow-logo.jpg',
  './grafiflow-icon-192-v3.png',
  './grafiflow-icon-512-v3.png',
  './grafiflow-icon-maskable-192-v3.png',
  './grafiflow-icon-maskable-512-v3.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match('./index.html'))));
});
