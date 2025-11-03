// ===========================================================
// 🧠 ACW-App Config v5.6.3 Turbo — Blue Glass White Connected
// Johan A. Giraldo (JAG15) & Sky — Nov 2025
// Pair with: ACW LOGIN v4.6.9 R1 (stable) or your current GAS WebApp
// ===========================================================

const CONFIG = {
  // ⬇️ Put your GAS Web App URL here (R1 stable recommended)
  BASE_URL: "https://script.google.com/macros/s/AKfycbx-6DqfjydMMGp-K2z8FeBSH9t8Z1Ooa0Ene0u917RK7Eo6vu80aOTLmCf7lJtm-Ckh/exec".trim(),
  VERSION: "🧠 ACW‑App v5.6.3 Turbo — Blue Glass White Connected"
};

// Global
window.CONFIG = CONFIG;

setTimeout(() => {
  console.log(`✅ ACW-App connected → ${CONFIG.VERSION}`);
  console.log(`🌐 Backend: ${CONFIG.BASE_URL}`);
}, 50);
