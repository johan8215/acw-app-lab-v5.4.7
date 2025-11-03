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
  // programa cambio a medianoche
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
  // Reemplaza COMPLETO API.getSchedule por esto
getSchedule(email, offset = 0, controller){
  const ttl = offset===0 ? API.schedTTL0 : API.schedTTLOld;
  const base = `${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}`;
  const u = offset===0 ? base : `${base}&offset=${offset}`;
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
/* =============== Directory loader (local + GAS) =============== */
function normEmp(r){
  return {
    name:  String(r?.name  || "").trim(),
    email: String(r?.email || "").trim(),
    role:  String(r?.role  || "").trim(),
    phone: String(r?.phone || "").trim(),
    status:String(r?.status|| "").trim()
  };
}

async function loadLocalDirectory(signal){
  try{
    const res = await fetch(CONFIG.DIR_URL, { cache:"no-store", signal });
    if (!res.ok) throw 0;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data.directory) ? data.directory : []);
    return list.map(normEmp);
  }catch{ return []; }
}

async function loadGasDirectory(signal){
  try{
    const u = `${CONFIG.BASE_URL}?action=getEmployeesDirectory`;
    const j = await fetchJSON(u, { ttl: CONFIG.DIR_TTL_MS || 300000, signal });
    if (j?.ok && Array.isArray(j.directory)) return j.directory.map(normEmp);
  }catch{}
  return [];
}

function mergeDirectory(local, remote){
  const byEmail = new Map();
  const put = (rec, src)=>{
    const k = (rec.email || "").toLowerCase().trim();
    if (!k) return;                            // sin email → se ignora
    if (!byEmail.has(k) || src==="local"){     // local manda
      byEmail.set(k, { ...byEmail.get(k), ...rec });
    }
  };
  local.forEach(r=>put(r,"local"));
  remote.forEach(r=>put(r,"remote"));
  return Array.from(byEmail.values());
}

/* =============== API helpers con TTL (fusionado, sin redeclarar) ========================== */
if (!window.API) window.API = {};
Object.assign(API, {
  dirTTL:      (CONFIG.DIR_TTL_MS || API.dirTTL || 5*60*1000),
  schedTTL0:   (API.schedTTL0   || 60*1000),
  schedTTLOld: (API.schedTTLOld || 5*60*1000),

  async getDirectory(controller){
    const local  = await loadLocalDirectory(controller?.signal);
    if (CONFIG.DIR_STRICT_LOCAL) return { ok:true, directory: local };

    const remote = await loadGasDirectory(controller?.signal);
    const merged = mergeDirectory(local, remote);
    return { ok:true, directory: merged };
  },

  async getSchedule(email, offset=0, controller){
    const ttl = offset===0 ? (API.schedTTL0||60000) : (API.schedTTLOld||300000);
    const u = `${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}${offset?`&offset=${offset}`:''}`;
    return fetchJSON(u, { ttl, signal: controller?.signal });
  }
});

