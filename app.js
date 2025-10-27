/* ============================================================
   🧠 ACW-App v5.6.2 — Blue Glass White Connected
   Johan A. Giraldo (JAG15) & Sky — Oct 2025
   ============================================================
   - Login conectado a GAS (login, getSmartSchedule, directory)
   - Dashboard: welcome + schedule + live hours + total estable
   - Team View (manager/supervisor) + Employee Modal
   - Envíos sendtoday / sendtomorrow (fallback simple)
   - Change password
   - Restauración de sesión + toasts
   ============================================================ */

let currentUser = null;

/* ============== helpers UI ============== */
function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }
function isManagerRole(role){ return ["manager","supervisor"].includes(String(role||"").toLowerCase()); }

function safeText(el, txt){ if(el) el.textContent = txt; }
function setVisible(el, show){ if(!el) return; el.style.display = show ? "" : "none"; }

/* ============== LOGIN ============== */
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

/* ============== WELCOME DASHBOARD ============== */
async function showWelcome(name, role) {
  setVisible($("#login"), false);
  setVisible($("#welcome"), true);
  $("#welcomeName").innerHTML = `<b>${name}</b>`;
  safeText($("#welcomeRole"), role || "");

  if (isManagerRole(role)) addTeamButton();

  // Inserta teléfono del usuario (si existe)
  try {
    const r = await fetch(`${CONFIG.BASE_URL}?action=getEmployeesDirectory`, {cache:"no-store"});
    const j = await r.json();
    if (j.ok && Array.isArray(j.directory)) {
      const self = j.directory.find(e => (e.email||"").toLowerCase() === (currentUser?.email||"").toLowerCase());
      if (self?.phone) {
        $(".user-phone")?.remove();
        $("#welcomeName")?.insertAdjacentHTML("afterend",
          `<p class="user-phone">📞 <a href="tel:${self.phone}" style="color:#0078ff;font-weight:600;text-decoration:none;">${self.phone}</a></p>`
        );
      }
    }
  } catch {}
}

/* ============== LOAD SCHEDULE + LIVE ============== */
async function loadSchedule(email) {
  const schedDiv = $("#schedule");
  schedDiv.innerHTML = `<p style="color:#007bff;font-weight:500;">Loading your shift...</p>`;

  try {
    const r = await fetch(`${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}`, {cache:"no-store"});
    const d = await r.json();

    if (!d.ok || !Array.isArray(d.days)) {
      schedDiv.innerHTML = `<p style="color:#c00;">No schedule found for this week.</p>`;
      return;
    }

    let html = `<table><tr><th>Day</th><th>Shift</th><th>Hours</th></tr>`;
    d.days.forEach(day=>{
      const isToday = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase() === day.name.slice(0,3).toLowerCase();
      html += `<tr class="${isToday?"today":""}"><td>${day.name}</td><td>${day.shift||"-"}</td><td>${day.hours||"0"}</td></tr>`;
    });
    html += `</table><p class="total">Total Hours: <b>${(d.total??0).toFixed?.(1) ?? d.total ?? 0}</b></p>`;

    schedDiv.innerHTML = html;

    // Arranca live 1s después para asegurar que el DOM esté
    setTimeout(()=> startLiveTimer(d.days, Number(d.total||0)), 1000);

  } catch (e) {
    console.warn(e);
    schedDiv.innerHTML = `<p style="color:#c00;">Error loading schedule.</p>`;
  }
}

/* ============== SESSION RESTORE ============== */
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

/* ============== LIVE TIMER (dashboard) ============== */
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
  totalEl.innerHTML = `<span style="color:${color}">⚪ Total Hours: <b>${value.toFixed(1)}</b></span>`;
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
    const todayKey = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
    const today = days.find(d=> d.name.slice(0,3).toLowerCase()===todayKey);
    if(!today || !today.shift || /off/i.test(today.shift)) return;

    const shift = today.shift.trim();
    removeOnlineBadge();

    // Turno activo estilo "7:30."
    if (shift.endsWith(".")) {
      addOnlineBadge();
      const startStr = shift.replace(/\.$/,"").trim();
      const startTime = parseTime(startStr); if (!startTime) return;

      const tick = ()=>{
        const diff = Math.max(0,(Date.now()-startTime.getTime())/36e5);
        updateTotalDisplay(total+diff, true);
        showLiveHours(diff, true);
        // también pinta dentro de la tabla (Horas de hoy)
        paintLiveInTable(todayKey, diff);
      };
      tick();
      clearInterval(window.__acwLiveTick__); window.__acwLiveTick__ = setInterval(tick, 60000);
      return;
    }

    // Turno cerrado "7:30 - 6"
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

