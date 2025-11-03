// ===========================================================
// 🧩 ACW-App Service Worker v5.6.3 — Safer Updates
// ===========================================================

const CACHE_NAME = "acw-cache-v5.6.3";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json"
];

// 🧱 Instalar y precache
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

// ♻️ Activar y limpiar versiones viejas
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 🌐 Estrategias de fetch
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ⚠️ No interceptar backend GAS
  if (url.hostname.includes("script.google.com")) return;

  // 1) Navegación/HTML → network-first
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
    );
    return;
  }

  // 2) Críticos (JS de app y config) → network-first
  if (/\/(app\.js|config\.js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 3) Resto → cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => new Response("Offline", { status: 503 }));
    })
  );
});
