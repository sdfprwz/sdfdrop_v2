/* Self-referencing canonical + structured-data URLs.
 * The same static shell is served from more than one host (Render, Vercel),
 * so absolute URLs baked into index.html would point every copy at one host
 * and make the others look like duplicates. The canonical tag uses "/" as a
 * no-JS fallback; this upgrades it to the absolute URL of the host serving
 * the page. Runs in <head> before first paint; CSP allows same-origin scripts.
 */
(function () {
  if (!/^https?:$/.test(location.protocol)) return;
  var host = location.hostname;
  // Dev/LAN hosts are never indexed — leave their metadata alone.
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return;

  var origin = location.origin + '/';

  var canonical = document.getElementById('canonicalLink');
  if (canonical) canonical.setAttribute('href', origin);

  var ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute('content', origin);

  var ld = document.getElementById('appLd');
  if (ld) {
    try {
      var data = JSON.parse(ld.textContent);
      data.url = origin;
      ld.textContent = JSON.stringify(data);
    } catch (e) { /* keep the static JSON-LD */ }
  }
})();