/* ============== SETTINGS ============== */
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

/* ============== CHANGE PASSWORD ============== */
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

/* ============== TEAM VIEW (gestión) ============== */
const TEAM_PAGE_SIZE = 8;
let __teamList=[], __teamPage=0;

function addTeamButton(){
  if ($("#teamBtn")) return;
  const btn = document.createElement("button");
  btn.id="teamBtn"; btn.className="team-btn"; btn.textContent="Team View";
  btn.onclick = toggleTeamOverview; document.body.appendChild(btn);
}
function toggleTeamOverview(){
  const w = $("#directoryWrapper");
  if (w){ w.classList.add("fade-out"); setTimeout(()=>w.remove(), 220); return; }
  loadEmployeeDirectory();
}
async function loadEmployeeDirectory() {
  try {
    const r = await fetch(`${CONFIG.BASE_URL}?action=getEmployeesDirectory`, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) return;

    __teamList = j.directory || [];
    __teamPage = 0;
    renderTeamViewPage();
  } catch (e) {
    console.warn(e);
  }
}

function renderTeamViewPage() {
  // 🔄 Limpia anterior si existe
  $("#directoryWrapper")?.remove();

  // 🧱 Crea el contenedor principal centrado
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

  // 🧩 Contenido del Team View
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

  // 📊 Carga datos de empleados
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

  // 📄 Navegación por páginas
  $("#tvPrev", box).onclick = () => { __teamPage = Math.max(0, __teamPage - 1); renderTeamViewPage(); };
  $("#tvNext", box).onclick = () => { __teamPage = Math.min(Math.ceil(__teamList.length / TEAM_PAGE_SIZE) - 1, __teamPage + 1); renderTeamViewPage(); };

  // 🔢 Llenar horas totales
  slice.forEach(async emp => {
    try {
      const r = await fetch(`${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(emp.email)}`, { cache: "no-store" });
      const d = await r.json();
      const tr = body.querySelector(`tr[data-email="${CSS.escape(emp.email)}"]`);
      if (tr) tr.querySelector(".tv-hours").textContent = (d && d.ok) ? (Number(d.total || 0)).toFixed(1) : "0";
    } catch { }
  });

  // 🔁 Actualiza Live Status
  updateTeamViewLiveStatus();

  // 🧠 Animación de aparición centrada (sin “baile”)
  setTimeout(() => {
    box.style.visibility = "visible";
    box.style.opacity = "1";
    box.style.transform = "translate(-50%, -50%) scale(1)";
  }, 100);
}
async function updateTeamViewLiveStatus(){
  try{
    const rows = $all(".tv-table tr[data-email]"); if (!rows.length) return;
    for (const row of rows){
      const email=row.dataset.email, liveCell=row.querySelector(".tv-live"), totalCell=row.querySelector(".tv-hours");
      const r = await fetch(`${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}`, {cache:"no-store"});
      const d = await r.json(); if (!d.ok || !d.days) continue;

      const todayKey = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
      const today = d.days.find(x=> x.name.slice(0,3).toLowerCase()===todayKey);
      if (!today?.shift) { liveCell.innerHTML="—"; continue; }

      if (today.shift.trim().endsWith(".")){
        const startTime = parseTime(today.shift.replace(/\.$/,"").trim());
        if(!startTime) continue;
        const diff = Math.max(0,(Date.now()-startTime.getTime())/36e5);
        liveCell.innerHTML = `🟢 ${diff.toFixed(1)}h`;
        liveCell.style.color="#33ff66"; liveCell.style.fontWeight="600"; liveCell.style.textShadow="0 0 10px rgba(51,255,102,.6)";
        const base = parseFloat(totalCell.textContent)||0;
        totalCell.innerHTML = `${(base+diff).toFixed(1)} <span style="color:#33a0ff;font-size:.85em;">(+${diff.toFixed(1)})</span>`;
      }else{
        liveCell.innerHTML="—"; liveCell.style.color="#aaa"; liveCell.style.fontWeight="400"; liveCell.style.textShadow="none";
      }
    }
  }catch(e){ console.warn("Live col error:", e); }
}
setInterval(updateTeamViewLiveStatus, 120000);

