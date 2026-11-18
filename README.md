# sdfdrop — drop it. share it.

Fast browser-to-browser file + text sharing. Same-WiFi discovery, room codes for any network, and private device-to-device transfers — under **sdfdrop** branding.

- **Same WiFi:** open sdfdrop on 2 devices → they appear on each other's radar instantly. No code, no signup.
- **Different networks:** join the same **Room code** (e.g. `CLASS1`) or open the shared link → connects via WebRTC + TURN, with WebSocket relay fallback.
- **Room broadcast (classroom):** a teacher taps **Send to room** — one upload fans out to everyone in that room only. Live accept-count, auto-send, resend for stragglers, room announcements.
- **Private:** WebRTC P2P first (DTLS encrypted), direct LAN/host path preferred. TURN, then WebSocket relay as last fallback for 1-to-1 transfers. Server only signals — files are never stored. No database, no accounts.
- **Trusted devices:** mark your own devices once → future transfers auto-accept with no tap. Block or remove any device from the 🔐 Devices panel (list stored locally).
- **Preview & confirm:** picking a file opens a **preview + Send/Cancel** dialog first (images, video, audio, PDF, text) — nothing is transferred until you confirm. Completed transfers also keep a 👁 Preview button.
- **Folders:** 🗂️ **Send folder** uses the browser's real directory picker (or a multi-file + folder-name fallback on mobile), packs a streaming ZIP on the fly, then asks you to confirm before sending. Drag & drop of a folder works too.
- **Fast:** 64KB DataChannel chunks with proper backpressure, larger relay chunks, streaming receive (no base64 concat), progress + speed, screen WakeLock for big transfers.
- **PWA:** installable, dark/light themes, responsive phone → desktop UI.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

**Same WiFi (phone/laptop):** open `http://<your-lan-ip>:3000` (e.g. `http://10.0.163.127:3000` — check `/debug` or `ipconfig` for yours). A `localhost` tab is bridged with private-LAN devices, so the PC can stay on `localhost:3000` while the phone uses the LAN URL. Allow the Windows firewall prompt for Node.js (Private networks).

Quick test: open two tabs → click a peer → send a file → Accept. Room test: join both tabs to `TEST1` → Send to room from one → Accept popup in the other.

## Security updates applied
- Updated Node.js version requirement to `>=22.23.4` (see `package.json` and `.nvmrc`). This includes fixes for recent TLS and Brotli vulnerabilities.
- Ran `npm audit fix` to upgrade vulnerable dependencies (`body-parser` to 1.20.9, `qs` to 6.16.2).
- After deploying, **rebuild/redeploy** your service to refresh the system certificate store, mitigating the eMudhra compromised intermediate certificates. On Render, a fresh deploy pulls the latest OS CA bundle.
- Ensure your Render environment uses the updated Node version (set the Node version in the Render settings or rely on the `engines` field).

## Host on GitHub + Render

1. **Push to GitHub**
   ```bash
   git init
   git add -A
   git commit -m "sdfdrop"
   git branch -M main
   git remote add origin https://github.com/sdfprwz/sdfdrop_v2.git
   git push -u origin main
   ```

2. **Render (backend + frontend in one service)**
   - New → Web Service → connect your `sdfdrop_v2` repo (or deploy via `render.yaml` blueprint).
   - Build: `npm install` · Start: `npm start` · Health check: `/health`.
   - Open `https://<your-app>.onrender.com` on both devices → same-WiFi auto-discovery works immediately.
   - Free tier sleeps when idle — first load after sleep takes ~30s, then it reconnects by itself.

3. **(Optional) GitHub Pages frontend → Render backend**
   - The frontend auto-detects `github.io` and uses `wss://sdfdrop2.onrender.com/ws` — change that URL in `public/app.js` (`getWsUrl()`) to your Render URL, or set `window.SDFDROP_WS_URL` at deploy time.
   - Deploy `/public` to Pages; keep Render running for signaling.

## How it works

```
Device A  ←WebSocket→  sdfdrop server (Render / localhost)  ←WebSocket→  Device B
   │  1. hello + auto WiFi-group (IP keys) and/or Room code               │
   │  2. server sends each device its visible peers list                  │
   │  3. offer/answer/ICE exchanged via server (signaling only)            │
                   └══════════════ WebRTC DataChannel (files, encrypted) ═════════════┘
                     ↳ direct host → srflx/prflx → TURN (browser ICE picks the path)
                     ↳ genuine P2P failure only? → WS relay chunks via server (last resort)
                     ↳ Room broadcast? → one upload, server fans out to room (unchanged)
```

