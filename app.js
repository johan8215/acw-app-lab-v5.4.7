/* ============================================================
   ACW-App v5.6.4 — Blue Glass White Clean
   Johan A. Giraldo (JAG15) & Sky — Nov 2025
   ============================================================ */

/* ---------- Utils ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const isManagerRole = role => ["manager", "supervisor"].includes(String(role || "").toLowerCase());
const safeText = (el, txt) => { if (el) el.textContent = txt; };
const setVisible = (el, show) => { if (!el) return; el.style.display = show ? "" : "none"; };

/* Today key (cached) */
const Today = (() => {
  let key = new Date().toLocaleString("en-US", { weekday: "short" }).slice(0, 3).toLowerCase();
  const now = new Date();
  const next = new Date(now); next.setHours(24, 0, 0, 0);
  setTimeout(() => { key = new Date().toLocaleString("en-US", { weekday: "short" }).slice(0, 3).toLowerCase(); }, next - now + 50);
  return { get key() { return key; } };
})();

/* ---------- Network cache with TTL ---------- */
const Net = (() => {
  const store = new Map();
  function get(k) {
    const it = store.get(k);
    if (!it) return null;
    if (it.value && it.expires > Date.now()) return it.value;
    if (it.inflight) return it.inflight;
    store.delete(k);
    return null;
  }
  function set(k, v, ttl) { store.set(k, { value: v, expires: Date.now() + ttl }); return v; }
  function setInflight(k, p) { store.set(k, { inflight: p, expires: 0 }); }
  function clearInflight(k) { const it = store.get(k); if (it && it.inflight) store.delete(k); }
  return { get, set, setInflight, clearInflight };
})();

async function fetchJSON(url, { ttl = 0, signal } = {}) {
  if (ttl > 0) {
    const cached = Net.get(url);
    if (cached) return cached;
  }
  const inflight = fetch(url, { cache: "no-store", signal }).then(r => r.json());
  if (ttl > 0) Net.setInflight(url, inflight);
  try {
    const data = await inflight;
    if (ttl > 0) Net.set(url, data, ttl);
    return data;
  } finally {
    if (ttl > 0) Net.clearInflight(url);
  }
}

