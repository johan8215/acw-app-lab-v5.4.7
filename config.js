// ===========================================================
// 🧠 ACW-App Config v5.6.2 — Blue Glass White Connected Edition
// Johan A. Giraldo (JAG15) | Allston Car Wash © 2025
// ===========================================================

const CONFIG = {
  BASE_URL: "https://script.google.com/macros/s/AKfycbx-6DqfjydMMGp-K2z8FeBSH9t8Z1Ooa0Ene0u917RK7Eo6vu80aOTLmCf7lJtm-Ckh/exec".trim(),
  VERSION: "v5.6.2 — Blue Glass White Connected Edition",

  // === Directory config (nuevo) ============================
  // Archivo local que será la fuente primaria del directorio.
  // Crea un `directory.json` en la misma carpeta de `index.html`.
  DIR_URL: "./directory.json",

  // Opcional: TTL de caché para el directorio (usado por API.getDirectory).
  DIR_TTL_MS: 5 * 60 * 1000,

  // Opcional: si TRUE, usa SOLO el archivo local (no mezcla con Sheets).
  // Si FALSE (recomendado), mezcla: local manda y GAS completa lo que falte.
  DIR_STRICT_LOCAL: false
};

// 🔁 Asegura visibilidad global
window.CONFIG = CONFIG;

// 🧩 Log no bloqueante
setTimeout(() => {
  console.log(`✅ ACW-App connected → ${CONFIG.VERSION}`);
  console.log(`🌐 Backend: ${CONFIG.BASE_URL}`);
  console.log(`📇 Directory: ${CONFIG.DIR_URL} (strictLocal=${CONFIG.DIR_STRICT_LOCAL})`);
}, 100);
