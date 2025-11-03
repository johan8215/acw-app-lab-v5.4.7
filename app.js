/* ============================================================
   ACW-LITE v1.0 — Local-first (registro en la app)
   (c) JAG15 2025 — Blue Glass White minimal
   ============================================================ */

let currentUser = null;

/* ---------- Mini DB (LocalStorage) ---------- */
const DB = {
  read(k, fallback){ try{ return JSON.parse(localStorage.getItem(k) || JSON.stringify(fallback)); }catch{ return fallback; } },
  write(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
};
const Users = {
  all(){ return DB.read('acw.users', []); },
  save(list){ DB.write('acw.users', list); },
  add(u){
    const list = this.all();
    const email = String(u.email||"").toLowerCase().trim();
    if (!email) throw new Error("Email required");
    if (list.some(x => (x.email||"").toLowerCase() === email)) throw new Error("Email already exists");
    const rec = {
      name: String(u.name||"").trim(),
      email,
      phone: String(u.phone||"").trim(),
      role: (u.role||"employee").toLowerCase(),
      pass: String(u.pass||"")
    };
    list.push(rec); this.save(list); return rec;
  },
  get(email){ return this.all().find(x => (x.email||"").toLowerCase() === String(email||"").toLowerCase()); }
};
const Sched = {
  all(){ return DB.read('acw.sched', {}); },
  save(obj){ DB.write('acw.sched', obj); },
  weekKey(d=new Date()){
    const day=d.getDay(); // 0=Sun
    const mon=new Date(d); mon.setHours(0,0,0,0); mon.setDate(mon.getDate()-((day+6)%7));
    const sun=new Date(mon); sun.setDate(mon.getDate()+6);
    const F=x=>x.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    return `${F(mon)} – ${F(sun)}`;
  },
  template(){
    const days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    return days.map(n=>({name:n, shift:"-", hours:0}));
  },
  get(email, key=this.weekKey()){
    const all=this.all(); const e=String(email||"").toLowerCase();
    if (!all[e]) all[e]={};
    if (!all[e][key]) all[e][key]=this.template();
    this.save(all); return { key, days: all[e][key] };
  },
  set(email, key, days){
    const all=this.all(); const e=String(email||"").toLowerCase();
    if (!all[e]) all[e]={}; all[e][key]=days; this.save(all);
  }
};

/* ---------- Utils UI pequeños ---------- */
function $(sel, root=document){ return root.querySelector(sel); }
function setVisible(el, show){ if(!el) return; el.style.display = show ? "" : "none"; }
function safeText(el, txt){ if(el) el.textContent = txt; }

/* ---------- Parse y horas ---------- */
function parseTime(str){
  const s=String(str||"").trim();
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?$/i);
  if(!m) return null;
  let h=+m[1], min=+(m[2]||0), ap=(m[3]||"").toLowerCase();
  if (ap==="pm" && h<12) h+=12; if (ap==="am" && h===12) h=0;
  const d=new Date(); d.setHours(h,min,0,0); return d;
}
function hoursFromShift(shift){
  const t = String(shift||"").trim();
  if (!t || /^-$/i.test(t) || /off/i.test(t)) return 0;
  if (t.endsWith(".")){ // live: "9am."
    const a=parseTime(t.replace(/\.$/,"").trim()); if(!a) return 0;
    return Math.max(0,(Date.now()-a.getTime())/36e5);
  }
  const p=t.split("-"); if (p.length!==2) return 0;
  const a=parseTime(p[0].trim()), b=parseTime(p[1].trim());
  if (!a || !b) return 0;
  return Math.max(0,(b-a)/36e5);
}

