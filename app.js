/* ============================================================
   🧠 ACW-App v5.6.3 Turbo — Blue Glass White Connected
   Johan A. Giraldo (JAG15) & Sky — Nov 2025
   ============================================================
   Mejoras clave:
   - Caché en memoria con TTL (desduplica y acelera)
   - Team View sin intervalos cuando está cerrado
   - Carga por página con concurrencia limitada
   - AbortController para cancelar al cerrar
   - Menos repaints/DOM touches
   ============================================================ */

let currentUser = null;

/* =================== Utils / Core =================== */
function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }
function isManagerRole(role){ return ["manager","supervisor"].includes(String(role||"").toLowerCase()); }
function safeText(el, txt){ if(el) el.textContent = txt; }
function setVisible(el, show){ if(!el) return; el.style.display = show ? "" : "none"; }
function cssEscape(s){ try{return CSS.escape(s);}catch{ return String(s).replace(/[^a-zA-Z0-9_\-]/g,"_"); } }

/* Hoy cacheado + refresco a medianoche */
const Today = (()=> {
  let key = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
  const now = new Date();
  const next = new Date(now); next.setHours(24,0,0,0);
  setTimeout(()=>{ key = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase(); }, next-now+50);
  return { get key(){ return key; } };
})();

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
  function setInflight(key, p){ store.set(key, { inflight: p, expires: 0 }); }
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
    const data = await inflight;
    if (ttl>0) Net.set(url, data, ttl);
    return data;
  }finally{
    if (ttl>0) Net.clearInflight(url);
  }
}

/* API helpers con TTL inteligentes */
const API = {
  dirTTL: 5*60*1000,         // 5 min
  schedTTL0: 60*1000,        // semana actual 60s (para live y TeamView)
  schedTTLOld: 5*60*1000,    // semanas -1..-4 más relajado

  getDirectory(controller){
    const u = `${CONFIG.BASE_URL}?action=getEmployeesDirectory`;
    return fetchJSON(u, { ttl: API.dirTTL, signal: controller?.signal });
  },
  getSchedule(email, offset=0, controller){
    const ttl = offset===0 ? API.schedTTL0 : API.schedTTLOld;
    const u = `${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}&offset=${offset}`;
    return fetchJSON(u, { ttl, signal: controller?.signal });
  }
};

/* Concurrencia limitada simple (p-limit) */
function runLimited(items, limit, iteratee){
  const queue = [...items];
  let running = 0;
  return new Promise((resolve) => {
    const results = new Array(items.length);
    let idx = 0, done = 0;
    function next(){
      while (running < limit && idx < items.length){
        const cur = idx++;
        running++;
        Promise.resolve(iteratee(items[cur], cur))
          .then(res => { results[cur]=res; })
          .finally(()=>{
            running--; done++;
            if (done===items.length) return resolve(results);
            next();
          });
      }
    }
    next();
  });
}

/* =================== LOGIN =================== */
async function loginUser() {
  const email = $("#email")?.value.trim();
  const password = $("#password")?.value.trim();
  const diag = $("#diag");
  const btn = $("#signInBtn") || $("#login button");

  if (!email || !password) { safeText(diag, "Please enter your email and password."); return; }

  try {
    if (btn){ btn.disabled = true; btn.textContent = "⏳ Loading your shift…"; }
    safeText(diag, "Connecting to Allston Car Wash servers ☀️");

    const res  = await fetch(`${CONFIG.BASE_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`, {cache:"no-store"});
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.error || "Invalid email or password.");

    currentUser = data; // {ok,name,email,role,week}
    localStorage.setItem("acwUser", JSON.stringify(data));

    safeText(diag, "✅ Welcome, " + data.name + "!");
    await showWelcome(data.name, data.role);
    await loadSchedule(email);
  } catch (e) {
    safeText(diag, "❌ " + (e.message || "Login error"));
  } finally {
    if (btn){ btn.disabled = false; btn.textContent = "Sign In"; }
  }
}

/* =================== WELCOME DASHBOARD =================== */
async function showWelcome(name, role) {
  setVisible($("#login"), false);
  setVisible($("#welcome"), true);
  $("#welcomeName").innerHTML = `<b>${name}</b>`;
  safeText($("#welcomeRole"), role || "");

  if (isManagerRole(role)) addTeamButton();

  // Teléfono del usuario (usando caché de directorio)
  try {
    const dir = await API.getDirectory();
    if (dir?.ok && Array.isArray(dir.directory)) {
      const self = dir.directory.find(e => (e.email||"").toLowerCase() === (currentUser?.email||"").toLowerCase());
      if (self?.phone) {
        $(".user-phone")?.remove();
        $("#welcomeName")?.insertAdjacentHTML("afterend",
          `<p class="user-phone">📞 <a href="tel:${self.phone}" style="color:#0078ff;font-weight:600;text-decoration:none;">${self.phone}</a></p>`
        );
      }
    }
  } catch {}
}

/* =================== LOAD SCHEDULE + LIVE =================== */
async function loadSchedule(email) {
  const schedDiv = $("#schedule");
  schedDiv.innerHTML = `<p style="color:#007bff;font-weight:500;">Loading your shift...</p>`;

  try {
    const d = await API.getSchedule(email, 0);
    if (!d?.ok || !Array.isArray(d.days)) {
      schedDiv.innerHTML = `<p style="color:#c00;">No schedule found for this week.</p>`;
      return;
    }

    let html = `<table><tr><th>Day</th><th>Shift</th><th>Hours</th></tr>`;
    const todayKey = Today.key;
    d.days.forEach(day=>{
      const isToday = todayKey === day.name.slice(0,3).toLowerCase();
      html += `<tr class="${isToday?"today":""}"><td>${day.name}</td><td>${day.shift||"-"}</td><td>${day.hours||"0"}</td></tr>`;
    });
    const totalFmt = (d.total??0);
    html += `</table><p class="total">Total Hours: <b>${Number(totalFmt).toFixed(1)}</b></p>`;
    schedDiv.innerHTML = html;

    // Arranca live tras DOM listo
    clearInterval(window.__acwLiveTick__); // evita duplicados
    setTimeout(()=> startLiveTimer(d.days, Number(d.total||0)), 300);

  } catch (e) {
    console.warn(e);
    schedDiv.innerHTML = `<p style="color:#c00;">Error loading schedule.</p>`;
  }
}

