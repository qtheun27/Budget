// Service worker — Budget du Foyer
// - Page : réseau d'abord (mises à jour immédiates), cache en secours hors ligne.
// - Fichiers de l'appli et SDK Firebase (versions figées, immuables) : cache d'abord.
// - Les échanges avec Firebase (Auth, Firestore) ne sont jamais interceptés : le SDK gère lui-même le hors ligne.
const CACHE = 'budget-foyer-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png'];
const FIREBASE_SDK = /^https:\/\/www\.gstatic\.com\/firebasejs\/\d+\.\d+\.\d+\//;

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !FIREBASE_SDK.test(req.url)) return;

  if (sameOrigin && req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('./index.html', c)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  })));
});