/* ---------- Login / Registro ---------- */
async function loginUser(){
  const email = $("#email")?.value.trim().toLowerCase();
  const pass  = $("#password")?.value.trim();
  const diag  = $("#diag");
  if(!email || !pass) return safeText(diag, "Enter email and password.");
  const u = Users.get(email);
  if(!u || u.pass !== pass){ safeText(diag, "❌ Invalid email or password."); return; }
  currentUser = u; localStorage.setItem("acwUser", JSON.stringify(u));
  safeText(diag, "✅ Welcome, " + u.name + "!");
  showWelcome(u.name, u.role); loadSchedule(u.email);
}
function ensureRegisterButton(){
  if (document.getElementById("openReg")) return;
  const btn = document.createElement("button");
  btn.id="openReg"; btn.textContent="Create account";
  btn.style.marginTop="10px";
  btn.onclick = openRegister;
  $("#login")?.appendChild(btn);
}
function openRegister(){
  if (document.getElementById("regModal")) { $("#regModal").style.display="flex"; return; }
  const m=document.createElement("div"); m.id="regModal";
  Object.assign(m.style,{position:"fixed",inset:"0",display:"flex",alignItems:"center",justifyContent:"center",
    background:"rgba(0,0,0,.45)",backdropFilter:"blur(6px)",zIndex:12000});
  m.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:16px 18px;min-width:300px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.25);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <h3 style="margin:0;color:#0a84ff">Create account</h3>
        <button id="regClose" style="background:none;border:0;font-size:20px;cursor:pointer">×</button>
      </div>
      <input id="r_name"  placeholder="Full name"    style="display:block;width:100%;margin:6px 0;padding:8px">
      <input id="r_email" placeholder="Email"        style="display:block;width:100%;margin:6px 0;padding:8px">
      <input id="r_phone" placeholder="Phone (opt.)" style="display:block;width:100%;margin:6px 0;padding:8px">
      <select id="r_role"  style="display:block;width:100%;margin:6px 0;padding:8px">
        <option value="employee">Employee</option>
        <option value="manager">Manager</option>
      </select>
      <input id="r_pass"  type="password" placeholder="Password" style="display:block;width:100%;margin:6px 0;padding:8px">
      <p id="r_diag" style="color:#e60000;font-size:.9em"></p>
      <button id="r_save" style="background:#e60000;color:#fff;border:0;border-radius:10px;padding:10px 12px;font-weight:700;cursor:pointer;width:100%">Create</button>
    </div>`;
  document.body.appendChild(m);
  $("#regClose").onclick = ()=> m.remove();
  $("#r_save").onclick = ()=>{
    const name=$("#r_name").value, email=$("#r_email").value, phone=$("#r_phone").value, role=$("#r_role").value, pass=$("#r_pass").value;
    const diag=$("#r_diag");
    if(!name||!email||!pass){ diag.textContent="Fill name, email and password."; return; }
    try{
      const rec = Users.add({name,email,phone,role,pass});
      currentUser = rec; localStorage.setItem("acwUser", JSON.stringify(rec));
      m.remove(); showWelcome(rec.name, rec.role); loadSchedule(rec.email);
    }catch(e){ diag.textContent=String(e.message||e); }
  };
}

/* ---------- Bienvenida y sesión ---------- */
async function showWelcome(name, role){
  setVisible($("#login"), false);
  setVisible($("#welcome"), true);
  $("#welcomeName").innerHTML = `<b>${name}</b>`;
  safeText($("#welcomeRole"), role||"");

  // Manager: botón Team
  if (["manager","supervisor"].includes(String(role||"").toLowerCase())) {
    if (!document.getElementById("teamBtn")) {
      const b=document.createElement("button");
      b.id="teamBtn"; b.className="team-btn"; b.textContent="Team";
      b.onclick=openTeam; document.body.appendChild(b);
    }
  }
}
window.addEventListener("load", ()=>{
  ensureRegisterButton();
  try{
    const saved = localStorage.getItem("acwUser");
    if (saved){
      currentUser = JSON.parse(saved);
      showWelcome(currentUser.name, currentUser.role);
      loadSchedule(currentUser.email);
    }
  }catch{}
});

/* ---------- Render de horario (con edición simple) ---------- */
function loadSchedule(email){
  const box = $("#schedule");
  const wk = Sched.get(email);
  const todayKey = new Date().toLocaleString("en-US",{weekday:"short"}).slice(0,3).toLowerCase();

  // recalcula horas por cada fila
  wk.days.forEach(d => d.hours = +hoursFromShift(d.shift).toFixed(1));
  Sched.set(email, wk.key, wk.days);

  let html = `<div style="margin:6px 0;color:#0078ff">Week: ${wk.key}</div>`;
  html += `<table><tr><th>Day</th><th>Shift</th><th>Hours</th></tr>`;
  wk.days.forEach(d=>{
    const isToday = d.name.slice(0,3).toLowerCase()===todayKey;
    html += `<tr class="${isToday?"today":""}">
      <td>${d.name}</td>
      <td contenteditable="true" data-day="${d.name}">${d.shift||"-"}</td>
      <td style="text-align:right">${Number(d.hours||0).toFixed(1)}</td>
    </tr>`;
  });
  const total = wk.days.reduce((a,b)=>a+Number(b.hours||0),0);
  html += `</table>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <button id="saveSched" style="background:#e60000;color:#fff;border:0;border-radius:10px;padding:8px 12px;font-weight:700;cursor:pointer">Save</button>
      <button id="histBtn" style="border:1px solid #ccc;border-radius:8px;padding:8px 12px;cursor:pointer">History</button>
      <span class="total" style="margin-left:auto">Total Hours: <b>${total.toFixed(1)}</b></span>
    </div>`;
  box.innerHTML = html;

  $("#saveSched").onclick = ()=>{
    const rows = box.querySelectorAll('td[contenteditable][data-day]');
    const days = Array.from(rows).map(cell=>{
      const name = cell.dataset.day;
      const shift = cell.innerText.trim();
      return { name, shift, hours: +hoursFromShift(shift).toFixed(1) };
    });
    Sched.set(email, wk.key, days);
    loadSchedule(email); // re-render
  };
  $("#histBtn").onclick = ()=> openHistory(email, currentUser?.name||"");
}

/* ---------- Team (simple listado manager) ---------- */
function openTeam(){
  document.getElementById("teamModal")?.remove();
  const m=document.createElement("div"); m.id="teamModal";
  Object.assign(m.style,{position:"fixed",inset:"0",display:"flex",alignItems:"center",justifyContent:"center",
    background:"rgba(0,0,0,.35)",backdropFilter:"blur(4px)",zIndex:11000});
  const users = Users.all();
  const wkKey = Sched.weekKey();
  const rows = users.map(u=>{
    const d = Sched.get(u.email, wkKey).days;
    const tot = d.reduce((a,b)=>a+Number(b.hours||0),0);
    return `<tr data-email="${u.email}">
      <td><b>${u.name}</b><div style="color:#777;font-size:.85em">${u.role}</div></td>
      <td style="text-align:right">${tot.toFixed(1)}h</td>
      <td><button class="open" style="padding:6px 10px">Open</button></td>
    </tr>`;
  }).join("");
  m.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:16px 18px;min-width:320px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,.25);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0;color:#0a84ff">Team</h3>
        <button id="teamClose" style="background:none;border:0;font-size:20px;cursor:pointer">×</button>
      </div>
      <table style="width:100%;border-collapse:separate;border-spacing:0 6px">
        <tr><th style="text-align:left">Employee</th><th style="text-align:right">Hours</th><th></th></tr>
        ${rows||""}
      </table>
    </div>`;
  document.body.appendChild(m);
  $("#teamClose").onclick = ()=> m.remove();
  m.querySelectorAll(".open").forEach(btn=>{
    btn.onclick = ()=>{
      const email = btn.closest("tr").dataset.email;
      m.remove();
      // ver horario de otro empleado
      loadSchedule(email);
    };
  });
}