/* =================== SESSION RESTORE =================== */
window.addEventListener("load", () => {
  try {
    const saved = localStorage.getItem("acwUser");
    if (saved) {
      currentUser = JSON.parse(saved);
      showWelcome(currentUser.name, currentUser.role);
      loadSchedule(currentUser.email);
    }
  } catch {}
});

/* =================== LIVE TIMER (dashboard) =================== */
function parseTime(str){
  const clean = String(str||"").trim();
  const m = clean.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/i);
  if(!m) return null;
  let h = +m[1], min = +(m[2]||0), s = (m[3]||"").toLowerCase();
  if (s==="pm" && h<12) h+=12;
  if (s==="am" && h===12) h=0;
  const d = new Date(); d.setHours(h, min, 0, 0); return d;
}
function updateTotalDisplay(value, active=false){
  const totalEl = $(".total");
  if (!totalEl || isNaN(value)) return;
  const color = active? "#33a0ff":"#e60000";
  const html = `⚪ Total Hours: <b>${value.toFixed(1)}</b>`;
  if (totalEl.__lastHTML !== html){
    totalEl.__lastHTML = html;
    totalEl.innerHTML = `<span style="color:${color}">${html}</span>`;
  }
}
function showLiveHours(hours, active=true){
  let el = $(".live-hours");
  if (!el) {
    el = document.createElement("p");
    el.className = "live-hours";
    el.style.fontSize="1.05em"; el.style.marginTop="6px"; el.style.textShadow="0 0 10px rgba(0,120,255,.35)";
    $("#schedule")?.appendChild(el);
  }
  el.innerHTML = active ? `⏱️ <b style="color:#33a0ff">${hours.toFixed(1)}h</b>` : "";
}
function addOnlineBadge(){
  if ($("#onlineBadge")) return;
  const badge = document.createElement("span");
  badge.id="onlineBadge"; badge.textContent="🟢 Online";
  Object.assign(badge.style,{display:"block",fontWeight:"600",color:"#33ff66",textShadow:"0 0 10px rgba(51,255,102,.5)",marginBottom:"6px"});
  $("#welcomeName")?.parentNode?.insertBefore(badge, $("#welcomeName"));
}
function removeOnlineBadge(){ $("#onlineBadge")?.remove(); }

function startLiveTimer(days, total){
  try{
    const todayKey = Today.key;
    const today = days.find(d=> d.name.slice(0,3).toLowerCase()===todayKey);
    if(!today || !today.shift || /off/i.test(today.shift)) return;

    const shift = today.shift.trim();
    removeOnlineBadge();

    if (shift.endsWith(".")) {
      addOnlineBadge();
      const startStr = shift.replace(/\.$/,"").trim();
      const startTime = parseTime(startStr); if (!startTime) return;

      const tick = ()=>{
        const diff = Math.max(0,(Date.now()-startTime.getTime())/36e5);
        updateTotalDisplay(total+diff, true);
        showLiveHours(diff, true);
        paintLiveInTable(todayKey, diff);
      };
      tick();
      clearInterval(window.__acwLiveTick__); window.__acwLiveTick__ = setInterval(tick, 60000);
      return;
    }

    const p = shift.split("-"); if (p.length<2) return;
    const a = parseTime(p[0].trim()), b = parseTime(p[1].trim());
    if(!a || !b) return;
    const diff = Math.max(0,(b-a)/36e5);
    updateTotalDisplay(total,false);
    showLiveHours(diff,false);
    paintLiveInTable(todayKey, diff, /*static*/true);
  }catch(e){ console.warn("Live error:", e); }
}

function paintLiveInTable(todayKey, hours, staticMode=false){
  const table = $("#schedule table"); if (!table) return;
  const row = Array.from(table.rows).find(r=> r.cells?.[0]?.textContent.slice(0,3).toLowerCase()===todayKey);
  if (!row) return;
  row.cells[2].innerHTML = (staticMode? `` : `⏱️ `) + `${hours.toFixed(1)}h`;
  row.cells[2].style.color = staticMode ? "#999" : "#33a0ff";
  row.cells[2].style.fontWeight = staticMode ? "500" : "600";
}

/* =================== SETTINGS =================== */
function openSettings(){ setVisible($("#settingsModal"), true); }
function closeSettings(){ setVisible($("#settingsModal"), false); }

function refreshApp() {
  try { if ("caches" in window) caches.keys().then(keys=>keys.forEach(k=>caches.delete(k))); } catch {}
  toast("⏳ Updating…", "info");
  setTimeout(()=>location.reload(), 900);
}
function logoutUser(){
  localStorage.removeItem("acwUser");
  toast("👋 Logged out", "info");
  setTimeout(()=>location.reload(), 500);
}

/* =================== CHANGE PASSWORD =================== */
async function submitChangePassword() {
  const oldPass = $("#oldPass")?.value.trim();
  const newPass = $("#newPass")?.value.trim();
  const confirm = $("#confirmPass")?.value.trim();
  const diag = $("#passDiag");

  if (!oldPass || !newPass || !confirm) return safeText(diag, "⚠️ Please fill out all fields.");
  if (newPass !== confirm)   return safeText(diag, "❌ New passwords do not match.");
  if (newPass.length < 6)    return safeText(diag, "⚠️ Password must be at least 6 characters.");

  try {
    safeText(diag, "⏳ Updating password...");
    const email = currentUser?.email;
    if (!email) throw new Error("Session expired. Please log in again.");

    const res = await fetch(`${CONFIG.BASE_URL}?action=changePassword&email=${encodeURIComponent(email)}&oldPass=${encodeURIComponent(oldPass)}&newPass=${encodeURIComponent(newPass)}`, {cache:"no-store"});
    const data = await res.json();

    if (data.ok) {
      safeText(diag, "✅ Password updated successfully!");
      toast("✅ Password updated", "success");
      setTimeout(() => { closeChangePassword(); $("#oldPass").value = $("#newPass").value = $("#confirmPass").value = ""; }, 1200);
    } else {
      safeText(diag, "❌ " + (data.error || "Invalid current password."));
    }
  } catch (err) {
    safeText(diag, "⚠️ " + err.message);
  }
}

