/* sdfdrop first-visit tour — external file (CSP has no inline scripts). */
(() => {
  'use strict';
  const KEY = 'sdfdrop-tour-v1';
  const steps = [
    { sel: '#radar', title: 'Your device radar', text: 'Devices on the same Wi‑Fi appear here automatically. Tap one to send files or start a chat.' },
    { sel: '#btnRoom', title: 'Different network?', text: 'Join a room code — or scan a QR — to connect with anyone, anywhere.' },
    { sel: '#btnDevices', title: 'Trust your devices', text: 'Mark a device trusted once and future transfers skip the Accept tap. You can block or remove devices here too.' },
    { sel: '#btnSendFolder', title: 'Send files or folders', text: 'Pick files or a whole folder. You’ll preview everything and confirm before anything leaves your device.' },
    { sel: '#btnText', title: 'Messages chat', text: 'Open 💬 Messages for saved conversations, typing indicators, and quick file sharing.' },
  ];
  const $ = (s) => document.querySelector(s);
  const overlay = $('#tourOverlay'), spot = $('#tourSpot'), tip = $('#tourTip');
  if (!overlay || !spot || !tip) return;
  let idx = 0, active = false;

  function saveDone() { try { localStorage.setItem(KEY, '1'); } catch {} }
  function placeTip(r) {
    if (innerWidth <= 600) { tip.style.left = ''; tip.style.top = ''; return; }
    const pad = 14, w = tip.offsetWidth || 330, h = tip.offsetHeight || 180;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(pad, Math.min(left, innerWidth - w - pad));
    let top = r.bottom + pad;
    if (top + h > innerHeight - pad) top = Math.max(pad, r.top - h - pad);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function show() {
    const s = steps[idx], el = $(s.sel);
    if (!el) { next(); return; }
    $('#tourStep').textContent = `Step ${idx + 1} of ${steps.length}`;
    $('#tourTitle').textContent = s.title;
    $('#tourText').textContent = s.text;
    $('#btnTourBack').disabled = idx === 0;
    $('#btnTourNext').textContent = idx === steps.length - 1 ? 'Finish' : 'Next';
    const r = el.getBoundingClientRect(), pad = 8;
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
    placeTip(r);
  }
  function start() { if (active) return; active = true; idx = 0; overlay.classList.remove('hidden'); show(); }
  function stop() { active = false; overlay.classList.add('hidden'); }
  function next() { idx++; if (idx >= steps.length) { saveDone(); stop(); } else show(); }
  function back() { if (idx > 0) { idx--; show(); } }

  $('#btnTourNext').onclick = next;
  $('#btnTourBack').onclick = back;
  $('#btnTourSkip').onclick = () => { saveDone(); stop(); };
  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); saveDone(); stop(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next(); }
  });
  addEventListener('resize', () => { if (active) show(); });
  addEventListener('scroll', () => { if (active) show(); }, { passive: true });

  function maybeStart() {
    try { if (localStorage.getItem(KEY)) return; } catch {}
    start();
  }
  document.querySelectorAll('[data-open-app]').forEach((b) => b.addEventListener('click', () => setTimeout(maybeStart, 220)));
  if (location.hash === '#app') setTimeout(maybeStart, 500);
  const helpBtn = $('#btnTour');
  if (helpBtn) helpBtn.onclick = () => { $('#helpModal')?.classList.add('hidden'); start(); };
  window.startSdfTour = start;
})();
