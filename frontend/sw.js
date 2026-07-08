/* Service worker — network-first so the latest code always loads while online
   (this app needs the network to run anyway), with a cached shell as an offline
   fallback and for installability. Cache-first was a mistake: it served stale
   JS/CSS after updates. Bump CACHE to force old clients to refresh. */
const CACHE = "arena-v2";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "animations.js",
  "manifest.webmanifest",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Real-time traffic always goes straight to the network.
  if (url.pathname.startsWith("/socket.io") || url.pathname.startsWith("/api")) return;
  if (e.request.method !== "GET") return;

  // Network-first: fetch fresh, update the cache, fall back to cache only when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
