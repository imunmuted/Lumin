const region = () => document.getElementById('toast-r');

function show(msg, type, ms=3500) {
  const r = region(); if (!r) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = String(msg).slice(0, 200);
  r.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(()=>t.remove(),300); }, ms);
}

export const toastOk   = msg => show(msg, 'ok');
export const toastErr  = msg => show(msg, 'err', 4500);
export const toastInfo = msg => show(msg, 'info');
export const toastWarn = msg => show(msg, 'warn');

/**
 * Replace window.confirm() with a non-blocking toast confirmation.
 * Returns a Promise<boolean>.
 * Usage: if (!await toastConfirm('Sure?')) return;
 */
export function toastConfirm(msg) {
  return new Promise(resolve => {
    const r = region(); if (!r) { resolve(window.confirm(msg)); return; }
    const t = document.createElement('div');
    t.className = 'toast confirm';
    t.innerHTML = `<span class="toast-msg">${String(msg).slice(0,160)}</span>
      <div class="toast-btns">
        <button class="toast-yes">Confirm</button>
        <button class="toast-no">Cancel</button>
      </div>`;
    r.appendChild(t);
    const cleanup = (val) => { t.remove(); resolve(val); };
    t.querySelector('.toast-yes').onclick = () => cleanup(true);
    t.querySelector('.toast-no').onclick  = () => cleanup(false);
  });
}