/* =================== LOGIN =================== */
async function loginUser() {
  const email = $("#email")?.value.trim();
  const password = $("#password")?.value.trim();
  const diag = $("#diag");
  const btn = $("#signInBtn") || $("#login button");

  if (!email || !password) { safeText(diag, "Please enter your email and password."); return; }

  try {
    if (btn){ btn.disabled = true; btn.innerHTML = "⏳ Loading your shift…"; }
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
    if (btn){ btn.disabled = false; btn.innerHTML = "Sign In"; }
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
function openChangePassword(){ setVisible($("#changePasswordModal"), true); }
function closeChangePassword(){ setVisible($("#changePasswordModal"), false); }

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
(function ensureShareCSS(){
  if (document.getElementById('acw-share-css')) return;
  const s = document.createElement('style'); s.id = 'acw-share-css';
  s.textContent = `
    /* Botón Share junto a la X */
    .acwh-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .acwh-head .acwh-share{
      background:#ff4d4f; color:#fff; border:0; border-radius:10px;
      padding:6px 10px; font-weight:700; cursor:pointer;
      box-shadow:0 2px 8px rgba(255,77,79,.35);
    }
    .acwh-head .acwh-share:active{ transform:translateY(1px); }

    /* MODO NÍTIDO PARA CAPTURA */
    #acwhOverlay[data-share="1"]{
      background: transparent !important;
      backdrop-filter: none !important;
      filter: none !important;
    }
    #acwhOverlay[data-share="1"] .acwh-card{
      background:#ffffff !important;
      opacity:1 !important;
      filter:none !important;
      backdrop-filter:none !important;
      box-shadow:none !important; /* evita velo gris */
    }
    /* por si algún hijo tiene opacidades/filtros */
    #acwhOverlay[data-share="1"] .acwh-card *{
      opacity:1 !important;
      filter:none !important;
    }
  `;
  document.head.appendChild(s);
})();

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
  const body  = $("#tvBody", box);
  const todayKey = Today.key;

  body.innerHTML = slice.map(emp => `
    <tr data-email="${emp.email || ''}" data-name="${emp.name}" data-role="${emp.role || ''}" data-phone="${emp.phone || ''}">
      <td><b>${emp.name}</b></td>
      <td class="tv-hours">—</td>
      <td class="tv-live">—</td>
      <td><button class="open-btn" onclick="openEmployeePanel(this)">Open</button></td>
    </tr>`).join("");

  $("#tvPrev", box).onclick = () => { __teamPage = Math.max(0, __teamPage - 1); renderTeamViewPage(); };
  $("#tvNext", box).onclick = () => { __teamPage = Math.min(Math.ceil(__teamList.length / TEAM_PAGE_SIZE) - 1, __teamPage + 1); renderTeamViewPage(); };

  // -------- Horas + Live del slice (con manejo "no email" y fallback) --------
  runLimited(slice, 4, async (emp) => {
    // ⬇️ NUEVO: fila sin email → marcar y salir
    if (!emp?.email) {
      const trNoEmail = box.querySelector('tr[data-email=""]');
      if (trNoEmail){
        trNoEmail.querySelector(".tv-hours").textContent = "—";
        const liveCell = trNoEmail.querySelector(".tv-live");
        liveCell.textContent = "⚠ no email";
        liveCell.style.color = "#e60000";
      }
      return;
    }

    try{
      // Preferente: API con TTL
      let d = await API.getSchedule(emp.email, 0, __tvController);
      // Fallback: reintento directo SIN offset si vino vacío
      if (!d || !Array.isArray(d.days) || d.days.length === 0) {
        const u = `${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(emp.email)}`;
        d = await fetchJSON(u, { ttl: API.schedTTL0, signal: __tvController?.signal });
      }

      const tr = box.querySelector(`tr[data-email="${cssEscape(emp.email)}"]`) ||
                 Array.from(body.querySelectorAll('tr[data-email]'))
                   .find(r => (r.dataset.email||'').trim().toLowerCase() === (emp.email||'').trim().toLowerCase());
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
    }catch(e){
      // silenciar: evita romper toda la página
    }
  });

  // -------- Interval SOLO visible (cada 2 min) con mismo manejo --------
  if (__tvIntervalId){ clearInterval(__tvIntervalId); __tvIntervalId=null; }
  __tvIntervalId = setInterval(async ()=>{
    const rows = $all(".tv-table tr[data-email]", box);
    const sliceNow = rows.map(r=>({ email: r.dataset.email || '', rowEl: r }));

    await runLimited(sliceNow, 4, async (info)=>{
      if (!info?.email) {
        const liveCell = info.rowEl.querySelector(".tv-live");
        info.rowEl.querySelector(".tv-hours").textContent = "—";
        liveCell.textContent = "⚠ no email";
        liveCell.style.color = "#e60000";
        return;
      }

      let d = await API.getSchedule(info.email, 0, __tvController);
      if (!d || !Array.isArray(d.days) || d.days.length === 0) {
        const u = `${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(info.email)}`;
        d = await fetchJSON(u, { ttl: API.schedTTL0, signal: __tvController?.signal });
      }

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
      try { if ("caches" in window) caches.keys().then(k => k.forEach(n => caches.delete(n))); } catch {}
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
  // 5 semanas en paralelo (usa cache de API.getSchedule con TTL)
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

// Botón Share pegado a la X (se crea una sola vez por overlay)
function __attachHistoryShare(root = document){
  const head = root.querySelector('.acwh-head');
  if (!head) return;

  let btn = head.querySelector('.acwh-share');
  if (!btn){
    btn = document.createElement('button');
    btn.className = 'acwh-share';
    btn.type = 'button';
    btn.textContent = 'Share';
    // lo insertamos justo antes de la X
    head.insertBefore(btn, head.querySelector('.acwh-close') || null);
  }

  // acción del botón
  btn.onclick = async ()=>{
    const overlay = root.closest('#acwhOverlay') || root;
    const card    = overlay.querySelector('.acwh-card') || overlay;
    const title   = overlay.querySelector('.acwh-title')?.textContent?.trim() || 'History';
    const who     = overlay.querySelector('.acwh-sub')?.textContent?.trim() || (currentUser?.name || 'ACW');

    // Modo nítido SOLO durante la captura
    overlay.setAttribute('data-share','1');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));

    try{
      await __shareElAsImage(card, `${who} — ${title}.png`);
    } finally {
      overlay.removeAttribute('data-share');
    }
  };
} // <-- este cierre faltaba

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
(function(){
  const id='acw-share-css';
  if (document.getElementById(id)) return;
  const s=document.createElement('style'); s.id=id;
  s.textContent = `
    .acwh-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .acwh-head .acwh-share{
      background:#ff4d4f; border:none; color:#fff; font-weight:700;
      padding:6px 10px; border-radius:12px; box-shadow:0 2px 6px rgba(0,0,0,.15);
    }
    .acwh-head .acwh-share:active{ transform:scale(.98); }
  `;
  document.head.appendChild(s);
})();

/* =================== GLOBAL BINDS =================== */
window.loginUser = loginUser;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.refreshApp = refreshApp;
window.logoutUser = logoutUser;
window.openChangePassword = openChangePassword;
window.closeChangePassword = closeChangePassword;
window.submitChangePassword = submitChangePassword;
window.openEmployeePanel = openEmployeePanel;
window.sendShiftMessage = sendShiftMessage;
window.updateShiftFromModal = updateShiftFromModal;
window.showWelcome = showWelcome;
window.renderTeamViewPage = renderTeamViewPage;
window.openHistoryPicker = openHistoryPicker;
window.openHistoryFor   = (...args)=> openHistoryPicker(...args);

console.log(`✅ ACW-App loaded → ${CONFIG?.VERSION||"v5.6.3 Turbo"} | Base: ${CONFIG?.BASE_URL||"<no-config>"}`);

/* =================== UI micro-fix (TV show class) =================== */
(function(){
  const prev = typeof window.renderTeamViewPage==='function' ? window.renderTeamViewPage : null;
  if (!prev) return;
  window.renderTeamViewPage = function(...args){
    prev.apply(this, args);
    const box = document.querySelector('#directoryWrapper');
    if (box) box.classList.add('show');
  };
})();
// === HOTFIX Settings modal (v5.6.3) ===
(function () {
  function openSettingsFix() {
    const modal = document.getElementById("settingsModal");
    if (!modal) { console.warn("⚠️ Settings modal not found"); return; }

    // Cierra overlays que podrían taparlo
    document.getElementById("acwhOverlay")?.remove();      // History
    document.getElementById("directoryWrapper")?.remove(); // Team View

    // Mostrar por encima de todo
    modal.style.display = "flex";         // <- sobrescribe .modal{display:none}
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = 12000;           // por encima de history/team view
    requestAnimationFrame(() => modal.classList.add("show"));

    // Cerrar al click fuera
    const onClick = (e) => { if (e.target === modal) closeSettingsFix(); };
    modal.addEventListener("click", onClick, { once: true });

    // Cerrar con ESC
    const onKey = (ev) => { if (ev.key === "Escape") closeSettingsFix(); };
    document.addEventListener("keydown", onKey, { once: true });

    function closeSettingsFix() {
      modal.classList.remove("show");
      setTimeout(() => (modal.style.display = "none"), 150);
    }
    // Exporta close actualizado
    window.closeSettings = closeSettingsFix;
  }
  // Exporta open actualizado
  window.openSettings = openSettingsFix;
})();
// === HOTFIX Settings modal (v5.6.3) ===
(function () {
  function openSettingsFix() {
    const modal = document.getElementById("settingsModal");
    if (!modal) { console.warn("⚠️ Settings modal not found"); return; }

    // Cierra overlays que podrían taparlo
    document.getElementById("acwhOverlay")?.remove();      // History
    document.getElementById("directoryWrapper")?.remove(); // Team View

    // Mostrar por encima de todo
    modal.style.display = "flex";         // <- sobrescribe .modal{display:none}
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.zIndex = 12000;           // por encima de history/team view
    requestAnimationFrame(() => modal.classList.add("show"));

    // Cerrar al click fuera
    const onClick = (e) => { if (e.target === modal) closeSettingsFix(); };
    modal.addEventListener("click", onClick, { once: true });

    // Cerrar con ESC
    const onKey = (ev) => { if (ev.key === "Escape") closeSettingsFix(); };
    document.addEventListener("keydown", onKey, { once: true });

    function closeSettingsFix() {
      modal.classList.remove("show");
      setTimeout(() => (modal.style.display = "none"), 150);
    }
    // Exporta close actualizado
    window.closeSettings = closeSettingsFix;
  }
  // Exporta open actualizado
  window.openSettings = openSettingsFix;
})();
// === ACW v5.6.3 — Change Password hard-fix (pegar al FINAL) ===
(function () {
  function injectStyleOnce(id, css){
    if (document.getElementById(id)) return;
    const s = document.createElement('style'); s.id = id; s.textContent = css;
    document.head.appendChild(s);
  }
  injectStyleOnce('acw-cp2-css', `
    #changePasswordModal{position:fixed; inset:0; display:none; align-items:center; justify-content:center;
      background:rgba(0,0,0,.45); backdrop-filter:blur(8px); z-index:13000;}
    #changePasswordModal.show{ display:flex !important; }
    #changePasswordModal .modal-content.glass{
      background:rgba(255,255,255,.97); border-radius:14px; box-shadow:0 0 40px rgba(0,120,255,.3);
      padding:24px 26px; width:340px; max-width:92vw; animation:popIn .22s ease; position:relative; text-align:center;
    }
    #changePasswordModal .close{ position:absolute; right:10px; top:8px; background:none; border:none; font-size:22px; cursor:pointer; }
    #changePasswordModal input{
      display:block; margin:8px auto; width:90%; max-width:280px; padding:10px;
      border:1px solid rgba(0,120,255,.25); border-radius:6px; outline:none;
    }
  `);

  function ensureChangePasswordModal(){
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
      cp.querySelector('.close').onclick = closeChangePassword2;
      cp.querySelector('#cpCancelBtn').onclick = closeChangePassword2;
      cp.addEventListener('click', (e)=>{ if (e.target === cp) closeChangePassword2(); });
      cp.querySelector('#cpSaveBtn').onclick = submitChangePassword;
    }
    return cp;
  }

  let _settingsWasVisible = null;

  function openChangePassword2(){
    const cp = ensureChangePasswordModal();
    const settings = document.getElementById('settingsModal');
    if (settings){
      _settingsWasVisible = (settings.style.display !== 'none' && settings.offsetParent !== null);
      settings.style.display = 'none';
      settings.classList.remove('show');
    }
    cp.style.zIndex = '13000';
    cp.classList.add('show');
    const onKey = (ev)=>{ if (ev.key === 'Escape') closeChangePassword2(); };
    document.addEventListener('keydown', onKey, { once:true });
    setTimeout(()=> document.getElementById('oldPass')?.focus(), 50);
  }

  function closeChangePassword2(){
    const cp = document.getElementById('changePasswordModal');
    const settings = document.getElementById('settingsModal');
    if (cp){ cp.classList.remove('show'); cp.style.display = 'none'; }
    if (settings && _settingsWasVisible){
      settings.style.display = 'flex';
      settings.classList.add('show');
      settings.style.alignItems = 'center';
      settings.style.justifyContent = 'center';
      settings.style.zIndex = '12000';
    }
    _settingsWasVisible = null;
  }

  window.openChangePassword = openChangePassword2;
  window.closeChangePassword = closeChangePassword2;

  const btn = document.getElementById('changePassBtn');
  if (btn) btn.onclick = openChangePassword2;
})();
/* === ACW — History "Clean Skin" (solo estilos) === */
(function(){
  const id = 'acw-history-skin';
  if (document.getElementById(id)) return;
  const css = `
  #acwhOverlay{
    --acw-accent: #0a84ff;      /* azul títulos */
    --acw-danger: #e53935;      /* rojo totales */
    --acw-card:   #ffffff;      /* fondo tarjeta */
    --acw-border: rgba(0,0,0,.08);
    --acw-radius: 16px;
    --acw-shadow: 0 8px 28px rgba(0,0,0,.08);
    --acw-text:   #2a2a2a;
    background: rgba(0,0,0,.22);
    backdrop-filter: blur(1.5px);
  }
  #acwhOverlay .acwh-card{
    background: var(--acw-card);
    color: var(--acw-text);
    border: 1px solid var(--acw-border);
    border-radius: var(--acw-radius);
    box-shadow: var(--acw-shadow);
    padding: 16px 18px;
  }
  #acwhOverlay .acwh-title{
    color: var(--acw-accent);
    line-height: 1.05;
  }
  #acwhOverlay .acwh-sub{ color:#97a1ad; }

  /* filas de la lista */
  #acwhOverlay .acwh-list .acwh-row{
    background:#fff;
    border:1px solid var(--acw-border);
    border-radius: 14px;
    padding: 12px 14px;
    display:flex; align-items:center; justify-content:space-between;
    gap:12px; margin:10px 0;
  }
  #acwhOverlay .acwh-week{ color:#2b2b2b; }
  #acwhOverlay .acwh-total{ color: var(--acw-danger); font-weight:700; }

  /* botón Open */
  #acwhOverlay .acwh-btn{
    background:#e00000; color:#fff; border:0; border-radius:14px;
    padding:10px 14px; font-weight:700;
  }

  /* botón Share (encima a la derecha) */
  #acwhOverlay .acwh-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
  #acwhOverlay .acwh-head .acwh-share{
    background:#ff6b6f; color:#fff; border:0; border-radius:12px;
    padding:6px 10px; font-weight:700; box-shadow:0 2px 8px rgba(255,107,111,.28);
  }
  #acwhOverlay .acwh-head .acwh-share:active{ transform:translateY(1px); }

  /* tabla detalle semana */
  #acwhOverlay table.acwh-table th{ color: var(--acw-accent); }
  #acwhOverlay .acwh-total-line{ color: var(--acw-danger); font-weight:700; text-align:right; }

  /* durante captura (data-share="1") todo sin velos */
  #acwhOverlay[data-share="1"]{ background: transparent !important; backdrop-filter:none !important; }
  #acwhOverlay[data-share="1"] .acwh-card,
  #acwhOverlay[data-share="1"] .acwh-card *{ opacity:1 !important; filter:none !important; box-shadow:none !important; }
  `;
  const s = document.createElement('style'); s.id = id; s.textContent = css;
  document.head.appendChild(s);
})();

/* === ACW History UI skin v1 — Blue Glass White (safe drop-in) === */
(function patchHistUI(){
  // 1) Skin + colores
  const id='acw-hist-skin';
  if(!document.getElementById(id)){
    const css = `
      #acwhOverlay .acwh-card{
        background:rgba(255,255,255,.98);
        border-radius:16px;
        box-shadow:0 12px 40px rgba(0,120,255,.22);
      }
      #acwhOverlay .acwh-title{ color:#0b6dff; letter-spacing:.2px; }
      #acwhOverlay .acwh-sub{ color:rgba(0,0,0,.38); margin-top:2px; }

      /* MISMO ROJO QUE OPEN */
      #acwhOverlay .acwh-head .acwh-share{
        background:#e60000 !important;
        color:#fff; border:0; border-radius:12px;
        padding:6px 12px; font-weight:700; cursor:pointer;
        box-shadow:0 8px 18px rgba(230,0,0,.32);
      }
      #acwhOverlay .acwh-head .acwh-share:active{ transform:translateY(1px); }

      #acwhOverlay .acwh-total,
      #acwhOverlay .acwh-total-line{ color:#e60000; font-weight:700; }
      #acwhOverlay .acwh-total-line{ text-align:right; margin-top:10px; }

      /* Tabla limpia y alineada */
      #acwhOverlay .acwh-table{
        width:100%; border-collapse:separate; border-spacing:0; table-layout:fixed;
      }
      #acwhOverlay .acwh-table thead th{
        padding:10px 12px; color:#0b6dff; font-weight:700;
      }
      #acwhOverlay .acwh-table thead th.right{ text-align:right; }
      #acwhOverlay .acwh-table tbody td{
        padding:10px 12px; border-top:1px solid rgba(0,0,0,.06);
      }
      /* Números y horas perfectamente alineados */
      #acwhOverlay .acwh-table td.c-shift,
      #acwhOverlay .acwh-table td.c-hours{
        font-variant-numeric: tabular-nums; letter-spacing:.2px;
      }
      #acwhOverlay .acwh-table td.c-hours{ text-align:right; }
      #acwhOverlay .acwh-table tr.off td{ color:#9aa3ad; }

      /* Modo captura (mantén tu data-share=1) */
      #acwhOverlay[data-share="1"]{ background:transparent !important; backdrop-filter:none !important; filter:none !important; }
      #acwhOverlay[data-share="1"] .acwh-card{
        background:#fff !important; box-shadow:none !important; opacity:1 !important; filter:none !important;
      }
      #acwhOverlay[data-share="1"] .acwh-card *{ opacity:1 !important; filter:none !important; }
    `;
    const s=document.createElement('style'); s.id=id; s.textContent=css; document.head.appendChild(s);
  }

  // 2) Detalle con columnas fijas (mismo tamaño que te gustó)
  const renderFixed = function(week, email, name, offset, root){
    const body = root.querySelector("#acwhBody");
    body.className = "";
    root.querySelector(".acwh-title").textContent = week.label;
    root.querySelector(".acwh-sub").textContent =
      `${offset===0 ? "Week (current)" : `Week -${offset}`} • ${String(name||"").toUpperCase()}`;

    const rows = (week.days||[]).map(d=>{
      const off = /off/i.test(String(d.shift||""));
      return `<tr class="${off?'off':''}">
        <td class="c-day">${d.name||""}</td>
        <td class="c-shift">${d.shift||'-'}</td>
        <td class="c-hours">${Number(d.hours||0).toFixed(1)}</td>
      </tr>`;
    }).join("");

    body.innerHTML = `
      <div class="acwh-headrow" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <button class="acwh-back">‹ Weeks</button>
        <div class="acwh-total">${Number(week.total||0).toFixed(1)}h</div>
      </div>
      <table class="acwh-table">
        <colgroup>
          <col style="width:38%">
          <col style="width:40%">
          <col style="width:22%">
        </colgroup>
        <thead>
          <tr><th>Day</th><th>Shift</th><th class="right">Hours</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="acwh-total-line">Total: ${Number(week.total||0).toFixed(1)}h</div>
    `;
    body.querySelector(".acwh-back").onclick = () => renderHistoryPickerList(email, name, root);
    __attachHistoryShare(root);
  };

  // Sobrescribe de forma segura
  window.renderHistoryDetailCentered = renderFixed;
})();
/* === ACW Schedule table alignment v1 — Blue Glass White (safe drop-in) === */
(function scheduleSkin(){
  const id='acw-sched-skin';
  if (document.getElementById(id)) return;

  const css = `
    #schedule table{
      width:100%; table-layout:fixed; border-collapse:separate; border-spacing:0;
    }
    #schedule table th, #schedule table td{
      padding:10px 12px; border-top:1px solid rgba(0,0,0,.06);
    }
    /* Anchos fijos */
    #schedule table th:nth-child(1), #schedule table td:nth-child(1){ width:38%; }
    #schedule table th:nth-child(2), #schedule table td:nth-child(2){
      width:44%; white-space:nowrap; font-variant-numeric:tabular-nums;
    }
    #schedule table th:nth-child(3), #schedule table td:nth-child(3){
      width:18%; text-align:right; font-variant-numeric:tabular-nums;
    }
    /* Hoy visible y OFF gris */
    #schedule table tr.today td{ background:rgba(11,109,255,.06); }
    #schedule table td.off{ color:#9aa3ad; }
  `;
  const s=document.createElement('style'); s.id=id; s.textContent=css; document.head.appendChild(s);

  // Normaliza el guion para que no parta línea (NBSP–NBSP)
  function formatShift(str){
    const t = String(str||'-').trim();
    return t.replace(/\s-\s/g, '\u00A0–\u00A0');
  }

  // Post-procesa la tabla después de que se renderiza
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
      if (hoursCell){ /* ya queda derecha y tabular por CSS */ }
    });
  }

  // Hook: vuelve a aplicar tras loadSchedule
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
// Share = rojo fuerte (igual que Open)
(function(){
  const id='acw-share-red';
  if (document.getElementById(id)) return;
  const s=document.createElement('style'); s.id=id;
  s.textContent = `
    .acwh-head .acwh-share{
      background:#e60000 !important;
      box-shadow:0 2px 10px rgba(230,0,0,.35);
      color:#fff; border:0; border-radius:10px;
    }
    .acwh-head .acwh-share:active{ transform:translateY(1px); }
  `;
  document.head.appendChild(s);
})();
/* ============================================================
   🔧 ACW_TEST v1.3 — Diagnóstico integral (no destructivo)
   (Mismo que ya viste en pantalla de resultados)
   ============================================================ */
(function(){
  const enc = encodeURIComponent;
  const nowShort = ()=> new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();

  async function j(url){
    try{
      const r = await fetch(url + (url.includes("?")?"&":"?") + "_t=" + Date.now(), {cache:"no-store"});
      return await r.json();
    }catch(e){ return { ok:false, error:String(e&&e.message||e||"net_error") }; }
  }

  function statusEmoji(s){ return s==="ok"?"🟢":s==="warn"?"🟡":s==="skip"?"⚪":"🔴"; }
  function asRow(c){ return { id:c.id, status:c.status, ok:c.ok, note:c.note||"", fix:c.fix||"" }; }

  const FIX = {
    set_config_base_url: "Configura CONFIG.BASE_URL (Apps Script web app ‘exec’ correcto y público).",
    gas_ping:             "Agrega action=ping en doGet(e) o revisa despliegue.",
    gas_login:            "Revisa action=login (credenciales/ACL/Scopes).",
    gas_schedule:         "Revisa action=getSmartSchedule (7 días, total numérico, soporta &offset).",
    gas_directory:        "Revisa action=getEmployeesDirectory (lista vacía o error).",
    gas_send_today:       "Revisa action=sendtoday (acepte ?actor&target&dry=1).",
    gas_send_tomorrow:    "Revisa action=sendtomorrow (acepte ?actor&target&dry=1).",
    sw_not_registered:    "Service Worker no registrado: verifica sw.js y https/localhost.",
    sw_cache_version:     "Actualiza CACHE_NAME en sw.js o CONFIG.VERSION para limpiar caché vieja.",
    today_key_mismatch:   "Bug en Today.key: normaliza TZ/locale o reinicio de medianoche.",
    dedupe_cache:         "fetchJSON sin de-dupe/TTL efectivo; revisar Net/TTL o doble definición.",
    ui_missing_nodes:     "Faltan nodos #login/#welcome/#schedule/#settingsModal en index.html."
  };

  function makeOverlay(){
    const css = `
      #acwdiag{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:system-ui,Segoe UI,Roboto,Arial}
      #acwdiag .card{width:560px;max-width:92vw;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:18px 18px 12px;color:#1e1e1e}
      #acwdiag h3{margin:0 0 4px;color:#0a84ff}
      #acwdiag .sub{color:#667; font-size:12px;margin-bottom:6px}
      #acwdiag table{width:100%;border-collapse:separate;border-spacing:0 6px;font-size:14px}
      #acwdiag td{background:#f7f9fc;padding:8px 10px;border-radius:8px}
      #acwdiag td:first-child{width:56px;text-align:center}
      #acwdiag .row.fail td{background:#ffecec}
      #acwdiag .row.warn td{background:#fff7e6}
      #acwdiag .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
      #acwdiag button{background:#e60000;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:700;cursor:pointer}
      #acwdiag .ghost{background:#fff;color:#0a84ff;border:2px solid rgba(10,132,255,.35)}
    `;
    if (!document.getElementById("acwdiag-css")){
      const s=document.createElement("style"); s.id="acwdiag-css"; s.textContent=css; document.head.appendChild(s);
    }
    const root=document.createElement("div"); root.id="acwdiag";
    root.innerHTML = `
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <h3>ACW — Diagnóstico</h3>
          <button class="ghost" id="acwdiag-close">Cerrar</button>
        </div>
        <div class="sub">Resultados en la página y en la consola (tabla + JSON).</div>
        <div id="acwdiag-body"></div>
        <div class="btns">
          <button class="ghost" id="acwdiag-copy">Copiar JSON</button>
          <button id="acwdiag-share">Share (imagen)</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    root.querySelector("#acwdiag-close").onclick = ()=> root.remove();

    // Share como imagen
    root.querySelector("#acwdiag-share").onclick = async ()=>{
      const el = root.querySelector(".card");
      try{
        if(!window.html2canvas){
          const s=document.createElement("script");
          s.src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
          await new Promise((ok,ko)=>{ s.onload=ok; s.onerror=ko; document.head.appendChild(s); });
        }
        const c = await html2canvas(el,{backgroundColor:"#ffffff",scale: Math.min(3, window.devicePixelRatio||2)});
        c.toBlob(b=>{
          const file = new File([b], "ACW_Diag.png", {type:"image/png"});
          if(navigator.canShare && navigator.canShare({files:[file]})){
            navigator.share({files:[file]}).catch(()=>{});
          }else{
            const url=URL.createObjectURL(b); open(url,"_blank");
          }
        });
      }catch{}
    };
    return root;
  }

  function renderOverlay(root, list, meta){
    const body = root.querySelector("#acwdiag-body");
    const rows = list.map(c=>{
      const cls = c.status==="fail"?"row fail":c.status==="warn"?"row warn":"row";
      return `<tr class="${cls}">
        <td>${statusEmoji(c.status)}</td>
        <td><b>${c.label}</b><div style="color:#667;font-size:12px">${c.note||""}</div></td>
        <td style="text-align:right">${c.fix?`<span style="color:#e60000;font-weight:700">${c.fix}</span>`:""}</td>
      </tr>`;
    }).join("");
    body.innerHTML = `
      <table>${rows}</table>
      <div class="sub" style="margin-top:6px">BASE_URL: ${meta.base||"<vacío>"} • VERSION: ${meta.version||"?"} • SW: ${meta.sw||"—"}</div>
    `;

    root.querySelector("#acwdiag-copy").onclick = async ()=>{
      try{
        await navigator.clipboard.writeText(JSON.stringify({meta, checks:list.map(asRow)}, null, 2));
        alert("JSON copiado");
      }catch{ alert("No se pudo copiar"); }
    };
  }

  async function run(opts={}){
    const BASE = (window.CONFIG && CONFIG.BASE_URL) || "";
    const CFGV = (window.CONFIG && CONFIG.VERSION) || "";
    const checks = [];
    const meta = { base: BASE, version: CFGV, sw: "" };

    function push({id,label,ok,status,note,fix}){ checks.push({id,label,ok,status,note,fix}); }

    // 0) CONFIG & entorno
    push({
      id:"base_url", label:"CONFIG.BASE_URL",
      ok: !!BASE, status: !!BASE?"ok":"fail",
      note: BASE||"vacío", fix: !!BASE?"":FIX.set_config_base_url
    });

    // 1) Service Worker + cachés
    try{
      if ("serviceWorker" in navigator){
        const regs = await navigator.serviceWorker.getRegistrations();
        meta.sw = regs.length? "registered":"not registered";
        const keys = await caches.keys();
        const cacheKey = (keys||[]).find(k=>/acw-cache-/i.test(k)) || "";
        const vFromCache = cacheKey.replace(/^.*v/i,"v");
        const vMatch = CFGV && vFromCache && CFGV.includes(vFromCache);
        push({
          id:"sw_registered", label:"Service Worker",
          ok: regs.length>0, status: regs.length>0?"ok":"warn",
          note: regs.length?`ok (${cacheKey||"sin caché estática"})`:"no registrado",
          fix: regs.length? ( (CFGV && cacheKey && !vMatch) ? FIX.sw_cache_version : "" ) : FIX.sw_not_registered
        });
        if (CFGV && cacheKey && !vMatch){
          push({
            id:"sw_cache_version", label:"Versión de caché (SW vs CONFIG)",
            ok:false, status:"warn",
            note:`CONFIG.VERSION=${CFGV} • CACHE=${cacheKey}`,
            fix: FIX.sw_cache_version
          });
        }
      }else{
        push({id:"sw_support", label:"Service Worker", ok:false, status:"warn", note:"no soportado", fix:""});
      }
    }catch{
      push({id:"sw_error", label:"Service Worker", ok:false, status:"warn", note:"error consultando SW", fix:""});
    }

    // 2) PING
    let ping = BASE? await j(`${BASE}?action=ping`) : {};
    push({
      id:"ping", label:"Backend ping",
      ok: !!ping.ok, status: ping.ok?"ok":"fail",
      note: ping.ok?(`version: ${ping.version||"?"}`): (ping.error||"error"),
      fix: ping.ok?"":FIX.gas_ping
    });

    // 3) LOGIN
    let login = {};
    if (opts.email && opts.password){
      login = BASE? await j(`${BASE}?action=login&email=${enc(opts.email)}&password=${enc(opts.password)}`) : {};
      push({
        id:"login", label:"Login",
        ok: !!login.ok, status: login.ok?"ok":"fail",
        note: login.ok?`${login.name||login.email||"ok"} • role=${login.role||"?"}`:(login.error||"fail"),
        fix: login.ok?"":FIX.gas_login
      });
    }else{
      push({id:"login", label:"Login", ok:false, status:"warn", note:"sin credenciales (pásalas a ACW_TEST.run)", fix:""});
    }

    // 4) DIRECTORY
    let dir = BASE? await j(`${BASE}?action=getEmployeesDirectory`) : {};
    const dlen = Array.isArray(dir.directory)? dir.directory.length : 0;
    push({
      id:"directory", label:"Employees Directory",
      ok: !!dir.ok && dlen>0, status: (!!dir.ok && dlen>0)?"ok":"warn",
      note: dir.ok?`items=${dlen}`:(dir.error||"error"),
      fix: (!!dir.ok && dlen>0)?"":FIX.gas_directory
    });

    // 5) SCHEDULE (0..4)
    if (opts.email && BASE){
      for(let off=0; off<5; off++){
        const sc = await j(`${BASE}?action=getSmartSchedule&email=${enc(opts.email)}&offset=${off}`);
        const days = Array.isArray(sc.days)? sc.days.length : 0;
        push({
          id:`sched_${off}`, label:`SmartSchedule (week -${off})`,
          ok: !!sc.ok && days>0, status: (!!sc.ok && days===7)?"ok": (!!sc.ok ? "warn":"fail"),
          note: sc.ok?`${sc.weekLabel||"(sin label)"} • days=${days} • total=${sc.total}`:(sc.error||"error"),
          fix: sc.ok? (days===7?"":FIX.gas_schedule) : FIX.gas_schedule
        });
      }
    }else{
      push({id:"sched", label:"SmartSchedule", ok:false, status:"warn", note:"sin email/base", fix:""});
    }

    // 6) SEND (dry run)
    if (opts.email && login.ok){
      const actor = login.email;
      const tgt = opts.target || actor;
      const st  = await j(`${BASE}?action=sendtoday&actor=${enc(actor)}&target=${enc(tgt)}&dry=1`);
      const stm = await j(`${BASE}?action=sendtomorrow&actor=${enc(actor)}&target=${enc(tgt)}&dry=1`);
      push({
        id:"sendtoday", label:"Send Today (dry)",
        ok: !!st.ok, status: st.ok?"ok":"warn",
        note: st.ok?`→ ${st.sent?.shift||"-"}`:(st.error||"error"),
        fix: st.ok?"":FIX.gas_send_today
      });
      push({
        id:"sendtomorrow", label:"Send Tomorrow (dry)",
        ok: !!stm.ok, status: stm.ok?"ok":"warn",
        note: stm.ok?`→ ${stm.sent?.shift||"-"}`:(stm.error||"error"),
        fix: stm.ok?"":FIX.gas_send_tomorrow
      });
    }else{
      push({id:"send", label:"Send Today/Tomorrow", ok:false, status:"skip", note:"sin login (omitido)", fix:""});
    }

    // 7) Today.key
    try{
      const tk = (window.Today && Today.key) || "(no Today)";
      const expect = nowShort();
      push({
        id:"today_key", label:"Today.key",
        ok: tk===expect, status: tk===expect?"ok":"warn",
        note:`Today.key=${tk} • expect=${expect}`,
        fix: tk===expect?"":FIX.today_key_mismatch
      });
    }catch{
      push({id:"today_key", label:"Today.key", ok:false, status:"warn", note:"no definido", fix:FIX.today_key_mismatch});
    }

    // 8) De-dupe/TTL de fetchJSON
    try{
      if (typeof window.fetchJSON === "function" && BASE){
        const url = `${BASE}?action=ping`;
        const a = await fetchJSON(url,{ttl:10000});
        const b = await fetchJSON(url,{ttl:10000});
        const sameRef = (a && b) ? (a===b) : false;
        push({
          id:"dedupe", label:"Cache TTL + de-dupe",
          ok: sameRef, status: sameRef?"ok":"warn",
          note: sameRef?"OK (mismo objeto cacheado)":"Devuelve objetos distintos (posible de-dupe inefectivo)",
          fix: sameRef?"":FIX.dedupe_cache
        });
      }else{
        push({id:"dedupe", label:"Cache TTL + de-dupe", ok:false, status:"skip", note:"fetchJSON no disponible", fix:""});
      }
    }catch{
      push({id:"dedupe", label:"Cache TTL + de-dupe", ok:false, status:"warn", note:"error al probar", fix:FIX.dedupe_cache});
    }

    // 9) UI básicos presentes
    const needed = ["#login", "#welcome", "#schedule", "#settingsModal"];
    const missing = needed.filter(sel => !document.querySelector(sel));
    push({
      id:"ui_nodes", label:"UI nodos base",
      ok: missing.length===0, status: missing.length===0?"ok":"warn",
      note: missing.length?("faltan: "+missing.join(", ")):"ok",
      fix: missing.length?FIX.ui_missing_nodes:""
    });

    // Consola y overlay
    const root = makeOverlay();
    const list = checks.map(c=>({
      id:c.id,
      label: ({
        base_url:"CONFIG.BASE_URL",
        sw_registered:"Service Worker",
        sw_cache_version:"SW cache vs CONFIG",
        ping:"Backend ping",
        login:"Login",
        directory:"Employees Directory",
        today_key:"Today.key",
        dedupe:"Cache TTL + de-dupe",
        ui_nodes:"UI base"
      }[c.id]) || c.label,
      status:c.status, ok:c.ok, note:c.note, fix:c.fix
    }));
    renderOverlay(root, list, meta);

    // Consola
    console.group("ACW_TEST");
    console.table(checks.map(asRow));
    console.log("Meta:", meta);
    console.log("Fix map:", FIX);
    console.groupEnd();

    return { meta, checks, fix_suggestions: checks.filter(x=>x.status!=="ok").map(x=>({id:x.id, fix:x.fix})) };
  }

  window.ACW_TEST = { run };
})();

/* ▶ Auto-diag por URL: ...?diag=1 */
(function(){
  try{
    const q = new URLSearchParams(location.search);
    if (q.get("diag")==="1" && window.ACW_TEST){
      const saved = localStorage.getItem("acwDiagEmail") || (window.currentUser?.email || "");
      const email = saved || prompt("ACW email:");
      const password = prompt("Password:");
      if (email && password){
        localStorage.setItem("acwDiagEmail", email);
        ACW_TEST.run({ email, password });
      }
    }
  }catch(e){}
})();

/* ▶ Botón flotante para ejecutar diagnóstico */
(function(){
  if (document.getElementById("acwDiagBtn") || !window.ACW_TEST) return;
  const b = document.createElement("button");
  b.id="acwDiagBtn";
  b.textContent="Run DIAG";
  Object.assign(b.style,{
    position:"fixed", right:"14px", bottom:"14px", zIndex:12000,
    padding:"10px 14px", border:"0", borderRadius:"10px",
    fontWeight:"700", cursor:"pointer",
    background:"#e60000", color:"#fff", boxShadow:"0 8px 18px rgba(230,0,0,.32)"
  });
  b.onclick = async ()=>{
    const saved = localStorage.getItem("acwDiagEmail") || (window.currentUser?.email || "");
    const email = saved || prompt("ACW email:");
    const password = prompt("Password:");
    if (!email || !password) return;
    localStorage.setItem("acwDiagEmail", email);
    await ACW_TEST.run({ email, password });
  };
  document.addEventListener("DOMContentLoaded", ()=> document.body.appendChild(b));
})();
/* ==== ACW — ONE-PASTE SCHEDULE PATCH (drop at very end) ==== */
(function(){
  if (window.__acwSchedulePatched__) return; // idempotente
  window.__acwSchedulePatched__ = true;

  // Guarda el fetchJSON original (o crea uno mínimo si no existe)
  const __origFetchJSON__ = window.fetchJSON || (async function(url, {signal} = {}){
    const r = await fetch(url, { cache:"no-store", signal }); 
    return r.json();
  });

  // Helper: ¿respuesta con días válidos?
  function okDays(d){ return d && Array.isArray(d.days) && d.days.length > 0; }

  // Ejecuta SmartSchedule con reintentos automáticos:
  async function robustSchedule(url, opts){
    let data = null;
    try { data = await __origFetchJSON__(url, opts); } catch { data = null; }
    // Si ya vino bien, devuelve
    if (okDays(data)) return data;

    // Quita &offset=N y reintenta SIN offset (algunos deploys devuelven vacío con offset)
    const baseNoOffset = String(url).replace(/&offset=\d+/i, "");
    try {
      const d2 = await __origFetchJSON__(baseNoOffset, { ...opts, ttl: (window.API?.schedTTL0||opts?.ttl) });
      if (okDays(d2)) return d2;
    } catch {}

    // Fallback final: vieja action=getSchedule (compatibilidad)
    try {
      const legacy = baseNoOffset.replace(/getSmartSchedule/i, "getSchedule");
      const d3 = await __origFetchJSON__((legacy), { ...opts, ttl: (window.API?.schedTTL0||opts?.ttl) });
      if (okDays(d3)) return d3;
    } catch {}

    // Devuelve lo que haya (aunque vacío) para no romper llamados
    return data;
  }

  // 1) Parchea fetchJSON: solo intercepta cuando es getSmartSchedule
  window.fetchJSON = async function(url, opts = {}){
    if (typeof url === "string" && /action=getSmartSchedule/i.test(url)){
      return robustSchedule(url, opts);
    }
    // resto de URLs igual que siempre
    return __origFetchJSON__(url, opts);
  };

  // 2) Fuerza API.getSchedule a usar el flujo robusto (aunque haya múltiples definiciones arriba)
  if (!window.API) window.API = {};
  window.API.getSchedule = async function(email, offset = 0, controller){
    const ttl = offset === 0 ? (API.schedTTL0 || 60000) : (API.schedTTLOld || 300000);
    const base = `${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}`;
    const url  = offset ? `${base}&offset=${offset}` : base;
    return robustSchedule(url, { ttl, signal: controller?.signal });
  };

  console.log("🩹 ACW one-paste schedule patch active");
})();
