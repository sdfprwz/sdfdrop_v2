/**
 * sdfdrop — signaling + relay server
 * - Serves ./public
 * - WebSocket signaling at /ws
 * - Auto-groups peers on same WiFi by public IP (local discovery)
 * - Room codes for internet / relay sharing
 * - Forwards WebRTC signal messages + WS relay fallback chunks
 * - No files stored. No database.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { randomUUID: uuidv4 } = require('crypto'); // built-in: no ESM-only uuid package

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// ---- TURN / STUN config (env-overridable, served via /config) ----
function iceServers() {
  // Free defaults that work without signup. Override on Render if you have your own.
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
  // Open Relay (metered.ca) free TURN — helps NAT / different-network P2P.
  // Override with TURN_URLS / TURN_USER / TURN_PASS env vars.
  const turnUrls = (process.env.TURN_URLS || 'turn:openrelay.metered.ca:80,turn:openrelay.metered.ca:443').split(',').map(s => s.trim()).filter(Boolean);
  const turnUser = process.env.TURN_USER || 'openrelay';
  const turnPass = process.env.TURN_PASS || 'openrelay';
  if (turnUrls.length) {
    servers.push({ urls: turnUrls, username: turnUser, credential: turnPass });
  }
  if (process.env.TURN_URLS_EXTRA) {
    servers.push({
      urls: process.env.TURN_URLS_EXTRA.split(',').map(s => s.trim()),
      username: process.env.TURN_USER_EXTRA || turnUser,
      credential: process.env.TURN_PASS_EXTRA || turnPass,
    });
  }
  return servers;
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// Minimal hardening headers (no extra dependency).
// Note: CSP has no 'unsafe-inline' scripts — keep all JS in external files.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src blob: data:; connect-src 'self' wss: ws: https:; " +
    "font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
  next();
});
app.use(express.json({ limit: '1mb' }));

// static frontend
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'sdfdrop', time: new Date().toISOString() }));
app.get('/config', (_req, res) => {
  res.json({
    service: 'sdfdrop',
    wsPath: '/ws',
    iceServers: iceServers(),
    maxRelayChunk: 64 * 1024,
    relayMaxBytes: RELAY_MAX_BYTES,
  });
});
app.get('/stats', (req, res) => {
  // Detailed counts are gated: direct same-machine/LAN or ?token=ADMIN_TOKEN.
  // NOTE: must exclude proxied requests — on Render the socket IP is the
  // proxy's internal (private) address, so "private socket" alone is NOT local.
  const sock = normIp(req.socket?.remoteAddress || '');
  const proxied = !!(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip']);
  const local = !proxied && (isLoopback(sock) || isPrivateIPv4(sock) ||
    sock.startsWith('fc') || sock.startsWith('fd') || sock.startsWith('fe80'));
  const tokenOk = ADMIN_TOKEN && req.query.token === ADMIN_TOKEN;
  if (local || tokenOk) {
    return res.json({ peers: peers.size, rooms: rooms.size, uptime: process.uptime() });
  }
  res.json({ ok: true, service: 'sdfdrop', uptime: Math.floor(process.uptime()) });
});
// Debug helper for "why can't I see my other device?" — shows YOUR grouping keys.
// Open https://your-app.onrender.com/debug on both devices: same WiFi should share ≥1 key.
app.get('/debug', (req, res) => {
  const raw = getIp(req);
  const ip = normIp(raw);
  res.json({
    ipHash: shortHash(ip),
    keys: localKeysFor(rawIpSafe(raw)).map(k => ({ key: k, hash: shortHash(k) })),
    hint: 'Compare "hashes" on both devices. Same WiFi must share at least one key hash. If not, the app also matches a private-LAN hint (see lanHint) or just use a Room code.',
    lanHint: 'If ?lan=192.168.1.0/24 is passed, its hash is shown so you can compare the WebRTC-derived subnet on both devices.',
    lanHash: typeof req.query.lan === 'string' && lanKeyFor(req.query.lan) ? shortHash(lanKeyFor(req.query.lan)) : null,
    trustProxy: true,
  });
  function rawIpSafe(v) { return v; }
});

// SPA fallback (keep /health /config /stats working)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/ws') || req.path.startsWith('/health') || req.path.startsWith('/config') || req.path.startsWith('/stats')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });

// peerId -> { ws, id, name, avatar, color, ip, localKeys, rooms:Set, ua, connectedAt, clientId, alive, msgStamps }
const peers = new Map();
// roomCode -> Set<peerId>
const rooms = new Map();

// ---- abuse guards (lightweight, in-memory; tuned for small Render instances) ----
const MAX_CONN_PER_IP = parseInt(process.env.MAX_CONN_PER_IP || '5', 10);
const MSG_WINDOW_MS = 10_000;
const MSG_MAX_PER_WINDOW = parseInt(process.env.MSG_MAX_PER_WINDOW || '60', 10);
const MAX_ROOMS_PER_PEER = 3;
// WS-relay cap per file (default 2GB = effectively unlimited for browser
// transfers; the relay streams chunk-by-chunk without storing the file).
// WebRTC P2P path was never capped. Override with RELAY_MAX_BYTES env.
const RELAY_MAX_BYTES = parseInt(process.env.RELAY_MAX_BYTES || String(2 * 1024 * 1024 * 1024), 10);
const TEXT_MAX_LEN = 8192;
const SIGNAL_MAX_JSON = 20 * 1024;
const RELAY_CHUNK_MAX = 100 * 1024; // base64 chars per chunk message
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PEER_ID_RE = /^[0-9a-f-]{8,36}$/i;
const TRANSFER_ID_RE = /^[0-9a-f]{1,16}$/i;
const RELAY_KINDS = new Set(['file-header', 'file-chunk', 'file-done', 'file-cancelled', 'text', 'accept', 'decline']);
const MAX_ROOM_SIZE = 100; // classroom scale; larger rooms get politely refused
const MAX_ACTIVE_SENDS_PER_PEER = 5; // bounds blind-chunk spam: chunks need a prior header
const SESSION_TTL_MS = 15 * 60 * 1000;
const ipConns = new Map(); // ip -> active WS count
// Relay/broadcast transfer sessions: key `${fromId}:${toOrRoom}:${transferId}`
// -> { t, size, bytes, nextSeq }. Keeping byte/sequence state server-side
// prevents a valid header from being used to stream unbounded relay data.
const relaySessions = new Map();
function sessionKey(from, target, tid) { return `${from}:${target}:${tid}`; }
function senderSessionCount(from) {
  let n = 0;
  for (const k of relaySessions.keys()) if (k.startsWith(from + ':')) n++;
  return n;
}
function b64DecodedLength(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return -1;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, (s.length * 3) / 4 - pad);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, session] of relaySessions) {
    if (now - session.t > SESSION_TTL_MS) relaySessions.delete(k);
  }
}, 5 * 60 * 1000);

function getIp(req) {
  // Proxy-set headers first (a well-behaved proxy overwrites these).
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/^\[|\]$/g, '') : null);
  const direct = pick(req.headers['cf-connecting-ip']) || pick(req.headers['x-real-ip']);
  if (direct) {
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(direct)) return direct.slice(0, direct.lastIndexOf(':'));
    return direct;
  }
  const fwd = pick(req.headers['x-forwarded-for']);
  if (fwd) {
    // Render documents the real client IP as the FIRST X-Forwarded-For
    // entry. Later entries are proxy hops; using the last entry would group
    // unrelated users together behind the same proxy and break rate limits.
    const parts = fwd.split(',').map(s => s.trim().replace(/^\[|\]$/g, '')).filter(Boolean);
    const first = parts[0];
    if (first) {
      if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(first)) return first.slice(0, first.lastIndexOf(':'));
      return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Normalize IPv4-mapped IPv6 + strip zone id (%eth0) for grouping
function normIp(ip) {
  if (!ip) return 'unknown';
  ip = String(ip).trim().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip.toLowerCase();
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isPrivateIPv4(ip) {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

function ipv4_24(ip) {
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0/24` : ip;
}

// First 4 hextets = /64 (same LAN even when each device has its own global IPv6)
function ipv6_64(ip) {
  const noPort = ip.split('%')[0];
  // expand :: shorthand enough to get prefix
  const halves = noPort.split('::');
  let head = (halves[0] || '').split(':').filter(Boolean);
  let tail = (halves[1] || '').split(':').filter(Boolean);
  // pad head to 4 groups for prefix
  while (head.length < 4 && tail.length > 0) { head.push('0'); }
  const prefix = head.slice(0, 4).join(':').toLowerCase() || 'unknown6';
  return prefix + '/64';
}

function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Client-reported private-LAN hint (e.g. "192.168.1.0/24") obtained from
// WebRTC host ICE candidates. This fixes same-WiFi discovery when the two
// devices exit via different public IPs (IPv4-vs-IPv6, CGNAT pools, iCloud
// Private Relay, VPN on one side). Strictly validated: private ranges only,
// so it can never widen visibility beyond a LAN the device is actually on.
function lanKeyFor(hint) {
  if (typeof hint !== 'string') return null;
  const h = hint.trim().toLowerCase();
  let m = h.match(/^(10\.\d+\.\d+\.0\/24|192\.168\.\d+\.0\/24|172\.(1[6-9]|2\d|3[01])\.\d+\.0\/24)$/);
  if (m) return 'local:lan4:' + m[1];
  m = h.match(/^([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){0,3})\/64$/);
  if (m && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))) {
    return 'local:lan6:' + h;
  }
  return null;
}

// A device gets MULTIPLE grouping keys so same-WiFi matches even with
// IPv4-vs-IPv6 differences, private LANs, and Render proxy quirks.
function localKeysFor(rawIp) {
  const ip = normIp(rawIp);
  if (ip === 'unknown') return ['local:unknown'];
  if (isLoopback(ip)) return ['local:loopback']; // all localhost tabs together
  const keys = [];
  if (ip.includes('.') && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    keys.push('local:v4:' + ip); // exact public IPv4 (same WiFi behind NAT)
    keys.push('local:v4net:' + ipv4_24(ip)); // /24 covers private LAN 192.168.1.x
    if (isPrivateIPv4(ip)) keys.push('local:private-v4:' + ipv4_24(ip));
  } else if (ip.includes(':')) {
    keys.push('local:v6:' + ip);
    keys.push('local:v6net:' + ipv6_64(ip)); // same WiFi, different global IPv6
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) {
      keys.push('local:private-v6:' + ipv6_64(ip));
    }
  } else {
    keys.push('local:' + ip);
  }
  return [...new Set(keys)];
}

function isSameNetwork(a, b) {
  if (!a || !b) return false;
  if (a.localKeys && b.localKeys) {
    for (const k of a.localKeys) if (b.localKeys.has(k)) return true;
  }
  // Private-LAN hint match (WebRTC host candidates): same WiFi even when
  // public exit IPs differ. Both sides must report the identical subnet.
  if (a.lanKeys && b.lanKeys && a.lanKeys.size && b.lanKeys.size) {
    for (const k of a.lanKeys) if (b.lanKeys.has(k)) return true;
  }
  // Self-host bridge: a localhost tab IS the host machine, so it shares the
  // LAN with private-network devices connecting to it (e.g. PC on
  // http://localhost:3000 + phone on http://192.168.1.10:3000).
  // Never applies on Render/cloud (no client socket is loopback there).
  const loopPrivate = (x, y) =>
    x.localKeys.has('local:loopback') &&
    [...y.localKeys].some(k => k.startsWith('local:private-'));
  if (loopPrivate(a, b) || loopPrivate(b, a)) return true;
  return false;
}

function joinRoom(peerId, code) {
  code = String(code || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return null;
  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(peerId);
  const p = peers.get(peerId);
  if (p) p.rooms.add(code);
  return code;
}

function roomFull(code) {
  const set = rooms.get(code);
  return !!set && set.size >= MAX_ROOM_SIZE;
}

function leaveRoom(peerId, code) {
  code = String(code || '').toUpperCase().trim();
  const set = rooms.get(code);
  if (set) {
    set.delete(peerId);
    if (set.size === 0) rooms.delete(code);
  }
  const p = peers.get(peerId);
  if (p) p.rooms.delete(code);
}

function visiblePeersFor(peerId) {
  const me = peers.get(peerId);
  if (!me) return [];
  const out = [];
  for (const [id, p] of peers) {
    if (id === peerId) continue;
    const sameLocal = isSameNetwork(p, me);
    let sharedRoom = null;
    for (const r of me.rooms) {
      if (p.rooms.has(r)) { sharedRoom = r; break; }
    }
    if (sameLocal || sharedRoom) {
      out.push({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
        mode: sameLocal && sharedRoom ? 'both' : sameLocal ? 'local' : 'room',
        room: sharedRoom,
      });
    }
  }
  return out;
}

// Notify everyone whose view may have changed: same network (incl. LAN hint)
// + members of given rooms
function broadcastPeerLists(changedPeerId) {
  const changed = peers.get(changedPeerId);
  if (!changed) return;
  const affectedRooms = [...changed.rooms];

  for (const [id, p] of peers) {
    if (p.ws.readyState !== 1) continue;
    const sameNet = isSameNetwork(p, changed);
    let sharesRoom = id === changedPeerId;
    for (const r of affectedRooms) {
      if (p.rooms.has(r)) { sharesRoom = true; break; }
    }
    if (sameNet || sharesRoom) {
      try {
        p.ws.send(JSON.stringify({ type: 'peers', peers: visiblePeersFor(id), you: { id: p.id } }));
      } catch { /* ignore */ }
    }
  }
}