/* ---------- API ---------- */
const API = {
  dirTTL: 5 * 60 * 1000,
  schedTTL0: 60 * 1000,
  schedTTLOld: 5 * 60 * 1000,
  _aliasCache: new Map(),

  async getDirectory(controller) {
    const u = `${CONFIG.BASE_URL}?action=getEmployeesDirectory`;
    return fetchJSON(u, { ttl: this.dirTTL, signal: controller?.signal });
  },

  async resolveAlias({ email, phone } = {}, controller) {
    const key = (email || phone || "").toLowerCase();
    if (this._aliasCache.has(key)) return this._aliasCache.get(key);
    const d = await this.getDirectory(controller);
    const list = d?.directory || d?.employees || d?.rows || (Array.isArray(d) ? d : []);
    const norm = v => (v || "").toString().trim();
    const nPhone = v => norm(v).replace(/\D/g, "");
    const rec = list.find(x =>
      (email && norm(x.email).toLowerCase() === norm(email).toLowerCase()) ||
      (phone && nPhone(x.phone) && nPhone(x.phone) === nPhone(phone))
    );
    if (!rec) throw new Error("ALIAS_NOT_FOUND_IN_DIRECTORY");
    const full = norm(rec.name || rec.employee || rec.fullname || "");
    const alias = deriveAliasFromFullName(full);
    if (!alias) throw new Error("ALIAS_EMPTY");
    const res = { alias, foundBy: "directory" };
    this._aliasCache.set(key, res);
    return res;
  },

  async resolvePhone({ email }, controller) {
    try {
      const sched = await this.getSchedule(email, 0, controller);
      const raw = sched?.raw || {};
      const byWeek = raw.rowCallMeBot || raw.rowPhone || raw.phone || raw.contact || null;
      if (byWeek) return String(byWeek).trim();
    } catch {}
    try {
      const d = await this.getDirectory(controller);
      const rec = (d?.directory || d?.employees || []).find(r => (r.email || "").toLowerCase() === String(email).toLowerCase());
      if (rec?.phone) return String(rec.phone).trim();
    } catch {}
    return null;
  },

  async resolveApiKey({ email }, controller) {
    try {
      const sched = await this.getSchedule(email, 0, controller);
      const raw = sched?.raw || {};
      const byWeek = raw.rowApiKey || raw.apikey || null;
      if (byWeek) return String(byWeek).trim();
    } catch {}
    try {
      const d = await this.getDirectory(controller);
      const rec = (d?.directory || d?.employees || []).find(r => (r.email || "").toLowerCase() === String(email).toLowerCase());
      if (rec?.apiKey) return String(rec.apiKey).trim();
    } catch {}
    return null;
  },

  async sendShift({ targetEmail, action, actor }) {
    const base = CONFIG.BASE_URL;
    const enc = encodeURIComponent;
    let alias = null;
    try { alias = (await this.resolveAlias({ email: targetEmail }))?.alias || null; } catch {}
    const tries = [
      `${base}?action=${action}&target=${enc(targetEmail)}${actor ? `&actor=${enc(actor)}` : ""}`,
      alias ? `${base}?action=${action}&alias=${enc(alias)}${actor ? `&actor=${enc(actor)}` : ""}` : null,
      `${base}?action=${action}&email=${enc(targetEmail)}${actor ? `&actor=${enc(actor)}` : ""}`
    ].filter(Boolean);
    for (const url of tries) {
      try {
        const j = await fetchJSON(url, { ttl: 0 });
        if (j?.ok) return { ok: true, data: j, used: url };
      } catch {}
    }
    return { ok: false, error: "all_variants_failed" };
  },

  async updateShift({ targetEmail, day, newShift, actor }) {
    const base = CONFIG.BASE_URL;
    const enc = encodeURIComponent;
    const day3 = this._dayFix(day);
    const shift = String(newShift || "").replace(/\s+/g, " ").trim();
    let alias = null;
    try { alias = (await this.resolveAlias({ email: targetEmail }))?.alias || null; } catch {}
    const tries = [
      `${base}?action=updateShift&actor=${enc(actor)}&target=${enc(targetEmail)}&day=${enc(day3)}&shift=${enc(shift)}`,
      alias ? `${base}?action=updateShift&actor=${enc(actor)}&alias=${enc(alias)}&day=${enc(day3)}&shift=${enc(shift)}` : null,
      alias ? `${base}?action=updateShiftAPI&actor=${enc(actor)}&alias=${enc(alias)}&day=${enc(day3)}&shift=${enc(shift)}` : null,
      alias ? `${base}?action=updateShiftAPI_v1&actor=${enc(actor)}&alias=${enc(alias)}&day=${enc(day3)}&shift=${enc(shift)}` : null
    ].filter(Boolean);
    for (const url of tries) {
      try {
        const j = await fetchJSON(url, { ttl: 0 });
        if (j?.ok) return { ok: true, data: j, used: url };
      } catch {}
    }
    return { ok: false, error: "all_variants_failed" };
  },

  _dayFix(d) {
    const k = String(d || "").slice(0, 3).toLowerCase();
    const map = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
                  lun: "Mon", mar: "Tue", mié: "Wed", mie: "Wed", jue: "Thu", vie: "Fri", sáb: "Sat", sab: "Sat", dom: "Sun" };
    return map[k] || (String(d || "").slice(0, 3) || "Mon");
  },

  async getSchedule(identifier, offset = 0, controller) {
    const base = CONFIG.BASE_URL;
    const ttl = offset === 0 ? (this.schedTTL0 || 60_000) : (this.schedTTLOld || 300_000);
    const signal = controller?.signal;

    function toMin(s) {
      s = String(s || "").trim().toUpperCase();
      let ap = (s.match(/\b(AM|PM)\b/) || [])[1] || "";
      s = s.replace(/\s*(AM|PM)\s*$/, "");
      let [h, m] = s.split(":"); h = +h; m = +(m || 0);
      if (ap === "AM" && h === 12) h = 0;
      if (ap === "PM" && h !== 12) h += 12;
      return h * 60 + m;
    }
    function _parseHours(cell) {
      if (!cell) return 0;
      const t = String(cell).trim().toUpperCase();
      if (/^(OFF|OFFR|CERRADO|N\/A|APP)$/.test(t)) return 0;
      const core = t.split(/\s+(DONE|READY|SENT|UPDATE|UPDATED)\b/i)[0].trim();
      const clean = core.replace(/\.+\s*$/, "").replace(/[–—]|to/gi, "-").replace(/\s*-\s*/, "-");
      const m = clean.match(/^([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)\s*-\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)$/i);
      if (!m) return 0;
      let a = toMin(m[1]), b = toMin(m[2]);
      if (!/[AP]M/i.test(m[1]) && !/[AP]M/i.test(m[2]) && b < a) b += 720;
      return Math.max(0, b - a) / 60;
    }
    function normalize(j) {
      if (!j) return { ok: false, days: [], total: 0 };
      let daysArr = j.days || j.week?.days || j.schedule || j.rows;
      if (!Array.isArray(daysArr)) {
        const keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        if (keys.some(k => k in j)) {
          daysArr = keys.filter(k => k in j).map(k => ({ name: k, shift: j[k] }));
        }
      }
      const days = Array.isArray(daysArr)
        ? daysArr.map(x => {
            const name = x?.name || x?.day || "";
            const shift = x?.shift ?? x?.text ?? x ?? "";
            const hours = Number(x?.hours ?? 0) || _parseHours(shift);
            return { name, shift, hours };
          })
        : [];
      const total = (typeof j.total === "number") ? j.total : days.reduce((s, r) => s + (Number(r.hours) || 0), 0);
      return { ok: days.length > 0, days, total, rowAlias: j.rowAlias || j.alias || null, weekLabel: j.weekLabel || j.label, raw: j };
    }
    async function fetchN(u) {
      try {
        const raw = await fetchJSON(u, { ttl, signal });
        const n = normalize(raw);
        return { ...n, raw };
      } catch {
        return { ok: false, days: [], total: 0 };
      }
    }

    // 1) por email
    let res = await fetchN(`${base}?action=getSmartSchedule&email=${encodeURIComponent(identifier)}&offset=${offset}`);
    if (res.ok) return res;

    // 2) fallback por alias
    let alias = null;
    try { alias = (await this.resolveAlias({ email: identifier }, controller))?.alias; } catch {}
    if (alias) {
      for (const action of ["getSmartSchedule", "getScheduleByAlias", "getSchedule"]) {
        res = await fetchN(`${base}?action=${action}&alias=${encodeURIComponent(alias)}&offset=${offset}`);
        if (res.ok) return res;
      }
    }
    return res;
  }
};

