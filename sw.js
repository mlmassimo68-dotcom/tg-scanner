// TG Scanner Service Worker v3.3
const CACHE = 'tg-scanner-v3.3';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting(); // forza attivazione immediata
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // prendi controllo immediato di tutte le schede
});

self.addEventListener('fetch', e => {
  // Rete per API worker e Yahoo Finance, cache per assets statici
  if (e.request.url.includes('workers.dev') || e.request.url.includes('yahoo')) {
    e.respondWith(fetch(e.request).catch(() => new Response('offline', { status: 503 })));
    return;
  }
  // Network-first per HTML (sempre versione fresca)
  if (e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Cache-first per altri asset
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
