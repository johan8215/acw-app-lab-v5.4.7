# ACW‑App v5.6.3 Turbo — Blue Glass White Connected

Allston Car Wash — JAG15 & Sky — © 2025

## 🚀 Demo local rápida
1. Descomprime el ZIP.
2. (Opcional) Lanza un server estático:
   - **Node**: `npx serve -p 5173 .`
   - **Python**: `python -m http.server 5173`
3. Abre `http://localhost:5173`.
4. Edita `config.js` si necesitas cambiar `BASE_URL` (GAS Web App).

> Para PWA, el Service Worker funciona en `https://` o `http://localhost`.

## 🔌 Endpoints esperados (GAS)
- `login&email&password` → `{ ok, name, email, role }`
- `getSmartSchedule&email&offset` → `{ ok, days:[{name,shift,hours}], total, weekLabel }`
- `getEmployeesDirectory` → `{ ok, directory:[{name,email,phone,role}] }`
- `updateShift&actor&target&day&shift` → `{ ok:true }`
- `changePassword&email&oldPass&newPass` → `{ ok:true }`
- `sendtoday|sendtomorrow&actor&target` → `{ ok:true, sent:{name,shift,mode} }`

## 🧰 Tips
- Cambia `CONFIG.VERSION` en `config.js` para forzar limpieza de caché.
- Team View solo aparece para roles `manager` o `supervisor`.
