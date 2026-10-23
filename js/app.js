import { getToken, setToken, clearToken, hasToken, BASE_URL, getApiWebSocketUrl } from './config.js';
import { buildSidebarNav, buildBottomNav, navigate, onNavigate, setLockdownIndicator } from './router.js';
import { renderCommands, renderApiKeysPanel } from './commands.js';
import { initNodeTerminal, initMongoTerminal, initShellTerminal } from './terminals.js';
import { toastOk, toastErr, toastInfo, toastWarn, toastConfirm } from './toast.js';
import { api } from './api.js';

const fmtBytes=(b,d=1)=>!b||b<0?'—':b<1024?`${b}B`:b<1048576?`${(b/1024).toFixed(d)}KB`:b<1073741824?`${(b/1048576).toFixed(d)}MB`:`${(b/1073741824).toFixed(d)}GB`;
const fmtUp=s=>{s=Math.floor(s||0);const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),sec=s%60;return d>0?`${d}d ${h}h ${m}m`:h>0?`${h}h ${m}m`:`${m}m ${sec}s`;};
const fmtN=n=>(n==null)?'—':Number(n).toLocaleString();
const setText=(id,v)=>{const e=document.getElementById(id);if(e&&e.textContent!==String(v))e.textContent=String(v);};
const el=id=>document.getElementById(id);
const show=(id,cls='')=>{const e=el(id);if(e){e.className=cls;e.classList.remove('hidden');}};
const hide=id=>el(id)?.classList.add('hidden');
const v=id=>(el(id)?.value||'').trim();

// ── Clock ─────────────────────────────────────────────────────────────────
function startClock() {
  const tick=()=>{const n=new Date();setText('tb-clk',`${n.toLocaleDateString('en-US',{month:'short',day:'numeric'})} · ${n.toLocaleTimeString('en-US',{hour12:false})}`);}; tick(); setInterval(tick,1000);
}

// ── Stats WebSocket stream ────────────────────────────────────────────────
let statsWs=null;
function startStatsStream() {
  if (statsWs && statsWs.readyState < 2) return;
  // API base and cookie authentication are shared with normal requests.
  statsWs=new WebSocket(getApiWebSocketUrl('/ws/stats')); // No session token in URL.
  statsWs.onmessage=e=>{try{const d=JSON.parse(e.data);if(d.type==='stats')updateStats(d.data);}catch{}};
  statsWs.onclose=()=>setTimeout(startStatsStream,3000);
  statsWs.onerror=()=>statsWs?.close();
}

function updateStats(d) {
  setText('hc-servers',fmtN(d.serverCount));
  setText('hc-members',fmtN(d.totalUsers));
  setText('hc-ping',d.ping>=0?`${d.ping}ms`:'—');
  setText('hc-uptime',fmtUp(d.uptime));
  setText('tb-ping',d.ping>=0?`${d.ping}ms`:'—');
  const q=el('hc-ping-q'); if(q)q.textContent=d.ping<0?'Offline':d.ping<150?'Excellent':d.ping<300?'Good':'High latency';
  const dot=el('sb-dot');
  if(dot){dot.className='sb-dot'+(d.ping<0?' err':d.ping>400?' warn':'');}
  setText('sb-ping',d.ping>=0?`${d.ping}ms`:'—');
  setText('sb-status',d.wsStatus||'Unknown');
  buildStatGrid(d);
  if(d.globalLockdown!==undefined) setLockdownIndicator(!!d.globalLockdown);
}

function buildStatGrid(d) {
  const grid=el('stat-grid'); if(!grid) return;
  const hU=d.heapUsed||0,hT=d.heapTotal||0,rss=d.rss||0,sF=d.sysFree||0,sT=d.sysTotal||0;
  const hPct=hT?Math.round((hU/hT)*100):0,rPct=sT?Math.round(((sT-sF)/sT)*100):0;
  const stats=[
    {l:'Heap Used',   v:fmtBytes(hU),  s:`${hPct}% of ${fmtBytes(hT)}`,bar:hPct,  bc:hPct>80?'err':hPct>60?'warn':'ok'},
    {l:'RSS Memory',  v:fmtBytes(rss), s:'Resident set size'},
    {l:'System RAM',  v:fmtBytes(sT-sF),s:`${rPct}% used`,              bar:rPct,  bc:rPct>85?'err':rPct>70?'warn':'ok'},
    {l:'Disk',        v:d.disk?.used||'—',s:`${d.disk?.percent||'—'} · ${d.disk?.available||'—'} free`},
    {l:'Node.js',     v:d.nodeVersion||'—',s:'Runtime version'},
    {l:'WS Status',   v:d.wsStatus||'—',s:'Discord gateway',tag:d.wsStatus==='READY'?'ok':d.wsStatus==='CONNECTING'?'warn':'err',tl:d.wsStatus||'?'},
    {l:'Lockdown',    v:d.globalLockdown?'ACTIVE':'Off',s:'Global state',tag:d.globalLockdown?'err':null,tl:'ON'},
    {l:'Debug Mode',  v:d.debugMode?'ON':'Off',s:'Verbose logging'},
    {l:'Chat Sessions',v:fmtN(d.totalHistories),s:'In memory'},
    {l:'Histories',   v:fmtN(d.totalHistories),s:'Active'},
    {l:'User Settings',v:fmtN(d.totalUsers_s),s:'Stored'},
    {l:'Uptime',      v:fmtUp(d.uptime),s:'Process uptime'},
  ];
  grid.innerHTML=stats.map(s=>`<div class="sc"><div class="sc-lbl">${s.l}</div><div class="sc-val">${s.v}</div><div class="sc-sub">${s.s}</div>${s.bar!=null?`<div class="sc-bar"><div class="sc-fill ${s.bc||'ok'}" style="width:${Math.min(s.bar,100)}%"></div></div>`:''}${s.tag&&s.tl?`<span class="tag tag-${s.tag}" style="margin-top:4px">${s.tl}</span>`:''}</div>`).join('');
}

async function loadFullStats() {
  const r=await api.getStats().catch(()=>null); if(!r) return;
  if(r.username) setText('bot-name',r.username);
  if(r.id)       setText('bot-id',`ID: ${r.id}`);
  if(r.tag)      setText('bot-tag',r.tag);
  const av=el('bot-av'); if(av&&r.avatarURL){av.src=r.avatarURL;av.style.display='block';}
  const dbOk=r.mongoStatus==='Connected';
  const dbD=el('db-dot'); if(dbD) dbD.className=`db-dot ${dbOk?'ok':'err'}`;
  setText('db-status-text',r.mongoStatus||'Unknown');
  const kr=await api.getApiKeyStats().catch(()=>null);
  if(kr?.success) renderApiKeysPanel(kr.data);
  loadCurrentPresence();
}

