// ============================================================
// 🧠 ACW-App Config v5.6.3 — Modularized Edition
// Johan A. Giraldo (JAG15) & Sky — Dec 2025 (Improved by Gemini)
// ============================================================

const CONFIG = {
  // 🌐 URL de tu Web App de Google Apps Script (Reemplaza con tu URL)
  BASE_URL: "https://script.google.com/macros/s/AKfycbx-6DqfjydMMGp-K2z8FeBSH9t8Z1Ooa0Ene0u917RK7Eo6vu80aOTLmCf7lJtm-Ckh/exec".trim(),
  VERSION: "v5.6.3 — Modularized Edition",

  // 🔐 Roles con permisos de gestión (centralizado para consistencia)
  MANAGER_ROLES: ["manager", "supervisor"], 
};

// 🔁 Asegura visibilidad global
window.CONFIG = CONFIG;

// 🧩 Log no bloqueante
setTimeout(() => {
  console.log(`✅ ACW-App connected → ${CONFIG.VERSION}`);
  console.log(`🌐 Backend: ${CONFIG.BASE_URL}`);
}, 100);
