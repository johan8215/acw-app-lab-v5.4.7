/* ============================================================
   📡 ACW-App API & Network Layer
   (Lógica de red, caché y llamadas HTTP movida de app.js)
   ============================================================ */

/* Caché en memoria con TTL + de-dupe */
const Net = (()=> {
  const store = new Map(); // key -> {expires, value} | inflight: Promise
  function get(key){
    const it = store.get(key);
    if (!it) return null;
    if (it.value && it.expires > Date.now()) return it.value;
    if (it.inflight) return it.inflight; // de-dupe concurrente
    store.delete(key);
    return null;
  }
  function set(key, value, ttl){
    store.set(key, { value, expires: Date.now()+ttl });
    return value;
  }
  function setInflight(key, p){
    store.set(key, { inflight: p, expires: 0 });
  }
  function clearInflight(key){
    const it = store.get(key);
    if (it && it.inflight) store.delete(key);
  }
  return { get, set, setInflight, clearInflight };
})();

/* fetch JSON con TTL y dedupe */
async function fetchJSON(url, { ttl=0, signal } = {}){
  if (ttl>0){
    const cached = Net.get(url);
    if (cached) return cached;
  }
  const inflight = fetch(url, { cache:"no-store", signal }).then(r=>r.json());
  if (ttl>0) Net.setInflight(url, inflight);
  try{
    const j = await inflight;
    if (ttl>0) Net.set(url, j, ttl);
    return j;
  }finally{
    if (ttl>0) Net.clearInflight(url);
  }
}


/* Cliente de la API de Google Apps Script */
const API = {
  // Función auxiliar para construir URLs y codificar parámetros
  _url: (action, params = {}) => {
    const url = new URL(CONFIG.BASE_URL);
    url.searchParams.append("action", action);
    for (const key in params) {
      if (params[key] !== undefined && params[key] !== null) {
        url.searchParams.append(key, params[key]);
      }
    }
    return url.toString();
  },

  // 🔐 Login de Usuario
  login: async ({ email, password }) => {
    const url = API._url("login", { email, password });
    try {
      const res = await fetchJSON(url, { ttl: 0 }); // No cachear login
      return res;
    } catch (error) {
      return { ok: false, error: "Network error or script not deployed." };
    }
  },

  // 🔑 Cambiar Contraseña
  changePassword: async ({ email, oldPass, newPass }) => {
    const url = API._url("changepassword", { 
      email: encodeURIComponent(email), 
      oldPass: encodeURIComponent(oldPass), 
      newPass: encodeURIComponent(newPass) 
    });
    return fetchJSON(url, { ttl: 0 }); 
  },

  // 📅 Obtener Horario de la Semana y Total
  getSchedule: async (controller) => {
    const url = API._url("getschedule", { email: window.currentUser.email });
    return fetchJSON(url, { ttl: 300000, signal: controller?.signal }); // TTL 5 min
  },
  
  // 👥 Obtener Directorio de Empleados (Vista de Manager)
  getDirectory: async (controller) => {
    const url = API._url("getemployeesdirectory", { 
      actor: window.currentUser.email,
      role: window.currentUser.role // Opcional: para validación backend
    });
    // Cachear agresivamente (10 minutos) ya que no cambia mucho
    return fetchJSON(url, { ttl: 600000, signal: controller?.signal }); 
  },
  
  // ✍️ Actualizar Turno (Requiere rol de Manager/Supervisor)
  updateShift: async ({ targetEmail, newShift, actor }) => {
    const url = API._url("updateshiftapi", { 
      email: encodeURIComponent(targetEmail), 
      shift: encodeURIComponent(newShift), 
      actor: encodeURIComponent(actor) 
    });
    return fetchJSON(url, { ttl: 0 }); // No cachear
  },

  // 💬 Enviar mensaje por WhatsApp
  sendShift: async ({ targetEmail, action, actor }) => {
    const enc = encodeURIComponent;
    const url = API._url(action, { 
      target: enc(targetEmail),
      actor: enc(actor)
    });
    // Se agregan variantes de URL para redundancia (como en el original)
    const tries = [
        url,
        `${url.replace(`action=${action}`, 'action=updateshift')}`, // Fallback al v1
        `${CONFIG.BASE_URL}?action=updateshiftapi_v1&email=${enc(targetEmail)}${actor?`&actor=${enc(actor)}`:''}` // Fallback antiguo
    ].filter(Boolean);

    let lastErr = null;
    for (const u of tries){
      try{
        const j = await fetchJSON(u, { ttl:0 });
        if (j?.ok) return { ok:true, data:j, used:u };
        lastErr = j?.error || "send_failed";
      }catch(e){
        lastErr = e?.message || String(e);
      }
    }
    return { ok:false, error:lastErr || "all_variants_failed" };
  },
};

// Exponer la API globalmente para ser usada en app.js
window.API = API;
