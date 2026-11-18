/* sdfdrop frontend — P2P + relay, same-WiFi auto-discovery + internet rooms */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);

  // ---------- identity ----------
  const ANIMALS = ['🦊','🐼','🐨','🦁','🐯','🦄','🐸','🐙','🐧','🦋','🐝','🦀','🐢','🦉','🐬','🦖','🐰','🐲','🦝','🐺'];
  const rand = (n) => Math.floor(Math.random() * n);
  const uid = (n=8) => [...crypto.getRandomValues(new Uint8Array(n))].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,n);
  function hashStr(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}

  let myName = localStorage.getItem('sdfdrop-name');
  if (!myName) {
    const adj = ['Swift','Bright','Calm','Neon','Cosmic','Sunny','Rapid','Clever','Misty','Bold'];
    myName = `${adj[rand(adj.length)]} ${ANIMALS[rand(ANIMALS.length)]} ${rand(90)+10}`;
    // strip emoji duplication: keep readable name
    myName = `${adj[rand(adj.length)]} ${['Falcon','Panda','Tiger','Wolf','Otter','Fox','Bear','Hawk'][rand(8)]} ${rand(90)+10}`;
    localStorage.setItem('sdfdrop-name', myName);
  }
  let myAvatar = localStorage.getItem('sdfdrop-avatar') || ANIMALS[hashStr(myName) % ANIMALS.length];
  let myColor = localStorage.getItem('sdfdrop-color');
  if (!myColor) { myColor = `hsl(${hashStr(myName)%360} 70% 55%)`; localStorage.setItem('sdfdrop-color', myColor); }
  // nicer: store hex for server validation; convert hsl->hex approx via canvas
  function toHex(color){
    if(/^#[0-9a-fA-F]{6}$/.test(color)) return color;
    const c=document.createElement('canvas').getContext('2d');c.fillStyle=color;return c.fillStyle.length===7?c.fillStyle:'#6366f1';
  }
  myColor = toHex(myColor);
  let clientId = localStorage.getItem('sdfdrop-client');
  if(!clientId){ clientId = uid(16); localStorage.setItem('sdfdrop-client', clientId); }

  // ---------- device trust / block (local to this browser only) ----------
  // Identity = a server-signed token derived from the peer's stable clientId
  // and echoed in the peer list as `deviceId` — never the per-connection socket
  // id, and never the raw clientId (so room members can't steal an identity).
  // Trusted devices auto-accept files (no Accept tap); blocked ones are ignored.
  // Stored in localStorage — no server database, no accounts. Trust is still a
  // UX convenience, not a security boundary (see README).
  const DEVICES_KEY='sdfdrop-devices';
  let devices={};
  try{ devices=JSON.parse(localStorage.getItem(DEVICES_KEY)||'{}')||{}; }catch{ devices={}; }
  function saveDevices(){ try{ localStorage.setItem(DEVICES_KEY,JSON.stringify(devices)); }catch{} }
  function peerRecord(p){ return (p&&p.deviceId&&devices[p.deviceId])||null; }
  function peerTrusted(p){ const r=peerRecord(p); return !!(r&&r.trust); }
  function peerBlocked(p){ const r=peerRecord(p); return !!(r&&r.block); }
  function peerById(id){ return peers.find(p=>p.id===id)||null; }
  function trustedSender(id){ return peerTrusted(peerById(id)); }
  function blockedSender(id){ return peerBlocked(peerById(id)); }
  function activePeers(){ return peers.filter(p=>!peerBlocked(p)); }
  function updateDevice(cid,name,avatar,patch){
    if(!cid)return;
    const cur=devices[cid]||{name:name||'Device',avatar:avatar||'📦',addedAt:Date.now()};
    const next=Object.assign({},cur,patch,{name:name||cur.name,avatar:avatar||cur.avatar});
    if(!next.trust&&!next.block)delete devices[cid]; else devices[cid]=next;
    saveDevices();
  }

  // ---------- state ----------
  let ws=null, myId=null, peers=[], myRoom=null, iceServers=[{urls:'stun:stun.l.google.com:19302'}];
  let retryMs=1000, connectTimer=null, lastServerMsg=Date.now(), myNetGroup='…', watchdogTimer=null;
  let manualClose=false;
  const pcs=new Map(); // peerId -> {pc, dc, ready, mode:'p2p'|'relay', state:'new'|'connecting'|'connected'|'relay', path:'lan'|'direct'|'turn'|'relay'|'unknown', waiters:[]}
  const pendingAccept=new Map(); // transferId -> {resolve,reject} (1-to-1)
  const broadcastWaits=new Map(); // transferId -> {accepted:Set, onAccept, room} (1-to-room)
  const incoming=new Map(); // transferId -> {meta, chunks, received, from, mode, el...}
  const CHUNK=64*1024; // 64KB DataChannel messages: 4x fewer round-trips than
  // 16KB with the same per-message overhead; universally supported (Chrome /
  // Firefox / Safari SCTP all handle 64KB). Larger (256KB) breaks older FF.
  const RELAY_BIN_STEP=71*1024; // → ~97KB base64, just under the 100KB server chunk cap
  let RELAY_MAX_BYTES = 2*1024*1024*1024; // server /config relayMaxBytes overrides

  // ---------- ui refs ----------
  const statusPill=$('#statusPill'), statusText=$('#statusText'), peersLayer=$('#peersLayer'),
    emptyState=$('#emptyState'), peerCount=$('#peerCount'), transfersEl=$('#transfers'),
    netBadge=$('#netBadge'), connInfo=$('#connInfo');

  function toast(msg, kind='info'){
    const d=document.createElement('div');d.className='toast '+kind;d.textContent=msg;
    $('#toasts').appendChild(d);setTimeout(()=>{d.style.opacity='0';setTimeout(()=>d.remove(),300)},3200);
  }
  function setStatus(online, txt){
    statusPill.classList.toggle('online',online);statusPill.classList.toggle('offline',!online);
    statusText.textContent=txt;
    // keep radar pill honest (e.g. "offline — retrying…" instead of "searching")
    if(!activePeers().length){
      const et=$('#emptyText');
      if(et)et.textContent=txt==='online ✓'?'Searching for nearby devices…':txt;
    }
  }
  function renderMe(){
    $('#meName').textContent=myName;$('#meAvatar').textContent=myAvatar;$('#selfNodeAvatar').textContent=myAvatar;
  }
  renderMe();

  // theme
  const themeBtn=$('#btnTheme');
  function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('sdfdrop-theme',t);themeBtn.textContent=t==='light'?'🌙':'☀️'}
  applyTheme(localStorage.getItem('sdfdrop-theme') || 'dark');
  themeBtn.onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');

  $('#btnEditName').onclick=()=>{
    const n=prompt('Your display name:',myName);
    if(n&&n.trim()){myName=n.trim().slice(0,24);localStorage.setItem('sdfdrop-name',myName);
      myAvatar=ANIMALS[hashStr(myName)%ANIMALS.length];localStorage.setItem('sdfdrop-avatar',myAvatar);
      renderMe();hello();toast('Name updated ✓','ok');}
  };

  // ---------- ws url ----------
  // No ?ws= override: a malicious link could otherwise silently point the
  // victim at an attacker signalling server (identity + file theft).
  // Deploy-time override lives with the page author (window.SDFDROP_WS_URL);
  // a saved localStorage override is only honored for local/LAN hosts with a
  // protocol matching the page (no https→ws downgrade).
  function getWsUrl(){
    if (typeof window.SDFDROP_WS_URL === 'string' && window.SDFDROP_WS_URL) return window.SDFDROP_WS_URL;
    try {
      const saved = localStorage.getItem('sdfdrop-ws');
      if (saved) {
        const httpsPage = location.protocol === 'https:';
        const okProto = httpsPage ? saved.startsWith('wss://') : /^wss?:\/\//.test(saved);
        let host = '';
        try { host = new URL(saved.replace(/^ws/, 'http')).hostname; } catch { host = ''; }
        const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
          /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
          (typeof location.hostname === 'string' && host === location.hostname);
        if (okProto && isLocalHost) return saved;
        console.warn('[sdfdrop] ignoring untrusted saved WS URL');
        try { localStorage.removeItem('sdfdrop-ws'); } catch {}
      }
    } catch { /* ignore */ }
    // GitHub Pages default → point at Render backend (change to your URL)
    if(location.hostname.endsWith('github.io')){
      return 'wss://sdfdrop2.onrender.com/ws';
    }
    const proto=location.protocol==='https:'?'wss:':'ws:';
    if(location.protocol.startsWith('http')) return `${proto}//${location.host}/ws`;
    return 'ws://localhost:3000/ws'; // file:// dev
  }

  async function loadConfig(){
    try{
      const base=getWsUrl().replace(/\/ws$/,'').replace(/^ws/,'http');
      if(base.startsWith('http')){
        const r=await fetch(base+'/config');if(r.ok){const j=await r.json();if(j.iceServers?.length)iceServers=j.iceServers;if(Number.isFinite(j.relayMaxBytes)&&j.relayMaxBytes>0)RELAY_MAX_BYTES=j.relayMaxBytes;}
      }
    }catch{/* keep defaults */}
  }

  // ---------- private-LAN hint (same-WiFi matching when public IPs differ) ----------
  // Derives e.g. "192.168.1.0/24" from WebRTC host ICE candidates and reports
  // it in hello/update. Server matches identical subnets. Cached: candidates
  // don't change unless the network does.
  let lanSubnet='', lanDetectDone=false;
  function detectLanSubnet(){
    if(lanDetectDone)return Promise.resolve(lanSubnet);
    lanDetectDone=true;
    return new Promise((resolve)=>{
      let done=false;
      const finish=(v)=>{if(!done){done=true;lanSubnet=v||'';try{if(lanSubnet)hello();}catch{}resolve(lanSubnet);}};
      try{
        const pc=new RTCPeerConnection({iceServers:[]});
        pc.createDataChannel('lan');
        const seen={};
        pc.onicecandidate=(e)=>{
          if(!e.candidate){finish(mostCommon(seen));try{pc.close()}catch{}return;}
          const m=/candidate:\d+ \d+ udp \d+ (10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/.exec(e.candidate.candidate||'');
          if(m){const p=m[1].split('.');seen[`${p[0]}.${p[1]}.${p[2]}.0/24`]=(seen[`${p[0]}.${p[1]}.${p[2]}.0/24`]||0)+1;}
        };
        pc.createOffer().then(o=>pc.setLocalDescription(o)).catch(()=>finish(''));
        setTimeout(()=>{finish(mostCommon(seen));try{pc.close()}catch{};},2500);
        function mostCommon(o){let b='',n=0;for(const k in o){if(o[k]>n){n=o[k];b=k;}}return b;}
      }catch{finish('');}
    });
  }
  setTimeout(()=>{try{detectLanSubnet();}catch{}},1500);

  // ---------- websocket (hardened: watchdog + clean reconnect + room rejoin) ----------
  function clearPeerConnections(){
    for(const[,c]of pcs){try{if(c.connectTimer)clearTimeout(c.connectTimer);}catch{}try{if(c.disconnectTimer)clearTimeout(c.disconnectTimer);}catch{}try{c.dc?.close()}catch{}try{c.pc?.close()}catch{}}
    pcs.clear();
  }
  async function connect(){
    if(connectTimer){clearTimeout(connectTimer);connectTimer=null;}
    await loadConfig();
    const url=getWsUrl();
    connInfo.textContent='sdfdrop • fast, private file sharing';
    setStatus(false,'connecting…');
    manualClose=false;
    try{ws?.close()}catch{}
    clearPeerConnections();
    let opened=false;
    try{ws=new WebSocket(url);}
    catch{connectTimer=setTimeout(connect,retryMs);retryMs=Math.min(retryMs*1.6,15000);return;}
    ws.onopen=()=>{
      opened=true;retryMs=1000;lastServerMsg=Date.now();setStatus(true,'online ✓');
      hello();
      toast('Connected to sdfdrop ✓','ok');
    };
    ws.onmessage=(e)=>{lastServerMsg=Date.now();try{onServer(JSON.parse(e.data))}catch{}};
    ws.onclose=()=>{
      setStatus(false,'offline — retrying…');
      clearPeerConnections();
      if(!manualClose){connectTimer=setTimeout(connect,retryMs);retryMs=Math.min(retryMs*1.6,15000);}
    };
    ws.onerror=()=>{if(!opened){try{ws.close()}catch{}}};
    startWatchdog();
  }
  function startWatchdog(){
    if(watchdogTimer)return;
    watchdogTimer=setInterval(()=>{
      if(!ws||ws.readyState!==1)return;
      const silentFor=Date.now()-lastServerMsg;
      if(silentFor>45000){
        // Server heartbeat is protocol-level; also do app-level ping.
        // If neither gets an answer, the connection is half-dead (common on
        // mobile / Render sleep) — reconnect instead of showing stale radar.
        send({type:'ping'});
        setTimeout(()=>{
          if(Date.now()-lastServerMsg>55000){
            try{ws.close()}catch{}
          }
        },6000);
      }
    },10000);
  }
  function scheduleReconnect(){if(connectTimer)clearTimeout(connectTimer);connectTimer=setTimeout(connect,retryMs);retryMs=Math.min(retryMs*1.6,15000);}
  function send(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
  function hello(){send({type:'hello',name:myName,avatar:myAvatar,color:myColor,clientId,room:myRoom||undefined,lanSubnet:lanSubnet||undefined});}
  // Keep presence fresh + heal missed broadcasts: re-hello every 25s and an
  // explicit rescan (own reply + server pokes same-network peers).
  setInterval(()=>{if(ws&&ws.readyState===1)hello();},25000);
  function rescan(){if(ws&&ws.readyState===1){hello();send({type:'rescan'});}else{connect();}}
  const _btnRescan=$('#btnRescan');if(_btnRescan)_btnRescan.onclick=()=>{rescan();toast('Scanning for nearby devices…','info');};
  // If radar is empty, nudge the server periodically (missed broadcast heal).
  setInterval(()=>{if(ws&&ws.readyState===1&&peers.length===0)send({type:'rescan'});},15000);
  // Refresh presence when tab comes back (mobile browsers freeze WS in background)
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden){
      if(!ws||ws.readyState!==1){connect();}
      else{hello();}
    }
  });

  function onServer(m){
    if(m.type==='welcome'){
      myId=m.id;if(m.iceServers?.length)iceServers=m.iceServers;
      if(m.network?.group){myNetGroup=m.network.group;updateDiag();}
      // Re-apply room after (re)connect — server forgets rooms on restart
      if(myRoom)send({type:'join',room:myRoom});
    }
    else if(m.type==='peers'){peers=m.peers||[];if(m.you)myId=m.you.id;renderPeers();warmConnections();}
    else if(m.type==='signal'){onSignal(m.from,m.data);}
    else if(m.type==='relay'){onRelay(m.from,m.data);}
    else if(m.type==='broadcast-sent'){
      // Server fan-out receipt: who got this chunk/header (room members only).
      if(m.kind==='file-header')toast(`📢 Broadcasting to ${m.recipients} in ${m.room}…`,'info');
    }
    else if(m.type==='room-joined'){myRoom=m.room;persistRoom();renderRoom();}
    else if(m.type==='room-left'){if(m.room===myRoom){myRoom=null;persistRoom();renderRoom();}}
    else if(m.type==='error'){toast(m.message,'err');}
    else if(m.type==='pong'){/* keepalive */}
  }
  setInterval(()=>send({type:'ping'}),25000);
  function persistRoom(){
    try{
      if(myRoom)localStorage.setItem('sdfdrop-room',myRoom);
      else localStorage.removeItem('sdfdrop-room');
    }catch{}
  }

  // ---------- rooms ----------
  function roomPeerCount(){return activePeers().filter(p=>p.room===myRoom).length;}
  function renderRoom(){
    const b=$('#roomBanner');
    if(myRoom){b.classList.remove('hidden');$('#roomCodeLabel').textContent=myRoom;
      $('#roomHint').textContent='devices with this code can see you';
      const rc=$('#roomCount');if(rc)rc.textContent=`• ${roomPeerCount()} in room`;
      history.replaceState(null,'',location.pathname+'?room='+myRoom+location.hash);
    } else {b.classList.add('hidden');history.replaceState(null,'',location.pathname+location.hash);}
  }
  function joinRoom(code,silent){
    code=String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,12);
    if(!/^[A-Z0-9]{4,12}$/.test(code)){if(!silent)toast('Code must be 4–12 letters/numbers','err');return;}
    send({type:'join',room:code});myRoom=code;persistRoom();renderRoom();
    if(!silent)toast(`Joined room ${code} 🌐`,'ok');
    closeModal('#roomModal');
  }
  const roomChars='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const randomRoom=()=>Array.from({length:6},()=>roomChars[rand(roomChars.length)]).join('');

  $('#btnRoom').onclick=()=>openModal('#roomModal');
  const _btnRoom2=$('#btnRoom2');if(_btnRoom2)_btnRoom2.onclick=()=>openModal('#roomModal');
  $('#btnHelp').onclick=()=>{updateDiag();openModal('#helpModal');};
  $('#btnCloseHelp').onclick=()=>closeModal('#helpModal');
  $('#btnHelpRoom').onclick=()=>{closeModal('#helpModal');openModal('#roomModal');};
  $('#btnCloseRoom').onclick=()=>closeModal('#roomModal');
  $('#btnRandomRoom').onclick=()=>{$('#roomInput').value=randomRoom();};
  $('#btnJoinRoom').onclick=()=>joinRoom($('#roomInput').value);
  $('#roomInput').addEventListener('keydown',e=>{if(e.key==='Enter')joinRoom(e.target.value);});
  $('#btnLeaveRoom').onclick=()=>{if(myRoom)send({type:'leave',room:myRoom});myRoom=null;persistRoom();renderRoom();toast('Left room','info');};
  $('#btnCopyRoom').onclick=async()=>{await copyText(roomLink());toast('Room link copied ✓','ok');};
  function roomLink(){
    if(!myRoom){const c=randomRoom();joinRoom(c,true);}
    return location.origin+location.pathname+'?room='+myRoom;
  }

  // ---------- qr ----------
  $('#btnQr').onclick=async()=>{
    openModal('#qrModal');
    const link=roomLink();
    $('#qrLink').textContent=link;
    drawQR($('#qrCanvas'),link);
  };
  $('#btnCloseQr').onclick=()=>closeModal('#qrModal');
  $('#btnCopyQr').onclick=async()=>{await copyText($('#qrLink').textContent);toast('Link copied ✓','ok');};
  async function copyText(t){try{await navigator.clipboard.writeText(t)}catch{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}}

  // QR via locally vendored generator (no CDN supply chain).
  // Encodes the room join link: scan → open → auto-joins the room.
  function drawQR(canvas,text){
    const ctx=canvas.getContext('2d');
    const W=canvas.width,H=canvas.height;
    function fallback(){
      ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
      ctx.fillStyle='#111';ctx.textAlign='center';
      const code=myRoom||'SDF';
      ctx.font='bold 44px monospace';ctx.fillText(code,W/2,H/2-8);
      ctx.font='13px monospace';
      ctx.fillText('enter this code on',W/2,H/2+26);
      ctx.fillText('the other device',W/2,H/2+44);
    }
    try{
      if(typeof qrcode==='undefined')return fallback();
      const qr=qrcode(0,'M'); // 0 = auto version
      qr.addData(text);qr.make();
      const n=qr.getModuleCount(),qz=4,total=n+qz*2;
      const scale=Math.max(1,Math.floor(Math.min(W,H)/total));
      const size=scale*total,ox=Math.floor((W-size)/2),oy=Math.floor((H-size)/2);
      ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
      ctx.fillStyle='#111';
      for(let r=0;r<n;r++)for(let c=0;c<n;c++){
        if(qr.isDark(r,c))ctx.fillRect(ox+(c+qz)*scale,oy+(r+qz)*scale,scale,scale);
      }
    }catch{fallback();}
  }

  // ---------- peers radar (clean: no forced text, just pill + popup help) ----------
  function renderPeers(){
    peersLayer.innerHTML='';
    const list=activePeers(); // blocked devices stay hidden
    const n=list.length;
    peerCount.textContent=n===0?'searching…':`${n} nearby`;
    const empty=$('#emptyState');
    if(empty)empty.style.display=n===0?'flex':'none';
    const emptyText=$('#emptyText');
    if(emptyText&&n===0){
      const online=statusPill.classList.contains('online');
      emptyText.textContent=online?'Searching for nearby devices…':statusText.textContent;
    }
    list.forEach((p,i)=>{
      const a=(i/n)*Math.PI*2-Math.PI/2;
      const x=50+Math.cos(a)*42, y=55+Math.sin(a)*40;
      const b=document.createElement('button');
      b.className='peer '+(p.mode||'local')+(peerTrusted(p)?' trusted':'');
      b.style.left=x+'%';b.style.top=y+'%';
      const col=/^#[0-9a-fA-F]{6}$/.test(p.color)?p.color:'#6366f1'; // defense-in-depth (server also validates)
      const tag=p.mode==='room'?'🌐 '+(p.room||'room'):p.mode==='both'?'📶+🌐 wifi+room':'📶 wifi';
      b.innerHTML=`<span class="avatar" style="background:${col}33;border-color:${col}">${p.avatar}</span><span class="pname">${escapeHtml(p.name)}</span><span class="ptag">${peerTrusted(p)?'🔐 ':''}${tag}</span>`;
      b.title=`Send to ${p.name}${peerTrusted(p)?' (trusted — auto-accept)':''}`;
      b.onclick=()=>askAndSend(p);
      peersLayer.appendChild(b);
    });
    const rc=$('#roomCount');if(rc&&myRoom)rc.textContent=`• ${roomPeerCount()} in room`;
    renderDeviceModal();
    updateDiag();
  }
  function updateDiag(){
    const el=$('#diagInfo');
    const txt=`${myName} • ${activePeers().length} nearby${myRoom?' • room '+myRoom:''}`;
    if(el)el.textContent=txt;
    try{connInfo.title=txt;}catch{}
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  window.addEventListener('resize',renderPeers);

  // ---------- modals ----------
  function openModal(s){$(s).classList.remove('hidden')}
  function closeModal(s){$(s).classList.add('hidden')}
  document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.add('hidden')}));
  // Esc closes any open modal (checkboxes / inputs keep their state).
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape')return;
    document.querySelectorAll('.modal:not(.hidden)').forEach(m=>{
      if(m.id==='previewModal')stopPreview();
      if(m.id==='sendModal'){clearSendPreview();sendFiles=null;sendIntent=null;}
      m.classList.add('hidden');
    });
  });

  // ---------- device manager (trust / block / remove) ----------
  const _btnDevices=$('#btnDevices');if(_btnDevices)_btnDevices.onclick=()=>{renderDeviceModal();openModal('#devicesModal');};
  const _btnCloseDevices=$('#btnCloseDevices');if(_btnCloseDevices)_btnCloseDevices.onclick=()=>closeModal('#devicesModal');
  function deviceRow(d){
    const col=/^#[0-9a-fA-F]{6}$/.test(d.color||'')?d.color:'#6366f1';
    return `<div class="device-row">
      <span class="device-avatar" style="background:${col}33;border-color:${col}">${escapeHtml(String(d.avatar||'📦').slice(0,4))}</span>
      <span class="device-name"><strong>${escapeHtml(d.name||'Device')}</strong><small>${escapeHtml(d.sub||'')}</small></span>
      <span class="device-actions">${d.actions||''}</span>
    </div>`;
  }
  function deviceListHtml(list,emptyMsg){
    return list.length?list.map(deviceRow).join(''):`<p class="muted small">${emptyMsg}</p>`;
  }
  function renderDeviceModal(){
    const known=$('#deviceKnown'),saved=$('#deviceSaved');
    if(!known||!saved)return;
    // Show ALL peers here (incl. blocked) so a blocked device can be unblocked.
    // Peers without a deviceId yet are mid-handshake (hello not processed) —
    // skip them until the next peer-list update rather than offering a dead button.
    const nearby=peers.filter(p=>p.deviceId).map(p=>{
      const rec=peerRecord(p),trusted=!!(rec&&rec.trust),blocked=!!(rec&&rec.block);
      const cid=escapeHtml(p.deviceId||'');
      const nm=escapeHtml(p.name||'Device'),av=escapeHtml(p.avatar||'📦');
      return{avatar:p.avatar,name:p.name,color:p.color,
        sub:`${p.mode==='room'?'🌐 '+(p.room||'room'):p.mode==='both'?'📶+🌐 wifi+room':'📶 wifi'}${trusted?' • auto-accept ✓':''}${blocked?' • blocked':''}`,
        actions:`<button class="btn small ${trusted?'primary':''}" data-dev-act="trust" data-cid="${cid}" data-name="${nm}" data-avatar="${av}">${trusted?'🔐 Trusted':'Trust'}</button>`+
                `<button class="btn small ${blocked?'danger-ghost':''}" data-dev-act="block" data-cid="${cid}" data-name="${nm}" data-avatar="${av}">${blocked?'Unblock':'Block'}</button>`};
    });
    known.innerHTML=deviceListHtml(nearby,'No devices nearby yet — open sdfdrop on the other device first.');
    const remembered=Object.entries(devices).map(([cid,rec])=>({avatar:rec.avatar,name:rec.name,color:undefined,
      sub:`${rec.trust?'🔐 auto-accept':''}${rec.trust&&rec.block?' • ':''}${rec.block?'⛔ blocked':''}${!rec.trust&&!rec.block?'stored':''}`,
      actions:(rec.trust?`<button class="btn small" data-dev-act="trust" data-cid="${escapeHtml(cid)}" data-name="${escapeHtml(rec.name||'Device')}" data-avatar="${escapeHtml(rec.avatar||'📦')}">Revoke trust</button>`:'')+
              (rec.block?`<button class="btn small" data-dev-act="block" data-cid="${escapeHtml(cid)}" data-name="${escapeHtml(rec.name||'Device')}" data-avatar="${escapeHtml(rec.avatar||'📦')}">Unblock</button>`:'')+
              `<button class="btn small danger-ghost" data-dev-act="remove" data-cid="${escapeHtml(cid)}">Remove</button>`}));
    saved.innerHTML=deviceListHtml(remembered,'No saved devices. Trust or block a nearby device to add it here.');
  }
  function onDeviceAction(e){
    const b=e.target.closest('button[data-dev-act]');if(!b)return;
    const cid=b.dataset.cid;if(!cid)return;
    const name=b.dataset.name||'Device',avatar=b.dataset.avatar||'📦';
    const act=b.dataset.devAct;
    if(act==='trust'){
      const cur=devices[cid]||{};const trust=!cur.trust;
      updateDevice(cid,name,avatar,{trust,block:trust?false:!!cur.block});
      toast(trust?'Device trusted — files auto-accept ✓':'Trust removed — Accept taps back on','ok');
    }else if(act==='block'){
      const cur=devices[cid]||{};const block=!cur.block;
      updateDevice(cid,name,avatar,{block,trust:block?false:!!cur.trust});
      toast(block?'Device blocked — hidden & ignored ⛔':'Device unblocked','info');
    }else if(act==='remove'){
      delete devices[cid];saveDevices();toast('Device removed from this browser','info');
    }
    renderDeviceModal();renderPeers();
  }
  $('#deviceKnown')?.addEventListener('click',onDeviceAction);
  $('#deviceSaved')?.addEventListener('click',onDeviceAction);

  // ---------- file preview (images / video / audio / PDF / text) ----------
  function previewKind(mime,name){
    const m=String(mime||'').toLowerCase(),n=String(name||'').toLowerCase();
    if(m.startsWith('image/'))return'image';
    if(m.startsWith('video/'))return'video';
    if(m.startsWith('audio/'))return'audio';
    if(m==='application/pdf'||n.endsWith('.pdf'))return'pdf';
    if(m.startsWith('text/')||/\.(txt|md|csv|json|js|css|html|htm|xml|log|ya?ml|ts|py|sh|ini)$/.test(n))return'text';
    return null;
  }
  function pauseMedia(container){
    if(!container)return;
    for(const el of container.querySelectorAll('video,audio')){try{el.pause();el.removeAttribute('src');el.load?.();}catch{}}
  }
  function stopPreview(){const body=$('#previewBody');pauseMedia(body);if(body)body.innerHTML='';}
  function pdfLinks(url,name){
    const bar=document.createElement('div');bar.className='pdf-actions';
    const open=document.createElement('a');open.className='btn small primary';open.textContent='Open PDF ↗';
    open.href=url;open.target='_blank';open.rel='noopener';bar.appendChild(open);
    const dl=document.createElement('a');dl.className='btn small';dl.textContent='Download ⬇';
    dl.href=url;dl.download=name||'document.pdf';bar.appendChild(dl);
    return bar;
  }
  async function renderPreview(container,url,mime,name){
    if(!container||!url)return false;
    const kind=previewKind(mime,name);if(!kind)return false;
    pauseMedia(container);container.innerHTML='';
    if(kind==='image'){
      const img=document.createElement('img');img.src=url;img.alt=name||'Preview';container.appendChild(img);
    }else if(kind==='video'){
      const v=document.createElement('video');v.src=url;v.controls=true;v.playsInline=true;container.appendChild(v);
    }else if(kind==='audio'){
      const a=document.createElement('audio');a.src=url;a.controls=true;container.appendChild(a);
    }else if(kind==='pdf'){
      // Phone browsers generally refuse to display a blob: PDF inside an
      // iframe (Chrome Android / iOS Safari show an error). Give them a
      // tap-to-open / download path; desktop keeps the inline viewer plus
      // the same buttons as a fallback.
      const mobilePdf=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||'')||
        matchMedia('(pointer:coarse)').matches||Math.min(innerWidth,innerHeight)<=700;
      if(mobilePdf){
        const box=document.createElement('div');box.className='pdf-fallback';
        const icon=document.createElement('div');icon.className='pdf-icon';icon.textContent='📄';box.appendChild(icon);
        const strong=document.createElement('strong');strong.textContent=name||'PDF';box.appendChild(strong);
        const p=document.createElement('p');p.className='muted small';
        p.textContent='This browser can’t show PDFs inline. Open it or save it instead.';box.appendChild(p);
        box.appendChild(pdfLinks(url,name));container.appendChild(box);
      }else{
        const wrap=document.createElement('div');wrap.className='pdf-embed';
        const f=document.createElement('iframe');f.src=url;f.title=name||'PDF';wrap.appendChild(f);
        wrap.appendChild(pdfLinks(url,name));container.appendChild(wrap);
      }
    }else{
      const pre=document.createElement('pre');pre.textContent='Loading…';container.appendChild(pre);
      try{const r=await fetch(url);pre.textContent=(await r.text()).slice(0,200000);}catch{pre.textContent='Could not read this file.';}
    }
    return true;
  }
  async function openPreview(url,mime,name){
    if(!previewKind(mime,name)||!url)return;
    const body=$('#previewBody');stopPreview();
    $('#previewTitle').textContent=`👁 ${name||'Preview'}`;
    await renderPreview(body,url,mime,name);
    openModal('#previewModal');
  }
  const _btnClosePreview=$('#btnClosePreview');if(_btnClosePreview)_btnClosePreview.onclick=()=>{stopPreview();closeModal('#previewModal');};
  $('#previewModal')?.addEventListener('click',e=>{if(e.target.id==='previewModal')stopPreview();});

  // ---------- pre-send preview + confirm (nothing leaves until Send is tapped) ----------
  let sendFiles=null,sendIntent=null,sendPreviewUrl=null;
  function clearSendPreview(){
    const box=$('#sendPreview');pauseMedia(box);
    if(box){box.innerHTML='';box.classList.add('hidden');}
    if(sendPreviewUrl){try{URL.revokeObjectURL(sendPreviewUrl)}catch{}sendPreviewUrl=null;}
  }
  function queueSend(files,intent){
    if(!files||!files.length)return;
    sendFiles=files;sendIntent=intent||{kind:'auto'};
    renderSendModal();openModal('#sendModal');
  }
  function renderSendModal(){
    clearSendPreview();
    const intent=sendIntent||{kind:'auto'};
    let dest='nearby devices';
    if(intent.kind==='peer'&&intent.peer)dest=intent.peer.name;
    else if(intent.kind==='room')dest=`Room ${intent.room}`;
    else if(intent.kind==='all')dest='all nearby devices';
    const total=sendFiles.reduce((n,f)=>n+(f.size||0),0);
    $('#sendModalTitle').textContent=sendFiles.length===1?'📤 Ready to send':`📤 Ready to send ${sendFiles.length} files`;
    $('#sendModalMeta').textContent=`To: ${dest} • ${fmtSize(total)}${sendFiles[0]?.isVirtualZip?' • folder ZIP':''}`;
    $('#sendFileList').innerHTML=sendFiles.slice(0,12).map(f=>`<div><span>${escapeHtml(f.name||'file')}</span><span class="muted">${fmtSize(f.size)}</span></div>`).join('')+(sendFiles.length>12?`<div class="muted">…and ${sendFiles.length-12} more</div>`:'');
    const f=sendFiles[0];
    if(sendFiles.length===1&&f&&!f.isVirtualZip&&previewKind(f.type||'',f.name||'')){
      try{
        sendPreviewUrl=URL.createObjectURL(f);
        const box=$('#sendPreview');box.classList.remove('hidden');
        renderPreview(box,sendPreviewUrl,f.type||'',f.name||'');
      }catch{}
    }
  }
  const _btnCancelSend=$('#btnCancelSend');
  if(_btnCancelSend)_btnCancelSend.onclick=()=>{clearSendPreview();sendFiles=null;sendIntent=null;closeModal('#sendModal');};
  const _btnConfirmSend=$('#btnConfirmSend');
  if(_btnConfirmSend)_btnConfirmSend.onclick=async()=>{
    const files=sendFiles,intent=sendIntent||{kind:'auto'};
    clearSendPreview();sendFiles=null;sendIntent=null;closeModal('#sendModal');
    await executeSend(files,intent);
  };
  $('#sendModal')?.addEventListener('click',e=>{if(e.target.id==='sendModal'){clearSendPreview();sendFiles=null;sendIntent=null;}});

  // ---------- streaming folder → ZIP (no library, no whole-folder buffering) ----------
  // Presents a File-like object whose slice() synthesizes ZIP bytes on demand,
  // so the existing P2P / relay / room pipeline works unchanged. Store method
  // + data descriptors; CRC32 is computed as each chunk is read. No 4GB+ files.
  const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
  function crcUpdate(state,buf){const u=new Uint8Array(buf);let c=state.crc;for(let i=0;i<u.length;i++)c=CRC_TABLE[(c^u[i])&255]^(c>>>8);state.crc=c>>>0;}
  function crcFinal(state){return(state.crc^0xFFFFFFFF)>>>0;}
  const u16=(v)=>[v&255,(v>>8)&255];
  const u32=(v)=>[v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255];
  function joinBytes(parts){let n=0;for(const p of parts)n+=p.length;const out=new Uint8Array(n);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;}
  async function makeZipFile(entries,rootName){
    const enc=new TextEncoder(),now=new Date();
    const dosTime=((now.getHours()&31)<<11)|((now.getMinutes()&63)<<5)|((now.getSeconds()&31)>>1);
    const dosDate=(((now.getFullYear()-1980)&127)<<9)|(((now.getMonth()+1)&15)<<5)|(now.getDate()&31);
    const metas=entries.map(e=>{
      const name=String(e.path||e.file.webkitRelativePath||e.file.name).replace(/\\/g,'/');
      return{file:e.file,name,nameBytes:enc.encode(name),size:name.endsWith('/')?0:(e.file.size||0),isDir:name.endsWith('/'),crc:{crc:0xFFFFFFFF}};
    });
    let offset=0;
    for(const m of metas){m.localOffset=offset;m.headerLen=30+m.nameBytes.length;offset+=m.headerLen+m.size+16;}
    const centralStart=offset;
    let centralLen=0;for(const m of metas)centralLen+=46+m.nameBytes.length;
    const total=centralStart+centralLen+22;
    if(total>0xFFFFFFF0)return null; // ZIP32 limit
    const segs=[];
    for(let i=0;i<metas.length;i++){
      const m=metas[i],b=m.localOffset;
      segs.push({start:b,len:m.headerLen,kind:'header',i});
      if(m.size)segs.push({start:b+m.headerLen,len:m.size,kind:'data',i});
      segs.push({start:b+m.headerLen+m.size,len:16,kind:'desc',i});
    }
    segs.push({start:centralStart,len:centralLen,kind:'central'});
    segs.push({start:centralStart+centralLen,len:22,kind:'eocd'});
    const FLAGS=0x0808; // bit 3 = data descriptor, bit 11 = UTF-8 names
    const localHeader=(m)=>new Uint8Array([
      ...u32(0x04034b50),...u16(20),...u16(FLAGS),...u16(0),...u16(dosTime),...u16(dosDate),
      ...u32(0),...u32(0),...u32(0),...u16(m.nameBytes.length),...u16(0),...m.nameBytes
    ]);
    const descriptor=(m)=>new Uint8Array([...u32(0x08074b50),...u32(crcFinal(m.crc)),...u32(m.size),...u32(m.size)]);
    const centralDir=()=>joinBytes(metas.map(m=>new Uint8Array([
      ...u32(0x02014b50),...u16(20),...u16(20),...u16(FLAGS),...u16(0),...u16(dosTime),...u16(dosDate),
      ...u32(crcFinal(m.crc)),...u32(m.size),...u32(m.size),
      ...u16(m.nameBytes.length),...u16(0),...u16(0),...u16(0),...u16(0),
      ...u32(m.isDir?0x00100000:0),...u32(m.localOffset),...m.nameBytes
    ])));
    const eocd=()=>new Uint8Array([
      ...u32(0x06054b50),...u16(0),...u16(0),...u16(metas.length),...u16(metas.length),
      ...u32(centralLen),...u32(centralStart),...u16(0)
    ]);
    async function buildRange(start,len){
      const parts=[];
      for(const seg of segs){
        const from=Math.max(start,seg.start),to=Math.min(start+len,seg.start+seg.len);
        if(to<=from)continue;
        const rel=from-seg.start,take=to-from;
        if(seg.kind==='data'){
          const m=metas[seg.i],buf=await m.file.slice(rel,rel+take).arrayBuffer();
          crcUpdate(m.crc,buf);parts.push(new Uint8Array(buf));
        }else if(seg.kind==='header')parts.push(localHeader(metas[seg.i]).subarray(rel,rel+take));
        else if(seg.kind==='desc')parts.push(descriptor(metas[seg.i]).subarray(rel,rel+take));
        else if(seg.kind==='central')parts.push(centralDir().subarray(rel,rel+take));
        else parts.push(eocd().subarray(rel,rel+take));
      }
      return joinBytes(parts).buffer;
    }
    // Build the whole archive once into a real Blob. The old on-demand slice
    // generator was fragile across browsers/transports (0-byte downloads).
    // ~4GB cap keeps memory bounded; normal classroom folders are far smaller.
    const bytes=await buildRange(0,total);
    const blob=new Blob([bytes],{type:'application/zip'});
    return{
      name:String(rootName||'folder').replace(/[^\w.\- ]+/g,'_').slice(0,60)+'.zip',
      size:blob.size,type:'application/zip',isVirtualZip:true,
      slice(start,end){return blob.slice(start,end);}
    };
  }
  const EMPTY_FILE={size:0,slice(){return{arrayBuffer:async()=>new ArrayBuffer(0)}}};
  async function entriesFromDrop(dt){
    const items=[...(dt.items||[])].filter(i=>i.kind==='file');
    if(items.length&&items[0].webkitGetAsEntry){
      const out=[];
      const walk=async(entry,prefix)=>{
        if(!entry)return;
        if(entry.isFile){
          const f=await new Promise(res=>entry.file(res,()=>res(null)));
          if(f)out.push({file:f,path:prefix+entry.name});
        }else if(entry.isDirectory){
          out.push({file:EMPTY_FILE,path:prefix+entry.name+'/'});
          const reader=entry.createReader();let batch;
          do{batch=await new Promise(res=>reader.readEntries(res,()=>res([])));
            for(const child of batch)await walk(child,prefix+entry.name+'/');
          }while(batch.length);
        }
      };
      for(const it of items)await walk(it.webkitGetAsEntry(),'');
      if(out.length)return out;
    }
    return [...(dt.files||[])].map(f=>({file:f,path:f.name}));
  }
  function folderRoot(entries){
    for(const e of entries){const i=(e.path||'').indexOf('/');if(i>0)return e.path.slice(0,i);}
    return'folder';
  }

  // ---------- file picking ----------
  let targetPeer=null,sendIntentGlobal=null;
  const fileInput=$('#fileInput');
  function destinationIntent(){
    if($('#chkBroadcast').checked)return{kind:'all'};
    if(targetPeer&&!peerBlocked(targetPeer))return{kind:'peer',peer:targetPeer};
    const list=activePeers();
    return list.length===1?{kind:'peer',peer:list[0]}:{kind:'auto'};
  }
  async function executeSend(files,intent){
    if(!files||!files.length)return;
    if(intent.kind==='room'){
      if(!myRoom){toast('Join a room first 🔗','err');return;}
      await sendRoomFiles(intent.room||myRoom,files);return;
    }
    if(intent.kind==='all'){await sendToAll(files);return;}
    if(intent.kind==='peer'&&intent.peer){await sendFilesTo(intent.peer,files);return;}
    const list=activePeers();
    if(list.length===1){await sendFilesTo(list[0],files);return;}
    if(list.length>1){await sendFilesTo(list[0],files);toast(`Sent to ${list[0].name} (tap another device to choose)`,'info');return;}
    toast('No devices nearby yet','err');
  }
  async function readDirHandle(handle,root){
    const out=[];
    const walk=async(h,path)=>{
      for await(const [name,child] of h.entries()){
        const p=path+name;
        if(child.kind==='directory'){out.push({file:EMPTY_FILE,path:p+'/'});await walk(child,p+'/');}
        else if(child.kind==='file'){try{out.push({file:await child.getFile(),path:p});}catch{}}
      }
    };
    await walk(handle,'');
    for(const e of out)e.path=root+'/'+e.path;
    return out;
  }
  async function pickFolderEntries(){
    // Chromium desktop: true directory picker (works on PC, keeps empty dirs).
    if(typeof window.showDirectoryPicker==='function'&&window.isSecureContext){
      try{
        const dir=await window.showDirectoryPicker();
        const entries=await readDirHandle(dir,dir.name||'folder');
        if(entries.length)return entries;
      }catch(e){if(e&&e.name==='AbortError')return null;}
    }
    // Mobile / other browsers: multi-file picker + a folder name. webkitdirectory
    // is too unreliable (often yields zero files), so it is not used here.
    const files=await pickFiles();
    if(!files||!files.length)return null;
    const root=prompt('Folder name for these files:','SharedFolder');
    if(root===null)return null;
    const clean=String(root).trim().replace(/[\\/]/g,'')||'SharedFolder';
    return files.map(f=>({file:f,path:clean+'/'+(f.webkitRelativePath||f.name)}));
  }
  async function queueFolder(intent){
    const entries=await pickFolderEntries();
    if(!entries){return;}
    if(!entries.length){toast('No files found in that folder','err');return;}
    const zip=await makeZipFile(entries,folderRoot(entries));
    if(!zip||zip.size<=22){toast('No files found in that folder','err');return;}
    queueSend([zip],intent);
  }
  const _btnSendFolder=$('#btnSendFolder');
  if(_btnSendFolder)_btnSendFolder.onclick=()=>{
    const list=activePeers();
    if(!list.length){toast('No devices nearby — or use a Room','err');return;}
    if(!(targetPeer&&!peerBlocked(targetPeer))){
      if(list.length===1)targetPeer=list[0];
      else{toast('Tap a device first, then send the folder 👆','info');return;}
    }
    queueFolder(destinationIntent());
  };
  const _btnSendRoomFolder=$('#btnSendRoomFolder');
  if(_btnSendRoomFolder)_btnSendRoomFolder.onclick=()=>{
    if(!myRoom){toast('Join a room first 🔗','err');openModal('#roomModal');return;}
    if(!roomPeerCount()){toast('Nobody else in this room yet','err');return;}
    queueFolder({kind:'room',room:myRoom});
  };
  function askAndSend(peer){
    targetPeer=peer;
    fileInput.click();
  }
  $('#btnSendRoom').onclick=()=>{
    if(!myRoom){toast('Join a room first 🔗','err');openModal('#roomModal');return;}
    if(!roomPeerCount()){toast('Nobody else in this room yet','err');return;}
    sendIntentGlobal={kind:'room',room:myRoom};fileInput.click();
  };
  $('#btnSendFiles').onclick=()=>{
    const list=activePeers();
    if(list.length===0){toast('No devices nearby — open sdfdrop on the other device first','err');openModal('#qrModal');$('#qrLink').textContent=roomLink();drawQR($('#qrCanvas'),roomLink());return;}
    if(list.length===1){targetPeer=list[0];sendIntentGlobal=destinationIntent();fileInput.click();}
    else if($('#chkBroadcast').checked){sendIntentGlobal={kind:'all'};fileInput.click();}
    else {toast('Tap a device to send to it 👆','info');}
  };
  fileInput.onchange=()=>{
    const files=[...fileInput.files];fileInput.value='';
    if(!files.length)return;
    queueSend(files,sendIntentGlobal||destinationIntent());
    sendIntentGlobal=null;
  };
  async function sendToAll(files){
    if(!files?.length)return;
    const list=activePeers();
    if(!list.length){toast('Nobody to send to','err');return;}
    toast(`Sending to ${list.length} device(s)…`,'info');
    for(const p of list){sendFilesTo(p,files).catch(e=>toast(`Failed → ${p.name}: ${e.message}`,'err'));}
  }
  function pickFiles(){return new Promise(res=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.onchange=()=>res([...i.files]);i.click();setTimeout(()=>res(null),60000);});}

  // ---------- room broadcast (teacher → whole room, one upload) ----------
  const ROOM_ACCEPT_WAIT_MS = 45000;
  async function sendRoomFiles(room, files){
    for(const f of files)await sendOneRoomFile(room,f);
  }
  async function sendOneRoomFile(room, file){
    if(file.size>RELAY_MAX_BYTES){toast('File too big','err');return;}
    const id=uid(6);
    const n=roomPeerCount();
    const ui=addTransfer({id,name:file.name,size:file.size,peerName:`Room ${room} (${n})`,dir:'up',mode:'room'});
    const act=ui.el.querySelector('.t-act'), stEl=ui.el.querySelector('.st');
    const bw={accepted:new Set(),room,started:false,onAccept:null};
    broadcastWaits.set(id,bw);
    send({type:'broadcast',room,data:{kind:'file-header',id,name:file.name,size:file.size,mime:file.type||'application/octet-stream'}});
    const sendCancel=()=>{send({type:'broadcast',room,data:{kind:'file-cancelled',id}});broadcastWaits.delete(id);};
    // chain the default ✕ Cancel so the room is notified too
    const cancelBtn=act.querySelector('button');
    if(cancelBtn){const prev=cancelBtn.onclick;cancelBtn.onclick=()=>{try{prev&&prev()}catch{}clearTimeout(timer);if(!bw.started)sendCancel();broadcastWaits.delete(id);};}
    const sendBtn=document.createElement('button');sendBtn.className='btn small primary';sendBtn.style.marginTop='6px';
    const paintBtn=()=>{sendBtn.textContent=`📢 Send now (${bw.accepted.size}/${roomPeerCount()})`;};
    paintBtn();
    bw.onAccept=()=>{paintBtn();stEl.textContent=`Room ${room} • waiting for accepts (${bw.accepted.size})…`;};
    stEl.textContent=`Room ${room} • waiting for accepts (0)… ask everyone to tap Accept`;
    async function start(){
      if(bw.started||ui.cancelled)return;bw.started=true;
      sendBtn.remove();clearTimeout(timer);
      stEl.textContent=`Room ${room} • broadcasting to ${bw.accepted.size} accepted…`;
      let seq=0; // RELAY_BIN_STEP → just under the server chunk cap
      for(let off=0;off<file.size;off+=RELAY_BIN_STEP){
        if(ui.cancelled){sendCancel();return;}
        const buf=await file.slice(off,off+RELAY_BIN_STEP).arrayBuffer();
        send({type:'broadcast',room,data:{kind:'file-chunk',id,seq:seq++,chunk:b64encode(buf),last:off+RELAY_BIN_STEP>=file.size}});
        ui.update(Math.min(file.size,off+RELAY_BIN_STEP));
        while(ws&&typeof ws.bufferedAmount==='number'&&ws.bufferedAmount>1024*1024){await new Promise(r=>setTimeout(r,20));}
      }
      send({type:'broadcast',room,data:{kind:'file-done',id}});
      ui.done(null);
      if(!file.isVirtualZip){try{const u=URL.createObjectURL(file);trackBlobUrl(u);ui.setPreview(u,file.type||'',file.name);}catch{}}
      broadcastWaits.delete(id);
      toast(`Broadcast ${file.name} → Room ${room} ✓`,'ok');
      const re=document.createElement('button');re.className='btn small';re.textContent='↻ Resend to room';re.style.marginTop='6px';
      re.onclick=()=>sendRoomFiles(room,[file]); // stragglers who accepted late
      act.appendChild(re);
    }
    sendBtn.onclick=()=>{if(!ui.cancelled)start();};
    act.prepend(sendBtn);
    const timer=setTimeout(()=>{if(ui.cancelled){sendCancel();return;}toast('Auto-sending to accepted devices…','info');start();},ROOM_ACCEPT_WAIT_MS);
  }

  // drag & drop anywhere
  ['dragover','drop'].forEach(ev=>window.addEventListener(ev,e=>{e.preventDefault();}));
  window.addEventListener('drop',async e=>{
    const items=[...(e.dataTransfer.items||[])];
    if(items.some(i=>i.kind==='file'&&i.webkitGetAsEntry&&i.webkitGetAsEntry()?.isDirectory)){
      const entries=await entriesFromDrop(e.dataTransfer);
      if(!entries.length){toast('No files found in that folder','err');return;}
      const zip=await makeZipFile(entries,folderRoot(entries));
      if(!zip||zip.size<=22){toast('No files found in that folder','err');return;}
      queueSend([zip],destinationIntent());
      return;
    }
    const files=[...e.dataTransfer.files];
    if(!files.length)return;
    queueSend(files,destinationIntent());
  });

  // ---------- text ----------
  let textPeer=null;
  function openText(peer){textPeer=peer||activePeers()[0];$('#textTargetLabel').textContent=textPeer?`To: ${textPeer.name}`:'No devices nearby';$('#textInput').value='';const rb=$('#btnDoSendRoomText');if(rb)rb.style.display=myRoom?'':'none';openModal('#textModal');setTimeout(()=>$('#textInput').focus(),50);}
  $('#btnText').onclick=()=>{const l=activePeers();if(!l.length)return toast('No devices nearby','err');openText(l[0]);};
  $('#btnSendText2').onclick=()=>{const l=activePeers();if(!l.length)return toast('No devices nearby','err');openText((targetPeer&&!peerBlocked(targetPeer))?targetPeer:l[0]);};
  $('#btnCloseText').onclick=()=>closeModal('#textModal');
  $('#btnDoSendRoomText').onclick=async()=>{
    const t=$('#textInput').value.trim();if(!t||!myRoom)return;
    if(t.length>8192){toast('Message too long (8KB max)','err');return;}
    closeModal('#textModal');
    const id=uid(6);
    send({type:'broadcast',room:myRoom,data:{kind:'text',id,text:t}});
    addTransfer({id,name:'Announcement 📢',size:t.length,peerName:`Room ${myRoom}`,dir:'up',mode:'room'}).done(null);
    toast(`Announcement → Room ${myRoom} ✓`,'ok');
  };
  $('#btnDoSendText').onclick=async()=>{
    const t=$('#textInput').value.trim();if(!t)return;
    closeModal('#textModal');
    const list=activePeers();
    const dests=$('#chkBroadcast').checked?list:((textPeer&&!peerBlocked(textPeer))?[textPeer]:list.slice(0,1));
    for(const p of dests)await sendTextTo(p,t);
  };

  // ---------- WebRTC (P2P strongly preferred; WS relay is last fallback) ----------
  function rtcConfig(){return{iceServers,sdpSemantics:'unified-plan'};}
  // Policy: always attempt WebRTC first and let the browser ICE agent pick the
  // real path (host/srflx/prflx/relay). Never force iceTransportPolicy:'relay'.
  // WS file relay is used only after genuine P2P failure. Room broadcast is
  // intentionally server-mediated and untouched by this state machine.
  const P2P_CONNECT_TIMEOUT = 15000; // wait for slow ICE; do NOT cut over after 4s
  const P2P_DISCONNECT_TIMEOUT = 5000; // recovery window for transient 'disconnected'
  function logP2P(peerId,msg){try{console.log(`[sdfdrop] peer=${peerId} ${msg}`);}catch{}}
  function isP2PMode(m){return m==='p2p'||(typeof m==='string'&&m.indexOf('p2p-')===0);}
  // Actual selected ICE candidate pair -> real path. Never infer LAN from the
  // server's discovery/mode flag; only from the selected pair. Tolerates modern
  // mDNS-obfuscated host candidates (type is still 'host' even when the address
  // is 'xxx.local' instead of a literal 192.168.x.x).
  async function getConnectionPath(pc){
    try{
      const stats=await pc.getStats();
      const locals=new Map(), remotes=new Map();
      let sel=null, fallback=null;
      stats.forEach(s=>{
        if(s.type==='local-candidate')locals.set(s.id,s);
        else if(s.type==='remote-candidate')remotes.set(s.id,s);
        else if(s.type==='candidate-pair'){
          if(s.state==='succeeded'&&(s.nominated||s.selected))sel=s;
          else if(s.state==='succeeded'&&!fallback)fallback=s;
        }
      });
      const pair=sel||fallback;
      if(!pair)return{path:'unknown',localType:'unknown',remoteType:'unknown'};
      const lc=locals.get(pair.localCandidateId), rc=remotes.get(pair.remoteCandidateId);
      const localType=(lc&&(lc.candidateType||lc.type))||'unknown';
      const remoteType=(rc&&(rc.candidateType||rc.type))||'unknown';
      let path='unknown';
      if(localType==='relay'||remoteType==='relay')path='turn';
      else if(localType==='host'&&remoteType==='host')path='lan';
      else if(localType!=='unknown'&&remoteType!=='unknown')path='direct';
      return{path,localType:String(localType),remoteType:String(remoteType),
        localAddr:(lc&&(lc.address||lc.ip))||'',remoteAddr:(rc&&(rc.address||rc.ip))||''};
    }catch{return{path:'unknown',localType:'unknown',remoteType:'unknown'};}
  }
  function pathBadgeText(path){
    if(path==='lan')return'⚡ Direct P2P • LAN';
    if(path==='direct')return'⚡ Direct P2P';
    if(path==='turn')return'🟠 P2P via TURN';
    if(path==='relay')return'🌐 Server relay';
    return'P2P connected ✓';
  }
  function transferModeLabel(mode,path){
    if(mode==='room')return'📢 room';
    if(mode==='relay')return'🌐 Server relay';
    if(mode==='p2p-lan'||path==='lan')return'⚡ LAN P2P';
    if(mode==='p2p-turn'||path==='turn')return'🟠 P2P via TURN';
    if(mode==='p2p-direct')return'⚡ Direct P2P';
    if(mode==='p2p')return path==='lan'?'⚡ LAN P2P':path==='turn'?'🟠 P2P via TURN':'⚡ Direct P2P';
    return'⚡ Direct P2P';
  }
  function detailedP2PMode(c){
    if(!c||c.mode==='relay')return'relay';
    if(c.path==='lan')return'p2p-lan';
    if(c.path==='turn')return'p2p-turn';
    return'p2p-direct';
  }
  function resolveWaiters(c){
    const w=c.waiters||[];c.waiters=[];
    for(const r of w){try{r(c);}catch{}}
  }
  function clearConnTimers(c){
    if(c.connectTimer){clearTimeout(c.connectTimer);c.connectTimer=null;}
    if(c.disconnectTimer){clearTimeout(c.disconnectTimer);c.disconnectTimer=null;}
  }
  function destroyConn(peerId){
    const c=pcs.get(peerId);if(!c)return;
    clearConnTimers(c);
    try{c.dc?.close()}catch{}
    try{c.pc?.close()}catch{}
    pcs.delete(peerId);
  }
  function settleRelay(peerId,c,reason){
    if(!c||c.state==='relay')return;
    c.state='relay';c.mode='relay';c.ready=true;c.path='relay';c.pathDetail=null;
    clearConnTimers(c);
    netBadge.textContent='🌐 Server relay';
    logP2P(peerId,`→ WebSocket relay (${reason})`);
    resolveWaiters(c);
  }
  async function refreshPath(peerId,c){
    const info=await getConnectionPath(c.pc);
    if(c.state!=='relay'){
      if(info.path!=='unknown'){c.path=info.path;c.pathDetail=info;}
      // Second look shortly after connect: stats sometimes lack the nominated
      // pair on the very first getStats after dc open (slow TURN allocation).
      if((c.path==='unknown'||!c.path)&&info.path==='unknown'){
        setTimeout(async()=>{
          try{
            if(c.state!=='connected')return;
            const info2=await getConnectionPath(c.pc);
            if(info2.path!=='unknown'){c.path=info2.path;c.pathDetail=info2;
              netBadge.textContent=pathBadgeText(c.path);
              try{netBadge.title=`${info2.localType}/${info2.remoteType} → ${c.path}`;}catch{}
              if(info2.path==='lan')logP2P(peerId,`ICE ${info2.localType}/${info2.remoteType} → LAN P2P`);
              else if(info2.path==='direct')logP2P(peerId,`ICE ${info2.localType}/${info2.remoteType} → Direct P2P`);
              else if(info2.path==='turn')logP2P(peerId,`ICE ${info2.localType}/${info2.remoteType} → TURN`);
            }
          }catch{}
        },2000);
      }
    }
    if(c.state!=='relay'){
      const label=pathBadgeText(c.path);
      netBadge.textContent=label;
      try{netBadge.title=`${info.localType}/${info.remoteType} → ${c.path}`;}catch{}
    }
    if(info.path==='lan')logP2P(peerId,`ICE ${info.localType}/${info.remoteType} → LAN P2P`);
    else if(info.path==='direct')logP2P(peerId,`ICE ${info.localType}/${info.remoteType} → Direct P2P`);
    else if(info.path==='turn')logP2P(peerId,`ICE ${info.localType}/${info.remoteType} → TURN`);
    return info;
  }
  function settleConnected(peerId,c,via){
    const wasRelay=c.state==='relay';
    c.state='connected';c.mode='p2p';c.ready=true;c.dcOpen=true;
    if(c.connectTimer){clearTimeout(c.connectTimer);c.connectTimer=null;}
    if(c.disconnectTimer){clearTimeout(c.disconnectTimer);c.disconnectTimer=null;}
    // Refresh the real path (LAN vs direct vs TURN) then resolve waiters so the
    // transfer locks in the correct transport + label.
    refreshPath(peerId,c).then(()=>resolveWaiters(c));
    if(wasRelay)logP2P(peerId,`late P2P upgrade via ${via} (existing relay transfers stay on relay)`);
    else logP2P(peerId,`P2P connected via ${via}`);
  }
  function checkP2PState(peerId,c){
    if(!c||c.state==='connected'||c.state==='relay'){
      // Already decided — except: a 'disconnected' after 'connected' needs a
      // recovery window, and a late 'failed' after relay stays relay.
      if(c.state==='connected'){
        const cs=c.pc.connectionState, ice=c.pc.iceConnectionState;
        if(ice==='failed'||cs==='failed'){settleRelay(peerId,c,`ice failed after connect (${ice}/${cs})`);return;}
        if(ice==='disconnected'||cs==='disconnected'){
          if(!c.disconnectTimer){
            netBadge.textContent='P2P reconnecting…';
            logP2P(peerId,`ICE ${ice}/${cs} — waiting ${P2P_DISCONNECT_TIMEOUT}ms for recovery`);
            c.disconnectTimer=setTimeout(()=>{
              c.disconnectTimer=null;
              const ice2=c.pc.iceConnectionState, cs2=c.pc.connectionState;
              if(ice2==='connected'||ice2==='completed'||cs2==='connected'||(c.dc&&c.dc.readyState==='open')){
                logP2P(peerId,'recovered to P2P — continuing');
                return;
              }
              if(ice2==='failed'||cs2==='failed'||ice2==='disconnected'||cs2==='disconnected'||ice2==='closed'||cs2==='closed'){
                settleRelay(peerId,c,`disconnect timeout (${ice2}/${cs2})`);
              }
            },P2P_DISCONNECT_TIMEOUT);
          }
          return;
        }
        if(ice==='closed'||cs==='closed'){
          if(!c.dc||c.dc.readyState!=='open')settleRelay(peerId,c,`closed (${ice}/${cs})`);
          return;
        }
      }
      return;
    }
    const cs=c.pc.connectionState, ice=c.pc.iceConnectionState;
    if(ice==='connected'||ice==='completed'||cs==='connected'){
      // ICE found a path — wait for the DataChannel open to resolve; the
      // dc.onopen handler calls settleConnected. If the DC is already open,
      // settle now (covers stats-first ordering).
      if(c.dc&&c.dc.readyState==='open')settleConnected(peerId,c,`ice ${ice}/${cs}`);
      else{
        c.state='connecting';
        netBadge.textContent='P2P connecting…';
      }
      return;
    }
    if(ice==='failed'||cs==='failed'){
      settleRelay(peerId,c,`genuine ICE failure (${ice}/${cs})`);
      return;
    }
    if(ice==='disconnected'||cs==='disconnected'){
      if(!c.disconnectTimer){
        netBadge.textContent='P2P reconnecting…';
        logP2P(peerId,`ICE ${ice}/${cs} — waiting ${P2P_DISCONNECT_TIMEOUT}ms for recovery`);
        c.disconnectTimer=setTimeout(()=>{
          c.disconnectTimer=null;
          const ice2=c.pc.iceConnectionState, cs2=c.pc.connectionState;
          if(ice2==='connected'||ice2==='completed'||cs2==='connected'||(c.dc&&c.dc.readyState==='open')){
            if(c.dc&&c.dc.readyState==='open')settleConnected(peerId,c,'recovered');
            return;
          }
          settleRelay(peerId,c,`disconnect timeout (${ice2}/${cs2})`);
        },P2P_DISCONNECT_TIMEOUT);
      }
      return;
    }
    if(ice==='closed'||cs==='closed'){
      settleRelay(peerId,c,`closed (${ice}/${cs})`);
      return;
    }
    // Still negotiating (new/checking/connecting): keep waiting for ICE.
    // Do NOT fall back here — only the 15s connect timer may fall back.
    if(c.state==='new'){c.state='connecting';netBadge.textContent='P2P connecting…';}
  }
  // Dial new peers the moment they appear: the DataChannel is already open
  // when the user taps Send, so transfers start instantly (no offer/answer/
  // ICE/DTLS handshake in the critical path). Lower peer id dials — the rule
  // is identical on both sides, so they never offer at once (no glare).
  function warmConnections(){
    if(!myId)return;
    const list=activePeers();
    const seen=new Set(list.map(p=>p.id));
    for(const [pid]of pcs){
      if(!seen.has(pid))destroyConn(pid);
    }
    for(const p of list){
      if(pcs.has(p.id))continue;
      if(myId<p.id){try{getConn(p.id,true);}catch{}}
    }
  }
  function getConn(peerId, initiator){
    let c=pcs.get(peerId);
    if(c)return c;
    const pc=new RTCPeerConnection(rtcConfig());
    // Explicit state machine: 'new' → 'connecting' → 'connected' OR 'relay'.
    // 'ready' means a stable transport decision exists (P2P dc open, or relay
    // after genuine failure / 15s timeout). Never infer 'relay' from a short wait.
    c={pc,dc:null,dcOpen:false,ready:false,mode:'p2p',state:'new',path:'unknown',pathDetail:null,offered:false,waiters:[],connectTimer:null,disconnectTimer:null};
    pcs.set(peerId,c);
    pc.onicecandidate=(e)=>{if(e.candidate)send({type:'signal',to:peerId,data:{candidate:e.candidate}});};
    pc.onconnectionstatechange=()=>{checkP2PState(peerId,c);};
    pc.oniceconnectionstatechange=()=>{checkP2PState(peerId,c);};
    pc.ondatachannel=(e)=>{attachDC(peerId,e.channel);};
    const armConnectTimer=()=>{
      if(c.connectTimer)clearTimeout(c.connectTimer);
      c.connectTimer=setTimeout(()=>{
        c.connectTimer=null;
        if(c.state==='connected'||c.state==='relay')return;
        const ice=c.pc.iceConnectionState, cs=c.pc.connectionState;
        if(c.dc&&c.dc.readyState==='open'){settleConnected(peerId,c,'late connect-timer check');return;}
        if(ice==='connected'||ice==='completed'||cs==='connected'){
          // ICE found a path but the DataChannel hasn't opened yet (slow DTLS).
          // Give it one short grace window, then fall back if still unusable.
          logP2P(peerId,`ICE ${ice}/${cs} but no DataChannel yet — 5s grace`);
          c.connectTimer=setTimeout(()=>{
            c.connectTimer=null;
            if(c.state==='connected'||c.state==='relay')return;
            if(c.dc&&c.dc.readyState==='open'){settleConnected(peerId,c,'grace-period dc open');return;}
            settleRelay(peerId,c,`no DataChannel after grace (${c.pc.iceConnectionState}/${c.pc.connectionState})`);
          },5000);
          return;
        }
        settleRelay(peerId,c,`connect timeout ${P2P_CONNECT_TIMEOUT}ms (${ice}/${cs})`);
      },P2P_CONNECT_TIMEOUT);
    };
    armConnectTimer();
    if(initiator){
      const dc=pc.createDataChannel('sdfdrop',{ordered:true});
      attachDC(peerId,dc);
      pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>{
        send({type:'signal',to:peerId,data:{sdp:pc.localDescription}});
      }).catch(()=>{settleRelay(peerId,c,'offer failed');});
    }
    return c;
  }
  function attachDC(peerId,dc){
    const c=pcs.get(peerId);if(!c)return;
    c.dc=dc;dc.binaryType='arraybuffer';
    dc.onopen=()=>{settleConnected(peerId,c,'datachannel open');};
    dc.onclose=()=>{c.dcOpen=false;if(c.state!=='relay')c.ready=false;checkP2PState(peerId,c);};
    dc.onmessage=(e)=>{
      if(typeof e.data==='string'){try{handlePacket(peerId,JSON.parse(e.data),'p2p')}catch{}}
      else handleBinary(peerId,e.data,'p2p');
    };
    // backpressure helper
    dc.bufferedAmountLowThreshold=256*1024;
  }
  async function onSignal(from,data){
    try{
      let c=pcs.get(from);
      if(data.sdp){
        if(!c)c=getConn(from,false);
        else if(data.sdp.type==='offer'&&c.pc.signalingState==='have-local-offer'){
          // Glare (both offered): designated dialer wins, the other stands down.
          if(myId&&from&&myId<from)return;
          destroyConn(from);
          c=getConn(from,false);
        }
        await c.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if(data.sdp.type==='offer'){
          const ans=await c.pc.createAnswer();await c.pc.setLocalDescription(ans);
          send({type:'signal',to:from,data:{sdp:c.pc.localDescription}});
        }
      } else if(data.candidate){
        if(!c)return;
        try{await c.pc.addIceCandidate(new RTCIceCandidate(data.candidate));}catch{}
      }
    }catch(e){console.warn('signal err',e);}
  }
  // Waits for a GENUINE transport decision: P2P connected (dc open) OR relay
  // after genuine ICE failure / 15s timeout. Never resolves 'relay' early.
  function waitReady(peerId, initiator=true){
    const c=getConn(peerId,initiator);
    if(c.state==='connected'&&c.dc&&c.dc.readyState==='open')return Promise.resolve(c);
    if(c.state==='relay'&&c.ready)return Promise.resolve(c);
    // Add a hard timeout: after 30 s without a definitive transport decision, fallback to relay.
    const timeoutMs = 30000;
    let timeoutId;
    const timeoutPromise = new Promise(res => {
      timeoutId = setTimeout(() => {
        // If still not resolved, force relay fallback.
        if(c.state !== 'relay'){
          settleRelay(peerId, c, 'waitReady timeout');
        }
        res(c);
      }, timeoutMs);
    });
    const waitPromise = new Promise(res => {c.waiters.push(res);});
    return Promise.race([waitPromise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
  }

  // ---------- transfers UI ----------
  const blobUrls=[]; // revoke oldest so long sessions don't leak Blob memory
  function trackBlobUrl(url){
    blobUrls.push(url);
    while(blobUrls.length>20){const old=blobUrls.shift();try{URL.revokeObjectURL(old)}catch{}}
  }
  window.addEventListener('pagehide',()=>{for(const u of blobUrls){try{URL.revokeObjectURL(u)}catch{}}});
  function addTransfer({id,name,size,peerName,dir,mode,path}){
    transfersEl.querySelector('.muted')?.remove();
    const d=document.createElement('div');d.className='t-item';d.id='t-'+id;
    // Backward compatible: accepts legacy 'p2p'/'relay'/'room' plus detailed
    // 'p2p-lan'/'p2p-direct'/'p2p-turn'. Detailed path refines the label.
    const label=transferModeLabel(mode,path);
    d.innerHTML=`<div class="t-head"><strong>${dir==='up'?'📤':'📥'} ${escapeHtml(name)}</strong><span>${fmtSize(size)}</span></div>
      <progress max="100" value="0"></progress>
      <div class="t-sub"><span class="st">${dir==='up'?'To':'From'} ${escapeHtml(peerName)} • ${label}</span><span class="sp"></span></div>
      <div class="t-act"></div>`;
    transfersEl.prepend(d);
    const bar=d.querySelector('progress'),st=d.querySelector('.st'),sp=d.querySelector('.sp'),act=d.querySelector('.t-act');
    const t0=Date.now();
    let lastPaint=0,previewUrl='',previewMime='',previewName='';
    const ui={
      el:d, cancelled:false,
      setPreview(url,mime,name){
        if(!url||!previewKind(mime,name))return;
        previewUrl=url;previewMime=mime||'';previewName=name||'';
        const btn=document.createElement('button');btn.className='btn small';btn.textContent='👁 Preview';btn.style.marginTop='6px';
        btn.onclick=()=>openPreview(previewUrl,previewMime,previewName);
        act.appendChild(btn);
      },
      update(recv){
        const pct=size?Math.min(100,recv/size*100):100;
        // Throttle DOM writes to ~12fps during bulk chunk streaming — large
        // files emit tens of thousands of chunks and per-chunk layout thrash
        // is a real CPU sink. Always paint the final 100%.
        const now=Date.now();
        if(pct<100&&now-lastPaint<80)return;
        lastPaint=now;
        bar.value=pct;
        const dt=(now-t0)/1000,spd=dt>0.3?recv/dt:0;
        sp.textContent=`${pct.toFixed(0)}% • ${fmtSize(spd)}/s`;
      },
      done(link,label){
        bar.value=100;st.innerHTML+=` • <span style="color:#22c55e">done ✓</span>`;
        cancelBtn.remove();
        if(link){const a=document.createElement('a');a.href=link.url;a.download=link.name;a.textContent='⬇ '+(label||'Download');a.style.marginTop='6px';a.style.display='inline-block';act.appendChild(a);}
      },
      fail(msg){st.innerHTML+=` • <span style="color:#f87171">${escapeHtml(msg)}</span>`;cancelBtn.remove();}
    };
    const cancelBtn=document.createElement('button');cancelBtn.className='btn small';cancelBtn.textContent='✕ Cancel';cancelBtn.style.marginTop='6px';
    cancelBtn.onclick=()=>{ui.cancelled=true;ui.fail('cancelled');toast('Transfer cancelled','info');};
    act.appendChild(cancelBtn);
    return ui;
  }
  function fmtSize(b){if(!b&&b!==0)return'—';if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(2)+' GB';}
  // Clearing only resets the visible list — active transfers keep running in
  // the background (their UI refs simply detach from the DOM).
  const _btnClear=$('#btnClearTransfers');
  if(_btnClear)_btnClear.onclick=()=>{
    transfersEl.innerHTML='<p class="muted">Nothing yet. Files you send &amp; receive show up here with speed + progress.</p>';
    toast('Transfer list cleared','info');
  };

  // ---------- sending ----------
  async function sendFilesTo(peer,files){
    for(const f of files)await sendOneFile(peer,f);
  }
  function sendTransferCancel(peerId,id,mode='relay'){
    const c=pcs.get(peerId);
    if(isP2PMode(mode) && c?.dc?.readyState==='open'){
      try{c.dc.send(JSON.stringify({kind:'file-cancelled',id}));return;}catch{}
    }
    send({type:'relay',to:peerId,data:{kind:'file-cancelled',id}});
  }
  async function sendOneFile(peer,file){
    // Lock exactly one transport BEFORE the file header is sent. waitReady only
    // resolves on a stable decision (P2P dc open, or relay after genuine ICE
    // failure / 15s timeout), so a slow ICE negotiation never pushes a large
    // file onto the Render relay. The captured `transport` never changes for
    // this transfer — no split-brain P2P+relay mixing.
    const id=uid(6);
    const c=await waitReady(peer.id,true);
    const transport=(c.state==='relay'||c.mode==='relay')?'relay':'p2p';
    const uiMode=transport==='relay'?'relay':detailedP2PMode(c);
    const ui=addTransfer({id,name:file.name,size:file.size,peerName:peer.name,dir:'up',mode:uiMode,path:c.path});
    if(transport==='relay'){await sendFileRelay(peer,file,id,ui);return;}
    // p2p — waitReady guarantees an open DataChannel; re-check for the tiny
    // race where it closed between resolve and header send.
    const dc=c.dc;
    if(!dc||dc.readyState!=='open'){
      ui.fail('P2P dropped before start — retry to send');
      try{send({type:'relay',to:peer.id,data:{kind:'file-cancelled',id}});}catch{}
      return;
    }
    // header + wait accept (sent ONLY on the locked P2P transport)
    let acceptTimer=null;
    const accepted=new Promise((res,rej)=>{pendingAccept.set(id,{res,rej});acceptTimer=setTimeout(()=>rej(new Error('declined/timeout')),90000);});
    try{
      dc.send(JSON.stringify({kind:'file-header',id,name:file.name,size:file.size,mime:file.type||'application/octet-stream'}));
    }catch{
      clearTimeout(acceptTimer);
      ui.fail('P2P unavailable at start — retry to send');
      pendingAccept.delete(id);
      try{send({type:'relay',to:peer.id,data:{kind:'file-cancelled',id}});}catch{}
      return;
    }
    if(peerTrusted(peer))toast(`Sending to trusted device ${peer.name} (auto-accept)…`,'info');
    else toast(`Waiting for ${peer.name} to accept…`,'info');
    try{await accepted;}catch{ui.fail('declined / timed out');pendingAccept.delete(id);return;}
    finally{clearTimeout(acceptTimer);}
    pendingAccept.delete(id);
    if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}
    // Stream 64KB messages with backpressure: only pause when >2MB is still
    // queued, and wake on bufferedamountlow (no fixed per-chunk sleep).
    dc.bufferedAmountLowThreshold=512*1024;
    let offset=0;
    let p2pFailed=false;
    while(offset<file.size){
      if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}
      if(dc.readyState!=='open'){p2pFailed=true;break;}
      if(dc.bufferedAmount>2*1024*1024){await waitForBuffer(dc);if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}}
      if(dc.readyState!=='open'){p2pFailed=true;break;}
      const slice=file.slice(offset,offset+CHUNK);
      const buf=await slice.arrayBuffer();
      if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}
      if(dc.readyState!=='open'){p2pFailed=true;break;}
      try{dc.send(buf);}catch{p2pFailed=true;break;}
      offset+=buf.byteLength;ui.update(offset);
    }
    if(p2pFailed){
      // Mid-transfer P2P failure: the receiver already holds a P2P header +
      // partial binary chunks and cannot resume over relay (protocols differ:
      // binary vs base64, no resume offsets). Silently restarting the whole
      // file via relay would corrupt/duplicate it — fail loudly instead.
      pendingAccept.delete(id);
      try{send({type:'relay',to:peer.id,data:{kind:'file-cancelled',id}});}catch{}
      try{if(dc.readyState==='open')dc.send(JSON.stringify({kind:'file-cancelled',id}));}catch{}
      ui.fail(`P2P dropped at ${fmtSize(offset)} of ${fmtSize(file.size)} — retry to send`);
      toast('P2P connection dropped mid-transfer — file NOT completed. Please retry.','err');
      return;
    }
    try{dc.send(JSON.stringify({kind:'file-done',id}));}
    catch{
      try{send({type:'relay',to:peer.id,data:{kind:'file-cancelled',id}});}catch{}
      ui.fail('P2P dropped before finish — retry to send');
      return;
    }
    ui.done(null);
    if(!file.isVirtualZip){try{const u=URL.createObjectURL(file);trackBlobUrl(u);ui.setPreview(u,file.type||'',file.name);}catch{}}
    toast(`Sent ${file.name} → ${peer.name} ✓`,'ok');
  }
  function waitForBuffer(dc){
    return new Promise((res)=>{
      let done=false;
      const finish=()=>{if(!done){done=true;try{dc.onbufferedamountlow=null;}catch{}res();}};
      try{dc.onbufferedamountlow=()=>finish();}catch{return finish();}
      setTimeout(finish,250);
    });
  }
  async function sendTextTo(peer,text){
    const id=uid(6);
    if(text.length>8192){toast('Message too long (8KB max)','err');return;}
    // Prefer P2P; only use WS relay after a genuine P2P decision (failure /
    // 15s timeout). No short 4s race — small texts can wait for the right path.
    try{
      const c=await waitReady(peer.id,true);
      if(c.state!=='relay'&&c.mode!=='relay'&&c.dc&&c.dc.readyState==='open'){
        c.dc.send(JSON.stringify({kind:'text',id,text}));
        addTransfer({id,name:'Message ✉️',size:text.length,peerName:peer.name,dir:'up',mode:detailedP2PMode(c),path:c.path}).done(null);
      } else throw 0;
    }catch{
      send({type:'relay',to:peer.id,data:{kind:'text',id,text}});
      addTransfer({id,name:'Message ✉️',size:text.length,peerName:peer.name,dir:'up',mode:'relay'}).done(null);
    }
    toast(`Message sent → ${peer.name} ✓`,'ok');
  }

  // relay sender (base64 chunks over WS) — streams slice-by-slice with
  // socket backpressure instead of a fixed per-chunk sleep, so throughput
  // is limited by the network, not by an artificial delay.
  async function sendFileRelay(peer,file,id,ui){
    if(file.size>RELAY_MAX_BYTES){ui.fail('too big for relay — try same-WiFi P2P or a room resend');toast('File too big for relay','err');return;}
    const header={kind:'file-header',id,name:file.name,size:file.size,mime:file.type||'application/octet-stream'};
    send({type:'relay',to:peer.id,data:header});
    toast(`P2P unavailable — relaying via server 🌐`,'info');
    let acceptTimer=null;
    const accepted=new Promise((res,rej)=>{pendingAccept.set(id,{res,rej});acceptTimer=setTimeout(()=>rej(new Error('declined/timeout')),90000);});
    if(peerTrusted(peer))toast(`Sending to trusted device ${peer.name} (auto-accept)…`,'info');
    try{await accepted;}catch{ui.fail('declined / timed out');pendingAccept.delete(id);return;}
    finally{clearTimeout(acceptTimer);}
    pendingAccept.delete(id);
    if(ui.cancelled){sendTransferCancel(peer.id,id,'relay');return;}
    let seq=0; // RELAY_BIN_STEP → just under the server chunk cap
    for(let off=0;off<file.size;off+=RELAY_BIN_STEP){
      if(ui.cancelled){sendTransferCancel(peer.id,id,'relay');return;}
      const buf=await file.slice(off,off+RELAY_BIN_STEP).arrayBuffer();
      send({type:'relay',to:peer.id,data:{kind:'file-chunk',id,seq:seq++,chunk:b64encode(buf),last:off+RELAY_BIN_STEP>=file.size}});
      ui.update(Math.min(file.size,off+RELAY_BIN_STEP));
      while(ws&&typeof ws.bufferedAmount==='number'&&ws.bufferedAmount>1024*1024){await new Promise(r=>setTimeout(r,20));}
    }
    send({type:'relay',to:peer.id,data:{kind:'file-done',id}});
    ui.done(null);
    if(!file.isVirtualZip){try{const u=URL.createObjectURL(file);trackBlobUrl(u);ui.setPreview(u,file.type||'',file.name);}catch{}}
  }
  function b64encode(buf){const u=new Uint8Array(buf);let s='';for(let i=0;i<u.length;i+=0x8000){s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));}return btoa(s);}
  function b64ToBytes(b64){const bin=atob(b64);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}

  // ---------- receiving ----------
  const recvQueue=[]; // pending headers
  function handlePacket(fromId,pkt,mode){
    if(blockedSender(fromId))return; // blocked device: ignore every packet
    const peer=peerById(fromId)||{name:'device'};
    // Room broadcasts arrive as server fan-out: same handling as relay, room-tagged.
    // For P2P receptions, refine the label from our own selected ICE pair
    // (mirror of the sender's path): LAN vs Direct vs TURN.
    let tmode=pkt.room?'room':mode;
    if(tmode==='p2p'){
      const c=pcs.get(fromId);
      if(c&&c.path==='lan')tmode='p2p-lan';
      else if(c&&c.path==='turn')tmode='p2p-turn';
      else tmode='p2p-direct';
    }
    if(pkt.kind==='file-header'){
      if(typeof pkt.size!=='number'||!(pkt.size>=0)||(!isP2PMode(tmode)&&pkt.size>RELAY_MAX_BYTES)){failIncoming(pkt.id,'file too large');return;}
      incoming.set(pkt.id,{meta:pkt,chunks:[],received:0,nextSeq:0,from:fromId,fromName:peer.name,mode:tmode,room:pkt.room||null,ui:null,accepted:false});
      if(trustedSender(fromId)){
        // Trusted device → no Accept tap: acknowledge immediately and stream.
        // Works for 1-to-1 P2P, relay and room broadcast alike.
        acceptTransfer(pkt.id);
        toast(`🔐 Auto-accepted ${pkt.name} from trusted device ${peer.name}`,'ok');
      }else{
        recvQueue.push(pkt.id);renderRecvModal();
      }
      // Expire stale unaccepted transfers so dead senders can't leak memory
      setTimeout(()=>{
        const inc2=incoming.get(pkt.id);
        if(inc2&&!inc2.done&&!inc2.accepted){
          incoming.delete(pkt.id);
          const qi=recvQueue.indexOf(pkt.id);
          if(qi>=0)recvQueue.splice(qi,1);
          renderRecvModal();
        }
      },5*60*1000);
    }
    else if(pkt.kind==='file-chunk'){
      const inc=incoming.get(pkt.id);if(!inc)return;
      if(isP2PMode(inc.mode))return;
      if(typeof pkt.chunk!=='string'||(pkt.seq!==undefined&&pkt.seq!==inc.nextSeq))return failIncoming(pkt.id,'invalid chunk sequence');
      // Decode immediately and store binary parts: concatenating one giant
      // base64 string is O(n²) and freezes/OOMs on large files.
      let part;
      try{part=b64ToBytes(pkt.chunk);}catch{return failIncoming(pkt.id,'invalid chunk');}
      if(!part.length||inc.received+part.length>inc.meta.size)return failIncoming(pkt.id,'invalid transfer size');
      inc.chunks.push(part);inc.received+=part.length;inc.nextSeq++;
      if(inc.ui)inc.ui.update(inc.received);
    }
    else if(pkt.kind==='file-done'){finishIncoming(pkt.id);}
    else if(pkt.kind==='file-cancelled'){
      const inc=incoming.get(pkt.id);
      if(inc){
        incoming.delete(pkt.id);
        const qi=recvQueue.indexOf(pkt.id);
        if(qi>=0)recvQueue.splice(qi,1);
        if(inc.ui)inc.ui.fail('cancelled by sender');
        else toast(`📢 ${inc.meta.name} cancelled by sender`,'info');
        renderRecvModal();
      }
    }
    else if(pkt.kind==='text'){
      const tm=tmode;
      toast(`${pkt.room?`📢 [${pkt.room}]`: '✉️'} from ${peer.name}: ${pkt.text.slice(0,120)}`,'ok');
      const ui=addTransfer({id:pkt.id||uid(6),name:pkt.room?'Announcement 📢':'Message ✉️',size:pkt.text.length,peerName:pkt.room?`Room ${pkt.room} • ${peer.name}`:peer.name,dir:'down',mode:tm});
      ui.done(null);
      // show text with copy
      const d=document.createElement('div');d.className='t-item';
      d.innerHTML=`<div class="t-head"><strong>✉️ from ${escapeHtml(peer.name)}</strong></div><div style="white-space:pre-wrap;word-break:break-word;font-size:14px">${escapeHtml(pkt.text)}</div>`;
      const btn=document.createElement('button');btn.className='btn small';btn.textContent='Copy';btn.style.marginTop='8px';
      btn.onclick=()=>copyText(pkt.text).then(()=>toast('Copied ✓','ok'));
      d.appendChild(btn);transfersEl.prepend(d);
      try{navigator.vibrate?.(100)}catch{}
    }
    else if(pkt.kind==='accept'){
      const pa=pendingAccept.get(pkt.id);if(pa)pa.res(true);
      const bw=broadcastWaits.get(pkt.id);
      if(bw){bw.accepted.add(fromId);if(bw.onAccept)try{bw.onAccept()}catch{}}
    }
    else if(pkt.kind==='decline'){pendingAccept.get(pkt.id)?.rej(new Error('declined'));}
  }
  function failIncoming(id,msg){
    const inc=incoming.get(id);if(!inc)return;
    incoming.delete(id);
    const qi=recvQueue.indexOf(id);if(qi>=0)recvQueue.splice(qi,1);
    if(inc.ui)inc.ui.fail(msg);else toast(`Transfer rejected: ${msg}`,'err');
    renderRecvModal();
  }
  function handleBinary(fromId,buf,mode){
    // find latest unaccepted? find active accepted transfer from this peer
    let target=null;
    for(const[id,inc]of incoming){if(inc.from===fromId&&inc.accepted&&!inc.done){target=inc;break;}}
    if(!target){
      // maybe header arrived but modal not accepted yet — buffer to latest pending from peer
      for(const[id,inc]of incoming){if(inc.from===fromId&&!inc.done){target=inc;break;}}
    }
    if(!target)return;
    if(target.received+buf.byteLength>target.meta.size){failIncoming(target.meta.id,'invalid transfer size');return;}
    target.chunks.push(buf);target.received+=buf.byteLength;
    if(target.ui)target.ui.update(target.received);
  }
  function onRelay(from,data){handlePacket(from,data,'relay');
    // accept/decline from relay receiver also arrives here (sender side handles via pendingAccept)
  }

  function renderRecvModal(){
    if(!recvQueue.length){closeModal('#recvModal');return;}
    const id=recvQueue[0];
    const inc=incoming.get(id);if(!inc){recvQueue.shift();renderRecvModal();return;}
    $('#recvTitle').textContent=`${inc.room?'📢 Room '+inc.room+' • ':''}📥 Incoming from ${inc.fromName}`;
    $('#recvMeta').textContent=`${inc.meta.name} • ${fmtSize(inc.meta.size)} • ${transferModeLabel(inc.mode)}`;
    $('#recvList').innerHTML=`<div>📄 <strong>${escapeHtml(inc.meta.name)}</strong> <span class="muted">${fmtSize(inc.meta.size)}</span></div>`;
    openModal('#recvModal');
    try{navigator.vibrate?.([100,50,100])}catch{}
  }
  // Shared by the Accept button and the trusted-device auto-accept path.
  function acceptTransfer(id){
    const inc=incoming.get(id);
    if(!inc||inc.accepted||inc.done)return false;
    inc.accepted=true;
    inc.ui=addTransfer({id,name:inc.meta.name,size:inc.meta.size,peerName:inc.fromName,dir:'down',mode:inc.mode});
    // Tell the sender over the same path the header arrived on.
    const c=pcs.get(inc.from);
    const msg=JSON.stringify({kind:'accept',id});
    let sent=false;
    if(isP2PMode(inc.mode)&&c?.dc?.readyState==='open'){
      try{c.dc.send(msg);sent=true;}catch{}
    }
    if(!sent)send({type:'relay',to:inc.from,data:{kind:'accept',id}});
    requestWakeLock(); // keep screen on for large transfers
    return true;
  }
  $('#btnAccept').onclick=()=>{
    const id=recvQueue.shift();
    if(!acceptTransfer(id)){renderRecvModal();return;}
    closeModal('#recvModal');
    if(recvQueue.length)renderRecvModal();
    toast('Receiving…','info');
  };
  $('#btnDecline').onclick=()=>{
    const id=recvQueue.shift();const inc=incoming.get(id);
    if(inc){incoming.delete(id);
      const c=pcs.get(inc.from);const msg=JSON.stringify({kind:'decline',id});
      if(!isP2PMode(inc.mode))send({type:'relay',to:inc.from,data:{kind:'decline',id}});
      else if(c?.dc?.readyState==='open')try{c.dc.send(msg)}catch{}
    }
    renderRecvModal();
  };
  function finishIncoming(id){
    const inc=incoming.get(id);if(!inc||inc.done)return;
    if(inc.received!==inc.meta.size){failIncoming(id,'incomplete transfer');return;}
    inc.done=true;
    const blob=new Blob(inc.chunks,{type:inc.meta.mime});
    inc.chunks.length=0; // allow GC of parts once Blob takes over
    const url=URL.createObjectURL(blob);
    trackBlobUrl(url);
    const ui=inc.ui||addTransfer({id,name:inc.meta.name,size:inc.meta.size,peerName:inc.fromName,dir:'down',mode:inc.mode});
    ui.done({url,name:inc.meta.name},'Save file');
    ui.setPreview(url,inc.meta.mime,inc.meta.name);
    // Auto-download on desktop. Mobile browsers block scripted blob downloads
    // (especially auto-accepted ones), so show the explicit Save link instead.
    const coarse=matchMedia('(pointer:coarse)').matches;
    const a=document.createElement('a');a.href=url;a.download=inc.meta.name;document.body.appendChild(a);
    if(!coarse){try{a.click()}catch{}}
    else toast(`Tap ⬇ Save file to download ${inc.meta.name}`,'info');
    setTimeout(()=>a.remove(),1000);
    toast(`Received ${inc.meta.name} ✓`,'ok');
    incoming.delete(id);
    releaseWakeLock();
  }

  // ---------- wake lock ----------
  let wakeLock=null;
  async function requestWakeLock(){try{wakeLock=await navigator.wakeLock?.request('screen')}catch{}}
  function releaseWakeLock(){try{wakeLock?.release?.()}catch{}wakeLock=null;}

  // ---------- pwa ----------
  if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('sw.js?v=15').catch(()=>{});});}

  // ---------- boot ----------
  // Room priority: ?room= URL > saved room > none. Saved room makes
  // Render deploys survive refresh; URL lets QR links override it.
  (function restoreRoom(){
    const q0=new URLSearchParams(location.search);
    const qRoom=(q0.get('room')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    let saved=null;
    try{saved=(localStorage.getItem('sdfdrop-room')||'').toUpperCase();}catch{}
    if(/^[A-Z0-9]{4,12}$/.test(qRoom))myRoom=qRoom;
    else if(/^[A-Z0-9]{4,12}$/.test(saved))myRoom=saved;
    if(myRoom)persistRoom();
    renderRoom();updateDiag();
  })();
  connect();
})();