/* =================== TEAM VIEW (gestión) =================== */
const TEAM_PAGE_SIZE = 8;
let __teamList=[], __teamPage=0;
let __tvController = null;      // Abort controller del TV
let __tvIntervalId = null;      // Interval solo cuando está abierto

function addTeamButton(){
  if ($("#teamBtn")) return;
  const btn = document.createElement("button");
  btn.id="teamBtn"; btn.className="team-btn"; btn.textContent="Team View";
  btn.onclick = toggleTeamOverview; document.body.appendChild(btn);
}
function toggleTeamOverview(){
  const w = $("#directoryWrapper");
  if (w){
    w.classList.add("fade-out");
    setTimeout(()=>{ w.remove(); }, 180);
    if (__tvIntervalId){ clearInterval(__tvIntervalId); __tvIntervalId=null; }
    if (__tvController){ __tvController.abort(); __tvController=null; }
    return;
  }
  loadEmployeeDirectory();
}
async function loadEmployeeDirectory() {
  try {
    __tvController?.abort();
    __tvController = new AbortController();

    const j = await API.getDirectory(__tvController);
    if (!j?.ok) return;

    __teamList = j.directory || [];
    __teamPage = 0;
    renderTeamViewPage();
  } catch (e) {
    if (e.name!=="AbortError") console.warn(e);
  }
}

/* ============================================================
   📇 DirectoryStore v1.1 — Local cache + Import/Export + Registro
   ============================================================ */
const DirectoryStore = (() => {
  const KEY = `acw.directory.${CONFIG.DIR_VERSION || "v1"}`;

  function _read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj?.directory || !Array.isArray(obj.directory)) return null;
      return obj;
    } catch { return null; }
  }
  function _write(payload){
    localStorage.setItem(KEY, JSON.stringify({
      version : CONFIG.DIR_VERSION,
      updated : new Date().toISOString(),
      source  : payload?.source || "local",
      directory: dedupeByEmail(payload?.directory || [])
    }));
  }
  function dedupeByEmail(list){
    const seen = new Map();
    (list||[]).forEach(e=>{
      const email = String(e.email||"").trim().toLowerCase();
      if(!email) return;
      // último gana (para poder actualizar)
      seen.set(email, {
        name:  e.name?.trim() || "",
        email,
        phone: (e.phone||"").trim(),
        role:  (e.role||"employee").trim()
      });
    });
    return Array.from(seen.values());
  }
  function getAll(){
    const obj = _read();
    return obj?.directory || [];
  }
  function setAll(list, source="local"){ _write({ directory:list, source }); }
  function clear(){ localStorage.removeItem(KEY); }

  function importJSON(text){
    let data = null;
    try{ data = JSON.parse(text); }catch(e){ throw new Error("JSON inválido"); }
    const dir = Array.isArray(data) ? data : (data?.directory || []);
    if (!Array.isArray(dir)) throw new Error("Estructura inválida");
    const cleaned = dedupeByEmail(dir);
    _write({ directory: cleaned, source:"import-json" });
    return cleaned.length;
  }
  function importCSV(text){
    // columnas esperadas: name,email,phone,role (headers flexibles)
    const lines = String(text||"").split(/\r?\n/).filter(Boolean);
    if (!lines.length) return 0;
    const header = lines.shift().split(",").map(s=>s.trim().toLowerCase());
    const idx = {
      name : header.findIndex(h => /name|nombre/.test(h)),
      email: header.findIndex(h => /email|correo/.test(h)),
      phone: header.findIndex(h => /phone|telefono|tel/.test(h)),
      role : header.findIndex(h => /role|rol/.test(h))
    };
    const rows = lines.map(l=>{
      // CSV simple (sin comillas complejas); si usas comillas, reemplaza por un parser más pro
      const parts = l.split(",").map(s=>s.trim());
      return {
        name:  idx.name  >=0 ? parts[idx.name]  : "",
        email: idx.email >=0 ? parts[idx.email] : "",
        phone: idx.phone >=0 ? parts[idx.phone] : "",
        role:  idx.role  >=0 ? parts[idx.role]  : "employee"
      };
    });
    const merged = dedupeByEmail([ ...getAll(), ...rows ]);
    _write({ directory: merged, source: "import-csv" });
    return merged.length;
  }
  function exportJSON(){
    const payload = _read() || { version: CONFIG.DIR_VERSION, directory: [] };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "directory.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 500);
  }

  function upsertEmployee({name,email,phone,role}){
    const list = getAll();
    const norm = {
      name : String(name||"").trim(),
      email: String(email||"").trim().toLowerCase(),
      phone: String(phone||"").trim(),
      role : String(role||"employee").trim()
    };
    if (!norm.email) throw new Error("Email requerido");
    const ix = list.findIndex(x => x.email === norm.email);
    if (ix >= 0) list[ix] = { ...list[ix], ...norm };
    else list.push(norm);
    _write({ directory:list, source:"self-reg" });
    return norm;
  }

  // público
  return { getAll, setAll, clear, importJSON, importCSV, exportJSON, upsertEmployee };
})();

/* === Override de API.getDirectory: remoto → fallback local; o solo local si flag === */
API.getDirectory = async function(controller){
  // 1) Solo local si así lo pide config
  if (CONFIG.USE_LOCAL_DIRECTORY) {
    const dir = DirectoryStore.getAll();
    return { ok:true, directory: dir, source:"local-only" };
  }

  // 2) Intenta remoto (como antes)
  try{
    const u = `${CONFIG.BASE_URL}?action=getEmployeesDirectory`;
    const data = await fetchJSON(u, { ttl: API.dirTTL, signal: controller?.signal });
    if (data?.ok && Array.isArray(data.directory) && data.directory.length){
      // guarda copia local para offline
      DirectoryStore.setAll(data.directory, "remote-sync");
      return { ...data, source:"remote" };
    }
    // si remoto no trae nada, usa local
  }catch(e){ /* cae a local */ }

  // 3) Fallback local
  const local = DirectoryStore.getAll();
  return { ok:true, directory: local, source:"local-fallback" };
};