- **Discovery:** same WiFi = shared network keys (exact public IPv4 + IPv6 `/64` prefix + private `/24`) **plus a client-reported private-LAN hint** (WebRTC host candidates, e.g. `192.168.1.0/24`) so phones/laptops match even when their public exit IPs differ (IPv4-vs-IPv6, CGNAT pools, Private Relay). `localhost` bridged with private LAN. Plus custom rooms (cap 100 members), presence re-announce every 25s, Rescan button, and auto-rescan while the radar is empty. Open `/debug` on both devices — matching key hashes means auto-discovery will work.
- **STUN/TURN:** Google STUN + OpenRelay TURN by default. Bring your own via env: `TURN_URLS`, `TURN_USER`, `TURN_PASS` (see `render.yaml`). No `iceTransportPolicy: 'relay'` — direct candidates are always allowed.
- **P2P path:** WebRTC is always attempted first with a ~15s ICE grace period (slow negotiation never triggers an early relay). Transient `disconnected` gets a ~5s recovery window; only genuine `failed`/timeout falls back to WS relay. Each transfer locks one transport before its header — no P2P+relay mixing, no silent mid-transfer restart.
- **Path labels:** footer badge + transfer rows show the real selected ICE pair: `⚡ Direct P2P • LAN` (host/host), `⚡ Direct P2P` (direct NAT), `🟠 P2P via TURN` (relay), `🌐 Server relay` (WebSocket fallback). Browser console logs e.g. `[sdfdrop] peer=<id> ICE host/host → LAN P2P`.
- **Endpoints:** `/health` · `/config` · `/stats` (gated) · `/debug` · WebSocket at `/ws`.

## Classroom broadcast

1. Teacher + students join the same room code. Banner shows the live headcount.
2. Teacher → **Send to room** → picks files. Students get an Accept prompt tagged with the room.
3. Teacher watches accepts (`Send now (23/50)`) → **Send now** or 45s auto-send. One upload, everyone gets a copy.
4. **Resend** covers late accepters; Cancel notifies the room; **Room** in the text box sends announcements.

## Trusted devices & device management

- **Auto-accept (no more Accept taps):** tap 🔐 **Devices** → **Trust** on a nearby device. Every future file/text/room broadcast from that device is accepted automatically — it appears in **Transfers** and downloads without the popup. Great for your own laptop ↔ phone, or for students receiving a teacher's room broadcast.
- **Block:** **Block** a device to hide it from the radar and ignore all its traffic (auto-decline). **Unblock** any time from the same panel.
- **Remove / revoke:** saved devices can be **Remove**d, which instantly revokes trust or block. Turning off **Trust** restores the normal Accept prompt.
- **Stable identity:** each browser has a persistent random `clientId` (localStorage `sdfdrop-client`). The server signs it into a `deviceId` token shared with peers — the raw id is never exposed, so a room member can't copy it to inherit trust. Trust survives reconnects and room changes; set `DEVICE_TOKEN_KEY` env to keep tokens stable across server restarts.
- **Local only:** the list lives in localStorage (`sdfdrop-devices`) on the receiving device. Nothing is sent to or stored by the server. Trust/block are UX conveniences, **not** a security boundary — a device can clear its site data to get a new id, so keep using rooms + HTTPS for sensitive transfers.
- Trusted peers show a green outline and 🔐 on the radar, and senders see a "trusted — auto-accept" toast.
- Identity is per **browser profile**, not per tab — two tabs in the same browser share an id (which is correct: it is one device). Clear site data to reset your id.

## Preview & folder transfer