/* ---------- Alias helpers ---------- */
function deriveAliasFromFullName(full) {
  if (!full) return "";
  full = full.replace(/\s+/g, " ").trim();
  const parts = full.split(" ").filter(p => !/^[A-ZÁÉÍÓÚÜÑ]\.?$/.test(p));
  if (parts.length === 0) return "";
  const JOINERS = new Set(["DE", "DEL", "DE LA", "DE LOS", "DE LAS", "DA", "VON", "VAN", "DI", "DAL"]);
  let last = parts[parts.length - 1];
  const prev = parts[parts.length - 2] || "";
  if (JOINERS.has(prev.toUpperCase())) last = `${prev} ${last}`;
  return last.toUpperCase().replace(/[^A-ZÁÉÍÓÚÜÑ ]/g, "").trim();
}

function buildAliasVariants(fullName) {
  if (!fullName) return [];
  const raw = fullName.replace(/\s+/g, " ").trim();
  const parts = raw.split(" ").filter(p => !/^[A-ZÁÉÍÓÚÜÑ]\.?$/.test(p));
  const first = (parts[0] || "").toUpperCase();
  let last = (parts[parts.length - 1] || "").toUpperCase();
  const JOINERS = new Set(["DE", "DEL", "DE LA", "DE LOS", "DE LAS", "DA", "VON", "VAN", "DI", "DAL"]);
  const prev = (parts[parts.length - 2] || "").toUpperCase();
  if (JOINERS.has(prev)) last = `${prev} ${last}`;
  const fi = first[0] || "";
  const NBSP = "\u00A0";
  const base = [
    last,
    `${fi}. ${last}`,
    `${fi}.${last}`,
    `${fi}${NBSP}.${NBSP}${last}`,
    `${fi}${NBSP}${last}`,
    `${fi} ${last}`,
    `${first} ${last}`,
    parts.join(" ").toUpperCase()
  ];
  return Array.from(new Set(base.filter(Boolean).map(s => s.trim())));
}

async function getAliasCandidates(targetEmail) {
  const [sched, dirRec] = await Promise.all([
    API.getSchedule(targetEmail, 0).catch(() => ({})),
    (async () => {
      try {
        const d = await API.getDirectory();
        const list = d?.directory || d?.employees || [];
        return list.find(r => (r.email || "").toLowerCase() === String(targetEmail).toLowerCase()) || null;
      } catch { return null; }
    })()
  ]);
  const set = new Set();
  if (sched?.rowAlias) set.add(String(sched.rowAlias).trim());
  if (dirRec?.name) buildAliasVariants(dirRec.name).forEach(a => set.add(a));
  if (dirRec?.name) {
    const last = (dirRec.name.split(" ").pop() || "").toUpperCase();
    if (last) set.add(last);
  }
  return Array.from(set).filter(Boolean);
}

async function getDirRecordByEmail(email) {
  try {
    const d = await API.getDirectory();
    const list = d?.directory || d?.employees || [];
    return list.find(r => (r.email || "").toLowerCase() === String(email).toLowerCase()) || null;
  } catch { return null;