/* === Integración suave con showWelcome (teléfono del usuario) === */
(async function patchWelcomePhone(){
  const _showWelcome = window.showWelcome;
  window.showWelcome = async function(name, role){
    await _showWelcome(name, role);
    try {
      const dir = DirectoryStore.getAll();
      const self = dir.find(e => (e.email||"").toLowerCase() === (currentUser?.email||"").toLowerCase());
      if (self?.phone) {
        $(".user-phone")?.remove();
        $("#welcomeName")?.insertAdjacentHTML("afterend",
          `<p class="user-phone">📞 <a href="tel:${self.phone}" style="color:#0078ff;font-weight:600;text-decoration:none;">${self.phone}</a></p>`
        );
      } else if (CONFIG.ALLOW_SELF_REGISTRATION) {
        // si NO tiene phone, ofrece registro rápido
        ensureRegModal(); openRegModalPrefill(currentUser?.name, currentUser?.email);
      }
    } catch {}
  };
})();

/* === UI: Import/Export/Registro (bindings globales) === */
function ensureRegModal(){
  if (document.getElementById("regModal")) return;
  const modal = document.createElement("div");
  modal.id = "regModal"; modal.className = "modal";
  modal.innerHTML = `
    <div class="modal-content glass" style="max-width:360px;">
      <span class="close" onclick="closeRegModal()">×</span>
      <h3 style="margin:0 0 10px;">Add / Update Employee</h3>
      <input id="regName"  placeholder="Full name">
      <input id="regEmail" placeholder="Email">
      <input id="regPhone" placeholder="Phone">
      <select id="regRole" style="display:block; margin:8px auto; width:90%; max-width:280px; padding:10px; border:1px solid rgba(0,120,255,.25); border-radius:6px;">
        <option value="employee">Employee</option>
        <option value="supervisor">Supervisor</option>
        <option value="manager">Manager</option>
      </select>
      <p id="regDiag" class="error"></p>
      <div style="display:flex; gap:8px; justify-content:center; margin-top:8px;">
        <button onclick="submitSelfReg()">Save</button>
        <button onclick="closeRegModal()" type="button">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}
function openRegModal(){ ensureRegModal(); $("#regModal").style.display = "flex"; }
function openRegModalPrefill(name,email){ openRegModal(); $("#regName").value=name||""; $("#regEmail").value=email||""; }
function closeRegModal(){ $("#regModal")?.classList?.remove("show"); $("#regModal").style.display="none"; }
async function submitSelfReg(){
  const name  = $("#regName")?.value||"";
  const email = $("#regEmail")?.value||"";
  const phone = $("#regPhone")?.value||"";
  const role  = $("#regRole")?.value||"employee";
  const diag  = $("#regDiag");
  try{
    DirectoryStore.upsertEmployee({name,email,phone,role});
    diag.textContent = "✅ Saved locally";
    toast("✅ Employee saved (local)","success");
    setTimeout(closeRegModal, 700);
  }catch(e){
    diag.textContent = "⚠️ " + (e.message||"Error");
  }
}

/* === Import/Export handlers (file input) === */
async function handleImportDirectoryFile(file){
  if (!file) return;
  const text = await file.text();
  let count = 0;
  try{
    if (file.name.toLowerCase().endsWith(".csv")) count = DirectoryStore.importCSV(text);
    else count = DirectoryStore.importJSON(text);
    toast(`✅ Directory imported (${count} records)`, "success");
  }catch(e){ toast(`❌ Import failed: ${e.message||e}`, "error"); }
}
window.triggerImportDirectory = ()=> $("#dirImportInput")?.click();
window.onImportDirectoryFile = (el)=> handleImportDirectoryFile(el.files?.[0]);
window.exportDirectoryJSON = ()=> DirectoryStore.exportJSON();
window.clearLocalDirectory = ()=> { DirectoryStore.clear(); toast("🗑️ Local directory cleared","info"); };

/* === Exponer registro a Settings === */
window.openRegModal = openRegModal;
window.submitSelfReg = submitSelfReg;
window.closeRegModal = closeRegModal;

function renderTeamViewPage() {
  $("#directoryWrapper")?.remove();

  const box = document.createElement("div");
  box.id = "directoryWrapper";
  box.className = "directory-wrapper tv-wrapper";
  Object.assign(box.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -48%) scale(0.98)",
    visibility: "hidden",
    opacity: "0",
    background: "rgba(255,255,255,0.97)",
    borderRadius: "16px",
    boxShadow: "0 0 35px rgba(0,128,255,0.3)",
    backdropFilter: "blur(10px)",
    padding: "22px 28px",
    width: "88%",
    maxWidth: "620px",
    zIndex: "9999",
    textAlign: "center",
    transition: "all 0.35s ease"
  });

  box.innerHTML = `
    <div class="tv-head" style="display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;color:#0078ff;text-shadow:0 0 8px rgba(0,120,255,0.25);">Team View</h3>
      <button class="tv-close" onclick="toggleTeamOverview()" style="background:none;border:none;font-size:22px;cursor:pointer;">✖️</button>
    </div>
    <div class="tv-pager" style="margin:10px 0;">
      <button class="tv-nav" id="tvPrev" ${__teamPage === 0 ? "disabled" : ""}>‹ Prev</button>
      <span class="tv-index" style="font-weight:600;color:#0078ff;">Page ${__teamPage + 1} / ${Math.max(1, Math.ceil(__teamList.length / TEAM_PAGE_SIZE))}</span>
      <button class="tv-nav" id="tvNext" ${(__teamPage + 1) >= Math.ceil(__teamList.length / TEAM_PAGE_SIZE) ? "disabled" : ""}>Next ›</button>
    </div>
    <table class="directory-table tv-table" style="width:100%;font-size:15px;border-collapse:collapse;margin-top:10px;">
      <tr><th>Name</th><th>Hours</th><th>Live (Working)</th><th></th></tr>
      <tbody id="tvBody"></tbody>
    </table>
  `;

  document.body.appendChild(box);

  const start = __teamPage * TEAM_PAGE_SIZE;
  const slice = __teamList.slice(start, start + TEAM_PAGE_SIZE);
  const body = $("#tvBody", box);

  body.innerHTML = slice.map(emp => `
    <tr data-email="${emp.email}" data-name="${emp.name}" data-role="${emp.role || ''}" data-phone="${emp.phone || ''}">
      <td><b>${emp.name}</b></td>
      <td class="tv-hours">—</td>
      <td class="tv-live">—</td>
      <td><button class="open-btn" onclick="openEmployeePanel(this)">Open</button></td>
    </tr>`).join("");

  $("#tvPrev", box).onclick = () => { __teamPage = Math.max(0, __teamPage - 1); renderTeamViewPage(); };
  $("#tvNext", box).onclick = () => { __teamPage = Math.min(Math.ceil(__teamList.length / TEAM_PAGE_SIZE) - 1, __teamPage + 1); renderTeamViewPage(); };

  // Horas totales del slice con concurrencia limitada (4)
  const todayKey = Today.key;
  runLimited(slice, 4, async (emp)=>{
    try{
      const d = await API.getSchedule(emp.email, 0, __tvController);
      const tr = body.querySelector(`tr[data-email="${cssEscape(emp.email)}"]`);
      if (!tr) return;
      tr.querySelector(".tv-hours").textContent = (d && d.ok) ? (Number(d.total || 0)).toFixed(1) : "0";

      // Live
      const liveCell = tr.querySelector(".tv-live");
      const today = d?.days?.find(x=> x.name.slice(0,3).toLowerCase()===todayKey);
      if (!today?.shift){ liveCell.textContent="—"; return; }

      if (today.shift.trim().endsWith(".")){
        const startTime = parseTime(today.shift.replace(/\.$/,"").trim());
        if (!startTime) return;
        const diff = Math.max(0,(Date.now()-startTime.getTime())/36e5);
        liveCell.innerHTML = `🟢 ${diff.toFixed(1)}h`;
        liveCell.style.color="#33ff66"; liveCell.style.fontWeight="600"; liveCell.style.textShadow="0 0 10px rgba(51,255,102,.6)";
        const totalCell = tr.querySelector(".tv-hours");
        const base = parseFloat(totalCell.textContent)||0;
        totalCell.innerHTML = `${(base+diff).toFixed(1)} <span style="color:#33a0ff;font-size:.85em;">(+${diff.toFixed(1)})</span>`;
      } else {
        liveCell.textContent = "—";
        liveCell.style.color="#aaa"; liveCell.style.fontWeight="400"; liveCell.style.textShadow="none";
      }
    }catch(e){}
  });

  // Interval SOLO mientras Team View está visible (cada 2 min)
  if (__tvIntervalId){ clearInterval(__tvIntervalId); __tvIntervalId=null; }
  __tvIntervalId = setInterval(async ()=>{
    const rows = $all(".tv-table tr[data-email]", box);
    const sliceNow = rows.map(r=>({
      email: r.dataset.email, rowEl: r
    }));
    // actualiza live del slice usando caché de 60s
    await runLimited(sliceNow, 4, async (info)=>{
      const d = await API.getSchedule(info.email, 0, __tvController);
      const today = d?.days?.find(x=> x.name.slice(0,3).toLowerCase()===Today.key);
      const liveCell = info.rowEl.querySelector(".tv-live");
      const totalCell= info.rowEl.querySelector(".tv-hours");
      if (!today?.shift){ liveCell.textContent="—"; return; }
      if (today.shift.trim().endsWith(".")){
        const startTime = parseTime(today.shift.replace(/\.$/,"").trim());
        if (!startTime) return;
        const diff = Math.max(0,(Date.now()-startTime.getTime())/36e5);
        liveCell.innerHTML = `🟢 ${diff.toFixed(1)}h`;
        liveCell.style.color="#33ff66"; liveCell.style.fontWeight="600"; liveCell.style.textShadow="0 0 10px rgba(51,255,102,.6)";
        const base = parseFloat(totalCell.textContent)||0;
        if (!/span/.test(totalCell.innerHTML)){
          totalCell.innerHTML = `${(base+diff).toFixed(1)} <span style="color:#33a0ff;font-size:.85em;">(+${diff.toFixed(1)})</span>`;
        }
      } else {
        liveCell.textContent = "—";
        liveCell.style.color="#aaa"; liveCell.style.fontWeight="400"; liveCell.style.textShadow="none";
      }
    });
  }, 120000);

  // Animación de aparición
  setTimeout(() => {
    box.style.visibility = "visible";
    box.style.opacity = "1";
    box.style.transform = "translate(-50%, -50%) scale(1)";
  }, 60);
}

/* =================== EMPLOYEE MODAL =================== */
async function openEmployeePanel(btnEl){
  const tr = btnEl.closest("tr");
  const email = tr.dataset.email, name = tr.dataset.name, role = tr.dataset.role||"", phone = tr.dataset.phone||"";
  const modalId = `emp-${email.replace(/[@.]/g,"_")}`;
  if (document.getElementById(modalId)) return;

  let data = null;
  try{
    data = await API.getSchedule(email, 0);
    if (!data?.ok) throw new Error();
  }catch{
    alert("No schedule found for this employee.");
    return;
  }

  const m = document.createElement("div");
  m.className = "employee-modal emp-panel";
  m.id = modalId;
  m.innerHTML = `
    <div class="emp-box">
      <button class="emp-close">×</button>
      <div class="emp-header">
        <h3>${name}</h3>
        ${phone ? `<p class="emp-phone"><a href="tel:${phone}">${phone}</a></p>` : ""}
        <p class="emp-role">${role}</p>
      </div>

      <table class="schedule-mini">
        <tr><th>Day</th><th>Shift</th><th>Hours</th></tr>
        ${(data.days||[]).map(d => `
          <tr data-day="${d.name.slice(0,3)}" data-original="${(d.shift||"-").replace(/"/g,'&quot;')}">
            <td>${d.name}</td>
            <td ${isManagerRole(currentUser?.role) ? 'contenteditable="true"' : ''}>${d.shift||"-"}</td>
            <td>${d.hours||0}</td>
          </tr>`).join("")}
      </table>

      <p class="total">Total Hours: <b id="tot-${name.replace(/\s+/g,"_")}">${data.total||0}</b></p>
      <p class="live-hours"></p>

      ${isManagerRole(currentUser?.role) ? `
        <div class="emp-actions" style="margin-top:10px;">
          <button class="btn-update">✏️ Update Shift</button>
          <button class="btn-today">📤 Send Today</button>
          <button class="btn-tomorrow">📤 Send Tomorrow</button>
          <button class="btn-history">📚 History (5w)</button>
          <p id="empStatusMsg-${email.replace(/[@.]/g,"_")}" class="emp-status-msg" style="margin-top:6px;font-size:.9em;"></p>
        </div>
      ` : ``}

      <button class="emp-refresh" style="margin-top:8px;">⚙️ Check for Updates</button>
    </div>
  `;
  document.body.appendChild(m);

  // binds
  m.querySelector(".emp-close").onclick = () => m.remove();
  const refBtn = m.querySelector(".emp-refresh");
  if (refBtn) {
    refBtn.onclick = () => {
      try { if ("caches" in window) caches.keys().then(k => k.forEach(n => n && caches.delete(n))); } catch {}
      m.classList.add("flash");
      setTimeout(() => location.reload(), 600);
    };
  }

  if (isManagerRole(currentUser?.role)) {
    m.querySelector(".btn-update").onclick   = () => updateShiftFromModal(email, m);
    m.querySelector(".btn-today").onclick    = () => sendShiftMessage(email, "sendtoday");
    m.querySelector(".btn-tomorrow").onclick = () => sendShiftMessage(email, "sendtomorrow");
    const hb = m.querySelector(".btn-history");
    if (hb) hb.onclick = () => openHistoryFor(email, name);
  }

  enableModalLiveShift(m, data.days||[]);
}

function enableModalLiveShift(modal, days){
  try{
    const key = Today.key;
    const today = days.find(d=> d.name.slice(0,3).toLowerCase()===key);
    if (!today?.shift || /off/i.test(today.shift)) return;

    const table = $(".schedule-mini", modal);
    const row = $all("tr", table).find(r=> r.cells?.[0]?.textContent.slice(0,3).toLowerCase()===key);
    if (!row) return;
    const hoursCell = row.cells[2];
    const shift = today.shift.trim();

    const totalEl = $(".total b", modal);
    if (totalEl && !totalEl.dataset.baseHours) totalEl.dataset.baseHours = totalEl.textContent;

    if (shift.endsWith(".")){
      const startTime = parseTime(shift.replace(/\.$/,"").trim());
      const tick = ()=>{
        const diff = Math.max(0,(Date.now() - startTime.getTime())/36e5);
        hoursCell.innerHTML = `⏱️ ${diff.toFixed(1)}h`;
        hoursCell.style.color="#33a0ff"; hoursCell.style.fontWeight="600";
        if (totalEl){
          const base = parseFloat(totalEl.dataset.baseHours||totalEl.textContent)||0;
          totalEl.innerHTML = `${(base+diff).toFixed(1)} <span style="color:#33a0ff;font-size:.85em;">(+${diff.toFixed(1)})</span>`;
        }
      };
      tick();
      clearInterval(modal.__tick__); modal.__tick__ = setInterval(tick, 60000);
    } else {
      const p=shift.split("-"); if (p.length===2){
        const a=parseTime(p[0].trim()), b=parseTime(p[1].trim());
        if (a && b){ const diff=Math.max(0,(b-a)/36e5); hoursCell.textContent=`${diff.toFixed(1)}h`; hoursCell.style.color="#999"; }
      }
    }
  }catch(e){ console.warn("modal live err:", e); }
}

/* =================== MANAGER ACTIONS =================== */
async function updateShiftFromModal(targetEmail, modalEl){
  const msg = $(`#empStatusMsg-${targetEmail.replace(/[@.]/g,"_")}`) || $(".emp-status-msg", modalEl);
  const actor = currentUser?.email;
  if (!actor) { msg && (msg.textContent="⚠️ Session expired. Login again."); return; }

  const rows = $all(".schedule-mini tr[data-day]", modalEl);
  const changes = rows.map(r=>{
    const day = r.dataset.day; const newShift = r.cells[1].innerText.trim();
    const original = (r.getAttribute("data-original")||"").trim();
    return (newShift !== original) ? { day, newShift } : null;
  }).filter(Boolean);

  if (!changes.length){ msg && (msg.textContent="No changes to save."); toast("ℹ️ No changes", "info"); return; }

  msg && (msg.textContent="✏️ Saving to Sheets...");
  let ok=0;
  for (const c of changes){
    try{
      const u = `${CONFIG.BASE_URL}?action=updateShift&actor=${encodeURIComponent(actor)}&target=${encodeURIComponent(targetEmail)}&day=${encodeURIComponent(c.day)}&shift=${encodeURIComponent(c.newShift)}`;
      const r = await fetch(u, {cache:"no-store"}); const j = await r.json();
      if (j?.ok) ok++;
    }catch{}
  }
  if (ok===changes.length){ msg.textContent="✅ Updated on Sheets!"; toast("✅ Shifts updated","success"); rows.forEach(r=> r.setAttribute("data-original", r.cells[1].innerText.trim())); }
  else if (ok>0){ msg.textContent=`⚠️ Partial save: ${ok}/${changes.length}`; toast("⚠️ Some shifts failed","error"); }
  else { msg.textContent="❌ Could not update."; toast("❌ Update failed","error"); }
}

