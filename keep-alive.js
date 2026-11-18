#!/usr/bin/env node
/**
 * sdfdrop keep-alive — pings the hosted service so Render's free tier does not
 * spin down from inactivity. No dependencies (Node 22+ built-in fetch).
 *
 *   npm run keepalive                 # run continuously (default: every 10 min)
 *   node keep-alive.js --once         # single ping, for Task Scheduler / cron
 *
 * Environment:
 *   SDFDROP_URL     health URL to ping (default https://sdfdrop2.onrender.com/health)
 *   SDFDROP_PING_MS interval in ms    (default 600000 = 10 min, minimum 60000)
 */
const TARGET = process.env.SDFDROP_URL || 'https://sdfdrop2.onrender.com/health';
const INTERVAL = Math.max(60_000, parseInt(process.env.SDFDROP_PING_MS || '600000', 10));
const ONCE = process.argv.includes('--once');
const stamp = () => new Date().toISOString();

async function ping() {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(TARGET, {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'sdfdrop-keepalive/1.0' },
    });
    clearTimeout(timer);
    const body = await res.text();
    console.log(`[${stamp()}] ${res.status} ${res.ok ? 'OK' : 'ERR'} ${Date.now() - started}ms ${body.slice(0, 120)}`);
    return res.ok;
  } catch (e) {
    console.log(`[${stamp()}] FAIL ${e && e.message ? e.message : e}`);
    return false;
  }
}

(async () => {
  console.log(`[${stamp()}] keep-alive → ${TARGET} every ${INTERVAL / 60000} min${ONCE ? ' (once)' : ''}`);
  const first = await ping();
  if (ONCE) process.exit(first ? 0 : 1);

  let failures = 0;
  setInterval(async () => {
    const ok = await ping();
    failures = ok ? 0 : failures + 1;
    if (failures >= 3) console.log(`[${stamp()}] warning: ${failures} consecutive failures`);
  }, INTERVAL);

  const stop = () => { console.log(`[${stamp()}] stopped`); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
