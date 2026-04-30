/**
 * toast.js — universal toast notification system.
 *
 * Loaded by sidebar.js so every authenticated page gets it.
 *
 * Public API:
 *   tw.toast(message)
 *   tw.toast(message, { type, action, duration })
 *
 *   type      : 'success' (default) | 'error' | 'info' | 'warning'
 *   action    : { label: 'Undo', onClick: () => { ... } }
 *   duration  : auto-dismiss ms (default 4500, or 8000 if action present, or 0 = sticky)
 *
 *   Returns a function that dismisses the toast manually.
 *
 * Backward compatibility:
 *   window.showToast(msg, type) keeps working — wraps tw.toast().
 *
 * Behavior:
 *   - Stacks bottom-right (newest on top)
 *   - Click action button → fires onClick, dismisses
 *   - Click ✕ → dismisses
 *   - Auto-dismiss after `duration` ms
 *   - Mobile: stacks bottom-center, full-width minus padding
 */
(function () {
  if (window.tw && window.tw.toast) return; // already loaded
  window.tw = window.tw || {};

  // ── Styles (injected once) ───────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .tw-toast-host {
      position: fixed; right: 20px; bottom: 20px; z-index: var(--tw-z-toast, 400);
      display: flex; flex-direction: column-reverse; gap: 10px;
      pointer-events: none;
      max-width: min(380px, calc(100vw - 32px));
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    @media (max-width: 600px) {
      .tw-toast-host { left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); max-width: none; }
    }
    .tw-toast {
      pointer-events: auto;
      background: #fff; color: #2D3748;
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(15,20,16,0.18), 0 1px 3px rgba(0,0,0,0.06);
      padding: 12px 14px 12px 16px;
      display: flex; align-items: center; gap: 12px;
      font-size: 13px; line-height: 1.4;
      border-left: 4px solid #1E6B4A;
      transform: translateY(8px); opacity: 0;
      transition: transform 0.18s ease, opacity 0.18s ease;
    }
    .tw-toast.show { transform: translateY(0); opacity: 1; }
    .tw-toast.leaving { transform: translateY(8px); opacity: 0; }
    .tw-toast.error    { border-left-color: #c0392b; }
    .tw-toast.warning  { border-left-color: #C4933F; }
    .tw-toast.info     { border-left-color: #3b5fc0; }

    .tw-toast-msg { flex: 1; min-width: 0; }
    .tw-toast-msg strong { color: #0F1410; font-weight: 700; }

    .tw-toast-action {
      flex-shrink: 0;
      background: none; border: 1px solid rgba(0,0,0,0.14);
      color: #1E6B4A; font-weight: 700; font-size: 12px;
      padding: 5px 11px; border-radius: 6px; cursor: pointer;
      font-family: inherit; transition: background 0.12s, border-color 0.12s;
    }
    .tw-toast-action:hover { background: rgba(30,107,74,0.08); border-color: #1E6B4A; }
    .tw-toast.error    .tw-toast-action { color: #c0392b; }
    .tw-toast.error    .tw-toast-action:hover { background: rgba(192,57,43,0.08); border-color: #c0392b; }

    .tw-toast-close {
      flex-shrink: 0;
      background: none; border: none; cursor: pointer;
      color: rgba(0,0,0,0.32); font-size: 16px; line-height: 1;
      padding: 2px 4px; border-radius: 4px;
      font-family: inherit;
    }
    .tw-toast-close:hover { color: rgba(0,0,0,0.7); background: rgba(0,0,0,0.04); }
  `;
  document.head.appendChild(style);

  // ── Host container (one per page) ────────────────────────────────────
  function getHost() {
    let host = document.getElementById('tw-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tw-toast-host';
      host.className = 'tw-toast-host';
      document.body.appendChild(host);
    }
    return host;
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

  // ── Public API ───────────────────────────────────────────────────────
  tw.toast = function (message, options) {
    const opts = options || {};
    const type = opts.type || 'success';
    const duration = opts.duration != null
      ? opts.duration
      : (opts.action ? 8000 : 4500);

    const host = getHost();
    const el = document.createElement('div');
    el.className = 'tw-toast ' + type;
    el.innerHTML =
      `<div class="tw-toast-msg">${escHtml(message)}</div>` +
      (opts.action ? `<button class="tw-toast-action" type="button">${escHtml(opts.action.label || 'Undo')}</button>` : '') +
      `<button class="tw-toast-close" type="button" aria-label="Dismiss">&times;</button>`;
    host.appendChild(el);
    // Force reflow so the entry animation runs
    requestAnimationFrame(() => el.classList.add('show'));

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      el.classList.add('leaving');
      el.classList.remove('show');
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }

    if (opts.action) {
      el.querySelector('.tw-toast-action').addEventListener('click', () => {
        try { opts.action.onClick && opts.action.onClick(); } catch (e) { console.error(e); }
        dismiss();
      });
    }
    el.querySelector('.tw-toast-close').addEventListener('click', dismiss);

    if (duration > 0) setTimeout(dismiss, duration);

    return dismiss;
  };

  // ── Backward-compat wrapper for existing showToast() callers ─────────
  // Old signature: showToast(msg, type)  where type was '' | 'success' | 'error'
  if (!window.showToast) {
    window.showToast = function (message, type) {
      return tw.toast(message, { type: type === 'error' ? 'error' : 'success' });
    };
  }
})();
