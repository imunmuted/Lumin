import { api } from './api.js';
import { toastOk, toastErr, toastConfirm } from './toast.js';

const v  = id => (document.getElementById(id)?.value || '').trim();
const el = id => document.getElementById(id);

function showRes(id, type, msg) {
  const e = el(id);
  if (!e) return;
  e.className = `result-box ${type}`;
  e.textContent = String(msg || '').slice(0, 600);
  e.classList.remove('hidden');
}

async function run(fn, resultId) {
  showRes(resultId, '', 'Running…');
  try {
    const r = await fn();
    if (r?._authError) { toastErr('Session expired'); return null; }
    const ok = r?.success !== false && !r?.error;
    showRes(resultId, ok ? 'ok' : 'err', r?.message || r?.error || (ok ? 'Done' : 'Error'));
    if (ok) toastOk(r?.message || 'Done'); else toastErr(r?.error || r?.message || 'Error');
    return r;
  } catch (e) {
    showRes(resultId, 'err', e.message);
    toastErr(e.message);
    return null;
  }
}

async function resolveUser(raw) {
  if (!raw) return null;
  if (/^\d{17,20}$/.test(raw)) return raw;
  const r = await api.resolveUsername(raw).catch(() => null);
  if (r?.success && r.id) return r.id;
  toastErr(`Cannot resolve "${raw}" to a user ID`);
  return null;
}

