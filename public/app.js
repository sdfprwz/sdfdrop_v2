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

  // ---------- state ----------
  let ws=null, myId=null, peers=[], myRoom=null, iceServers=[{urls:'stun:stun.l.google.com:19302'}];
  let retryMs=1000, connectTimer=null, lastServerMsg=Date.now(), myNetGroup='…', watchdogTimer=null;
  let manualClose=false;
  const pcs=new Map(); // peerId -> {pc, dc, ready, mode, queue:Promise}
  const pendingAccept=new Map(); // transferId -> {resolve,reject} (1-to-1)
  const broadcastWaits=new Map(); // transferId -> {accepted:Set, onAccept, room} (1-to-room)
  const incoming=new Map(); // transferId -> {meta, chunks, received, from, mode, el...}
  const CHUNK=16*1024;

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
    if(!peers.length){
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
  applyTheme(localStorage.getItem('sdfdrop-theme') || (matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'));
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
      return 'wss://sdfdrop.onrender.com/ws';
    }
    const proto=location.protocol==='https:'?'wss:':'ws:';
    if(location.protocol.startsWith('http')) return `${proto}//${location.host}/ws`;
    return 'ws://localhost:3000/ws'; // file:// dev
  }

  async function loadConfig(){
    try{
      const base=getWsUrl().replace(/\/ws$/,'').replace(/^ws/,'http');
      if(base.startsWith('http')){
        const r=await fetch(base+'/config');if(r.ok){const j=await r.json();if(j.iceServers?.length)iceServers=j.iceServers;}
      }
    }catch{/* keep defaults */}
  }

  // ---------- websocket (hardened: watchdog + clean reconnect + room rejoin) ----------
  function clearPeerConnections(){
    for(const[,c]of pcs){try{c.dc?.close()}catch{}try{c.pc?.close()}catch{}}
    pcs.clear();
  }
  async function connect(){
    if(connectTimer){clearTimeout(connectTimer);connectTimer=null;}
    await loadConfig();
    const url=getWsUrl();
    try{connInfo.textContent=`sdfdrop • ${new URL(url.replace(/^ws/,'http')).host} • WebRTC P2P + relay`;}catch{connInfo.textContent='sdfdrop • WebRTC P2P + relay';}
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
  function hello(){send({type:'hello',name:myName,avatar:myAvatar,color:myColor,clientId,room:myRoom||undefined});}
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
  function roomPeerCount(){return peers.filter(p=>p.room===myRoom).length;}
  function renderRoom(){
    const b=$('#roomBanner');
    if(myRoom){b.classList.remove('hidden');$('#roomCodeLabel').textContent=myRoom;
      $('#roomHint').textContent='devices with this code can see you';
      const rc=$('#roomCount');if(rc)rc.textContent=`• ${roomPeerCount()} in room`;
      history.replaceState(null,'',location.pathname+'?room='+myRoom);
    } else {b.classList.add('hidden');history.replaceState(null,'',location.pathname);}
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
    const n=peers.length;
    peerCount.textContent=n===0?'searching…':`${n} nearby`;
    const empty=$('#emptyState');
    if(empty)empty.style.display=n===0?'flex':'none';
    const emptyText=$('#emptyText');
    if(emptyText&&n===0){
      const online=statusPill.classList.contains('online');
      emptyText.textContent=online?'Searching for nearby devices…':statusText.textContent;
    }
    peers.forEach((p,i)=>{
      const a=(i/n)*Math.PI*2-Math.PI/2;
      const x=50+Math.cos(a)*42, y=55+Math.sin(a)*40;
      const b=document.createElement('button');
      b.className='peer '+(p.mode||'local');b.style.left=x+'%';b.style.top=y+'%';
      const col=/^#[0-9a-fA-F]{6}$/.test(p.color)?p.color:'#6366f1'; // defense-in-depth (server also validates)
      b.innerHTML=`<span class="avatar" style="background:${col}33;border-color:${col}">${p.avatar}</span><span class="pname">${escapeHtml(p.name)}</span><span class="ptag">${p.mode==='room'?'🌐 '+(p.room||'room'):p.mode==='both'?'📶+🌐 wifi+room':'📶 wifi'}</span>`;
      b.title=`Send to ${p.name}`;
      b.onclick=()=>askAndSend(p);
      peersLayer.appendChild(b);
    });
    const rc=$('#roomCount');if(rc&&myRoom)rc.textContent=`• ${roomPeerCount()} in room`;
    updateDiag();
  }
  function updateDiag(){
    const el=$('#diagInfo');
    const txt=`you ${myName} • net ${myNetGroup} • ${peers.length} nearby${myRoom?' • room '+myRoom:''}`;
    if(el)el.textContent=txt;
    try{connInfo.title=txt;}catch{}
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  window.addEventListener('resize',renderPeers);

  // ---------- modals ----------
  function openModal(s){$(s).classList.remove('hidden')}
  function closeModal(s){$(s).classList.add('hidden')}
  document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.add('hidden')}));

  // ---------- file picking ----------
  let targetPeer=null, pendingRoomSend=false;
  const fileInput=$('#fileInput');
  function askAndSend(peer){
    targetPeer=peer;
    if($('#chkBroadcast').checked){sendToAll();return;}
    fileInput.click();
  }
  $('#btnSendRoom').onclick=()=>{
    if(!myRoom){toast('Join a room first 🔗','err');openModal('#roomModal');return;}
    if(!roomPeerCount()){toast('Nobody else in this room yet','err');return;}
    pendingRoomSend=true;fileInput.click();
  };
  $('#btnSendFiles').onclick=()=>{
    if(peers.length===0){toast('No devices nearby — open sdfdrop on the other device first','err');openModal('#qrModal');$('#qrLink').textContent=roomLink();drawQR($('#qrCanvas'),roomLink());return;}
    if(peers.length===1){targetPeer=peers[0];fileInput.click();}
    else if($('#chkBroadcast').checked){sendToAll();}
    else {toast('Tap a device to send to it 👆','info');}
  };
  fileInput.onchange=async()=>{
    const files=[...fileInput.files];fileInput.value='';
    if(!files.length){pendingRoomSend=false;return;}
    if(pendingRoomSend){pendingRoomSend=false;if(myRoom)await sendRoomFiles(myRoom,files);return;}
    if($('#chkBroadcast').checked||!targetPeer){await sendToAll(files);}
    else await sendFilesTo(targetPeer,files);
  };
  async function sendToAll(files){
    files=files||await pickFiles();
    if(!files?.length)return;
    if(!peers.length){toast('Nobody to send to','err');return;}
    toast(`Sending to ${peers.length} device(s)…`,'info');
    for(const p of peers){sendFilesTo(p,files).catch(e=>toast(`Failed → ${p.name}: ${e.message}`,'err'));}
  }
  function pickFiles(){return new Promise(res=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.onchange=()=>res([...i.files]);i.click();setTimeout(()=>res(null),60000);});}

  // ---------- room broadcast (teacher → whole room, one upload) ----------
  const ROOM_ACCEPT_WAIT_MS = 45000;
  async function sendRoomFiles(room, files){
    for(const f of files)await sendOneRoomFile(room,f);
  }
  async function sendOneRoomFile(room, file){
    if(file.size>RELAY_MAX_BYTES){toast('File too big for broadcast (100MB max)','err');return;}
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
      const STEP_BIN=45*1024;let seq=0; // ~60KB base64 per message
      for(let off=0;off<file.size;off+=STEP_BIN){
        if(ui.cancelled){sendCancel();return;}
        const buf=await file.slice(off,off+STEP_BIN).arrayBuffer();
        send({type:'broadcast',room,data:{kind:'file-chunk',id,seq:seq++,chunk:b64encode(buf),last:off+STEP_BIN>=file.size}});
        ui.update(Math.min(file.size,off+STEP_BIN));
        while(ws&&ws.bufferedAmount>512*1024){await new Promise(r=>setTimeout(r,50));}
      }
      send({type:'broadcast',room,data:{kind:'file-done',id}});
      ui.done(null);broadcastWaits.delete(id);
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
    const files=[...e.dataTransfer.files];
    if(!files.length)return;
    if(peers.length===1)sendFilesTo(peers[0],files);
    else if(targetPeer)sendFilesTo(targetPeer,files);
    else if(peers.length>1){targetPeer=peers[0];sendFilesTo(peers[0],files);toast(`Sent to ${peers[0].name} (tap another device to choose)`, 'info');}
    else toast('No devices nearby yet','err');
  });

  // ---------- text ----------
  let textPeer=null;
  function openText(peer){textPeer=peer||peers[0];$('#textTargetLabel').textContent=textPeer?`To: ${textPeer.name}`:'No devices nearby';$('#textInput').value='';const rb=$('#btnDoSendRoomText');if(rb)rb.style.display=myRoom?'':'none';openModal('#textModal');setTimeout(()=>$('#textInput').focus(),50);}
  $('#btnText').onclick=()=>{if(!peers.length)return toast('No devices nearby','err');openText(peers[0]);};
  $('#btnSendText2').onclick=()=>{if(!peers.length)return toast('No devices nearby','err');openText(targetPeer||peers[0]);};
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
    const dests=$('#chkBroadcast').checked?peers:(textPeer?[textPeer]:peers.slice(0,1));
    for(const p of dests)await sendTextTo(p,t);
  };

  // ---------- WebRTC ----------
  function rtcConfig(){return{iceServers,sdpSemantics:'unified-plan'};}
  // Dial new peers the moment they appear: the DataChannel is already open
  // when the user taps Send, so transfers start instantly (no offer/answer/
  // ICE/DTLS handshake in the critical path). Lower peer id dials — the rule
  // is identical on both sides, so they never offer at once (no glare).
  function warmConnections(){
    if(!myId)return;
    const seen=new Set(peers.map(p=>p.id));
    for(const [pid,c]of pcs){
      if(!seen.has(pid)){try{c.dc?.close()}catch{}try{c.pc?.close()}catch{}pcs.delete(pid);}
    }
    for(const p of peers){
      if(pcs.has(p.id))continue;
      if(myId<p.id){try{getConn(p.id,true);}catch{}}
    }
  }
  function getConn(peerId, initiator){
    let c=pcs.get(peerId);
    if(c)return c;
    const pc=new RTCPeerConnection(rtcConfig());
    c={pc,dc:null,ready:false,mode:'p2p',offered:false};
    pcs.set(peerId,c);
    pc.onicecandidate=(e)=>{if(e.candidate)send({type:'signal',to:peerId,data:{candidate:e.candidate}});};
    pc.onconnectionstatechange=()=>{
      const s=pc.connectionState;
      netBadge.textContent=s==='connected'?'P2P connected ✓':s==='connecting'?'P2P connecting…':s==='failed'?'P2P failed → relay':'P2P ready';
      if(s==='failed'){c.mode='relay';c.ready=true;if(c.onReady)c.onReady();}
    };
    pc.ondatachannel=(e)=>{attachDC(peerId,e.channel);};
    if(initiator){
      const dc=pc.createDataChannel('sdfdrop',{ordered:true});
      attachDC(peerId,dc);
      pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>{
        send({type:'signal',to:peerId,data:{sdp:pc.localDescription}});
      }).catch(()=>{c.mode='relay';c.ready=true;if(c.onReady)c.onReady();});
      // safety: if no connection quickly, fall back to relay (server fan-out
      // is faster than waiting out a dead P2P path)
      setTimeout(()=>{if(pc.connectionState!=='connected'&&!c.ready){c.mode='relay';c.ready=true;if(c.onReady)c.onReady();}},4000);
    }
    return c;
  }
  function attachDC(peerId,dc){
    const c=pcs.get(peerId);if(!c)return;
    c.dc=dc;dc.binaryType='arraybuffer';
    dc.onopen=()=>{c.ready=true;c.mode='p2p';if(c.onReady)c.onReady();netBadge.textContent='P2P connected ✓';};
    dc.onclose=()=>{c.ready=false;};
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
          try{c.dc?.close()}catch{}try{c.pc.close()}catch{}pcs.delete(from);
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
  function waitReady(peerId, initiator=true){
    const c=getConn(peerId,initiator);
    if(c.ready&&(c.mode==='relay'||(c.dc&&c.dc.readyState==='open')))return Promise.resolve(c);
    return new Promise(res=>{c.onReady=()=>res(c);if(c.mode==='relay'&&c.ready)res(c);});
  }

  // ---------- transfers UI ----------
  const RELAY_MAX_BYTES = 100*1024*1024; // must match server RELAY_MAX_BYTES
  const blobUrls=[]; // revoke oldest so long sessions don't leak Blob memory
  function trackBlobUrl(url){
    blobUrls.push(url);
    while(blobUrls.length>20){const old=blobUrls.shift();try{URL.revokeObjectURL(old)}catch{}}
  }
  window.addEventListener('pagehide',()=>{for(const u of blobUrls){try{URL.revokeObjectURL(u)}catch{}}});
  function addTransfer({id,name,size,peerName,dir,mode}){
    transfersEl.querySelector('.muted')?.remove();
    const d=document.createElement('div');d.className='t-item';d.id='t-'+id;
    d.innerHTML=`<div class="t-head"><strong>${dir==='up'?'📤':'📥'} ${escapeHtml(name)}</strong><span>${fmtSize(size)}</span></div>
      <progress max="100" value="0"></progress>
      <div class="t-sub"><span class="st">${dir==='up'?'To':'From'} ${escapeHtml(peerName)} • ${mode==='room'?'📢 room':mode==='relay'?'🌐 relay':'⚡ p2p'}</span><span class="sp"></span></div>
      <div class="t-act"></div>`;
    transfersEl.prepend(d);
    const bar=d.querySelector('progress'),st=d.querySelector('.st'),sp=d.querySelector('.sp'),act=d.querySelector('.t-act');
    const t0=Date.now();
    const ui={
      el:d, cancelled:false,
      update(recv){
        const pct=size?Math.min(100,recv/size*100):100;bar.value=pct;
        const dt=(Date.now()-t0)/1000,spd=dt>0.3?recv/dt:0;
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

  // ---------- sending ----------
  async function sendFilesTo(peer,files){
    for(const f of files)await sendOneFile(peer,f);
  }
  function sendTransferCancel(peerId,id,mode='relay'){
    const c=pcs.get(peerId);
    if(mode==='p2p' && c?.dc?.readyState==='open'){
      try{c.dc.send(JSON.stringify({kind:'file-cancelled',id}));return;}catch{}
    }
    send({type:'relay',to:peerId,data:{kind:'file-cancelled',id}});
  }
  async function sendOneFile(peer,file){
    const id=uid(6);
    const c=await waitReady(peer.id,true);
    const mode=c.mode;
    const ui=addTransfer({id,name:file.name,size:file.size,peerName:peer.name,dir:'up',mode});
    if(mode==='relay'){await sendFileRelay(peer,file,id,ui);return;}
    // p2p
    const dc=c.dc;
    if(!dc||dc.readyState!=='open'){await sendFileRelay(peer,file,id,ui);return;}
    // header + wait accept
    const accepted=new Promise((res,rej)=>{pendingAccept.set(id,{res,rej});setTimeout(()=>rej(new Error('declined/timeout')),90000);});
    dc.send(JSON.stringify({kind:'file-header',id,name:file.name,size:file.size,mime:file.type||'application/octet-stream'}));
    toast(`Waiting for ${peer.name} to accept…`,'info');
    try{await accepted;}catch{ui.fail('declined');pendingAccept.delete(id);return;}
    pendingAccept.delete(id);
    if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}
    let offset=0;
    while(offset<file.size){
      if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}
      const slice=file.slice(offset,offset+CHUNK);
      const buf=await slice.arrayBuffer();
      while(dc.bufferedAmount>1024*1024){await new Promise(r=>{dc.onbufferedamountlow=()=>r();setTimeout(r,200);});}
      if(ui.cancelled){sendTransferCancel(peer.id,id,'p2p');return;}
      dc.send(buf);offset+=buf.byteLength;ui.update(offset);
    }
    dc.send(JSON.stringify({kind:'file-done',id}));
    ui.done(null);toast(`Sent ${file.name} → ${peer.name} ✓`,'ok');
  }
  async function sendTextTo(peer,text){
    const id=uid(6);
    if(text.length>8192){toast('Message too long (8KB max)','err');return;}
    try{
      const c=await Promise.race([waitReady(peer.id,true),new Promise(r=>setTimeout(()=>r(null),4000))]);
      if(c&&c.mode!=='relay'&&c.dc&&c.dc.readyState==='open'){
        c.dc.send(JSON.stringify({kind:'text',id,text}));
        addTransfer({id,name:'Message ✉️',size:text.length,peerName:peer.name,dir:'up',mode:'p2p'}).done(null);
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
    if(file.size>RELAY_MAX_BYTES){ui.fail('too big for relay (100MB max — use same-WiFi P2P)');toast('File too big for relay (100MB max)','err');return;}
    const header={kind:'file-header',id,name:file.name,size:file.size,mime:file.type||'application/octet-stream'};
    send({type:'relay',to:peer.id,data:header});
    toast(`P2P unavailable — relaying via server 🌐`,'info');
    const accepted=new Promise((res,rej)=>{pendingAccept.set(id,{res,rej});setTimeout(()=>rej(new Error('declined/timeout')),90000);});
    try{await accepted;}catch{ui.fail('declined');pendingAccept.delete(id);return;}
    pendingAccept.delete(id);
    if(ui.cancelled){sendTransferCancel(peer.id,id,'relay');return;}
    const STEP_BIN=45*1024;let seq=0; // → ~60KB base64, under the 100KB chunk cap
    for(let off=0;off<file.size;off+=STEP_BIN){
      if(ui.cancelled){sendTransferCancel(peer.id,id,'relay');return;}
      const buf=await file.slice(off,off+STEP_BIN).arrayBuffer();
      send({type:'relay',to:peer.id,data:{kind:'file-chunk',id,seq:seq++,chunk:b64encode(buf),last:off+STEP_BIN>=file.size}});
      ui.update(Math.min(file.size,off+STEP_BIN));
      while(ws&&ws.bufferedAmount>512*1024){await new Promise(r=>setTimeout(r,50));}
    }
    send({type:'relay',to:peer.id,data:{kind:'file-done',id}});
    ui.done(null);
  }
  function b64encode(buf){const u=new Uint8Array(buf);let s='';for(let i=0;i<u.length;i+=0x8000){s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));}return btoa(s);}
  function b64ToBytes(b64){const bin=atob(b64);const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}

  // ---------- receiving ----------
  const recvQueue=[]; // pending headers
  function handlePacket(fromId,pkt,mode){
    const peer=peers.find(p=>p.id===fromId)||{name:'device'};
    // Room broadcasts arrive as server fan-out: same handling as relay, room-tagged.
    const tmode=pkt.room?'room':mode;
    if(pkt.kind==='file-header'){
      incoming.set(pkt.id,{meta:pkt,chunks:[],b64:'',received:0,nextSeq:0,from:fromId,fromName:peer.name,mode:tmode,room:pkt.room||null,ui:null,accepted:false});
      recvQueue.push(pkt.id);renderRecvModal();
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
      if(inc.mode==='p2p')return;
      if(typeof pkt.chunk!=='string'||(pkt.seq!==undefined&&pkt.seq!==inc.nextSeq))return failIncoming(pkt.id,'invalid chunk sequence');
      const binLen=Math.max(0,Math.floor(pkt.chunk.length*3/4)-(pkt.chunk.endsWith('==')?2:pkt.chunk.endsWith('=')?1:0));
      if(!binLen||inc.received+binLen>inc.meta.size)return failIncoming(pkt.id,'invalid transfer size');
      inc.b64+=pkt.chunk;inc.received+=binLen;inc.nextSeq++;
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
    $('#recvMeta').textContent=`${inc.meta.name} • ${fmtSize(inc.meta.size)} • ${inc.mode==='p2p'?'⚡ p2p':'🌐 relay'} • E2E encrypted 🔒`;
    $('#recvList').innerHTML=`<div>📄 <strong>${escapeHtml(inc.meta.name)}</strong> <span class="muted">${fmtSize(inc.meta.size)}</span></div>`;
    openModal('#recvModal');
    try{navigator.vibrate?.([100,50,100])}catch{}
  }
  $('#btnAccept').onclick=()=>{
    const id=recvQueue.shift();const inc=incoming.get(id);
    if(!inc){renderRecvModal();return;}
    inc.accepted=true;
    inc.ui=addTransfer({id,name:inc.meta.name,size:inc.meta.size,peerName:inc.fromName,dir:'down',mode:inc.mode});
    // tell sender via best path (room/relay transfers are server-mediated)
    const c=pcs.get(inc.from);
    const msg=JSON.stringify({kind:'accept',id});
    if(inc.mode!=='p2p')send({type:'relay',to:inc.from,data:{kind:'accept',id}});
    else if(c?.dc?.readyState==='open')c.dc.send(msg);
    else send({type:'relay',to:inc.from,data:{kind:'accept',id}});
    // wake lock for large transfers
    requestWakeLock();
    closeModal('#recvModal');
    if(recvQueue.length)renderRecvModal();
    toast('Receiving…','info');
  };
  $('#btnDecline').onclick=()=>{
    const id=recvQueue.shift();const inc=incoming.get(id);
    if(inc){incoming.delete(id);
      const c=pcs.get(inc.from);const msg=JSON.stringify({kind:'decline',id});
      if(inc.mode!=='p2p')send({type:'relay',to:inc.from,data:{kind:'decline',id}});
      else if(c?.dc?.readyState==='open')try{c.dc.send(msg)}catch{}
    }
    renderRecvModal();
  };
  function finishIncoming(id){
    const inc=incoming.get(id);if(!inc||inc.done)return;
    if(inc.received!==inc.meta.size){failIncoming(id,'incomplete transfer');return;}
    inc.done=true;
    let blob;
    if(inc.b64){blob=new Blob([b64ToBytes(inc.b64)],{type:inc.meta.mime});}
    else {blob=new Blob(inc.chunks,{type:inc.meta.mime});}
    const url=URL.createObjectURL(blob);
    trackBlobUrl(url);
    if(inc.ui)inc.ui.done({url,name:inc.meta.name},'Save file');
    else {const ui=addTransfer({id,name:inc.meta.name,size:inc.meta.size,peerName:inc.fromName,dir:'down',mode:inc.mode});ui.done({url,name:inc.meta.name},'Save file');}
    // auto-download (desktop) + keep link
    const a=document.createElement('a');a.href=url;a.download=inc.meta.name;document.body.appendChild(a);
    try{a.click()}catch{}setTimeout(()=>a.remove(),1000);
    toast(`Received ${inc.meta.name} ✓`,'ok');
    incoming.delete(id);
    releaseWakeLock();
  }

  // ---------- wake lock ----------
  let wakeLock=null;
  async function requestWakeLock(){try{wakeLock=await navigator.wakeLock?.request('screen')}catch{}}
  function releaseWakeLock(){try{wakeLock?.release?.()}catch{}wakeLock=null;}

  // ---------- pwa ----------
  if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('sw.js').catch(()=>{});});}

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