/* ============== EMPLOYEE MODAL (gestión) ============== */
async function openEmployeePanel(btnEl){
  const tr = btnEl.closest("tr");
  const email = tr.dataset.email, name = tr.dataset.name, role = tr.dataset.role||"", phone = tr.dataset.phone||"";
  const modalId=`emp-${email.replace(/[@.]/g,"_")}`; if ($("#"+modalId)) return;

  let data=null;
  try{
    const r = await fetch(`${CONFIG.BASE_URL}?action=getSmartSchedule&email=${encodeURIComponent(email)}`, {cache:"no-store"});
    data = await r.json(); if (!data.ok) throw new Error();
  }catch{ alert("No schedule found for this employee."); return; }

  const m = document.createElement("div");
  m.className="employee-modal emp-panel"; m.id=modalId;
  m.innerHTML = `
    <div class="emp-box">
      <button class="emp-close">×</button>
      <div class="emp-header">
        <h3>${name}</h3>
        ${phone?`<p class="emp-phone"><a href="tel:${phone}">${phone}</a></p>`:""}
        <p class="emp-role">${role}</p>
      </div>
      <table class="schedule-mini">
        <tr><th>Day</th><th>Shift</th><th>Hours</th></tr>
        ${data.days.map(d=>`
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
          <p id="empStatusMsg-${email.replace(/[@.]/g,"_")}" class="emp-status-msg" style="margin-top:6px;font-size:.9em;"></p>
        </div>` : ``}
      <button class="emp-refresh" style="margin-top:8px;">⚙️ Check for Updates</button>
    </div>
  `;
  document.body.appendChild(m);

  $(".emp-close",m).onclick = ()=> m.remove();
  $(".emp-refresh",m).onclick = ()=> { try{ if("caches" in window) caches.keys().then(k=>k.forEach(n=>caches.delete(n))); }catch{}; m.classList.add("flash"); setTimeout(()=>location.reload(), 900); };

  if (isManagerRole(currentUser?.role)) {
    $(".btn-update",m).onclick   = ()=> updateShiftFromModal(email, m);
    $(".btn-today",m).onclick    = ()=> sendShiftMessage(email, "sendtoday");
    $(".btn-tomorrow",m).onclick = ()=> sendShiftMessage(email, "sendtomorrow");
  }

  enableModalLiveShift(m, data.days);
}