/* =================== SEND SHIFT MESSAGE =================== */
async function sendShiftMessage(targetEmail, action) {
  const msgBox = document.querySelector(`#empStatusMsg-${targetEmail.replace(/[@.]/g, "_")}`);
  if (msgBox) msgBox.textContent = "📤 Sending...";
  const actor = currentUser?.email;
  if (!actor) { if (msgBox) msgBox.textContent = "⚠️ Session expired"; return; }

  try {
    const url = `${CONFIG.BASE_URL}?action=${action}&actor=${encodeURIComponent(actor)}&target=${encodeURIComponent(targetEmail)}`;
    const r = await fetch(url, { cache: "no-store" });
    const data = await r.json();

    if (data.ok) {
      const name = data.sent?.name || "Employee";
      const shift = data.sent?.shift || "-";
      const mode = data.sent?.mode?.toUpperCase?.() || action.toUpperCase();

      if (msgBox){ msgBox.textContent = `✅ ${name} (${mode}) → ${shift}`; msgBox.style.color = "#00b341"; }
      toast(`✅ WhatsApp sent to ${name}`, "success");
      if (window.navigator.vibrate) window.navigator.vibrate(100);
    } else {
      const err = data.error || "unknown_error";
      if (msgBox){ msgBox.textContent = `⚠️ ${err}`; msgBox.style.color = "#ff4444"; }
      toast(`⚠️ Send failed (${err})`, "error");
    }
  } catch (err) {
    console.error("sendShiftMessage error:", err);
    if (msgBox){ msgBox.textContent = "❌ Network error"; msgBox.style.color = "#ff4444"; }
  }
}

