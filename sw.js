// Работа без интернета: окно приложения хранится в телефоне.
// При каждой правке файлов увеличивать VERSION.
const VERSION = "gde-lovit-v3";
const FILES = ["./", "index.html", "style.css", "app.js", "core.js", "manifest.json", "icon.svg", "vendor/leaflet.js", "vendor/leaflet.css"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Замер скорости и карта — всегда из сети, мимо кэша.
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