function broadcastAll() {
  for (const [id, p] of peers) {
    if (p.ws.readyState !== 1) continue;
    try {
      p.ws.send(JSON.stringify({ type: 'peers', peers: visiblePeersFor(id), you: { id: p.id } }));
    } catch { /* ignore */ }
  }
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// Same-origin WS is always fine (covers LAN-IP + Render domain automatically).
// Cross-origin is only allowed for explicitly configured frontends (e.g. GitHub Pages).
// Missing/null origin = non-browser client or file:// dev, allowed.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  let o;
  try { o = new URL(origin); } catch { return false; }
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const oh = o.hostname.toLowerCase();
  if (oh && oh === host) return true;
  if (oh === 'localhost' || oh === '127.0.0.1' || oh === '::1') return true;
  if (ALLOWED_ORIGINS.includes(oh) || ALLOWED_ORIGINS.includes(o.origin.toLowerCase())) return true;
  return false;
}

function rateLimited(peer) {
  const now = Date.now();
  peer.msgStamps = (peer.msgStamps || []).filter(t => now - t < MSG_WINDOW_MS);
  peer.msgStamps.push(now);
  return peer.msgStamps.length > MSG_MAX_PER_WINDOW;
}

wss.on('connection', (ws, req) => {
  if (!originAllowed(req)) {
    try { ws.close(4403, 'origin not allowed'); } catch {}
    return;
  }
  const rawIp = getIp(req);
  const ip = normIp(rawIp);
  const cur = (ipConns.get(ip) || 0) + 1;
  if (cur > MAX_CONN_PER_IP) {
    try { ws.close(4408, 'too many connections'); } catch {}
    return;
  }
  ipConns.set(ip, cur);
  const localKeys = new Set(localKeysFor(ip));
  const id = uuidv4(); // full 128-bit id (8-char prefixes were enumerable)
  const ua = req.headers['user-agent'] || '';

  const peer = {
    ws, id, ip, localKeys,
    lanKeys: new Set(),
    name: 'Anonymous',
    avatar: '📦',
    color: '#6366f1',
    rooms: new Set(),
    ua: String(ua).slice(0, 256),
    connectedAt: Date.now(),
    clientId: '',
    alive: true,
    msgStamps: [],
  };
  peers.set(id, peer);
  console.log(`[+] ${id} ip=${ip} keys=${[...localKeys].join(',')} total=${peers.size}`);

  // Welcome immediately so client knows its id + network group (for "why can't I see anyone?" diagnostics)
  send(ws, {
    type: 'welcome', id,
    network: { group: shortHash([...localKeys].sort().join('|')), keys: localKeys.size },
    iceServers: iceServers(),
  });

  // Parse ?room=CODE from URL for instant join
  try {
    const url = new URL(req.url, 'http://localhost');
    const qRoom = (url.searchParams.get('room') || '').toUpperCase().trim();
    if (/^[A-Z0-9]{4,12}$/.test(qRoom)) joinRoom(id, qRoom);
  } catch { /* ignore */ }

  let alive = true;
  ws.on('pong', () => { alive = true; peer.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    // File chunks are size-capped and session-gated (header first), so they
    // get their own budget — otherwise any relayed file >~3MB trips the chat
    // rate limit. Everything else (headers, text, signals) is rate-counted.
    const isChunk = (msg.type === 'relay' || msg.type === 'broadcast') &&
      msg.data && typeof msg.data === 'object' && msg.data.kind === 'file-chunk';
    if (!isChunk && rateLimited(peer)) {
      send(ws, { type: 'error', message: 'Rate limited — slow down.' });
      try { ws.close(4429, 'rate limited'); } catch {}
      return;
    }

    switch (msg.type) {
      case 'hello':
      case 'update': {
        if (typeof msg.name === 'string' && msg.name.trim()) peer.name = msg.name.trim().slice(0, 24);
        if (typeof msg.avatar === 'string' && msg.avatar) peer.avatar = [...msg.avatar].slice(0, 4).join('');
        if (typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)) peer.color = msg.color;
        if (typeof msg.clientId === 'string') peer.clientId = msg.clientId.slice(0, 64);
        // Private-LAN subnet hint from WebRTC host candidates (same-WiFi
        // matching when public IPs differ). Re-sent periodically by client.
        if (typeof msg.lanSubnet === 'string') {
          const lk = lanKeyFor(msg.lanSubnet);
          if (lk) {
            const before = peer.lanKeys.has(lk) ? peer.lanKeys.size : -1;
            peer.lanKeys = new Set([lk]);
            if (before !== 1) {
              setTimeout(() => broadcastPeerLists(id), 10);
            }
          }
        }
        if (typeof msg.room === 'string' && /^[A-Z0-9]{4,12}$/i.test(msg.room.trim())) {
          if (peer.rooms.size >= MAX_ROOMS_PER_PEER && !peer.rooms.has(msg.room.trim().toUpperCase())) {
            send(ws, { type: 'error', message: 'Room limit reached.' });
          } else if (roomFull(msg.room.trim().toUpperCase()) && !peer.rooms.has(msg.room.trim().toUpperCase())) {
            send(ws, { type: 'error', message: 'Room is full (100 max).' });
          } else {
            joinRoom(id, msg.room.trim());
            send(ws, { type: 'room-joined', room: msg.room.trim().toUpperCase() });
          }
        }
        broadcastPeerLists(id);
        break;
      }
      case 'join': {
        if (peer.rooms.size >= MAX_ROOMS_PER_PEER && !peer.rooms.has(String(msg.room || '').toUpperCase().trim())) {
          send(ws, { type: 'error', message: 'Room limit reached.' });
          break;
        }
        const want = String(msg.room || '').toUpperCase().trim();
        if (/^[A-Z0-9]{4,12}$/.test(want) && roomFull(want) && !peer.rooms.has(want)) {
          send(ws, { type: 'error', message: 'Room is full (100 max).' });
          break;
        }
        const code = joinRoom(id, msg.room);
        if (!code) { send(ws, { type: 'error', message: 'Invalid room code. Use 4–12 letters/numbers.' }); break; }
        send(ws, { type: 'room-joined', room: code });
        broadcastPeerLists(id);
        break;
      }
      case 'leave': {
        leaveRoom(id, msg.room);
        send(ws, { type: 'room-left', room: String(msg.room || '').toUpperCase() });
        broadcastPeerLists(id);
        break;
      }
      case 'signal': {
        if (typeof msg.to !== 'string' || !PEER_ID_RE.test(msg.to)) { send(ws, { type: 'error', message: 'Bad peer id' }); break; }
        if (!msg.data || typeof msg.data !== 'object') { send(ws, { type: 'error', message: 'Bad signal' }); break; }
        let size = 0;
        try { size = JSON.stringify(msg.data).length; } catch { send(ws, { type: 'error', message: 'Bad signal' }); break; }
        if (size > SIGNAL_MAX_JSON) { send(ws, { type: 'error', message: 'Signal too large' }); break; }
        const target = peers.get(msg.to);
        if (!target) { send(ws, { type: 'error', message: 'Peer offline' }); break; }
        // Only allow signaling to visible peers (privacy)
        const visible = visiblePeersFor(id).some(p => p.id === msg.to);
        if (!visible) { send(ws, { type: 'error', message: 'Peer not visible' }); break; }
        send(target.ws, { type: 'signal', from: id, data: msg.data });
        break;
      }
      case 'relay': {
        // Fallback transfer path when WebRTC P2P fails (symmetric NAT, VPN, etc.)
        if (typeof msg.to !== 'string' || !PEER_ID_RE.test(msg.to)) { send(ws, { type: 'error', message: 'Bad peer id' }); break; }
        const d = msg.data;
        if (!d || typeof d !== 'object' || typeof d.kind !== 'string' || !RELAY_KINDS.has(d.kind)) {
          send(ws, { type: 'error', message: 'Bad relay payload' }); break;
        }
        if (typeof d.id !== 'string' || !TRANSFER_ID_RE.test(d.id)) { send(ws, { type: 'error', message: 'Bad transfer id' }); break; }
        if (d.kind === 'text') {
          if (typeof d.text !== 'string' || d.text.length === 0 || d.text.length > TEXT_MAX_LEN) {
            send(ws, { type: 'error', message: 'Text too long (8KB max)' }); break;
          }
        } else if (d.kind === 'file-header') {
          if (typeof d.name !== 'string' || d.name.length === 0 || d.name.length > 255 ||
              typeof d.size !== 'number' || !(d.size >= 0) || d.size > RELAY_MAX_BYTES) {
            send(ws, { type: 'error', message: 'File too large for relay' }); break;
          }
        } else if (d.kind === 'file-chunk') {
          if (typeof d.chunk !== 'string' || d.chunk.length === 0 || d.chunk.length > RELAY_CHUNK_MAX) {
            send(ws, { type: 'error', message: 'Chunk too large' }); break;
          }
          if (d.seq !== undefined && (!Number.isInteger(d.seq) || d.seq < 0)) {
            send(ws, { type: 'error', message: 'Bad chunk sequence' }); break;
          }
        }
        const target = peers.get(msg.to);
        if (!target) { send(ws, { type: 'error', message: 'Peer offline' }); break; }
        const visible = visiblePeersFor(id).some(p => p.id === msg.to);
        if (!visible) { send(ws, { type: 'error', message: 'Peer not visible' }); break; }
        // Session gate: file chunks/done/cancel need a prior header (bounds blind spam).
        const skey = sessionKey(id, msg.to, d.id);
        if (d.kind === 'file-header') {
          if (senderSessionCount(id) >= MAX_ACTIVE_SENDS_PER_PEER && !relaySessions.has(skey)) {
            send(ws, { type: 'error', message: 'Too many active sends.' }); break;
          }
          relaySessions.set(skey, { t: Date.now(), size: d.size, bytes: 0, nextSeq: 0 });
        } else if (d.kind === 'file-chunk' || d.kind === 'file-done' || d.kind === 'file-cancelled') {
          const session = relaySessions.get(skey);
          if (!session) { send(ws, { type: 'error', message: 'Unknown transfer' }); break; }
          session.t = Date.now();
          if (d.kind === 'file-chunk') {
            const n = b64DecodedLength(d.chunk);
            if (n <= 0 || session.bytes + n > session.size ||
                (d.seq !== undefined && d.seq !== session.nextSeq)) {
              send(ws, { type: 'error', message: 'Invalid file chunk' }); break;
            }
            session.bytes += n;
            session.nextSeq++;
          } else if (d.kind === 'file-done') {
            if (session.bytes !== session.size) {
              send(ws, { type: 'error', message: 'Incomplete transfer' }); break;
            }
            relaySessions.delete(skey);
          } else {
            relaySessions.delete(skey);
          }
        }
        send(target.ws, { type: 'relay', from: id, data: msg.data });
        break;
      }
      case 'broadcast': {
        // Classroom fan-out: one upload from the sender, server forwards each
        // message to every member of the room (sender excluded). Scoped to
        // that room only — outsiders get nothing.
        const room = String(msg.room || '').toUpperCase().trim();
        if (!/^[A-Z0-9]{4,12}$/.test(room)) { send(ws, { type: 'error', message: 'Bad room code' }); break; }
        if (!peer.rooms.has(room)) { send(ws, { type: 'error', message: 'Join the room first' }); break; }
        const d = msg.data;
        if (!d || typeof d !== 'object' || typeof d.kind !== 'string' || !RELAY_KINDS.has(d.kind)) {
          send(ws, { type: 'error', message: 'Bad broadcast payload' }); break;
        }
        if (['accept', 'decline'].includes(d.kind)) { send(ws, { type: 'error', message: 'Bad broadcast payload' }); break; }
        if (typeof d.id !== 'string' || !TRANSFER_ID_RE.test(d.id)) { send(ws, { type: 'error', message: 'Bad transfer id' }); break; }
        if (d.kind === 'text') {
          if (typeof d.text !== 'string' || d.text.length === 0 || d.text.length > TEXT_MAX_LEN) {
            send(ws, { type: 'error', message: 'Text too long (8KB max)' }); break;
          }
        } else if (d.kind === 'file-header') {
          if (typeof d.name !== 'string' || d.name.length === 0 || d.name.length > 255 ||
              typeof d.size !== 'number' || !(d.size >= 0) || d.size > RELAY_MAX_BYTES) {
            send(ws, { type: 'error', message: 'File too large for broadcast' }); break;
          }
        } else if (d.kind === 'file-chunk') {
          if (typeof d.chunk !== 'string' || d.chunk.length === 0 || d.chunk.length > RELAY_CHUNK_MAX) {
            send(ws, { type: 'error', message: 'Chunk too large' }); break;
          }
          if (d.seq !== undefined && (!Number.isInteger(d.seq) || d.seq < 0)) {
            send(ws, { type: 'error', message: 'Bad chunk sequence' }); break;
          }
        }
        const skey = sessionKey(id, 'ROOM:' + room, d.id);
        if (d.kind === 'file-header') {
          if (senderSessionCount(id) >= MAX_ACTIVE_SENDS_PER_PEER && !relaySessions.has(skey)) {
            send(ws, { type: 'error', message: 'Too many active sends.' }); break;
          }
          relaySessions.set(skey, { t: Date.now(), size: d.size, bytes: 0, nextSeq: 0 });
        } else if (d.kind === 'file-chunk' || d.kind === 'file-done' || d.kind === 'file-cancelled') {
          const session = relaySessions.get(skey);
          if (!session) { send(ws, { type: 'error', message: 'Unknown transfer' }); break; }
          session.t = Date.now();
          if (d.kind === 'file-chunk') {
            const n = b64DecodedLength(d.chunk);
            if (n <= 0 || session.bytes + n > session.size ||
                (d.seq !== undefined && d.seq !== session.nextSeq)) {
              send(ws, { type: 'error', message: 'Invalid file chunk' }); break;
            }
            session.bytes += n;
            session.nextSeq++;
          } else if (d.kind === 'file-done') {
            if (session.bytes !== session.size) {
              send(ws, { type: 'error', message: 'Incomplete transfer' }); break;
            }
            relaySessions.delete(skey);
          } else {
            relaySessions.delete(skey);
          }
        }
        const members = rooms.get(room);
        let recipients = 0;
        if (members) {
          const out = { type: 'relay', from: id, data: Object.assign({}, d, { room }) };
          const payload = JSON.stringify(out);
          for (const mid of members) {
            if (mid === id) continue;
            const m = peers.get(mid);
            if (m && m.ws.readyState === 1) {
              try { m.ws.send(payload); recipients++; } catch {}
            }
          }
        }
        send(ws, { type: 'broadcast-sent', room, id: d.id, kind: d.kind, recipients });
        break;
      }
      case 'ping': {
        send(ws, { type: 'pong' });
        break;
      }
      case 'rescan': {
        // Client asked for a fresh radar: reply directly + poke same-net
        // peers so both sides converge even if a broadcast was missed.
        send(ws, { type: 'peers', peers: visiblePeersFor(id), you: { id } });
        broadcastPeerLists(id);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    const leftRooms = [...peer.rooms];
    for (const r of leftRooms) leaveRoom(id, r);
    peers.delete(id);
    ipConns.set(ip, Math.max(0, (ipConns.get(ip) || 1) - 1));
    for (const k of [...relaySessions.keys()]) if (k.startsWith(id + ':')) relaySessions.delete(k);
    console.log(`[-] ${id} total=${peers.size}`);
    // Notify anyone who could have seen this peer (same network or shared rooms).
    // Peer object is gone, so match by saved keys/rooms instead of isSameNetwork().
    for (const [otherId, p] of peers) {
      if (p.ws.readyState !== 1) continue;
      let should = false;
      for (const k of peer.localKeys) {
        if (p.localKeys.has(k)) { should = true; break; }
      }
      if (!should && peer.lanKeys && p.lanKeys) {
        for (const k of peer.lanKeys) {
          if (p.lanKeys.has(k)) { should = true; break; }
        }
      }
      if (!should) {
        for (const r of leftRooms) {
          if (p.rooms.has(r)) { should = true; break; }
        }
      }
      // If leaver had no rooms, it was local-only: refresh same-network peers.
      if (!should && leftRooms.length === 0) {
        for (const k of peer.localKeys) {
          if (p.localKeys.has(k)) { should = true; break; }
        }
      }
      if (should) {
        try { p.ws.send(JSON.stringify({ type: 'peers', peers: visiblePeersFor(otherId) })); } catch {}
      }
    }
  });

  // initial list
  setTimeout(() => {
    send(ws, { type: 'peers', peers: visiblePeersFor(id), you: { id } });
    // refresh same-network peers so newcomer appears instantly
    broadcastPeerLists(id);
  }, 50);
});

// heartbeat (ws protocol ping; browsers auto-reply with pong).
// NOTE: must set peer.alive — not a closure var — or everyone gets
// terminated after ~60s (the "disconnects on its own" bug).
setInterval(() => {
  for (const [id, p] of peers) {
    if (p.ws.readyState !== 1) { peers.delete(id); continue; }
    if (p.alive === false) {
      try { p.ws.terminate(); } catch {}
      peers.delete(id);
      console.log(`[!] heartbeat-timeout ${id}`);
      broadcastAll();
      continue;
    }
    p.alive = false;
    try { p.ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`[sdfdrop] listening on :${PORT} ${PUBLIC_URL ? '(' + PUBLIC_URL + ')' : ''}`);
});
