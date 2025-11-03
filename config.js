// ===========================================================
// 🧠 ACW-App Config v5.6.3 Turbo — Blue Glass White Connected
// Johan A. Giraldo (JAG15) & Sky — Nov 2025
// Pair with: ACW LOGIN v4.6.9 R1 (stable) or your current GAS WebApp
// ===========================================================

const CONFIG = {
  BASE_URL: "https://script.google.com/macros/s/<TU_ID>/exec".trim(),
  VERSION: "v5.6.2 — Blue Glass White Connected Edition",

  // === Nuevo: directorio local / registro ===
  USE_LOCAL_DIRECTORY: false,          // true = usar SOLO el directorio local
  LOCAL_DIR_TTL: 30 * 24 * 60 * 60 * 1000, // 30 días (por si quieres caducar)
  ALLOW_SELF_REGISTRATION: true,       // muestra registro si faltan datos del usuario
  DIR_VERSION: "acw-dir-1"             // cambia esto si quieres forzar “reset” local
};
window.CONFIG = CONFIG;

setTimeout(() => {
  console.log(`✅ ACW-App connected → ${CONFIG.VERSION}`);
  console.log(`🌐 Backend: ${CONFIG.BASE_URL}`);
}, 50);
