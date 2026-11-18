# SdfDrop — Work Progress Report

**Last updated:** 2026-11-18
**Local folder:** `C:\Users\sdfpe\AI-Projects\Test\SdfDrop_v2`
**GitHub:** https://github.com/sdfprwz/sdfdrop_v2 (default branch `main`)
**Hosted app:** https://sdfdrop2.onrender.com (Render)
**Local dev server:** `node server.js` → http://localhost:3000 and http://192.168.137.4:3000 (WiFi)

This file is the hand-over record for all work done on the project. It is safe to commit; secrets and binaries are git-ignored and listed in section 5.

---

## 1. Timeline

| Date | Work | Status |
|---|---|---|
| 2026-09-22 | Original GitHub repository created | baseline |
| 2026-10-28 | Upstream commit `14b8dc1` — robustness tuning (MAX_CONN_PER_IP 12, waitReady timeout, bufferedAmount guard, docs) | baseline |
| 2026-11-18 (early) | Confirmed local folder is an exact clone of the GitHub repo (same remote, same HEAD SHA) | done |
| 2026-11-18 | Trusted devices / block / remove + pre-send preview + folder ZIP + robustness/docs | done, pushed `117fd83` |
| 2026-11-18 | TWA/APK documentation + Digital Asset Links route | done, pushed `135a253` |
| 2026-11-18 | Signed release APK + AAB built; install notes | done, pushed `01067a0` |
| 2026-11-18 | This progress report + local credential backup | done, uncommitted at time of writing |

All feature development happened on 2026-11-18 in this working directory.

---

## 2. Feature-by-feature record

### 2.1 Repository identity check
- Compared local folder with GitHub: same `origin`, same branch `main`, same HEAD commit `14b8dc1`.
- Only pre-existing local difference was a dependency bump in `package-lock.json` (`body-parser` 1.20.8→1.20.9, `qs` 6.16.0→6.16.2), which was preserved.

### 2.2 Trusted devices / device management — `server.js`, `public/app.js`, `public/index.html`, `public/styles.css`
- New 🔐 **Devices** button opens a manager with **Nearby devices** and **Saved devices** lists.
- **Trust:** future files/text/room broadcasts from that device are accepted automatically (no Accept tap), appear in Transfers, and download. Works for P2P, relay, and classroom room broadcasts.
- **Block:** device hidden from radar and all its packets ignored; can be unblocked from either list.
- **Remove:** forgets the device (revokes trust/block).
- Identity: browser-persistent random `clientId` (localStorage `sdfdrop-client`) is HMAC-signed server-side into a `deviceId` token exposed in the peer list. The raw `clientId` is **never** sent to peers, so a room member cannot copy it to inherit trust. Override key with `DEVICE_TOKEN_KEY`.
- List stored locally in `localStorage['sdfdrop-devices']` — no server DB, no accounts.
- Trusted peers show a green outline + 🔐 on the radar; senders see an "auto-accept" toast.
- Trust is explicitly documented as UX convenience, not a security boundary.

### 2.3 Pre-send preview + confirmation — `public/app.js`, `public/index.html`
- Selecting a file/folder opens a **Ready to send** dialog first: destination, total size, file list, and (for a single previewable file) a live preview.
- Nothing transfers until **Send ✓** is tapped. **Cancel** aborts. Trusted-device auto-accept only skips the *receiver's* Accept tap — the sender still confirms.

### 2.4 File preview (post-transfer) + PDF handling — `public/app.js`, `public/styles.css`, `server.js`
- Completed transfers get a 👁 **Preview** button for images, video, audio, PDF, and text.
- Text is read from the local blob; CSP gained `blob:` in `connect-src` (this was required — otherwise text previews silently failed).
- Desktop PDF: large inline iframe plus **Open PDF ↗ / Download ⬇** fallback buttons.
- Phone PDF: mobile browsers refuse `blob:` PDFs inside iframes, so they get a clean tap-to-open/download panel instead. Mobile detection uses UA + pointer type + small screen size.
- CSS bug fixed: preview rules were scoped to `#previewBody` only, so the pre-send dialog's iframe defaulted to 300×150. Now shared via `.preview-body` selectors. Verified desktop iframe ≈ 861×630.

### 2.5 Folder transfer — `public/app.js`
- 🗂️ **Send folder** uses `showDirectoryPicker()` on Chromium desktop (real tree, empty folders preserved), with a multi-file + folder-name fallback for mobile/Safari. The unreliable `webkitdirectory` input was removed.
- 🗂️ **Folder to room** button in the room banner; dragging a folder onto the page also works.
- Tree is packed into a standard ZIP Blob (store method, data descriptors, CRC32 computed while assembling). Receiver gets one `FolderName.zip`.
- 4 GB limit (ZIP32). Empty-folder guard prevents sending an "empty" 22-byte archive.
- A fragile on-demand slice generator was replaced with eager Blob assembly after a real-world 0-byte download report.

