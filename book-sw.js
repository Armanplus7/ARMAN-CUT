const CACHE = 'arman-book-v1';
const SHELL = ['./book.html', './book-config.js', './book-manifest.json', './book-icon-192.png', './book-icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const fonts = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname);
  if (u.origin !== self.location.origin && !fonts) return;   // never touch Supabase calls
  if (fonts) {                                                // fonts: cache first
    e.respondWith(caches.match(r).then((hit) => hit || fetch(r).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); return res;
    })));
    return;
  }
  e.respondWith(                                              // our files: network first, cache when offline
    fetch(r).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)); return res;
    }).catch(() => caches.match(r))
  );
});
