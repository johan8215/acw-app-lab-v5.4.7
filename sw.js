// ===========================================================
// 🧩 ACW-App Service Worker v5.6.3 — Fixed Offline & Cache
// ===========================================================

const CACHE_NAME = "acw-cache-v5.6.3";
const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./acw-icon-512.png"
];

self.addEventListener("install", (event) => {
  console.log("🪣 Installing ACW Service Worker...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
});

self.addEventListener("activate", (event) => {
  console.log("♻️ Activating new cache version");
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // ⚠️ Do NOT intercept backend calls (GAS)
  if (req.url.includes("script.google.com/macros")) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      return cached || fetch(req).catch(() =>
        new Response("Offline or not found", { status: 404 })
      );
    })
  );
});

console.log("✅ ACW Service Worker v5.6.3 active");
