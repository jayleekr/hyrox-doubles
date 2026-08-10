// Minimal service worker: makes the app installable and keeps the shell available
// offline. Sheet data is always fetched from the network — a stale log is worse
// than no log.

const SHELL = "hyrox-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(["/", "/manifest.webmanifest", "/icon-192.png"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache sheet data
  // The personal link carries the access key in ?k=. Caching that URL would persist the
  // secret in Cache Storage, undoing the scrubbing the app does on load.
  if (url.search) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match("/"))),
  );
});
