// Работа без интернета: окно приложения хранится в телефоне.
// При каждой правке файлов увеличивать VERSION.
const VERSION = "gde-lovit-v8";
const TILES = "gde-lovit-tiles"; // карта: отдельный кэш, не стирается при обновлении приложения
const MAX_TILES = 3000;
const FILES = ["./", "index.html", "style.css", "app.js", "core.js", "manifest.json", "icon.svg", "vendor/leaflet.js", "vendor/leaflet.css"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Плитки карты: сначала из памяти телефона (работает в лесу), иначе из сети и запомнить.
  if (url.hostname === "tile.openstreetmap.org") { e.respondWith(tile(e.request)); return; }
  // Замер скорости — всегда из сети, мимо кэша.
  if (url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});

async function tile(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req.url);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.type === "cors") {
    await c.put(req.url, r.clone());
    const keys = await c.keys();
    if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) await c.delete(k);
  }
  return r;
}