### 2.6 Dynamic landing page — `public/landing-motion.js` (new), `public/styles.css`, `public/index.html`
- Staged hero entrance, drifting aurora gradients, pointer parallax + cursor glow on the illustration, animated data packets on orbit arcs.
- Thin scroll-progress bar, `IntersectionObserver` staggered reveals for steps/cards/CTA.
- Animated step connector, card lift/glow following the pointer, pausable trust-strip marquee.
- Pure CSS + vanilla JS, no libraries, external file so CSP stays intact; transforms/opacity only with rAF-throttled pointer handlers.
- Full `prefers-reduced-motion` fallback.
- **Landing theme:** restored to its original light palette after the user asked; only the app is dark by default.

### 2.7 Theme and text cleanup — `public/index.html`, `public/app.js`, `public/styles.css`, `package.json`, `README.md`
- App default theme is dark (`<html data-theme="dark">` + `applyTheme(... || 'dark')`); a saved user choice is still respected.
- Removed competitor comparisons (Snapdrop/PairDrop/AirDrop) from UI, meta keywords, package description, and README.
- Removed stale `v1.0` footer, developer diagnostics line in Help, overclaiming "E2E encrypted" labels, and simplified "How it works" wording.
- Footer is now `sdfdrop • fast, private file sharing`.

### 2.8 Performance / robustness / security
- Progress-bar DOM writes throttled to ~12 fps for large transfers.
- Accept-timeout timers cleared on all paths.
- Blocked peers excluded from radar, sends, text targets, rescan and connection warm-up.
- `clientId` validated as hex server-side.
- CSP: added `frame-src 'self' blob:` (PDF iframes) and `blob:` in `connect-src` (text preview).
- Fixed `#app` deep link being wiped by room URL cleanup.
- On phones, scripted blob downloads are skipped; receiver taps ⬇ **Save file**.

### 2.9 Service worker / cache strategy — `public/sw.js`
- Cache name bumped repeatedly (`v8` → `v15`) as changes shipped.
- JS/CSS/manifest are now **network-first** so updates apply without a hard refresh; other assets remain cache-first.
- Added `landing-motion.js` to precache assets.
- Asset URLs in `index.html` and the SW registration use `?v=15` query strings for hard cache busting.
- A stale service worker was the root cause of "preview never appears" reports — fixed permanently.

### 2.10 Deployment — GitHub + Render
- Pushed commits to `origin/main`: `117fd83`, `135a253`, `01067a0`.
- Render auto-deployed; verified hosted `app.js` now contains trusted devices, folder ZIP, PDF fallback, and the landing-motion script.
- Added `GET /.well-known/assetlinks.json` to `server.js` (Express static ignores dotfiles, so an explicit route was required). Env overrides: `TWA_PACKAGE`, `TWA_FINGERPRINT`.

### 2.11 Android APK (Trusted Web Activity)
- Built with Bubblewrap CLI 1.27.0 + JDK 17 + Android SDK (platform 35/36, build-tools 35), using the generated Gradle project at `C:\Users\sdfpe\AppData\Local\Temp\opencode\twaproject`.
- Package `com.sdfprwz.sdfdrop`, version `1.0.0` (code 1), minSdk 24, targetSdk 36, label **SdfDrop**, launch URL `https://sdfdrop2.onrender.com/`.
- Signed release APK and AAB are in `android/` (see §5).
- APK certificate SHA-256 matches the hosted `assetlinks.json` exactly → origin verification passes.
- No Android device was connected, so physical install was **not** tested here.

---

## 3. Bugs found and fixed (root causes)

| Symptom | Root cause | Fix |
|---|---|---|
| Preview button never appeared / old UI kept showing | Service worker cached `app.js` cache-first with a fixed version | Network-first code assets + cache-name/query bumps |
| Folder sent as 0-byte file | `webkitdirectory` input returned 0 files; also fragile on-demand ZIP slicing | Real directory picker + multi-file fallback; eager Blob ZIP; empty-folder guard |
| PDF preview tiny on PC | CSS scoped to `#previewBody`, not the pre-send dialog | Shared `.preview-body` selectors |
| PDF error on phone | Mobile browsers cannot render `blob:` PDF in iframe | Tap-to-open/download fallback panel |
| Text preview said "Could not read this file" | CSP `connect-src` lacked `blob:` | Added `blob:` to `connect-src` |
| Folder sent to wrong device | Folder button cleared selected peer when >1 device visible | Preserve selected peer; ask user to tap one otherwise |
| Phone download failed | Browser blocks scripted blob downloads on touch devices | Skip auto-click; show explicit Save link |
| `#app` deep link showed landing | Room URL cleanup stripped the hash | Preserve `location.hash` in `replaceState` |
| Gradle build failed | `minSdkVersion 21` < library requirement 24; wrong `--manifest`/cwd usage | Set minSdk 24; run build from project dir with file manifest |

