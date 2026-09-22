# sdfdrop 💧 — drop it. share it.

Fast browser-to-browser file + text sharing. Best of **Snapdrop** (zero-setup), **PairDrop** (rooms + relay), **AirDrop** (feel) — under your **sdfdrop** branding.

- 📶 **Same WiFi:** open sdfdrop on 2 devices → they appear on each other's radar instantly. No code, no signup.
- 🌐 **Different networks:** join the same **Room code** (e.g. `CLASS1`) or open the shared link → connects via WebRTC + TURN, with WebSocket relay fallback.
- 📢 **Room broadcast (classroom):** a teacher taps **Send to room** — one upload fans out to everyone in that room only. Live accept-count, auto-send, resend for stragglers, 📢 announcements.
- 🔒 **Private:** P2P first (DTLS encrypted), TURN/relay fallback. Server only signals — files are never stored. No database, no accounts.
- ⚡ **Fast:** 16KB DataChannel chunks with backpressure, progress + speed, screen WakeLock for big transfers.
- 📱 **PWA:** installable, dark/light themes, responsive phone → desktop UI.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

**Same WiFi (phone/laptop):** open `http://<your-lan-ip>:3000` (e.g. `http://10.0.163.127:3000` — check `/debug` or `ipconfig` for yours). A `localhost` tab is bridged with private-LAN devices, so the PC can stay on `localhost:3000` while the phone uses the LAN URL. Allow the Windows firewall prompt for Node.js (Private networks).

Quick test: open two tabs → click a peer → send a file → Accept. Room test: join both tabs to `TEST1` → 📢 Send to room from one → Accept popup in the other.

## Host on GitHub + Render

1. **Push to GitHub**
   ```bash
   git init
   git add -A
   git commit -m "sdfdrop"
   git branch -M main
   git remote add origin https://github.com/<you>/sdfdrop.git
   git push -u origin main
   ```

2. **Render (backend + frontend in one service)**
   - New → Web Service → connect your `sdfdrop` repo (or deploy via `render.yaml` blueprint).
   - Build: `npm install` · Start: `npm start` · Health check: `/health`.
   - Open `https://<your-app>.onrender.com` on both devices → same-WiFi auto-discovery works immediately.
   - Free tier sleeps when idle — first load after sleep takes ~30s, then it reconnects by itself.

3. **(Optional) GitHub Pages frontend → Render backend**
   - The frontend auto-detects `github.io` and uses `wss://sdfdrop.onrender.com/ws` — change that URL in `public/app.js` (`getWsUrl()`) to your Render URL, or set `window.SDFDROP_WS_URL` at deploy time.
   - Deploy `/public` to Pages; keep Render running for signaling.

## How it works

```
Device A  ←WebSocket→  sdfdrop server (Render / localhost)  ←WebSocket→  Device B
   │  1. hello + auto WiFi-group (IP keys) and/or Room code               │
   │  2. server sends each device its visible peers list                  │
   │  3. offer/answer/ICE exchanged via server (signaling only)            │
   └══════════════ WebRTC DataChannel (files, E2E encrypted) ═════════════┘
                    ↳ P2P fails? → WS relay chunks via server (fallback)
                    ↳ 📢 Room broadcast? → one upload, server fans out to room
```

- **Discovery:** same WiFi = shared network keys (exact public IPv4 + IPv6 `/64` prefix + private `/24`; `localhost` bridged with private LAN). Plus custom rooms (cap 100 members). Open `/debug` on both devices — matching key hashes means auto-discovery will work.
- **STUN/TURN:** Google STUN + OpenRelay TURN by default. Bring your own via env: `TURN_URLS`, `TURN_USER`, `TURN_PASS` (see `render.yaml`).
- **Endpoints:** `/health` · `/config` · `/stats` (gated) · `/debug` · WebSocket at `/ws`.

## Classroom broadcast

1. Teacher + students join the same room code. Banner shows the live headcount.
2. Teacher → **📢 Send to room** → picks files. Students get an Accept prompt tagged with the room.
3. Teacher watches accepts (`Send now (23/50)`) → **Send now** or 45s auto-send. One upload, everyone gets a copy.
4. **↻ Resend** covers late accepters; ✕ Cancel notifies the room; **📢 Room** in the text box sends announcements.

## Security model & limits

- **Trust:** encryption is end-to-end only if you trust the signaling server (a malicious server could swap SDP offers). Self-host; don't trade sensitive files over random public instances.
- **WebSocket origin policy:** same-origin always allowed (Render domain, LAN IP, localhost). Cross-origin only via `ALLOWED_ORIGINS` (e.g. your `https://<you>.github.io`). No `?ws=` override.
- **Anti-abuse caps (env-tunable):** `MAX_CONN_PER_IP` (5), `MSG_MAX_PER_WINDOW` (60/10s), 3 rooms/peer, relay/broadcast file cap 100MB, text 8KB, chunks ≤100KB, signals ≤20KB, header-before-chunks sessions.
- **Headers:** `nosniff`, `SAMEORIGIN` framing, minimal CSP, HSTS on https, no `X-Powered-By`. No third-party scripts (QR generator vendored in `public/vendor/` — scannable canvas QR, no CDN).
- **Detailed `/stats`** gated to localhost/direct-LAN or `?token=ADMIN_TOKEN`. `/debug` returns hashes only.
- **Large files:** relay >100MB refused (use same-WiFi P2P); transfers have ✕ Cancel; Blob URLs capped/revoked; stale transfers expire after 5 min.
- **PWA:** `sdfdrop-v2` cache, network-first navigations so updates apply.

## Troubleshooting

- **Same WiFi, can't see each other?** Same WiFi *name* on both (2.4 vs 5 GHz can isolate), VPN off. Compare `/debug` hashes on both — no shared hash (IPv6/carrier NAT) → just use a Room code, it always works.
- **Room code mismatch?** Both banners must show the identical code and headcount. The sender's toast tells the truth (`Broadcasting to 0 in X` = nobody in the room).
- **Nothing arrives after Send to room?** Students must tap Accept, then teacher taps Send now (or 45s auto-send).
- **Layout looks broken on phone?** Hard-refresh to drop the cached stylesheet (Ctrl+Shift+R / reload twice on mobile).
- **Render first load slow?** Free tier was asleep — wait ~30s and it connects.

## Project structure

```
sdfdrop/
├── server.js            # signaling + relay + room fan-out (Express + ws)
├── render.yaml          # Render blueprint (health check, env placeholders)
├── package.json
└── public/
    ├── index.html       # sdfdrop UI (radar, rooms, transfers, modals)
    ├── app.js           # WebRTC + relay + broadcast client
    ├── styles.css       # responsive phone → desktop styles
    ├── manifest.webmanifest
    └── sw.js            # PWA shell (v2, network-first pages)
```

MIT — built for sdfdrop.
