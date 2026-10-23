import { api } from './api.js';
import { toastOk, toastErr } from './toast.js';

export function initAnnounce() {}
export async function sendAnnouncement(payload, target) {
  if (target === 'servers' || target === 'both') { await api.announce(payload).catch(()=>{}); }
  if (target === 'users'   || target === 'both') { await api.announceUsers(payload).catch(()=>{}); }
}