/* ---------- History básico (sólo lectura, 5 semanas) ---------- */
function openHistory(email, name){
  document.getElementById("histModal")?.remove();
  const m=document.createElement("div"); m.id="histModal";
  Object.assign(m.style,{position:"fixed",inset:"0",display:"flex",alignItems:"center",justifyContent:"center",
    background:"rgba(0,0,0,.35)",backdropFilter:"blur(4px)",zIndex:11000});

  const weeks = Array.from({length:5},(_,i)=>i).map(off=>{
    const ref=new Date(); ref.setDate(ref.getDate()-(off*7));
    const key = Sched.weekKey(ref);
    const d   = Sched.get(email, key).days;
    const tot = d.reduce((a,b)=>a+Number(b.hours||0),0);
    return { key, days:d, total:tot, off };
  });
  const rows = weeks.map((w,i)=>`
    <tr data-idx="${i}">
      <td>${w.key}</td>
      <td style="text-align:right">${w.total.toFixed(1)}h</td>
      <td><button class="openW" style="padding:6px 10px">Open</button></td>
    </tr>`).join("");

  m.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:16px 18px;min-width:320px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.25);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0;color:#0a84ff">History — ${String(name||"")}</h3>
        <button id="histClose" style="background:none;border:0;font-size:20px;cursor:pointer">×</button>
      </div>
      <table style="width:100%;border-collapse:separate;border-spacing:0 6px">
        <tr><th style="text-align:left">Week</th><th style="text-align:right">Total</th><th></th></tr>
        ${rows}
      </table>
      <div id="histDetail" style="margin-top:10px"></div>
    </div>`;
  document.body.appendChild(m);
  $("#histClose").onclick = ()=> m.remove();

  m.querySelectorAll(".openW").forEach(btn=>{
    btn.onclick = ()=>{
      const i = +btn.closest("tr").dataset.idx;
      const w = weeks[i];
      const lines = w.days.map(d=>`
        <tr><td>${d.name}</td><td>${d.shift||"-"}</td><td style="text-align:right">${Number(d.hours||0).toFixed(1)}</td></tr>
      `).join("");
      $("#histDetail", m).innerHTML = `
        <h4 style="margin:10px 0 6px;color:#0a84ff">${w.key}</h4>
        <table style="width:100%;border-collapse:separate;border-spacing:0 4px">
          <tr><th style="text-align:left">Day</th><th>Shift</th><th style="text-align:right">Hours</th></tr>
          ${lines}
          <tr><td></td><td style="text-align:right"><b>Total</b></td><td style="text-align:right"><b>${w.total.toFixed(1)}</b></td></tr>
        </table>`;
    };
  });
}

/* ---------- Settings mínimos ---------- */
function openSettings(){ setVisible($("#settingsModal"), true); }
function closeSettings(){ setVisible($("#settingsModal"), false); }
function logoutUser(){ localStorage.removeItem("acwUser"); location.reload(); }
async function submitChangePassword(){
  const oldPass=$("#oldPass")?.value?.trim(), newPass=$("#newPass")?.value?.trim(), confirm=$("#confirmPass")?.value?.trim();
  const diag=$("#passDiag"); if(!oldPass||!newPass||!confirm) return safeText(diag,"Fill all fields.");
  if(newPass!==confirm) return safeText(diag,"Passwords do not match.");
  const u = Users.get(currentUser?.email); if(!u || u.pass!==oldPass) return safeText(diag,"Invalid current password.");
  u.pass=newPass; Users.save(Users.all().map(x=>x.email===u.email?u:x));
  safeText(diag,"✅ Password updated."); setTimeout(()=>closeSettings(),800);
}

/* ---------- (Opcional) Export JSON — por si quieres “compartir con Google” luego ---------- */
function exportData(){
  const blob = new Blob([JSON.stringify({users:Users.all(), schedules:Sched.all()}, null, 2)], {type:"application/json"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "acw-lite-export.json"; a.click();
}

/* ---------- Exponer al DOM ---------- */
window.loginUser = loginUser;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.logoutUser = logoutUser;
window.submitChangePassword = submitChangePassword;
window.openTeam = openTeam;
window.openHistory = openHistory;
window.exportData = exportData;

console.log("✅ ACW-LITE v1.0 ready (local-first)");

/* ===== ACW-LITE — Sync to Google (IMPORT) ===== */
function postJSON(url, data, { signal } = {}){
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    cache: "no-store",
    signal
  });
}

async function syncToGoogle(){
  const base = (window.CONFIG && CONFIG.BASE_URL) || "";
  if (!base){ toast("⚠️ Missing BASE_URL in config.js", "error"); return; }

  // Guarda la key localmente la primera vez
  let key = localStorage.getItem("acw.syncKey") || "";
  if (!key){
    key = prompt("Enter Integration Key (del GAS)");
    if (!key) return;
    localStorage.setItem("acw.syncKey", key);
  }

  // Armamos el dump (sin contraseñas)
  const payload = {
    meta: {
      version: "ACW-LITE v1.0",
      at: new Date().toISOString(),
      actor: currentUser?.email || null,
      device: navigator.userAgent
    },
    users: (window.Users?.all()||[]).map(({name,email,phone,role})=>({name,email,phone,role})),
    schedules: (window.Sched?.all()||{})   // { email: { "Mon – Sun": [ {name,shift,hours}, ... ] } }
  };

  toast("☁️ Syncing…", "info");
  try{
    const res = await postJSON(`${base}?action=import&key=${encodeURIComponent(key)}`, payload);
    const j = await res.json().catch(()=>null);
    if (res.ok && j?.ok){
      toast("✅ Synced to Google", "success");
      if (window.navigator.vibrate) navigator.vibrate(60);
    }else{
      throw new Error(j?.error || `HTTP ${res.status}`);
    }
  }catch(e){
    toast(`❌ Sync failed: ${e.message}`, "error");
  }
}

// Inserta botón en Settings automáticamente
(function injectSyncButton(){
  const modal = document.getElementById("settingsModal");
  if (!modal) return;
  const sec = modal.querySelector(".settings-section");
  if (!sec || document.getElementById("syncBtn")) return;
  const b = document.createElement("button");
  b.id = "syncBtn";
  b.textContent = "☁️ Sync to Google";
  b.onclick = syncToGoogle;
  sec.appendChild(b);
})();

window.syncToGoogle = syncToGoogle;