// ── Presence ─────────────────────────────────────────────────────────────
async function loadCurrentPresence() {
  const r=await api.getPresence().catch(()=>null); if(!r?.success) return;
  const p=r.presence; const e=el('presence-cur'); if(!e) return;
  if(!p){e.innerHTML='<span style="color:var(--text3);font-size:12px">No presence data</span>';return;}
  const TM={0:'Playing',1:'Streaming',2:'Listening to',3:'Watching',5:'Competing in'};
  const SD={online:'🟢',idle:'🟡',dnd:'🔴',invisible:'⚫'};
  const act=p.activities?.[0];
  e.innerHTML=`<span style="font-size:15px">${SD[p.status]||'⚪'}</span><span style="font-weight:600">${(p.status||'').replace(/^\w/,c=>c.toUpperCase())}</span>${act?`<span style="color:var(--text3)">·</span><span style="color:var(--text2)">${TM[act.type]||''} ${act.name||''}</span>`:''}`;
}

// ── Login flow ────────────────────────────────────────────────────────────
async function initiateOAuth(provider) {
  const route = provider === 'discord' ? '/auth/discord' : '/auth/google';
  try {
    const config = await api.authConfig();
    if (config?.recaptchaRequired) {
      if (!config.recaptchaSiteKey) throw new Error('CAPTCHA is required but not configured. Contact the service owner.');
      if (!window.grecaptcha) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(config.recaptchaSiteKey)}`;
          script.async = true;
          script.onload = resolve;
          script.onerror = () => reject(new Error('CAPTCHA could not be loaded. Check your network and try again.'));
          document.head.appendChild(script);
        });
      }
      await new Promise((resolve) => window.grecaptcha.ready(resolve));
      const token = await window.grecaptcha.execute(config.recaptchaSiteKey, { action: 'login' });
      const verified = await api.verifyRecaptcha(token, provider);
      if (!verified?.success) throw new Error(verified?.error || 'CAPTCHA verification failed. Please try again.');
    }
    location.href = `${BASE_URL}${route}`;
  } catch (error) {
    showLogin(error?.message || 'Unable to begin sign-in. Please try again.');
  }
}
window._initiateLogin = () => { void initiateOAuth('google'); };
window._initiateDiscordLogin = () => { void initiateOAuth('discord'); };

function showLogin(msg, type='err') {
  const a=el('login-alert'); if(!a) return;
  a.textContent=msg; a.className=type==='err'?'':'';
  a.classList.remove('hidden');
}

async function initAuth() {
  const params=new URLSearchParams(location.search);
  const authErr=params.get('auth');
  if(authErr==='denied'){showLogin('Access denied. Only the authorized account may log in.');return;}
  if(authErr==='error'){showLogin('Authentication error. Please try again.');return;}
  if(authErr==='invalid_state'){showLogin('Session expired during login. Please try again.');return;}
  if(authErr==='captcha_required'){showLogin('Complete the CAPTCHA check before signing in, then try again.');return;}

  // Fix #1/#10: No token in URL and no sessionStorage — auth is cookie-only.
  // Fix #1/#10: Cookie-only auth — skip the local token gate and always verify via /auth/me.

  const me=await api.authMe().catch(()=>null);
  if(!me?.success){
    clearToken();
    el('login-page')?.classList.remove('hidden');
    el('app')?.classList.add('hidden');
    const providers = await api.authConfig().catch(() => null);
    const google = el('google-btn'); const discord = el('discord-btn');
    if (google) google.classList.toggle('hidden', providers?.hasGoogleOAuth !== true);
    if (discord) discord.classList.toggle('hidden', providers?.hasDiscordOAuth !== true);
    if (providers && !providers.hasGoogleOAuth && !providers.hasDiscordOAuth) {
      showLogin('Console authentication is not configured. Contact the service owner.');
    }
    return;
  }

  el('login-page')?.classList.add('hidden');
  el('app')?.classList.remove('hidden');

  const av=el('sb-av');
  if(av&&me.user?.picture){av.src=me.user.picture;av.style.display='block';}
  setText('sb-un',me.user?.name||'Admin');
  setText('sb-ue',me.user?.email||'');

  buildSidebarNav(el('sb-nav'));
  renderCommands();
  startClock();
  startStatsStream();
  loadFullStats();
  initPresencePage();
  initAnnouncePage();
  initLockdownPage();
  initConfigPage();
  initModelsPage();
}

window._logout = async () => {
  await api.authLogout().catch(()=>{});
  clearToken();
  location.reload();
};

// ── Sidebar / nav ─────────────────────────────────────────────────────────
window._navigate = id => {
  navigate(id);
  if(id==='node-console')  { setTimeout(initNodeTerminal,  50); }
  if(id==='mongo-console') { setTimeout(initMongoTerminal, 50); }
  if(id==='shell-console') { setTimeout(initShellTerminal, 50); }
  if(id==='servers')       loadServers();
  if(id==='models')        window._loadModels();
  if(id==='database')      loadCollections();
  if(id==='files')         fbNav('');
  if(id==='users')         { }
};
window._toggleSidebar = () => { el('sidebar')?.classList.toggle('open'); el('sb-ov')?.classList.toggle('hidden'); };
window._closeSidebar  = () => { el('sidebar')?.classList.remove('open'); el('sb-ov')?.classList.add('hidden'); };

// ── Servers ───────────────────────────────────────────────────────────────
let allServers=[], serverPage=1, serversPerPage=12;
async function loadServers() {
  el('servers-grid').innerHTML='<div class="loading">Loading servers…</div>';
  const r=await api.getServers().catch(()=>null);
  if(!r?.success){el('servers-grid').innerHTML='<div class="empty">Failed to load</div>';return;}
  allServers=r.data||[];
  setText('servers-cnt',fmtN(allServers.length));
  serverPage=1;
  renderServers(allServers);
}

function renderServers(list) {
  const start=(serverPage-1)*serversPerPage, page=list.slice(start,start+serversPerPage);
  if(!page.length){el('servers-grid').innerHTML='<div class="empty">No servers found</div>';el('servers-pg').innerHTML='';return;}
  el('servers-grid').innerHTML=page.map(g=>{
    const ic=g.iconURL?`<img src="${g.iconURL}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/><div class="sv-ico-fb" style="display:none">${(g.name||'?')[0]}</div>`:`<div class="sv-ico-fb">${(g.name||'?')[0]}</div>`;
    return `<div class="sv-card">
      <div class="sv-top">
        <div class="sv-ico">${ic}</div>
        <div><div class="sv-name">${g.name}</div><div class="sv-id">${g.id}</div></div>
      </div>
      <div class="sv-stats">
        <div class="sv-st"><div class="sv-st-l">Members</div><div class="sv-st-v">${fmtN(g.memberCount)}</div></div>
        <div class="sv-st"><div class="sv-st-l">Blacklisted</div><div class="sv-st-v">${g.blacklisted||0}</div></div>
        <div class="sv-st"><div class="sv-st-l">Owner</div><div class="sv-st-v" style="font-size:9px">${g.ownerId}</div></div>
        <div class="sv-st"><div class="sv-st-l">Settings</div><div class="sv-st-v">${Object.keys(g.settings||{}).length} custom</div></div>
      </div>
      <div class="sv-acts">
        <button class="sv-btn" onclick="window._viewServerSettings('${g.id}')">⚙ Settings</button>
        <button class="sv-btn" onclick="window._sendToServer('${g.id}')">💬 Send Message</button>
        <button class="sv-btn d" onclick="window._leaveServer('${g.id}','${g.name.replace(/'/g,"\\'")}')">✕ Leave Server</button>
      </div>
    </div>`;
  }).join('');
  const pages=Math.ceil(list.length/serversPerPage);
  if(pages<=1){el('servers-pg').innerHTML='';return;}
  let pgHtml=`<div class="pg">`;
  pgHtml+=`<button class="pg-btn" onclick="window._svPg(${serverPage-1})" ${serverPage<=1?'disabled':''}>‹</button>`;
  for(let i=1;i<=pages;i++) pgHtml+=`<button class="pg-btn${i===serverPage?' active':''}" onclick="window._svPg(${i})">${i}</button>`;
  pgHtml+=`<button class="pg-btn" onclick="window._svPg(${serverPage+1})" ${serverPage>=pages?'disabled':''}>›</button>`;
  pgHtml+=`<span class="pg-info">${allServers.length} total</span></div>`;
  el('servers-pg').innerHTML=pgHtml;
}