---

## 4. Verification evidence

- `node --check` passed for `server.js`, `public/app.js`, `public/sw.js`, `public/landing-motion.js` after every change round.
- Real Chrome (CDP automation) verified: send modal opens on file pick, no transfer before confirm, preview renders text, folder ZIP arrives (443 B), received blob opens with correct nested entries.
- Generated ZIPs validated with Windows `System.IO.Compression.ZipFile`: paths, contents, empty folders, and SHA-256 match across multi-chunk streaming.
- Headless screenshots confirmed: light landing restored, dark app default, large desktop PDF preview, mobile PDF fallback panel, dynamic landing settled state.
- `apksigner verify --print-certs`: signer DN `CN=SdfDrop...`, SHA-256 `c6fdba3a…00b534`, matching hosted asset links.
- Hosted checks: `/health` → 200, `/.well-known/assetlinks.json` present and correct, hosted app.js contains all new features.

---

## 5. Current artifacts and important files

| Item | Location / value |
|---|---|
| Signed APK | `android\SdfDrop-v1.0.0-release.apk` |
| Play Store AAB | `android\SdfDrop-v1.0.0-release.aab` |
| Signing keystore | `android\keystore.jks` (git-ignored) |
| Keystore credentials | `android\keystore-credentials.txt` (git-ignored) |
| APK certificate SHA-256 | `C6:FD:BA:3A:98:15:20:D0:AE:E4:82:08:53:DA:75:11:DE:61:E6:3D:58:AB:A0:44:A2:C4:18:AB:6E:00:B5:34` |
| Asset-links route | `GET /.well-known/assetlinks.json` in `server.js` |
| Bubblewrap project (temp) | `C:\Users\sdfpe\AppData\Local\Temp\opencode\twaproject` (temporary — may be cleaned) |
| Bubblewrap CLI (temp) | `C:\Users\sdfpe\AppData\Local\Temp\opencode\bubblewrap\node_modules\.bin\bubblewrap.cmd` |

**Never commit** the keystore, credentials, APK, or AAB. The `.gitignore` already excludes them.

---

## 6. Git history (this work)

```
01067a0 2026-11-18  Add APK build artifacts and install notes
135a253 2026-11-18  Document TWA APK signing and asset-links configuration
117fd83 2026-11-18  Add trusted devices, previews, folders, dynamic landing, and TWA asset links
14b8dc1 2026-10-28  Upstream baseline
```

---

## 7. Known caveats / future work

- **Render free tier sleeps** — first app/APK launch after idle can take ~30 s.
- **APK needs Chrome + Android 7+**; it is a TWA, not a self-contained native app. If Chrome is unavailable, Bubblewrap falls back to Custom Tabs.
- **Physical device test pending** — please sideload the APK and confirm fullscreen launch, downloads, and file picking.
- **Keystore is critical** — any future APK must be signed with the same key, otherwise the hosted `assetlinks.json` fingerprint must be updated via `TWA_FINGERPRINT`.
- **Trust is not a security boundary** — `clientId` is self-asserted by browsers; the HMAC token prevents casual copying but a malicious client can generate a new id.
- **Folder ZIP limit is 4 GB** (ZIP32); send large files individually over same-WiFi P2P.
- **Mobile PDFs open natively** via Open/Download — inline rendering is not possible in mobile browsers.
- Play Store publishing was not attempted; the `.aab` is ready if wanted (requires a Google Play developer account and store listing).

---

## 8. Rebuilding the APK (quick reference)

1. Ensure JDK 17, Android SDK (platform 35+, build-tools 35) and Bubblewrap CLI are available.
2. Use the existing `android/keystore.jks` + credentials in `android/keystore-credentials.txt`.
3. Regenerate the Gradle project from `twaproject/twa-manifest.json` (or re-create it), keeping `packageId`, `host`, `signingKey`, and `fingerprints` unchanged.
4. From the project directory:
   ```
   set BUBBLEWRAP_KEYSTORE_PASSWORD=<store password>
   set BUBBLEWRAP_KEY_PASSWORD=<store password>
   bubblewrap build --skipPwaValidation --manifest=twa-manifest.json
   ```
5. Copy `app-release-signed.apk` / `app-release-bundle.aab` to `android/`.
6. Confirm the APK signer SHA-256 still matches the host's `assetlinks.json` before shipping.