function enableModalLiveShift(modal, days){
  try{
    const key = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
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

/* ============== MANAGER ACTIONS (safe full-week edition) ============== */
async function updateShiftFromModal(targetEmail, modalEl){
  const msg = $(`#empStatusMsg-${targetEmail.replace(/[@.]/g,"_")}`) || $(".emp-status-msg", modalEl);
  const actor = currentUser?.email;
  if (!actor) { msg && (msg.textContent="⚠️ Session expired. Login again."); return; }

  const rows = $all(".schedule-mini tr[data-day]", modalEl);
  const changes = rows.map(r=>{
    const day = r.dataset.day; 
    const newShift = r.cells[1].innerText.trim();
    const original = (r.getAttribute("data-original")||"").trim();
    return (newShift !== original) ? { day, newShift } : null;
  }).filter(Boolean);

  if (!changes.length){ 
    msg && (msg.textContent="ℹ️ No changes to save."); 
    toast("ℹ️ No changes", "info"); 
    return; 
  }

  msg && (msg.textContent="✏️ Updating schedule…");
  let ok=0;

  for (const c of changes){
    try {
      // 🧭 Detecta si el día modificado es hoy o mañana
      const today = new Date();
      const todayKey = today.toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
      const tomorrowKey = new Date(today.getTime()+86400000)
        .toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();
      const cKey = c.day.toLowerCase();

      // Define acción según el día
      const action = (cKey === todayKey) ? "updateShiftToday" :
                     (cKey === tomorrowKey) ? "updateShiftTomorrow" : "updateShift";

      const u = `${CONFIG.BASE_URL}?action=${action}&actor=${encodeURIComponent(actor)}&target=${encodeURIComponent(targetEmail)}&day=${encodeURIComponent(c.day)}&shift=${encodeURIComponent(c.newShift)}`;
      const r = await fetch(u, {cache:"no-store"}); 
      const j = await r.json();
      if (j?.ok) ok++;
    } catch(e){ console.warn("update err", e); }
  }

  if (ok === changes.length){ 
    msg.textContent="✅ All shifts updated!"; 
    toast("✅ Shifts updated","success"); 
    rows.forEach(r=> r.setAttribute("data-original", r.cells[1].innerText.trim())); 
  }
  else if (ok > 0){ 
    msg.textContent=`⚠️ Partial update: ${ok}/${changes.length}`; 
    toast("⚠️ Partial update","error"); 
  }
  else { 
    msg.textContent="❌ Update failed."; 
    toast("❌ Could not update","error"); 
  }
}
async function sendShiftMessage(targetEmail, action){
  const msg = $(`#empStatusMsg-${targetEmail.replace(/[@.]/g,"_")}`);
  msg && (msg.textContent="💬 Sending...");
  const actor = currentUser?.email; if (!actor){ msg && (msg.textContent="⚠️ Session expired"); return; }

  try{
    const url = `${CONFIG.BASE_URL}?action=${action}&actor=${encodeURIComponent(actor)}&target=${encodeURIComponent(targetEmail)}`;
    const r = await fetch(url, {cache:"no-store"}); const j = await r.json();
    if (j?.ok){ msg.textContent = action==="sendtoday" ? "✅ Sent Today" : "✅ Sent Tomorrow"; toast("✅ Shift message sent","success"); }
    else { msg.textContent = `⚠️ ${j?.error||"Failed to send"}`; toast("❌ Send failed","error"); }
  }catch(e){ msg && (msg.textContent="⚠️ Connection error"); toast("❌ Connection error","error"); }
}

/* ============== TOASTS ============== */
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

function openChangePassword() {
  const modal = $("#changePasswordModal");
  closeSettings(); // 🔹 cierra el Settings primero
  if (modal) {
    modal.classList.add("show");
    modal.style.display = "flex";
  }
}

function closeChangePassword() {
  const modal = $("#changePasswordModal");
  if (modal) {
    modal.classList.remove("show");
    setTimeout(() => (modal.style.display = "none"), 200);
  }
}

/* ============== GLOBAL BINDS ============== */
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

console.log(`✅ ACW-App loaded → ${CONFIG?.VERSION||"v5.6.2"} | Base: ${CONFIG?.BASE_URL||"<no-config>"}`);

/* ============================================================
   ⚙️ ACW-App Behavior Fix Pack v5.6.2
   Johan A. Giraldo (JAG15) & Sky — Nov 2025
   ============================================================ */

// 🧩 Corrige apertura del Team View con animación suave
const _oldRenderTV = window.renderTeamViewPage;
window.renderTeamViewPage = function(...args) {
  _oldRenderTV.apply(this, args);
  const box = document.querySelector("#directoryWrapper");
  if (box) setTimeout(() => box.classList.add("show"), 50);
};

// 🧩 Reasigna visibilidad del modal de settings
function openSettings() {
  const modal = document.getElementById("settingsModal");
  if (!modal) {
    console.warn("⚠️ Settings modal not found");
    return;
  }
  modal.style.display = "flex";
  modal.style.alignItems = "center";
  modal.style.justifyContent = "center";
}
function closeSettings() {
  const modal = document.getElementById("settingsModal");
  if (modal) modal.style.display = "none";
}

// 🔁 Asegura que las funciones globales sigan disponibles
window.openSettings = openSettings;
window.closeSettings = closeSettings;