window._svPg          = p=>{ serverPage=p; renderServers(window._filteredServers||allServers); };
window._filterServers = q=>{ const f=allServers.filter(g=>!q||g.name?.toLowerCase().includes(q.toLowerCase())||g.id?.includes(q)); window._filteredServers=f; serverPage=1; renderServers(f); };
window._loadServers   = loadServers;
window._leaveServer   = async(id,name)=>{ if(!await toastConfirm(`Leave ${name}?`)) return; const r=await api.leaveServer(id); r?.success?toastOk(`Left ${name}`):(toastErr(r?.error||'Error'),null); loadServers(); };
window._viewServerSettings = async(gid)=>{
  const r=await api.getServerSettings(gid).catch(()=>null);
  if(!r?.success){toastErr('Could not load settings');return;}
  const s=r.data; const editable=['embedColor','maxHistoryLength','customPersonality','responseMode'];
  const fields=editable.map(k=>`<div class="form-g"><label class="form-l">${k}</label><input class="form-i" id="svset-${k}" value="${s[k]!==undefined?s[k]:''}"/></div>`).join('');
  const modal=document.createElement('div');
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML=`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r12);padding:24px;width:100%;max-width:440px;max-height:80vh;overflow-y:auto"><div style="font-family:var(--fd);font-size:15px;font-weight:700;margin-bottom:14px">Server Settings: ${gid}</div>${fields}<div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-accent" style="flex:1" onclick="window._saveServerSettings('${gid}')">Save</button><button class="btn btn-ghost" style="flex:1" onclick="this.closest('div[style*=fixed]').remove()">Cancel</button></div></div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
};
window._saveServerSettings = async(gid)=>{
  const keys=['embedColor','maxHistoryLength','customPersonality','responseMode'];
  const data={}; keys.forEach(k=>{const val=v(`svset-${k}`);if(val)data[k]=val;});
  const r=await api.setServerSettings(gid,data).catch(()=>null);
  if(r?.success){toastOk('Settings saved');document.querySelector('div[style*="position:fixed"]')?.remove();}
  else toastErr(r?.error||'Error');
};
window._sendToServer = async(gid)=>{
  const r=await api.getChannels(gid).catch(()=>null);
  if(!r?.success){toastErr('Could not load channels');return;}
  const channels=r.data||[];
  const modal=document.createElement('div');
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML=`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r12);padding:24px;width:100%;max-width:400px"><div style="font-family:var(--fd);font-size:14px;font-weight:700;margin-bottom:12px">Send Message</div><div class="form-g"><label class="form-l">Channel</label><select class="form-sel" id="sm-ch">${channels.map(c=>`<option value="${c.id}">#${c.name}</option>`).join('')}</select></div><div class="form-g"><label class="form-l">Message</label><textarea class="form-ta" id="sm-msg" rows="3" placeholder="Message text"></textarea></div><div style="display:flex;gap:8px"><button class="btn btn-accent" style="flex:1" onclick="window._doSendChannel()">Send</button><button class="btn btn-ghost" style="flex:1" onclick="this.closest('div[style*=fixed]').remove()">Cancel</button></div></div>`;
  document.body.appendChild(modal);
};
window._doSendChannel = async()=>{
  const ch=v('sm-ch'),msg=v('sm-msg'); if(!ch||!msg){toastErr('Channel and message required');return;}
  const r=await api.sendChannel(ch,msg).catch(()=>null);
  if(r?.success){toastOk(r.message);document.querySelector('div[style*="position:fixed"]')?.remove();}
  else toastErr(r?.error||'Error');
};

// ── Users ─────────────────────────────────────────────────────────────────
async function resolveUser(raw) {
  if(!raw) return null;
  if(/^\d{17,20}$/.test(raw)) return raw;
  const r=await api.resolveUsername(raw).catch(()=>null);
  if(r?.success&&r.id) return r.id;
  toastErr(`Cannot resolve "${raw}" to a user ID`);
  return null;
}

