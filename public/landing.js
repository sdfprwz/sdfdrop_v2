/* sdfdrop landing <-> app toggle (external file: CSP has no 'unsafe-inline') */
(() => {
  const landing = document.getElementById('landing');
  const app = document.getElementById('appView');
  if (!landing || !app) return;
  const openButtons = document.querySelectorAll('[data-open-app]');
  function showApp() {
    landing.classList.add('hidden');
    app.classList.remove('hidden');
    document.body.classList.add('app-mode');
    try { history.replaceState(null, '', '#app'); } catch {}
    window.scrollTo(0, 0);
  }
  function showLanding() {
    app.classList.add('hidden');
    landing.classList.remove('hidden');
    document.body.classList.remove('app-mode');
  }
  openButtons.forEach((btn) => btn.addEventListener('click', showApp));
  if (location.hash === '#app') showApp();
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#app') showLanding();
  });
})();
