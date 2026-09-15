const CACHE = 'passman-shell-v4';
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

let sessionKey = null;
let sessionTouched = 0;
let driveToken = '';
let driveTokenExpiresAt = 0;

function clearSession() {
  sessionKey?.fill(0);
  sessionKey = null;
  sessionTouched = 0;
}

function clearDriveToken() {
  driveToken = '';
  driveTokenExpiresAt = 0;
}

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

self.addEventListener('message', event => {
  const message = event.data;
  const port = event.ports?.[0];
  if (!port || !message || typeof message.type !== 'string') return;

  try {
    if (message.type === 'PASSMAN_SESSION_SET') {
      const key = message.key;
      if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Invalid session key.');
      clearSession();
      sessionKey = new Uint8Array(key);
      sessionTouched = Date.now();
      port.postMessage({ ok: true, touched: sessionTouched });
      return;
    }

    if (message.type === 'PASSMAN_SESSION_GET') {
      const maxAgeMs = Number(message.maxAgeMs) || 0;
      if (sessionKey && maxAgeMs > 0 && Date.now() - sessionTouched > maxAgeMs) clearSession();
      port.postMessage(sessionKey
        ? { ok: true, key: new Uint8Array(sessionKey), touched: sessionTouched }
        : { ok: true, key: null });
      return;
    }

    if (message.type === 'PASSMAN_SESSION_TOUCH') {
      if (sessionKey) sessionTouched = Date.now();
      port.postMessage({ ok: true, touched: sessionTouched });
      return;
    }

    if (message.type === 'PASSMAN_SESSION_CLEAR') {
      clearSession();
      port.postMessage({ ok: true });
      return;
    }

    if (message.type === 'PASSMAN_DRIVE_SET') {
      const token = String(message.token || '');
      const expiresAt = Number(message.expiresAt) || 0;
      if (!token || expiresAt <= Date.now()) throw new Error('Invalid Drive token.');
      driveToken = token;
      driveTokenExpiresAt = expiresAt;
      port.postMessage({ ok: true });
      return;
    }

    if (message.type === 'PASSMAN_DRIVE_GET') {
      if (driveToken && Date.now() >= driveTokenExpiresAt) clearDriveToken();
      port.postMessage({ ok: true, token: driveToken || null, expiresAt: driveTokenExpiresAt });
      return;
    }

    if (message.type === 'PASSMAN_DRIVE_CLEAR') {
      clearDriveToken();
      port.postMessage({ ok: true });
    }
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
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