window._lookupUser = async()=>{
  const raw=v('user-lookup-id'); if(!raw){toastErr('Enter a User ID or username');return;}
  const uid=await resolveUser(raw); if(!uid) return;
  const r=await api.fetchUserProfile(uid).catch(()=>null);
  const resEl=el('user-lookup-result');
  if(!resEl) return;
  if(!r?.success){resEl.innerHTML=`<div class="result-box err">${r?.error||'User not found'}</div>`;resEl.classList.remove('hidden');return;}
  const u=r.user;
  resEl.innerHTML=`<div class="upc">
    <div class="upc-h"><img class="upc-av" src="${u.avatarURL||''}" alt=""/><div class="upc-id"><div class="upc-dn">${u.displayName||u.username}</div><div class="upc-tag">${u.tag||''}</div><div class="upc-uid mono">${u.id}</div></div></div>
    <div class="upc-g">
      <div class="upc-f"><div class="upc-fl">Bot</div><div class="upc-fv">${u.bot?'Yes':'No'}</div></div>
      <div class="upc-f"><div class="upc-fl">Mutual</div><div class="upc-fv">${u.mutualGuilds} guilds</div></div>
      <div class="upc-f"><div class="upc-fl">History</div><div class="upc-fv">${u.hasHistory?'Yes':'No'}</div></div>
      <div class="upc-f"><div class="upc-fl">Settings</div><div class="upc-fv">${u.hasSettings?'Custom':'Default'}</div></div>
      <div class="upc-f" style="grid-column:1/-1"><div class="upc-fl">Created</div><div class="upc-fv">${u.createdAt?.slice(0,10)||'—'}</div></div>
    </div>
    <div style="display:flex;gap:5px;padding:10px">
      <button class="btn btn-accent btn-sm" style="flex:1" onclick="window._viewUserSettings('${u.id}')">Settings</button>
      <button class="btn btn-danger btn-sm" style="flex:1" onclick="window._clearUserHist('${u.id}')">Clear History</button>
      <button class="btn btn-ghost btn-sm" style="flex:1" onclick="window._viewMemory('${u.id}')">Memory</button>
    </div>
  </div>`;
  resEl.classList.remove('hidden');
};
window._viewUserSettings = async(uid)=>{
  const r=await api.getUserSettings(uid).catch(()=>null);
  if(!r?.success){toastErr('Error');return;}
  const modal=document.createElement('div');
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML=`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r12);padding:24px;width:100%;max-width:480px;max-height:80vh;overflow-y:auto"><div style="font-family:var(--fd);font-size:14px;font-weight:700;margin-bottom:12px">User Settings: ${uid}</div><textarea class="cfg-ed" id="us-edit" style="min-height:300px">${JSON.stringify(r.data,null,2)}</textarea><div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-accent" style="flex:1" onclick="window._saveUSettings('${uid}')">Save</button><button class="btn btn-danger" style="flex:1" onclick="window._resetUSett('${uid}')">Reset</button><button class="btn btn-ghost" style="flex:1" onclick="this.closest('div[style*=fixed]').remove()">Close</button></div></div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
};
window._saveUSettings=async(uid)=>{try{const data=JSON.parse(v('us-edit'));const r=await api.setUserSettings(uid,data);r?.success?toastOk('Saved'):toastErr(r?.error||'Error');}catch(e){toastErr('Invalid JSON');}};
window._resetUSett=async(uid)=>{if(!await toastConfirm('Reset user settings?'))return;const r=await api.resetUserSettings(uid);r?.success?toastOk('Reset'):toastErr(r?.error||'Error');};
window._clearUserHist=async(uid)=>{if(!await toastConfirm('Clear history?'))return;const r=await api.clearHistory(uid);r?.success?toastOk('Cleared'):toastErr(r?.error||'Error');};
window._viewMemory=async(uid)=>{
  const r=await api.getMemory(uid).catch(()=>null);
  const modal=document.createElement('div');
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  const items=(r?.data||[]).map(m=>`<div class="mem-entry"><div><div class="mem-text">${m.content||m.text||JSON.stringify(m).slice(0,100)}</div><div class="mem-meta">${m.timestamp||m.createdAt||''}</div></div></div>`).join('') || '<div class="empty">No memories found</div>';
  modal.innerHTML=`<div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--r12);padding:24px;width:100%;max-width:520px;max-height:80vh;overflow-y:auto"><div style="font-family:var(--fd);font-size:14px;font-weight:700;margin-bottom:12px">Memory: ${uid}</div>${items}<div style="margin-top:12px;display:flex;gap:8px"><button class="btn btn-danger" style="flex:1" onclick="window._delMemory('${uid}',this)">Delete All</button><button class="btn btn-ghost" style="flex:1" onclick="this.closest('div[style*=fixed]').remove()">Close</button></div></div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
};
window._delMemory=async(uid,btn)=>{if(!await toastConfirm('Delete all memories?'))return;const r=await api.deleteMemory(uid);r?.success?(toastOk('Deleted'),btn.closest('div[style*=fixed]').remove()):toastErr(r?.error||'Error');};
window._sendDm=async()=>{
  const raw=v('dm-user-id'),msg=v('dm-message'); if(!raw||!msg){toastErr('User and message required');return;}
  const uid=await resolveUser(raw); if(!uid) return;
  const r=await api.sendDm(uid,msg).catch(()=>null);
  const re=el('dm-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};
window._blacklistUser=async()=>{
  const raw=v('bl-user-id'),g=v('bl-guild-id'); if(!raw||!g){toastErr('User and Guild required');return;}
  const uid=await resolveUser(raw); if(!uid) return;
  const r=await api.blacklistUser(uid,g).catch(()=>null);
  const re=el('bl-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};
window._unblacklistUser=async()=>{
  const raw=v('bl-user-id'),g=v('bl-guild-id'); if(!raw||!g){toastErr('User and Guild required');return;}
  const uid=await resolveUser(raw); if(!uid) return;
  const r=await api.unblacklistUser(uid,g).catch(()=>null);
  const re=el('bl-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};
window._loadBlacklist=async()=>{
  const r=await api.getBlacklisted().catch(()=>null);
  const c=el('blacklist-content'); if(!c) return;
  if(!r?.success){c.innerHTML='<div class="empty">Error loading</div>';return;}
  const entries=[]; for(const[guild,users]of Object.entries(r.data||{})) users.forEach(uid=>entries.push({guild,uid}));
  if(!entries.length){c.innerHTML='<div class="empty">No blacklisted users</div>';return;}
  c.innerHTML=entries.map(e=>`<div class="bl-e"><span class="bl-u">${e.uid}</span><span class="bl-g">${e.guild}</span><button class="btn btn-danger btn-sm" onclick="window._quickUnbl('${e.uid}','${e.guild}')">Remove</button></div>`).join('');
};
window._quickUnbl=async(uid,gid)=>{const r=await api.unblacklistUser(uid,gid).catch(()=>null);if(r?.success){toastOk('Removed');window._loadBlacklist();}else toastErr(r?.error||'Error');};
window._purgeBlacklist=async()=>{if(!await toastConfirm('PURGE entire blacklist?'))return;const r=await api.purgeBlacklist().catch(()=>null);r?.success?(toastOk(r.message),window._loadBlacklist()):toastErr(r?.error||'Error');};
window._viewHistory=async()=>{
  const raw=v('hist-user-id'); if(!raw){toastErr('Enter an ID or username');return;}
  const uid=await resolveUser(raw); if(!uid) return;
  const r=await api.getChatHistory(uid).catch(()=>null);
  const re=el('hist-result'); if(!re) return;
  if(!r?.success){re.className='result-box err';re.textContent=r?.error||'Not found';re.classList.remove('hidden');return;}
  const msgs=Array.isArray(r.data)?r.data:[];
  re.className='result-box ok'; re.textContent=msgs.length?msgs.map(m=>`[${m.role||'?'}]: ${String(m.content||m.parts?.[0]?.text||'').slice(0,120)}`).join('\n'):`No history for ${uid}`; re.classList.remove('hidden');
};
window._clearHistory=async()=>{
  const raw=v('hist-user-id'); if(!raw){toastErr('Enter an ID or username');return;} if(!await toastConfirm('Clear history?')) return;
  const uid=await resolveUser(raw); if(!uid) return;
  const r=await api.clearHistory(uid).catch(()=>null);
  const re=el('hist-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
};
window._loadHistories=async()=>{
  const r=await api.allHistories().catch(()=>null);
  const c=el('hist-all'); if(!c) return;
  if(!r?.success){c.innerHTML='<div class="result-box err">Error</div>';c.classList.remove('hidden');return;}
  const items=r.data||[];
  c.innerHTML=`<div class="result-box ok" style="max-height:300px;overflow-y:auto">${items.length?items.map(h=>`${h.id} — ${h.messageCount} messages`).join('\n'):'No histories'}</div>`;
  c.classList.remove('hidden');
};

// ── Models ────────────────────────────────────────────────────────────────
let modelsData=null;
async function loadModels() {
  const r=await api.getModels().catch(()=>null);
  if(!r?.success){el('mdl-grid').innerHTML='<div class="empty">Error loading models</div>';return;}
  modelsData=r;
  const models=r.models||{};
  const active=r.runtimeOverride||r.effectiveDefault||r.defaultModel||'';
  el('mdl-grid').innerHTML=Object.entries(models).map(([key,val])=>`
    <div class="mdl-card ${val===active||key===active?'active':''}" onclick="window._setModel('${val}',this)">
      <div class="mdl-name">${key}</div>
      <div class="mdl-id">${val}</div>
      <div class="mdl-tag"><span class="tag ${val===r.defaultModel?'tag-info':'tag-accent'}">${val===r.defaultModel?'DEFAULT':'ALIAS'}</span></div>
    </div>`).join('');
  setText('mdl-active-info',active?`Active: ${active}`:'Using default model');
  const kr=await api.getApiKeyStats().catch(()=>null);
  if(kr?.success) renderApiKeysPanel(kr.data);
  const ff=await api.getFeatureFlags().catch(()=>null);
  if(ff?.success){
    const flags=ff.data||{};
    const pdf=el('ff-pdf');
    if(pdf) pdf.value=String(flags.PDF_ENABLED_FOR_GEMINI ?? false);
  }
  // Load migration config
  const mc=await api.getMigrationConfig().catch(()=>null);
  if(mc?.success){
    const d=mc.data||{};
    if(el('mc-enable'))     el('mc-enable').value=String(d.ENABLE_MIGRATION??false);
    if(el('mc-batch-size')) el('mc-batch-size').value=d.BATCH_SIZE??50;
    if(el('mc-batch-delay'))el('mc-batch-delay').value=d.BATCH_DELAY_MS??100;
  }
  // Load bot/state config
  const bc=await api.getBotConfig().catch(()=>null);
  if(bc?.success){
    const d=bc.data||{};
    if(el('bc-resp-format'))  el('bc-resp-format').value=d.DEFAULT_RESPONSE_FORMAT||'Normal';
    if(el('bc-dms'))          el('bc-dms').value=String(d.WORK_IN_DMS??true);
    if(el('bc-queue'))        el('bc-queue').value=d.MAX_QUEUE_DEPTH_PER_USER??5;
    if(el('bc-key-hold'))     el('bc-key-hold').value=d.KEY_SWITCH_HOLD_MS??1500;
    if(el('bc-ram'))          el('bc-ram').value=d.RAM_MEDIA_SUSPEND_THRESHOLD_MB??380;
    if(el('bc-max-msg'))      el('bc-max-msg').value=d.STATE_MAX_MESSAGES??50;
    if(el('bc-ctx-break'))    el('bc-ctx-break').value=d.CONTEXT_BREAK_THRESHOLD_MIN??30;
    if(el('bc-gemma-limit'))  el('bc-gemma-limit').value=d.GEMMA_DAILY_LIMIT_PER_KEY??1500;
    if(el('bc-gemma-default'))el('bc-gemma-default').value=d.GEMMA_DEFAULT_MODEL||'';
    if(el('bc-gemma-fallback'))el('bc-gemma-fallback').value=d.GEMMA_FALLBACK_MODEL||'';
  }
}
window._loadModels=loadModels;
window._saveMigrationConfig=async()=>{
  const payload={
    ENABLE_MIGRATION: el('mc-enable')?.value==='true',
    BATCH_SIZE:       parseInt(el('mc-batch-size')?.value||'50'),
    BATCH_DELAY_MS:   parseInt(el('mc-batch-delay')?.value||'100'),
  };
  const r=await api.setMigrationConfig(payload).catch(()=>null);
  const re=el('mc-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};
window._saveBotConfig=async()=>{
  const payload={
    DEFAULT_RESPONSE_FORMAT:        el('bc-resp-format')?.value||'Normal',
    WORK_IN_DMS:                    el('bc-dms')?.value==='true',
    MAX_QUEUE_DEPTH_PER_USER:       parseInt(el('bc-queue')?.value||'5'),
    KEY_SWITCH_HOLD_MS:             parseInt(el('bc-key-hold')?.value||'1500'),
    RAM_MEDIA_SUSPEND_THRESHOLD_MB: parseInt(el('bc-ram')?.value||'380'),
    STATE_MAX_MESSAGES:             parseInt(el('bc-max-msg')?.value||'50'),
    CONTEXT_BREAK_THRESHOLD_MIN:    parseInt(el('bc-ctx-break')?.value||'30'),
    GEMMA_DAILY_LIMIT_PER_KEY:      parseInt(el('bc-gemma-limit')?.value||'1500'),
    GEMMA_DEFAULT_MODEL:            el('bc-gemma-default')?.value||'',
    GEMMA_FALLBACK_MODEL:           el('bc-gemma-fallback')?.value||'',
  };
  const r=await api.setBotConfig(payload).catch(()=>null);
  const re=el('bc-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};
window._setModel=async(model,cardEl)=>{
  const r=await api.setModel(model).catch(()=>null);
  if(r?.success){
    toastOk(r.message);
    document.querySelectorAll('.mdl-card').forEach(c=>c.classList.remove('active'));
    cardEl?.classList.add('active');
    setText('mdl-active-info',`Active: ${model}`);
  } else toastErr(r?.error||'Error');
};
window._toggleFlag=async(feature,enabled)=>{
  const r=await api.toggleFeature(feature,enabled).catch(()=>null);
  r?.success?toastOk(r.message):toastErr(r?.error||'Error');
};
function initModelsPage(){}

// ── Presence ──────────────────────────────────────────────────────────────
function initPresencePage() { loadCurrentPresence(); loadConfigActivities(); }
async function loadConfigActivities() {
  const r=await api.getActivities().catch(()=>null);
  if(!r?.success||!r.data?.length) return;
  const TYPE_MAP={'Playing':0,'Streaming':1,'Listening':2,'Watching':3,'Competing':5,'Listening to':2};
  const container=document.querySelector('.p-pb'); if(!container) return;
  // Append config activities as additional preset buttons
  const existing=container.innerHTML;
  const extras=r.data.map(a=>{
    const t=TYPE_MAP[a.type]??0;
    const icon={'Playing':'🎮','Watching':'📺','Listening':'🎧','Listening to':'🎧','Streaming':'📡','Competing':'🏆'}[a.type]||'⚡';
    return `<button class="p-p" onclick="window._preset('online','${a.name.replace(/'/g,"\\'")}','${t}')">${icon} ${a.name}</button>`;
  }).join('');
  container.innerHTML=existing+extras;
}
window._setPresence=async()=>{
  const r=await api.setPresence({status:v('pres-status'),activity:v('pres-activity'),activityType:parseInt(v('pres-type')||'0')}).catch(()=>null);
  const re=el('pres-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success){toastOk(r.message);loadCurrentPresence();}
};
window._preset=(status,act,type)=>{
  const ss=el('pres-status'),sa=el('pres-activity'),st=el('pres-type');
  if(ss)ss.value=status; if(sa)sa.value=act; if(st)st.value=type;
  window._setPresence();
};

// ── Announce ──────────────────────────────────────────────────────────────
let annTarget='both';
function initAnnouncePage() {
  const updatePreview=()=>{
    const title=v('ann-title')||'Announcement', msg=v('ann-msg')||'Your message…', color=v('ann-color')||'#6D5AE6';
    const pt=el('ann-pt'),pm=el('ann-pm'),pb=el('ann-pb');
    if(pt)pt.textContent=title; if(pm)pm.textContent=msg; if(pb)pb.style.background=color;
  };
  ['ann-title','ann-msg','ann-color'].forEach(id=>el(id)?.addEventListener('input',updatePreview));
}
window._updateAnnPreview=()=>{
  const title=v('ann-title')||'Announcement',msg=v('ann-msg')||'',color=v('ann-color')||'#6D5AE6';
  const pt=el('ann-pt'),pm=el('ann-pm'),pb=el('ann-pb');
  if(pt)pt.textContent=title; if(pm)pm.textContent=msg; if(pb)pb.style.background=color;
};
window._setAnnTarget=btn=>{
  annTarget=btn.dataset.target;
  document.querySelectorAll('.ann-t').forEach(b=>b.classList.toggle('active',b===btn));
};
window._sendAnnounce=async()=>{
  const msg=v('ann-msg'); if(!msg){toastErr('Enter a message');return;}
  const payload={message:msg,title:v('ann-title')||'Announcement',embedColor:v('ann-color')||'#6D5AE6',useEmbed:v('ann-fmt')==='true'};
  const re=el('ann-result'); if(re){re.textContent='Sending…';re.className='result-box';re.classList.remove('hidden');}
  try{
    if(annTarget==='servers'||annTarget==='both'){const r=await api.announce(payload);if(re){re.className=`result-box ${r?.success?'ok':'err'}`;re.textContent=r?.message||r?.error||'Error';}}
    if(annTarget==='users'||annTarget==='both'){const r2=await api.announceUsers(payload);if(annTarget==='users'&&re){re.className=`result-box ${r2?.success?'ok':'err'}`;re.textContent=r2?.message||r2?.error||'Error';}}
    toastOk('Announcement sent');
  } catch(e){if(re){re.className='result-box err';re.textContent=e.message;}toastErr(e.message);}
};
window._dmAllOwners=async()=>{
  const msg=v('ann-owners-msg'); if(!msg){toastErr('Enter a message');return;} if(!await toastConfirm('DM all server owners?'))return;
  const r=await api.dmAllOwners(msg).catch(()=>null);
  const re=el('ann-owners-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};

// ── Lockdown ──────────────────────────────────────────────────────────────
function initLockdownPage() {
  api.getStats().then(r=>{if(r?.globalLockdown!==undefined)setLockdownIndicator(r.globalLockdown);}).catch(()=>{});
}
window._toggleLockdown=async(enabled)=>{
  const r=await api.setLockdown(enabled).catch(()=>null);
  const re=el('lkd-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success){toastOk(r.message);setLockdownIndicator(enabled);}
  else{toastErr(r?.error||'Error');const t=el('lkd-toggle');if(t)t.checked=!enabled;}
};

// ── Config Editor ─────────────────────────────────────────────────────────
function initConfigPage() { loadRuntimeConfig(); }
async function loadRuntimeConfig() {
  const r=await api.getRuntimeConfig().catch(()=>null);
  if(!r?.success) return;
  const d=r.data||{};
  const im=el('rt-model'),ic=el('rt-color'),rr=el('rt-raw');
  if(im)im.value=d.activeModel||'';
  if(ic)ic.value=d.globalEmbedColor||'';
  if(rr)rr.value=JSON.stringify(d,null,2);
}
window._loadRuntimeConfig=loadRuntimeConfig;
window._saveRuntimeConfig=async()=>{
  const data={};
  const m=v('rt-model'),c=v('rt-color');
  if(m)data.activeModel=m; if(c)data.globalEmbedColor=c;
  const r=await api.setRuntimeConfig(data).catch(()=>null);
  const re=el('rt-result'); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.success?'Saved':r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success){toastOk('Saved');loadRuntimeConfig();}
};
window._saveRuntimeRaw=async()=>{
  try{
    const data=JSON.parse(v('rt-raw'));
    const r=await api.setRuntimeConfig(data).catch(()=>null);
    const re=el('rt-result'); if(!re) return;
    re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.success?'Saved':r?.error||'Error'; re.classList.remove('hidden');
    if(r?.success) toastOk('Saved');
  } catch(e){toastErr('Invalid JSON: '+e.message);}
};
window._clearRuntimeConfig=async()=>{
  if(!await toastConfirm('Clear all runtime config?')) return;
  const r=await api.clearRuntimeConfig().catch(()=>null);
  r?.success?(toastOk('Cleared'),loadRuntimeConfig()):toastErr(r?.error||'Error');
};
window._cfgTab=tabEl=>{
  const tab=tabEl.dataset.tab;
  document.querySelectorAll('.cfg-tab').forEach(t=>t.classList.toggle('active',t===tabEl));
  document.getElementById('cfg-runtime-pane')?.classList.toggle('hidden',tab!=='runtime');
  document.getElementById('cfg-modules-pane')?.classList.toggle('hidden',tab!=='modules');
  document.getElementById('cfg-base-pane')?.classList.toggle('hidden',tab!=='base');
  if(tab==='modules'&&!el('cfg-modules-ta')?.value) window._loadCfg('modules');
  if(tab==='base'&&!el('cfg-base-ta')?.value) window._loadCfg('base');
};
window._loadCfg=async(which)=>{
  const r=await (which==='modules'?api.getModulesConfig():api.getBaseConfig()).catch(()=>null);
  const ta=el(`cfg-${which}-ta`); if(!ta) return;
  if(r?.success){ta.value=r.content;const info=el(`cfg-${which}-info`);if(info)info.textContent=`Path: ${r.path}`;}
  else toastErr(r?.error||'Error');
};
window._saveCfg=async(which)=>{
  const ta=el(`cfg-${which}-ta`); if(!ta) return;
  const r=await (which==='modules'?api.setModulesConfig(ta.value):api.setBaseConfig(ta.value)).catch(()=>null);
  const re=el(`cfg-${which}-result`); if(!re) return;
  re.className=`result-box ${r?.success?'ok':'err'}`; re.textContent=r?.message||r?.error||'Error'; re.classList.remove('hidden');
  if(r?.success) toastOk(r.message);
};
window._resetCfg=async(which)=>{
  if(!await toastConfirm('Restore from backup?')) return;
  const r=await (which==='modules'?api.resetModulesConfig():api.resetBaseConfig()).catch(()=>null);
  if(r?.success){toastOk(r.message);window._loadCfg(which);}
  else toastErr(r?.error||'Error');
};

// ── Database Browser ──────────────────────────────────────────────────────
let dbCurrentColl='', dbPage=1;
async function loadCollections() {
  const r=await api.dbCollections().catch(()=>null);
  const c=el('db-coll-list'); if(!c) return;
  if(!r?.success){c.innerHTML='<div class="empty">MongoDB unavailable</div>';return;}
  c.innerHTML=(r.data||[]).map(col=>`
    <div class="db-coll${col.name===dbCurrentColl?' active':''}" onclick="window._dbSelectColl('${col.name}')">
      <span class="db-cn">${col.name}</span>
      <span class="db-cc">${col.count}</span>
    </div>`).join('');
}
window._loadCollections=loadCollections;
window._dbSelectColl=async(name)=>{
  dbCurrentColl=name; dbPage=1;
  document.querySelectorAll('.db-coll').forEach(c=>c.classList.toggle('active',c.querySelector('.db-cn')?.textContent===name));
  el('db-docs-h').textContent=name;
  el('db-docs-search')?.classList.remove('hidden');
  await loadDocs();
};
window._dbSearch=()=>{ dbPage=1; loadDocs(); };
async function loadDocs() {
  const list=el('db-doc-list'); if(!list) return;
  list.innerHTML='<div class="loading">Loading…</div>';
  const r=await api.dbCollection(dbCurrentColl,dbPage).catch(()=>null);
  if(!r?.success){list.innerHTML='<div class="empty">Error loading</div>';return;}
  const docs=r.data||[];
  if(!docs.length){list.innerHTML='<div class="empty">No documents</div>';el('db-pg').innerHTML='';return;}
  list.innerHTML=docs.map((doc,i)=>{
    const id=doc._id?String(doc._id):`doc-${i}`;
    const preview=JSON.stringify(doc,null,2);
    return `<div class="db-doc">
      <div class="db-doc-h" onclick="window._dbToggle(this)">
        <span class="db-doc-id">${id}</span>
        <div class="db-doc-acts">
          <button class="btn btn-accent btn-sm" onclick="event.stopPropagation();window._dbEdit('${id}',this)">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();window._dbDelete('${id}')">Delete</button>
        </div>
      </div>
      <div class="db-doc-body hidden" id="dbdoc-${id}">${preview.replace(/</g,'&lt;')}</div>
    </div>`;
  }).join('');
  const pages=Math.ceil(r.total/r.limit);
  if(pages>1){
    el('db-pg').innerHTML=`<div class="pg"><button class="pg-btn" onclick="window._dbPg(${dbPage-1})" ${dbPage<=1?'disabled':''}>‹</button>${Array.from({length:pages},(_,i)=>`<button class="pg-btn${i+1===dbPage?' active':''}" onclick="window._dbPg(${i+1})">${i+1}</button>`).join('')}<button class="pg-btn" onclick="window._dbPg(${dbPage+1})" ${dbPage>=pages?'disabled':''}>›</button></div>`;
  } else el('db-pg').innerHTML='';
}
window._dbPg=p=>{dbPage=p;loadDocs();};
window._dbToggle=h=>{const body=h.nextElementSibling;if(body)body.classList.toggle('hidden');};
window._dbEdit=async(id,btn)=>{
  const body=btn.closest('.db-doc')?.querySelector('.db-doc-body'); if(!body) return;
  body.classList.remove('hidden');
  const current=body.textContent;
  body.classList.add('editing');
  body.innerHTML='';
  const ta=document.createElement('textarea');
  ta.className='db-doc-edit'; ta.value=current;
  body.appendChild(ta);
  btn.textContent='Save';
  btn.onclick=async(ev)=>{
    ev.stopPropagation();
    try{
      const data=JSON.parse(ta.value);
      const r=await api.dbUpdateDoc(dbCurrentColl,id,data).catch(()=>null);
      if(r?.success){toastOk('Saved');loadDocs();}else toastErr(r?.error||'Error');
    } catch(e){toastErr('Invalid JSON');}
  };
};
window._dbDelete=async(id)=>{
  if(!await toastConfirm(`Delete document ${id}?`)) return;
  const r=await api.dbDeleteDoc(dbCurrentColl,id).catch(()=>null);
  r?.success?(toastOk('Deleted'),loadDocs()):toastErr(r?.error||'Error');
};

// ── File Browser ──────────────────────────────────────────────────────────
let fbCurrentPath='', fbCurrentFile='';
async function fbNav(path) {
  fbCurrentPath=path;
  const r=await api.files(path).catch(()=>null);
  const list=el('fb-list'); if(!list) return;
  if(!r?.success){list.innerHTML='<div class="empty">Error loading</div>';return;}
  const parts=path?path.split('/'):[];
  const pb=el('fb-path'); if(pb){
    let html=`<span class="fb-path-seg" onclick="window._fbNav('')">root</span>`;
    let built='';
    parts.forEach(p=>{built+=built?'/'+p:p;html+=`<span class="fb-path-sep">/</span><span class="fb-path-seg" onclick="window._fbNav('${built}')">${p}</span>`;});
    pb.innerHTML=html;
  }
  if(r.type==='dir'){
    const entries=r.entries||[];
    const dirs=entries.filter(e=>e.type==='dir').sort((a,b)=>a.name.localeCompare(b.name));
    const files=entries.filter(e=>e.type==='file').sort((a,b)=>a.name.localeCompare(b.name));
    list.innerHTML=[...dirs,...files].map(e=>`
      <div class="fb-e${e.path===fbCurrentFile?' active':''}" onclick="window._fbClick('${e.path}','${e.type}')">
        <svg class="fb-ei" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${e.type==='dir'?'<path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>':'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
        </svg>
        <span class="fb-en">${e.name}</span>
        ${e.type==='file'?`<span class="fb-es">${fmtBytes(e.size)}</span>`:''}
      </div>`).join('');
  }
}
window._fbNav=fbNav;
window._fbClick=async(path,type)=>{
  if(type==='dir'){fbNav(path);return;}
  fbCurrentFile=path;
  const r=await api.files(path).catch(()=>null);
  if(!r?.success){toastErr(r?.error||'Error');return;}
  el('fb-editor').style.display='flex';
  el('fb-editor').style.flexDirection='column';
  el('fb-no-file').style.display='none';
  setText('fb-fn',path.split('/').pop()||path);
  const ta=el('fb-ta'); if(ta) ta.value=r.content||'';
  document.querySelectorAll('.fb-e').forEach(e=>e.classList.toggle('active',e.querySelector('.fb-en')?.textContent===path.split('/').pop()));
};
window._fbSave=async()=>{
  const content=el('fb-ta')?.value; if(content===undefined) return;
  const r=await api.saveFile(fbCurrentFile,content).catch(()=>null);
  r?.success?toastOk('Saved'):toastErr(r?.error||'Error');
};
window._fbDelete=async()=>{
  if(!await toastConfirm(`Delete ${fbCurrentFile}?`)) return;
  const r=await api.deleteFile(fbCurrentFile).catch(()=>null);
  if(r?.success){toastOk('Deleted');el('fb-editor').style.display='none';el('fb-no-file').style.display='';fbNav(fbCurrentPath);}
  else toastErr(r?.error||'Error');
};

window._copyInvite=async()=>{
  const r=await api.inviteLink().catch(()=>null);
  if(!r?.link){toastErr('Could not get invite link');return;}
  navigator.clipboard?.writeText(r.link).then(()=>toastOk('Invite link copied!')).catch(()=>toastInfo(`Link: ${r.link}`));
};


// ── Feature flags (models page selects) ─────────────────────────────────────
// Load centrally registered runtime flags (memory/RAG controls are intentionally absent)
async function loadAllFeatureFlags() {
  const ff = await api.getFeatureFlags().catch(() => null);
  if (!ff?.success) return;
  const flags = ff.data || {};
  const map = {
    'PDF_ENABLED_FOR_GEMINI':  'ff-pdf',
    'ENABLE_IMAGE_PROCESSING': 'ff-image',
    'ENABLE_VIDEO_PROCESSING': 'ff-video',
    'ENABLE_AUDIO_PROCESSING': 'ff-audio',
    'ENABLE_FILE_PROCESSING':  'ff-file',
    'ENABLE_WEB_SEARCH':       'ff-websearch',
    'ENABLE_FUNCTION_CALLING': 'ff-funcall',
    'CROSS_CONTEXT_ENABLED':   'ff-cross',
  };
  for (const [flag, elId] of Object.entries(map)) {
    const sel = el(elId);
    if (sel) sel.value = String(flags[flag] ?? (flag === 'ENABLE_IMAGE_PROCESSING' || flag === 'ENABLE_VIDEO_PROCESSING' || flag === 'ENABLE_AUDIO_PROCESSING' || flag === 'ENABLE_WEB_SEARCH' || flag === 'ENABLE_FUNCTION_CALLING' ? true : false));
  }
}

// ── Rate limits ───────────────────────────────────────────────────────────────
async function loadRateLimits() {
  const r = await api.getRateLimits().catch(() => null);
  if (!r?.success) return;
  const d = r.data || {};
  if (el('rl-rpm'))     el('rl-rpm').value     = d.REQUESTS_PER_MINUTE ?? 15;
  if (el('rl-window'))  el('rl-window').value  = d.WINDOW_DURATION_MS  ?? 60000;
  if (el('rl-cool'))    el('rl-cool').value    = d.COOLDOWN_DURATION_MS ?? 60000;
  if (el('rl-fd'))      el('rl-fd').value      = d.RETRY_DELAYS?.FORBIDDEN    ?? 3000;
  if (el('rl-rl'))      el('rl-rl').value      = d.RETRY_DELAYS?.RATE_LIMIT   ?? 2500;
  if (el('rl-se'))      el('rl-se').value      = d.RETRY_DELAYS?.SERVER_ERROR ?? 1000;
  // Per-model overrides — show as JSON
  if (el('rl-model-overrides')) {
    el('rl-model-overrides').value = JSON.stringify(d.MODEL_REQUESTS_PER_MINUTE || {}, null, 2);
  }
}
window._loadRateLimits = loadRateLimits;
window._saveRateLimits = async () => {
  try {
    const modelOverrides = JSON.parse(el('rl-model-overrides')?.value || '{}');
    const payload = {
      REQUESTS_PER_MINUTE:  parseInt(el('rl-rpm')?.value  || '15'),
      WINDOW_DURATION_MS:   parseInt(el('rl-window')?.value || '60000'),
      COOLDOWN_DURATION_MS: parseInt(el('rl-cool')?.value  || '60000'),
      RETRY_DELAYS: {
        FORBIDDEN:    parseInt(el('rl-fd')?.value || '3000'),
        RATE_LIMIT:   parseInt(el('rl-rl')?.value || '2500'),
        SERVER_ERROR: parseInt(el('rl-se')?.value || '1000'),
        DEFAULT:      parseInt(el('rl-se')?.value || '1000'),
      },
      MODEL_REQUESTS_PER_MINUTE: modelOverrides,
    };
    const r = await api.setRateLimits(payload).catch(() => null);
    const re = el('rl-result'); if (!re) return;
    re.className = `result-box ${r?.success ? 'ok' : 'err'}`;
    re.textContent = r?.message || r?.error || 'Error';
    re.classList.remove('hidden');
    if (r?.success) toastOk(r.message);
  } catch (e) { toastErr('Invalid JSON in model overrides: ' + e.message); }
};

// ── Migration UI ──────────────────────────────────────────────────────────────
async function loadMigrateFields() {
  const FALLBACK_SERVER = [
    'selectedModel','responseFormat','showActionButtons','continuousReply',
    'customPersonality','embedColor','overrideUserSettings','serverChatHistory',
    'allowedChannels','gemmaEnabled',
  ];
  const FALLBACK_USER = [
    'selectedModel','responseFormat','showActionButtons','continuousReply',
    'customPersonality','embedColor','gemmaEnabled','crossContextEnabled',
  ];

  let serverFields = FALLBACK_SERVER;
  let userFields   = FALLBACK_USER;

  try {
    const r = await api.getMigrateFields();
    if (r?.success) {
      serverFields = r.serverFields || FALLBACK_SERVER;
      userFields   = r.userFields   || FALLBACK_USER;
    }
  } catch {}

  const renderCheckboxes = (fields, containerId) => {
    const c = el(containerId); if (!c) return;
    c.innerHTML = fields.map(f =>
      `<label class="cb-row"><input type="checkbox" class="mig-cb" value="${f}"/> ${f}</label>`
    ).join('');
  };
  renderCheckboxes(serverFields, 'mig-server-fields');
  renderCheckboxes(userFields,   'mig-user-fields');
}
window._loadMigrateFields = loadMigrateFields;

function getMigChecked(containerId) {
  return [...document.querySelectorAll(`#${containerId} .mig-cb:checked`)].map(cb => cb.value);
}
window._selectAllMigFields = (containerId, check) => {
  document.querySelectorAll(`#${containerId} .mig-cb`).forEach(cb => cb.checked = check);
};

window._runMigration = async (scope) => {
  const serverFields = getMigChecked('mig-server-fields');
  const userFields   = getMigChecked('mig-user-fields');
  const fields = scope === 'servers' ? serverFields : scope === 'users' ? userFields : [...new Set([...serverFields, ...userFields])];
  const force  = el('mig-force')?.checked || false;

  const label = scope === 'both' ? 'Migrate ALL (servers + users)' : `Migrate ${scope}`;
  if (!await toastConfirm(`${label}${force ? ' — FORCE mode, will overwrite existing fields' : ''}. Continue?`)) return;

  const re = el('mig-result'); if (re) { re.className = 'result-box'; re.textContent = 'Running…'; re.classList.remove('hidden'); }

  const r = await api.runMigration({ scope, fields: fields.length ? fields : undefined, force }).catch(() => null);

  if (!re) return;
  re.className = `result-box ${r?.success ? 'ok' : 'err'}`;
  re.textContent = r?.message || r?.error || 'Error';
  if (r?.success) toastOk(`Migration complete: ${r.message}`);
  else toastErr(r?.error || 'Migration failed');
};

// Extend loadModels to also load all new flag sections
const _origLoadModels = window._loadModels;
window._loadModels = async () => {
  await _origLoadModels();
  await loadAllFeatureFlags();
  await loadRateLimits();
  await loadMigrateFields();
};

initAuth();
