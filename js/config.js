// Fix #10: sessionStorage token storage removed — auth is now cookie-only.
// Token is carried via HttpOnly lumin_session cookie; /auth/me verifies the session.
export const BASE_URL = String(window.HELIUM_API_BASE_URL || (window.location.origin + '/dashboard')).replace(/\/$/, '');

/** Build a WebSocket URL against the configured API origin for a split frontend/backend deployment. */
export function getApiWebSocketUrl(route) {
  const base = new URL(BASE_URL, window.location.origin);
  const prefix = base.pathname.replace(/\/$/, '');
  const suffix = String(route || '').startsWith('/') ? String(route) : `/${route}`;
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${base.host}${prefix}${suffix}`;
}

// Kept for any legacy callers during transition — return empty string; server uses cookie.
export const getToken   = () => '';
export const setToken   = _t => {};
export const clearToken = () => {};
export const hasToken   = () => false;

const I = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">${d}</svg>`;

export const PAGES = [
  { id:'overview',      label:'Overview',  group:'Monitor',  title:'Overview',            icon:I('<rect x="3" y="13" width="7" height="8" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/><rect x="3" y="3" width="7" height="6" rx="1"/>') },
  { id:'servers',       label:'Servers',   group:'Monitor',  title:'Servers',             icon:I('<circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><path d="M2 12h20"/>') },
  { id:'users',         label:'Users',     group:'Monitor',  title:'User Management',     icon:I('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>') },
  { id:'models',        label:'Models',    group:'Monitor',  title:'Models & API Keys',   icon:I('<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>') },
  { id:'commands',      label:'Commands',  group:'Control',  title:'Admin Commands',      icon:I('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>') },
  { id:'presence',      label:'Presence',  group:'Control',  title:'Bot Presence',        icon:I('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>') },
  { id:'announce',      label:'Announce',  group:'Control',  title:'Global Announcement', icon:I('<path d="M3 11l19-9-9 19-2-8-8-2z"/>') },
  { id:'lockdown',      label:'Lockdown',  group:'Control',  title:'Global Lockdown',     icon:I('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>'), lockdown:true },
  { id:'config',        label:'Config',    group:'Advanced', title:'Config Editor',       icon:I('<path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>') },
  { id:'database',      label:'Database',  group:'Advanced', title:'Database Browser',    icon:I('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>') },
  { id:'files',         label:'Files',     group:'Advanced', title:'File Browser',        icon:I('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>') },
  { id:'node-console',  label:'Node.js',   group:'Consoles', title:'Node.js REPL',        icon:I('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>') },
  { id:'mongo-console', label:'MongoDB',   group:'Consoles', title:'MongoDB Shell',       icon:I('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>') },
  { id:'shell-console', label:'Shell',     group:'Consoles', title:'Bash Shell',          icon:I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8l4 4-4 4M13 16h4"/>') },
];
