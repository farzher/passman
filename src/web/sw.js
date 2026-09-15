const CACHE = 'passman-shell-v2';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './ui.css',
  './app.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  const freshShell = SHELL.map(url => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(freshShell)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const freshRequest = new Request(request, { cache: 'no-store' });
  if (request.mode === 'navigate') {
    event.respondWith(fetch(freshRequest).catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(
    fetch(freshRequest)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
