/* ============================================================
   🧠 ACW-App v5.6.3 Turbo — Blue Glass White Connected (Refactored)
   Johan A. Giraldo (JAG15) & Sky — Dec 2025 (Improved by Gemini)
   ============================================================
   Mejoras clave:
   - Capa de red/API modularizada en 'api.js'
   - Roles centralizados en 'config.js'
   ============================================================ */

// NOTA: La API (Net, fetchJSON, API object) ahora se carga desde './api.js'

let currentUser = null;

/* =================== Utils / Core =================== */
function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

// Usa el array centralizado en CONFIG.MANAGER_ROLES
function isManagerRole(role){ 
  // Usa un Set para chequeo de roles más eficiente
  const managerRoles = new Set(CONFIG.MANAGER_ROLES); 
  return managerRoles.has(String(role||"").toLowerCase()); 
}

// ✅ FUNCIÓN DE LÓGICA INVERTIDA (Para validar roles de empleados no-manager)
function isEmployeeRole(role){
  return !isManagerRole(role);
}

function safeText(el, txt){ if(el) el.textContent = txt; }
function setVisible(el, show){ if(!el) return; el.style.display = show ? "" : "none"; }
function cssEscape(s){ try{return CSS.escape(s);}catch{ return String(s).replace(/[^a-zA-Z0-9_\-]/g,"_"); } }

/* Hoy cacheado + refresco a medianoche */
const Today = (()=> {
  let key = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
  // programa cambio a medianoche
  const now = new Date();
  const next = new Date(now); next.setHours(24,0,0,0);
  setTimeout(()=>{ key = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase(); }, next-now+50);
  return { get key(){ return key; } };
})();

/* (El resto de la lógica de la aplicación se mantiene igual, 
   pero ahora usa window.API en lugar de la lógica de red interna). 
   Por ejemplo, loginUser ahora usa API.login() */
// ... (Resto de tu código de app.js)