- **Confirm before sending:** selecting a file/folder opens a preview dialog (single file) or a file list (multiple files) with the destination and total size. Tap **Send ✓** to transfer, **Cancel** to abort. Trusted-device auto-accept only skips the *receiver's* Accept tap — you still confirm what you send.
- **Preview:** images / video / audio play inline; text is read from the local blob (no upload, CSP allows `blob:` fetches). Desktop PDFs use the inline viewer with **Open PDF ↗ / Download ⬇** fallback buttons. Phone browsers can't render `blob:` PDFs in an iframe, so they get a clear tap-to-open / download panel instead. Completed transfers also get a 👁 Preview button. Blob URLs are revoked with the existing 20-URL cap.
- **Folders:** 🗂️ **Send folder** uses `showDirectoryPicker()` on Chromium (real folder tree, empty folders included) with a multi-file + folder-name fallback for mobile/Safari. The unreliable `webkitdirectory` input is no longer used. Dragging a folder onto the page also works.
- The tree is packed into a standard ZIP Blob (store method + data descriptors, CRC32 computed while assembling); the receiver gets one `FolderName.zip` download. Verified with nested folders, empty folders, and multi-chunk files.
- Works over every path — P2P DataChannel, WebSocket relay, and classroom room broadcast. Room senders also get a **🗂️ Folder to room** button.
- On phones, scripted blob downloads are blocked by the browser, so the receiver must tap **⬇ Save file**; desktop still auto-downloads.
- Limit: 4 GB per folder (ZIP32 format). For bigger data, send files individually over same-WiFi P2P.
- Code assets (`app.js`, `styles.css`) are now network-first in the service worker, so updates apply without a hard refresh.

## Security model & limits

- **Trust:** encryption is end-to-end only if you trust the signaling server (a malicious server could swap SDP offers). Self-host; don't trade sensitive files over random public instances.
- **Device identity:** peers only see a server-signed `deviceId` token (HMAC of the browser id), never the raw `clientId`, so room members can't copy an identity to inherit auto-accept. Set `DEVICE_TOKEN_KEY` to keep tokens stable across redeploys.
- **WebSocket origin policy:** same-origin always allowed (Render domain, LAN IP, localhost). Cross-origin only via `ALLOWED_ORIGINS` (e.g. your `https://<you>.github.io`). No `?ws=` override.
- **Anti-abuse caps (env-tunable):** `MAX_CONN_PER_IP` (12), `MSG_MAX_PER_WINDOW` (60/10s), 3 rooms/peer, relay/broadcast file cap 2GB default (`RELAY_MAX_BYTES`, effectively no limit — raise/lower via env), text 8KB, chunks ≤100KB, signals ≤20KB, header-before-chunks sessions.
- **Headers:** `nosniff`, `SAMEORIGIN` framing, minimal CSP, HSTS on https, no `X-Powered-By`. No third-party scripts (QR generator vendored in `public/vendor/` — scannable canvas QR, no CDN).
- **Detailed `/stats`** gated to localhost/direct-LAN or `?token=ADMIN_TOKEN`. `/debug` returns hashes only.
- **Large files:** no fixed 100MB cap (relay/broadcast default 2GB, P2P unlimited); transfers have Cancel; Blob URLs capped/revoked; stale transfers expire after 5 min.
- **PWA:** `sdfdrop-v2` cache, network-first navigations so updates apply.

## Troubleshooting

- **Same WiFi, can't see each other?** Same WiFi *name* on both (2.4 vs 5 GHz can isolate), VPN off. Compare `/debug` hashes on both — no shared hash (IPv6/carrier NAT) → just use a Room code, it always works.
- **How do I confirm LAN P2P (not Render relay)?** Same-WiFi transfer should show `⚡ Direct P2P • LAN` / `⚡ LAN P2P` and console `ICE host/host → LAN P2P`. `🟠 P2P via TURN` = TURN relay; `🌐 Server relay` = WebSocket fallback after genuine failure/timeout.
- **Room code mismatch?** Both banners must show the identical code and headcount. The sender's toast tells the truth (`Broadcasting to 0 in X` = nobody in the room).
- **Nothing arrives after Send to room?** Students must tap Accept, then teacher taps Send now (or 45s auto-send).
- **Layout looks broken on phone?** Hard-refresh to drop the cached stylesheet (Ctrl+Shift+R / reload twice on mobile).
- **Render first load slow?** Free tier was asleep — wait ~30s and it connects.

## Project structure

```
sdfdrop_v2/
├── server.js            # signaling + relay + room fan-out (Express + ws)
├── render.yaml          # Render blueprint (health check, env placeholders)
├── package.json
└── public/
    ├── index.html       # sdfdrop UI (radar, rooms, transfers, modals)
    ├── app.js           # WebRTC + relay + broadcast + device-trust client
    ├── styles.css       # responsive phone → desktop styles
    ├── manifest.webmanifest
    └── sw.js            # PWA shell (v2, network-first pages)
```

Repo: https://github.com/sdfprwz/sdfdrop_v2

MIT — built for sdfdrop.
