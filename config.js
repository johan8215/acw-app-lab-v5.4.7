// ACW-App Config v5.6.4 — Blue Glass White Clean
const CONFIG = {
  BASE_URL: "https://script.google.com/macros/s/AKfycbx-6DqfjydMMGp-K2z8FeBSH9t8Z1Ooa0Ene0u917RK7Eo6vu80aOTLmCf7lJtm-Ckh/exec".trim(),
  VERSION: "v5.6.4 — Blue Glass White Clean",
  WEEKLY_ID: "1HjPzkLLts7NlCou_94QSqwXezizc8MGQfob24RTdE9A"
};
window.CONFIG = CONFIG;
setTimeout(() => {
  console.log(`✅ ACW-App connected → ${CONFIG.VERSION}`);
  console.log(`🌐 Backend: ${CONFIG.BASE_URL}`);
}, 100);