/* =================== TOASTS =================== */
(function ensureToast(){
  if ($("#toastContainer")) return;
  const c=document.createElement("div"); c.id="toastContainer";
  Object.assign(c.style,{position:"fixed",top:"18px",right:"18px",zIndex:"9999",display:"flex",flexDirection:"column",alignItems:"flex-end"});
  document.body.appendChild(c);
})();
function toast(msg, type="info"){
  const t=document.createElement("div"); t.className="acw-toast"; t.textContent=msg;
  t.style.background = type==="success" ? "linear-gradient(135deg,#00c851,#007e33)" :
                    type==="error" ? "linear-gradient(135deg,#ff4444,#cc0000)" :
                                     "linear-gradient(135deg,#007bff,#33a0ff)";
  Object.assign(t.style,{color:"#fff",padding:"10px 18px",marginTop:"8px",borderRadius:"8px",fontWeight:"600",
    boxShadow:"0 6px 14px rgba(0,0,0,.25)",opacity:"0",transform:"translateY(-10px)",transition:"all .35s ease"});
  $("#toastContainer").appendChild(t);
  requestAnimationFrame(()=>{ t.style.opacity="1"; t.style.transform="translateY(0)"; });
  setTimeout(()=>{ t.style.opacity="0"; t.style.transform="translateY(-10px)"; setTimeout(()=>t.remove(),380); }, 2600);
}

