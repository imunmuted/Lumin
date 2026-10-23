import { getToken, getApiWebSocketUrl } from './config.js';

const THEME = {
  background:'#050508', foreground:'#E4E4F0', cursor:'#8B77FF', cursorAccent:'#050508',
  selectionBackground:'rgba(139,119,255,0.25)',
  black:'#1A1A25',  red:'#FF6B6B',    green:'#4ADE80',  yellow:'#FCD34D',
  blue:'#818CF8',   magenta:'#C084FC', cyan:'#67E8F9',   white:'#E4E4F0',
  brightBlack:'#555570',   brightRed:'#FF8585',    brightGreen:'#6BEE96',
  brightYellow:'#FDDF75',  brightBlue:'#A5B4FC',   brightMagenta:'#D8B4FE',
  brightCyan:'#93F0FF',    brightWhite:'#FFFFFF',
};

const OPTS = {
  theme:THEME, cursorBlink:true, cursorStyle:'bar',
  fontSize:13, fontFamily:"'JetBrains Mono','Fira Code','Cascadia Code',monospace",
  lineHeight:1.4, scrollback:5000, allowTransparency:true,
  disableStdin:false, convertEol:true,
};

const T = {
  node:  {term:null,ws:null,addon:null,ready:false,dispose:null},
  mongo: {term:null,ws:null,addon:null,ready:false,dispose:null},
  shell: {term:null,ws:null,addon:null,ready:false,dispose:null},
};

// Session authentication is cookie-only. Base URL supports separate console/API deployments.
const wsUrl = path => getApiWebSocketUrl(path);

function setConn(key, state) {
  const badge = document.getElementById(`${key}-badge`);
  if (badge) {
    badge.className = `conn-pill${state==='ok'?' ok':state==='warn'?' warn':''}`;
    const lbl = badge.querySelector('.conn-pill-lbl');
    if (lbl) lbl.textContent = state==='ok'?'Connected':state==='warn'?'Reconnecting…':'Disconnected';
    const dot = badge.querySelector('.conn-pill-dot');
    if (dot) dot.style.background = state==='ok'?'var(--ok)':state==='warn'?'var(--warn)':'var(--text3)';
  }
  const disc  = document.getElementById(`${key}-disconnect`);
  const recon = document.getElementById(`${key}-reconnect`);
  if (disc)  disc.classList.toggle('hidden',  state!=='ok');
  if (recon) recon.classList.toggle('hidden', state!=='disconnected');
}

const ro = new ResizeObserver(() => {
  for (const [,s] of Object.entries(T)) { if (s.ready) s.addon?.fit(); }
});

function initTerm(key, containerId) {
  const s = T[key];
  if (s.ready) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  s.term  = new Terminal(OPTS);
  s.addon = new FitAddon.FitAddon();
  s.term.loadAddon(s.addon);
  s.term.open(container);
  s.term.focus();
  requestAnimationFrame(() => { s.addon?.fit(); s.term?.focus(); });
  ro.observe(container);
  container.addEventListener('click', () => s.term?.focus());
  s.ready = true;
}

function connect(key, path) {
  const s = T[key];
  if (s.ws && s.ws.readyState < 2) return;
  setConn(key, 'warn');
  const ws = new WebSocket(wsUrl(path));
  ws.binaryType = 'arraybuffer';
  s.ws = ws;

  ws.onopen = () => {
    setConn(key, 'ok');
    s.term?.writeln('\x1b[32m[Connected — start typing]\x1b[0m\r');
    s.addon?.fit();
    s.term?.focus();
    if (s.dispose) { s.dispose.dispose(); s.dispose = null; }
    s.dispose = s.term?.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
      // Local echo: spawn() uses pipes, not a PTY, so the child process never
      // echoes characters back. We echo locally so input is visible while typing.
      if (data === '\r') {
        s.term?.write('\r\n');
      } else if (data === '\x7f' || data === '\b') {
        s.term?.write('\b \b');
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        s.term?.write(data);
      }
    });
  };

  ws.onmessage = e => {
    const text = typeof e.data==='string' ? e.data : new TextDecoder().decode(e.data);
    s.term?.write(text);
  };

  ws.onclose = () => {
    setConn(key, 'disconnected');
    s.term?.writeln('\r\n\x1b[33m[Session closed — click Reconnect]\x1b[0m\r');
    if (s.dispose) { s.dispose.dispose(); s.dispose = null; }
    s.ws = null;
  };

  ws.onerror = () => {
    setConn(key, 'disconnected');
    s.term?.writeln('\r\n\x1b[31m[Connection error]\x1b[0m\r');
    if (s.dispose) { s.dispose.dispose(); s.dispose = null; }
    s.ws = null;
  };
}

function disconnect(key) {
  if (T[key].dispose) { T[key].dispose.dispose(); T[key].dispose = null; }
  T[key].ws?.close(); T[key].ws = null;
  setConn(key, 'disconnected');
}

export function initNodeTerminal()  { initTerm('node',  'node-body');  if (!T.node.ws  || T.node.ws.readyState  > 1) connect('node',  '/ws/node'); }
export function initMongoTerminal() { initTerm('mongo', 'mongo-body'); if (!T.mongo.ws || T.mongo.ws.readyState > 1) connect('mongo', '/ws/mongo'); }
export function initShellTerminal() { initTerm('shell', 'shell-body'); if (!T.shell.ws || T.shell.ws.readyState > 1) connect('shell', '/ws/shell'); }

window.TERM = {
  disconnectNode:  ()=>disconnect('node'),
  reconnectNode:   ()=>{ T.node.term?.writeln('\x1b[36m[Reconnecting…]\x1b[0m\r'); connect('node','/ws/node'); },
  clearNode:       ()=>T.node.term?.clear(),
  disconnectMongo: ()=>disconnect('mongo'),
  reconnectMongo:  ()=>{ T.mongo.term?.writeln('\x1b[36m[Reconnecting…]\x1b[0m\r'); connect('mongo','/ws/mongo'); },
  clearMongo:      ()=>T.mongo.term?.clear(),
  disconnectShell: ()=>disconnect('shell'),
  reconnectShell:  ()=>{ T.shell.term?.writeln('\x1b[36m[Reconnecting…]\x1b[0m\r'); connect('shell','/ws/shell'); },
  clearShell:      ()=>T.shell.term?.clear(),
};
