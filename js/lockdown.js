import { api } from './api.js';
import { setLockdownIndicator } from './router.js';
import { toastOk, toastErr } from './toast.js';

export async function loadLockdownState() {
  const r = await api.getStats().catch(() => null);
  if (r?.globalLockdown !== undefined) setLockdownIndicator(!!r.globalLockdown);
}

export async function toggleLockdown(enabled) {
  const r = await api.setLockdown(enabled).catch(() => null);
  if (r?.success) { toastOk(r.message); setLockdownIndicator(enabled); }
  else toastErr(r?.error || 'Error');
}