/* =================== HISTORY (ligero y en caché) =================== */
async function __acwHistory5w(email, weeks = 5){
  const tasks = Array.from({length:weeks}, (_,i)=> i);
  const mkLabel = (off=0)=>{
    const now=new Date(), day=now.getDay();
    const mon=new Date(now); mon.setHours(0,0,0,0);
    mon.setDate(mon.getDate()-((day+6)%7)-(off*7));
    const sun=new Date(mon); sun.setDate(mon.getDate()+6);
    const F=d=>d.toLocaleDateString("en-US",{month:"short",day:"numeric"});
    return `${F(mon)} – ${F(sun)}`;
  };
  const settled = await runLimited(tasks, 3, async (off)=>{
    try{
      const d = await API.getSchedule(email, off);
      if (d?.ok) return { label: d.weekLabel || mkLabel(off), total: Number(d.total||0), days: Array.isArray(d.days)?d.days:[] };
    }catch{}
    return { label: mkLabel(off), total: 0, days: [] };
  });
  return settled;
}
function openHistoryPicker(email, name="My History"){
  document.getElementById("acwhOverlay")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "acwhOverlay";
  overlay.className = "acwh-overlay";
  overlay.innerHTML = `
    <div class="acwh-card">
      <div class="acwh-head">
        <div style="width:22px"></div>
        <h3 class="acwh-title">History (5 weeks)</h3>
        <button class="acwh-close" aria-label="Close">×</button>
      </div>
      <div class="acwh-sub">${String(name||"").toUpperCase()}</div>
      <div id="acwhBody" class="acwh-list">
        <div class="acwh-row" style="justify-content:center;opacity:.7;">Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  __attachHistoryShare(overlay);
  overlay.querySelector(".acwh-close").onclick = () => overlay.remove();
  overlay.addEventListener("click", e=>{ if(e.target===overlay) overlay.remove(); });
  renderHistoryPickerList(email, name, overlay);
}

// Botón Share pegado a la X
function __attachHistoryShare(root = document){
  const head = root.querySelector('.acwh-head');
  if (!head) return;

  let btn = head.querySelector('.acwh-share');
  if (!btn){
    btn = document.createElement('button');
    btn.className = 'acwh-share';
    btn.type = 'button';
    btn.textContent = 'Share';
    head.insertBefore(btn, head.querySelector('.acwh-close') || null);
  }

  btn.onclick = async ()=>{
    const overlay = root.closest('#acwhOverlay') || root;
    const card    = overlay.querySelector('.acwh-card') || overlay;
    const title   = overlay.querySelector('.acwh-title')?.textContent?.trim() || 'History';
    const who     = overlay.querySelector('.acwh-sub')?.textContent?.trim() || (currentUser?.name || 'ACW');

    overlay.setAttribute('data-share','1');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

    try{
      await __shareElAsImage(card, `${who} — ${title}.png`);
    } finally {
      overlay.removeAttribute('data-share');
    }
  };
}

// === SHARE (fallback claro y seguro) ===
async function __ensureH2C(){
  if (window.html2canvas) return;
  await new Promise((ok, fail)=>{
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
    s.onload = ok; s.onerror = ()=>fail(new Error('html2canvas load failed'));
    document.head.appendChild(s);
  });
}

async function __shareElAsImage(el, filename='acw.png'){
  try{
    await __ensureH2C();
    const canvas = await html2canvas(el, {
      backgroundColor: '#ffffff',
      scale: Math.min(3, window.devicePixelRatio || 2),
      useCORS: true
    });
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png', 0.95));
    const file = new File([blob], filename, { type: 'image/png' });

    try{
      if (navigator.canShare && navigator.canShare({ files:[file] })){
        await navigator.share({ files:[file] });
        toast('✅ Shared image','success'); 
        return;
      }
    }catch{}

    try{
      if (navigator.clipboard && window.ClipboardItem){
        await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
        toast('📋 Image copied to clipboard','success'); 
        return;
      }
    }catch{}

    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    toast('ℹ️ Opened image in new tab','info');
  }catch(e){
    console.warn('share error', e);
    toast('❌ Share failed','error');
  }
}
async function renderHistoryPickerList(email, name, root){
  const body = root.querySelector("#acwhBody");
  body.className = "acwh-list";
  const hist = await __acwHistory5w(email, 5);
  body.innerHTML = hist.map((w,i)=>`
    <div class="acwh-row" data-idx="${i}">
      <div class="acwh-week">
        <div>${w.label}</div>
        <small>${i===0 ? "Week (current)" : `Week -${i}`}</small>
      </div>
      <div class="acwh-total">${Number(w.total||0).toFixed(1)}h</div>
      <button class="acwh-btn" data-idx="${i}">Open ›</button>
    </div>
  `).join("");
  body.querySelectorAll(".acwh-row, .acwh-btn").forEach(el=>{
    el.onclick = ()=>{
      const idx = Number(el.dataset.idx || el.closest(".acwh-row")?.dataset.idx || 0);
      renderHistoryDetailCentered(hist[idx], email, name, idx, root);
    };
  });
  root.querySelector(".acwh-title").textContent = "History (5 weeks)";
  root.querySelector(".acwh-sub").textContent   = String(name||"").toUpperCase();
  __attachHistoryShare(root);
}
function renderHistoryDetailCentered(week, email, name, offset, root){
  const body = root.querySelector("#acwhBody");
  body.className = "";
  root.querySelector(".acwh-title").textContent = week.label;
  root.querySelector(".acwh-sub").textContent =
    `${offset===0 ? "Week (current)" : `Week -${offset}`} • ${String(name||"").toUpperCase()}`;
  const rows = (week.days||[]).map(d=>{
    const off = /off/i.test(String(d.shift||""));
    const styleCell = off ? 'style="color:#999"' : '';
    const styleHours = off ? 'style="color:#999;text-align:right"' : 'style="text-align:right"';
    return `<tr>
      <td>${d.name||""}</td>
      <td ${styleCell}>${d.shift||'-'}</td>
      <td ${styleHours}>${Number(d.hours||0).toFixed(1)}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <button class="acwh-back">‹ Weeks</button>
      <div class="acwh-total">${Number(week.total||0).toFixed(1)}h</div>
    </div>
    <table class="acwh-table">
      <tr><th>Day</th><th>Shift</th><th>Hours</th></tr>
      ${rows}
    </table>
    <div class="acwh-total-line">Total: ${Number(week.total||0).toFixed(1)}h</div>
  `;
  body.querySelector(".acwh-back").onclick = () => renderHistoryPickerList(email, name, root);
  __attachHistoryShare(root);
}

/* === Skin tweaks (schedule alignment) === */
(function scheduleSkin(){
  const id='acw-sched-skin';
  if (document.getElementById(id)) return;

  const css = `
    #schedule table{ width:100%; table-layout:fixed; border-collapse:separate; border-spacing:0; }
    #schedule table th, #schedule table td{ padding:10px 12px; border-top:1px solid rgba(0,0,0,.06); }
    #schedule table th:nth-child(1), #schedule table td:nth-child(1){ width:38%; }
    #schedule table th:nth-child(2), #schedule table td:nth-child(2){ width:44%; white-space:nowrap; font-variant-numeric:tabular-nums; }
    #schedule table th:nth-child(3), #schedule table td:nth-child(3){ width:18%; text-align:right; font-variant-numeric:tabular-nums; }
    #schedule table tr.today td{ background:rgba(11,109,255,.06); }
    #schedule table td.off{ color:#9aa3ad; }
  `;
  const s=document.createElement('style'); s.id=id; s.textContent=css; document.head.appendChild(s);

  function formatShift(str){
    const t = String(str||'-').trim();
    return t.replace(/\s-\s/g, '\u00A0–\u00A0');
  }
  function fixTable(){
    const table = document.querySelector('#schedule table');
    if(!table) return;
    const rows = Array.from(table.rows);
    rows.forEach((r,i)=>{
      if (i===0) return; // header
      const shiftCell = r.cells[1], hoursCell = r.cells[2];
      if (shiftCell){
        const raw = shiftCell.textContent;
        shiftCell.textContent = formatShift(raw);
        if (/^\s*off\s*$/i.test(raw)) shiftCell.classList.add('off');
      }
      if (hoursCell){ /* right aligned already */ }
    });
  }

  const orig = window.loadSchedule;
  if (typeof orig === 'function'){
    window.loadSchedule = async function(...args){
      await orig.apply(this, args);
      requestAnimationFrame(fixTable);
    };
  } else {
    requestAnimationFrame(fixTable);
  }
})();

/* =================== GLOBAL BINDS =================== */
window.loginUser = loginUser;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.refreshApp = refreshApp;
window.logoutUser = logoutUser;
window.openChangePassword = function openChangePassword(){
  // Inline modal builder (safe if HTML did not include it)
  let cp = document.getElementById('changePasswordModal');
  if (!cp){
    cp = document.createElement('div');
    cp.id = 'changePasswordModal';
    cp.className = 'modal';
    cp.innerHTML = `
      <div class="modal-content glass">
        <button class="close" aria-label="Close">×</button>
        <h3 style="margin:0 0 8px">Change Password</h3>
        <input id="oldPass" type="password" placeholder="Current password" autocomplete="current-password">
        <input id="newPass" type="password" placeholder="New password" autocomplete="new-password">
        <input id="confirmPass" type="password" placeholder="Confirm new password" autocomplete="new-password">
        <p id="passDiag" class="error"></p>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:6px;">
          <button id="cpSaveBtn">Save</button>
          <button id="cpCancelBtn" type="button">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(cp);
    cp.querySelector('.close').onclick = closeChangePassword;
    cp.querySelector('#cpCancelBtn').onclick = closeChangePassword;
    cp.addEventListener('click', (e)=>{ if (e.target === cp) closeChangePassword(); });
    cp.querySelector('#cpSaveBtn').onclick = submitChangePassword;
  }
  cp.style.display = 'flex';
  cp.classList.add('show');
};
window.closeChangePassword = function closeChangePassword(){
  const cp = document.getElementById('changePasswordModal');
  if (cp){ cp.classList.remove('show'); cp.style.display='none'; }
};
window.openEmployeePanel = openEmployeePanel;
window.sendShiftMessage = sendShiftMessage;
window.updateShiftFromModal = updateShiftFromModal;
window.showWelcome = showWelcome;
window.renderTeamViewPage = renderTeamViewPage;
window.openHistoryPicker = openHistoryPicker;
window.openHistoryFor   = (...args)=> openHistoryPicker(...args);

console.log(`✅ ACW-App loaded → ${CONFIG?.VERSION||"v5.6.3 Turbo"} | Base: ${CONFIG?.BASE_URL||"<no-config>"}`);