const CMDS = [
  { name:'Save State',          desc:'Persist in-memory state to MongoDB immediately.',
    render:()=>`<button class="cmd-btn" onclick="CMD.saveState()">Save Now</button>` },
  { name:'Clear All Histories', desc:'Wipe every chat history from memory and database.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearAllHistories()">Clear All</button>` },
  { name:'Clear User History',  desc:"Clear one user's chat history by ID or username.",
    render:()=>`<input class="cmd-i" id="ci-user" placeholder="User ID or username"/><button class="cmd-btn" onclick="CMD.clearUserHistory()">Clear</button>` },
  { name:'Rotate API Key',      desc:'Switch to the next Gemini API key in the rotation.',
    render:()=>`<button class="cmd-btn" onclick="CMD.switchApiKey()">Rotate Key</button>` },
  { name:'API Key Stats',       desc:'View usage stats for all configured API keys.',
    render:()=>`<button class="cmd-btn" onclick="CMD.getApiKeyStats()">View Stats</button>` },
  { name:'Clear Image Usage',   desc:'Reset image generation counters for all users.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearImageUsage()">Clear Image Usage</button>` },
  { name:'Clear Summary Usage', desc:'Reset summary feature counters for all users.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearSummaryUsage()">Clear Summary Usage</button>` },
  { name:'Clear Quote Usage',   desc:'Reset quote command counters for all users.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearQuoteUsage()">Clear Quote Usage</button>` },
  { name:'Clear All Usage',     desc:'Reset ALL usage counters (image, summary, quote, starter, compliment) at once.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearAllUsage()">Clear All Usage</button>` },
  { name:'Toggle Debug Mode',   desc:'Enable or disable verbose debug logging.',
    render:()=>`<button class="cmd-btn" onclick="CMD.toggleDebug()">Toggle Debug</button>` },
  { name:'Restart Bot',         desc:'Save state and restart the bot process.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.restart()">Restart Now</button>` },
  { name:'Reload Commands',     desc:'Re-register all slash commands with Discord API.',
    render:()=>`<button class="cmd-btn" onclick="CMD.reloadCommands()">Reload</button>` },
  { name:'Set Presence',        desc:'Update bot status and activity text.',
    render:()=>`
      <select class="cmd-i" id="cp-status"><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">DND</option><option value="invisible">Invisible</option></select>
      <input class="cmd-i" id="cp-act" placeholder="Activity text (optional)"/>
      <select class="cmd-i" id="cp-type"><option value="0">Playing</option><option value="2">Listening to</option><option value="3">Watching</option><option value="5">Competing in</option></select>
      <button class="cmd-btn" onclick="CMD.setPresence()">Update Presence</button>` },
  { name:'Send DM',             desc:'Send a direct message to a user by ID or username.',
    render:()=>`<input class="cmd-i" id="cd-user" placeholder="User ID or username"/><input class="cmd-i" id="cd-msg" placeholder="Message"/><button class="cmd-btn" onclick="CMD.sendDm()">Send DM</button>` },
  { name:'Blacklist User',      desc:'Block a user from using the bot in a server.',
    render:()=>`<input class="cmd-i" id="cbl-user" placeholder="User ID or username"/><input class="cmd-i" id="cbl-guild" placeholder="Guild ID"/><button class="cmd-btn d" onclick="CMD.blacklistUser()">Blacklist</button>` },
  { name:'Unblacklist User',    desc:'Restore bot access for a blacklisted user.',
    render:()=>`<input class="cmd-i" id="cubl-user" placeholder="User ID or username"/><input class="cmd-i" id="cubl-guild" placeholder="Guild ID"/><button class="cmd-btn" onclick="CMD.unblacklistUser()">Unblacklist</button>` },
  { name:'View User Settings',  desc:"Look up a user's custom bot config.",
    render:()=>`<input class="cmd-i" id="cus-id" placeholder="User ID or username"/><button class="cmd-btn" onclick="CMD.getUserSettings()">Fetch</button>` },
  { name:'Reset Server Settings',desc:'Wipe all custom settings for a server back to defaults.',
    render:()=>`<input class="cmd-i" id="css-guild" placeholder="Guild ID"/><button class="cmd-btn d" onclick="CMD.resetServerSettings()">Reset</button>` },
  { name:'Leave Server',        desc:'Force the bot to leave a server by Guild ID.',
    render:()=>`<input class="cmd-i" id="cl-guild" placeholder="Guild ID"/><button class="cmd-btn d" onclick="CMD.leaveServer()">Leave</button>` },
  { name:'Quick Announce',      desc:'Send plain text to all servers fast.',
    render:()=>`<input class="cmd-i" id="caq-msg" placeholder="Announcement text"/><button class="cmd-btn" onclick="CMD.quickAnnounce()">Announce</button>` },
  { name:'Fetch User Profile',  desc:'Get Discord user info, avatar, creation date and mutual servers.',
    render:()=>`<input class="cmd-i" id="cfu-id" placeholder="User ID or username"/><button class="cmd-btn" onclick="CMD.fetchUserProfile()">Fetch</button>` },
  { name:'Server Info',         desc:'Detailed info about a server by Guild ID.',
    render:()=>`<input class="cmd-i" id="cgi-id" placeholder="Guild ID"/><button class="cmd-btn" onclick="CMD.getGuildInfo()">Get Info</button>` },
  { name:'Clear Reminders',     desc:'Wipe all scheduled reminders.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearReminders()">Clear</button>` },
  { name:'Clear Birthdays',     desc:'Remove all birthday entries.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearBirthdays()">Clear</button>` },
  { name:'Reset User Settings', desc:"Reset one user's settings to defaults.",
    render:()=>`<input class="cmd-i" id="ccus-id" placeholder="User ID or username"/><button class="cmd-btn d" onclick="CMD.resetUserSettings()">Reset</button>` },
  { name:'Bot Statistics',      desc:'Comprehensive runtime stats: memory, guilds, uptime.',
    render:()=>`<button class="cmd-btn" onclick="CMD.getBotStats()">Fetch Stats</button>` },
  { name:'DM All Owners',       desc:'Send a DM to every server owner. Use carefully.',
    render:()=>`<input class="cmd-i" id="cdma-msg" placeholder="Message to server owners"/><button class="cmd-btn d" onclick="CMD.dmAllOwners()">Send to All Owners</button>` },
  { name:'Clear Starter Usage', desc:'Reset conversation starter counters.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearStarterUsage()">Clear</button>` },
  { name:'Clear Compliment Usage',desc:'Reset daily compliment counters.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.clearComplimentUsage()">Clear</button>` },
  { name:'View Chat History',   desc:"Show recent messages from a user's history.",
    render:()=>`<input class="cmd-i" id="cgh-id" placeholder="User ID or username"/><input class="cmd-i" id="cgh-limit" placeholder="Limit (default 20)" type="number"/><button class="cmd-btn" onclick="CMD.getChatHistory()">View</button>` },
  { name:'Broadcast Status',    desc:'Send a color-coded embed status to all servers.',
    render:()=>`
      <input class="cmd-i" id="cbs-title" placeholder="Status title"/>
      <input class="cmd-i" id="cbs-msg" placeholder="Status message"/>
      <select class="cmd-i" id="cbs-color"><option value="#22C55E">🟢 OK</option><option value="#F59E0B">🟡 Warning</option><option value="#EF4444">🔴 Critical</option><option value="#6D5AE6">🟣 Info</option></select>
      <button class="cmd-btn" onclick="CMD.broadcastStatus()">Broadcast</button>` },
  { name:'Top Servers by Size', desc:'List top 10 servers by member count.',
    render:()=>`<button class="cmd-btn" onclick="CMD.topServers()">Get Top 10</button>` },
  { name:'Purge Blacklist',     desc:'Remove ALL blacklist entries across all servers.',
    render:()=>`<button class="cmd-btn d" onclick="CMD.purgeBlacklist()">Purge All</button>` },
  { name:'Ping Check',          desc:'Check current WebSocket ping and connection status.',
    render:()=>`<button class="cmd-btn" onclick="CMD.pingCheck()">Check Ping</button>` },
  { name:'Send Channel Message',desc:'Send a message to a specific channel by ID.',
    render:()=>`<input class="cmd-i" id="cscm-ch" placeholder="Channel ID"/><input class="cmd-i" id="cscm-msg" placeholder="Message text"/><button class="cmd-btn" onclick="CMD.sendChannelMsg()">Send</button>` },
  { name:'Set Bot Nickname',    desc:"Change the bot's nickname in a specific server.",
    render:()=>`<input class="cmd-i" id="csbn-guild" placeholder="Guild ID"/><input class="cmd-i" id="csbn-nick" placeholder="New nickname (blank to reset)"/><button class="cmd-btn" onclick="CMD.setNickname()">Set Nickname</button>` },
  { name:'State Snapshot',      desc:'View counts of all in-memory state objects.',
    render:()=>`<button class="cmd-btn" onclick="CMD.stateSnapshot()">Snapshot</button>` },
  { name:'Get Invite Link',     desc:'Generate a bot invite link with Administrator permissions.',
    render:()=>`<button class="cmd-btn" onclick="CMD.getInviteLink()">Get Link</button>` },
  { name:'Usage Statistics',    desc:'View per-user usage stats across all feature types.',
    render:()=>`<button class="cmd-btn" onclick="CMD.usageStats()">View Stats</button>` },
];

export function renderCommands() {
  const grid = el('cmd-grid');
  if (!grid) return;
  grid.innerHTML = CMDS.map((c, i) => {
    const rid = `cmd-res-${i}`;
    return `<div class="cmd-card">
      <div class="cmd-name">${c.name}</div>
      <div class="cmd-desc">${c.desc}</div>
      ${c.render().replace(/class="cmd-btn"/g,'class="cmd-btn"').replace(/-result"/g,`" data-rid="${rid}"`)}
      <div class="result-box hidden" id="${rid}"></div>
    </div>`;
  }).join('');

  CMDS.forEach((c, i) => {
    const rid = `cmd-res-${i}`;
    const card = grid.children[i];
    const btn = card?.querySelector('.cmd-btn');
    if (btn && !btn.getAttribute('onclick').includes('CMD.')) btn.onclick = () => {};
  });
}

export function renderApiKeysPanel(d) {
  const e = el('api-keys-list');
  if (!e || !d?.keys) return;
  e.innerHTML = d.keys.map(k => `
    <div class="key-row ${k.isCurrent?'current':''}">
      <span class="key-n">Key ${k.keyNumber}${k.isCurrent?' ✓':''}</span>
      <span class="key-m">${k.totalRequests||0} req</span>
      ${k.isCurrent?`<span class="tag tag-accent" style="font-size:9px">ACTIVE</span>`:`<button class="btn btn-ghost btn-sm" style="padding:2px 6px;font-size:9px" onclick="CMD.switchToKey(${k.keyNumber})">Use</button>`}
    </div>`).join('') || '<div class="empty">No keys</div>';

  const detail = el('keys-detail');
  if (!detail) return;
  detail.innerHTML = d.keys.map(k => `
    <div class="key-detail ${k.isCurrent?'active':''}">
      <div class="kd-top">
        <span class="kd-n">Key ${k.keyNumber}</span>
        ${k.isCurrent?`<span class="tag tag-accent">ACTIVE</span>`:`<button class="btn btn-ghost btn-sm" onclick="CMD.switchToKey(${k.keyNumber})">Switch to this</button>`}
      </div>
      <div class="kd-stats">
        <div class="kd-st"><div class="kd-sl">Total Reqs</div><div class="kd-sv">${k.totalRequests||0}</div></div>
        <div class="kd-st"><div class="kd-sl">Daily Reqs</div><div class="kd-sv">${k.dailyRequests||0}</div></div>
        <div class="kd-st"><div class="kd-sl">Errors</div><div class="kd-sv">${k.errorCount||0}</div></div>
      </div>
    </div>`).join('');
}

function getResultId(btnEl) {
  const card = btnEl.closest('.cmd-card');
  return card?.querySelector('.result-box')?.id || '';
}

window.CMD = {
  saveState:          (e) => run(() => api.saveState(), getResultId(e?.target||document.activeElement)||''),
  clearAllHistories:  async(e) => { if(!await toastConfirm('Clear ALL chat histories?')) return; run(() => api.clearHistory(), getResultId(e?.target||document.activeElement)||''); },
  clearUserHistory:   async(e) => {
    const raw=v('ci-user'); if(!raw){toastErr('Enter a User ID or username');return;}
    const id=await resolveUser(raw); if(!id) return;
    run(()=>api.clearHistory(id), getResultId(e?.target||document.activeElement)||'');
  },
  switchApiKey:       async(e) => {
    const r = await run(()=>api.switchApiKey(), getResultId(e?.target||document.activeElement)||'');
    if (r?.stats) renderApiKeysPanel(r.stats);
  },
  switchToKey:        async(idx) => {
    const r = await api.switchToKey(idx).catch(()=>null);
    if (r?.success) { toastOk(r.message); renderApiKeysPanel(r.stats); }
    else toastErr(r?.error||'Error switching key');
  },
  getApiKeyStats:     async(e) => {
    const r = await api.getApiKeyStats();
    const rid = getResultId(e?.target||document.activeElement)||'';
    if (r?.success) { showRes(rid,'ok',JSON.stringify(r.data,null,2)); renderApiKeysPanel(r.data); }
    else showRes(rid,'err',r?.error||'Error');
  },
  clearImageUsage:    (e) => run(()=>api.clearImageUsage(), getResultId(e?.target||document.activeElement)||''),
  clearSummaryUsage:  (e) => run(()=>api.clearSummaryUsage(), getResultId(e?.target||document.activeElement)||''),
  clearQuoteUsage:    (e) => run(()=>api.clearQuoteUsage(), getResultId(e?.target||document.activeElement)||''),
  clearAllUsage:      (e) => { if(!confirm('Clear ALL usage counters?')) return; run(()=>api.clearAllUsage(), getResultId(e?.target||document.activeElement)||''); },
  toggleDebug:        (e) => run(()=>api.toggleDebug(), getResultId(e?.target||document.activeElement)||''),
  restart:            (e) => { if(!confirm('Restart the bot process?')) return; run(()=>api.restart(), getResultId(e?.target||document.activeElement)||''); },
  reloadCommands:     (e) => run(()=>api.reloadCommands(), getResultId(e?.target||document.activeElement)||''),
  setPresence:        (e) => run(()=>api.setPresence({status:v('cp-status'),activity:v('cp-act'),activityType:parseInt(v('cp-type')||'0')}), getResultId(e?.target||document.activeElement)||''),
  sendDm:             async(e) => {
    const raw=v('cd-user'),m=v('cd-msg'); if(!raw||!m){toastErr('User and message required');return;}
    const id=await resolveUser(raw); if(!id) return;
    run(()=>api.sendDm(id,m), getResultId(e?.target||document.activeElement)||'');
  },
  blacklistUser:      async(e) => {
    const raw=v('cbl-user'),g=v('cbl-guild'); if(!raw||!g){toastErr('User and Guild required');return;}
    const id=await resolveUser(raw); if(!id) return;
    run(()=>api.blacklistUser(id,g), getResultId(e?.target||document.activeElement)||'');
  },
  unblacklistUser:    async(e) => {
    const raw=v('cubl-user'),g=v('cubl-guild'); if(!raw||!g){toastErr('User and Guild required');return;}
    const id=await resolveUser(raw); if(!id) return;
    run(()=>api.unblacklistUser(id,g), getResultId(e?.target||document.activeElement)||'');
  },
  getUserSettings:    async(e) => {
    const raw=v('cus-id'); if(!raw){toastErr('Enter a User ID');return;}
    const id=await resolveUser(raw); if(!id) return;
    const r=await api.getUserSettings(id);
    const rid=getResultId(e?.target||document.activeElement)||'';
    r?.success ? showRes(rid,'ok',JSON.stringify(r.data,null,2)) : showRes(rid,'err',r?.error||'Error');
  },
  resetServerSettings:(e)=>{ const g=v('css-guild'); if(!g){toastErr('Guild ID required');return;} if(!confirm('Reset?')) return; run(()=>api.resetServer(g),getResultId(e?.target||document.activeElement)||''); },
  leaveServer:        (e)=>{ const g=v('cl-guild'); if(!g){toastErr('Guild ID required');return;} if(!confirm('Leave?')) return; run(()=>api.leaveServer(g),getResultId(e?.target||document.activeElement)||''); },
  quickAnnounce:      (e)=>{ const m=v('caq-msg'); if(!m){toastErr('Enter a message');return;} run(()=>api.announce({message:m,title:'Announcement',useEmbed:false}),getResultId(e?.target||document.activeElement)||''); },
  fetchUserProfile:   async(e) => {
    const raw=v('cfu-id'); if(!raw){toastErr('Enter a User ID');return;}
    const id=await resolveUser(raw); if(!id) return;
    const r=await api.fetchUserProfile(id);
    const rid=getResultId(e?.target||document.activeElement)||'';
    r?.success ? showRes(rid,'ok',`${r.user.tag} (${r.user.id})\nCreated: ${r.user.createdAt?.slice(0,10)}\nBot: ${r.user.bot}\nMutual guilds: ${r.user.mutualGuilds}\nAvatar: ${r.user.avatarURL}`) : showRes(rid,'err',r?.error||'Not found');
  },
  getGuildInfo:       async(e) => {
    const g=v('cgi-id'); if(!g){toastErr('Guild ID required');return;}
    const r=await api.getGuildInfo(g);
    const rid=getResultId(e?.target||document.activeElement)||'';
    r?.success ? showRes(rid,'ok',JSON.stringify(r.guild,null,2)) : showRes(rid,'err',r?.error||'Not found');
  },
  clearReminders:     (e)=>{ if(!confirm('Clear ALL reminders?')) return; run(()=>api.clearReminders(),getResultId(e?.target||document.activeElement)||''); },
  clearBirthdays:     (e)=>{ if(!confirm('Clear ALL birthdays?')) return; run(()=>api.clearBirthdays(),getResultId(e?.target||document.activeElement)||''); },
  resetUserSettings:  async(e)=>{
    const raw=v('ccus-id'); if(!raw){toastErr('Enter a User ID');return;}
    const id=await resolveUser(raw); if(!id) return;
    if(!confirm(`Reset settings for ${id}?`)) return;
    run(()=>api.resetUserSettings(id),getResultId(e?.target||document.activeElement)||'');
  },
  getBotStats:        async(e)=>{
    const r=await api.getStats().catch(e=>({error:e.message}));
    const rid=getResultId(e?.target||document.activeElement)||'';
    r?.serverCount!==undefined ? showRes(rid,'ok',`Servers:${r.serverCount} Users:${r.totalUsers} Ping:${r.ping}ms Uptime:${Math.floor(r.uptime/3600)}h${Math.floor((r.uptime%3600)/60)}m\nHeap:${Math.round((r.ram?.heapUsed||0)/1048576)}MB/${Math.round((r.ram?.heapTotal||0)/1048576)}MB RSS:${Math.round((r.ram?.rss||0)/1048576)}MB`) : showRes(rid,'err',r?.error||'Error');
  },
  dmAllOwners:        (e)=>{ const m=v('cdma-msg'); if(!m){toastErr('Enter a message');return;} if(!confirm('DM ALL owners?')) return; run(()=>api.dmAllOwners(m),getResultId(e?.target||document.activeElement)||''); },
  clearStarterUsage:  (e)=>{ if(!confirm('Clear?')) return; run(()=>api.clearStarterUsage(),getResultId(e?.target||document.activeElement)||''); },
  clearComplimentUsage:(e)=>{ if(!confirm('Clear?')) return; run(()=>api.clearComplimentUsage(),getResultId(e?.target||document.activeElement)||''); },
  getChatHistory:     async(e)=>{
    const raw=v('cgh-id'); if(!raw){toastErr('Enter a User ID');return;}
    const id=await resolveUser(raw); if(!id) return;
    const r=await api.getChatHistory(id);
    const rid=getResultId(e?.target||document.activeElement)||'';
    if(r?.success){ const msgs=Array.isArray(r.data)?r.data:[]; showRes(rid,'ok',msgs.length?msgs.map(m=>`[${m.role||'?'}]: ${String(m.content||m.parts?.[0]?.text||'').slice(0,100)}`).join('\n'):'No history'); }
    else showRes(rid,'err',r?.error||'Error');
  },
  broadcastStatus:    (e)=>{ const t=v('cbs-title'),m=v('cbs-msg'),c=v('cbs-color')||'#6D5AE6'; if(!m){toastErr('Enter a message');return;} if(!confirm('Broadcast to all servers?')) return; run(()=>api.announce({message:m,title:t||'Status Update',embedColor:c,useEmbed:true}),getResultId(e?.target||document.activeElement)||''); },
  topServers:         async(e)=>{ const r=await api.getServers().catch(x=>({error:x.message})); const rid=getResultId(e?.target||document.activeElement)||''; r?.data?showRes(rid,'ok',r.data.sort((a,b)=>b.memberCount-a.memberCount).slice(0,10).map((s,i)=>`${i+1}. ${s.name} — ${(s.memberCount||0).toLocaleString()} members`).join('\n')):showRes(rid,'err',r?.error||'Error'); },
  purgeBlacklist:     (e)=>{ if(!confirm('PURGE entire blacklist? Cannot undo.')) return; run(()=>api.purgeBlacklist(),getResultId(e?.target||document.activeElement)||''); },
  pingCheck:          async(e)=>{ const r=await api.getStats().catch(x=>({error:x.message})); const rid=getResultId(e?.target||document.activeElement)||''; r?.ping!==undefined?showRes(rid,'ok',`WS Ping: ${r.ping>=0?r.ping+'ms':'Offline'} | Status: ${r.wsStatus}`):showRes(rid,'err',r?.error||'Error'); },
  sendChannelMsg:     async(e)=>{ const ch=v('cscm-ch'),m=v('cscm-msg'); if(!ch||!m){toastErr('Channel ID and message required');return;} run(()=>api.sendChannel(ch,m),getResultId(e?.target||document.activeElement)||''); },
  setNickname:        (e)=>{ const g=v('csbn-guild'); if(!g){toastErr('Guild ID required');return;} run(()=>api.setNickname(g,v('csbn-nick')||null),getResultId(e?.target||document.activeElement)||''); },
  stateSnapshot:      async(e)=>{ const r=await api.stateSnapshot().catch(x=>({error:x.message})); const rid=getResultId(e?.target||document.activeElement)||''; r?.success?showRes(rid,'ok',JSON.stringify(r.data,null,2)):showRes(rid,'err',r?.error||'Error'); },
  getInviteLink:      async(e)=>{ const r=await api.inviteLink().catch(x=>({error:x.message})); const rid=getResultId(e?.target||document.activeElement)||''; r?.link?showRes(rid,'ok',r.link):showRes(rid,'err',r?.error||'Error'); },
  usageStats:         async(e)=>{ const r=await api.usageStats().catch(x=>({error:x.message})); const rid=getResultId(e?.target||document.activeElement)||''; r?.success?showRes(rid,'ok',JSON.stringify(r.data,null,2)):showRes(rid,'err',r?.error||'Error'); },
};
