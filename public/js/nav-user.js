/**
 * nav-user.js — shared user profile widget for all dashboard pages.
 * Reads session from localStorage, calls GET /api/auth/me, and renders
 * an avatar + name + role badge + dropdown in #navUserWidget.
 */
(function () {
  const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', staff: 'Staff' };
  const ROLE_COLORS = {
    owner: 'background:rgba(196,147,63,0.18);color:#C4933F;',
    admin: 'background:rgba(30,107,74,0.15);color:#1E6B4A;',
    staff: 'background:rgba(255,255,255,0.1);color:rgba(245,240,232,0.6);'
  };

  // Inject widget styles once
  const style = document.createElement('style');
  style.textContent = `
    .nu-wrap {
      position: relative;
      display: flex; align-items: center; gap: 10px;
      cursor: pointer; user-select: none;
      padding: 6px 10px; border-radius: 8px;
      transition: background 0.15s;
    }
    .nu-wrap:hover { background: rgba(255,255,255,0.07); }
    .nu-avatar {
      width: 34px; height: 34px; border-radius: 50%;
      background: #1E6B4A; border: 2px solid rgba(168,197,176,0.4);
      display: flex; align-items: center; justify-content: center;
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-weight: 800; font-size: 13px; color: #F5F0E8;
      flex-shrink: 0;
    }
    .nu-info { display: flex; flex-direction: column; line-height: 1.2; }
    .nu-name {
      font-size: 13px; font-weight: 600; color: #F5F0E8;
      white-space: nowrap; max-width: 140px;
      overflow: hidden; text-overflow: ellipsis;
    }
    .nu-role {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.5px; padding: 1px 6px; border-radius: 10px;
      display: inline-block; margin-top: 2px; width: fit-content;
    }
    .nu-caret {
      font-size: 10px; color: rgba(245,240,232,0.4); margin-left: 2px;
    }
    .nu-dropdown {
      display: none; position: absolute; top: calc(100% + 6px); right: 0;
      background: #fff; border-radius: 10px; min-width: 200px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18); overflow: hidden;
      z-index: 1000; border: 1px solid rgba(0,0,0,0.06);
    }
    .nu-dropdown.open { display: block; }
    .nu-dd-header {
      padding: 14px 16px 10px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .nu-dd-name { font-weight: 700; font-size: 14px; color: #0F1410; }
    .nu-dd-email { font-size: 11px; color: #999; margin-top: 2px; word-break: break-all; }
    .nu-dd-role-wrap { margin-top: 6px; }
    .nu-dd-role {
      font-size: 10px; font-weight: 800; text-transform: uppercase;
      letter-spacing: 0.5px; padding: 2px 8px; border-radius: 10px;
      display: inline-block;
    }
    .nu-dd-role.owner { background: rgba(196,147,63,0.15); color: #C4933F; }
    .nu-dd-role.admin { background: rgba(30,107,74,0.12); color: #1E6B4A; }
    .nu-dd-role.staff { background: rgba(0,0,0,0.06); color: #888; }
    .nu-dd-item {
      display: flex; align-items: center; gap: 10px;
      padding: 11px 16px; font-size: 13px; font-weight: 500;
      color: #2D3748; text-decoration: none; width: 100%;
      background: none; border: none; font-family: inherit;
      cursor: pointer; text-align: left; transition: background 0.12s;
    }
    .nu-dd-item:hover { background: rgba(30,107,74,0.05); color: #1E6B4A; }
    .nu-dd-item.danger { color: #e53e3e; }
    .nu-dd-item.danger:hover { background: rgba(229,62,62,0.05); }
    .nu-dd-divider { height: 1px; background: rgba(0,0,0,0.06); margin: 2px 0; }
  `;
  document.head.appendChild(style);

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem('tailwag_session') || 'null');
    } catch { return null; }
  }

  function getInitials(firstName, lastName, email) {
    const f = (firstName || '').trim()[0] || '';
    const l = (lastName || '').trim()[0] || '';
    if (f || l) return (f + l).toUpperCase();
    return (email || '?')[0].toUpperCase();
  }

  function doLogout() {
    localStorage.removeItem('tailwag_session');
    localStorage.removeItem('tailwag_user');
    window.location.href = '/login.html';
  }

  async function initNavUser() {
    const container = document.getElementById('navUserWidget');
    if (!container) return;

    const session = getSession();
    if (!session?.access_token) {
      window.location.href = '/login.html';
      return;
    }

    // Fallback: render minimal widget immediately from session cache
    const cachedUser = (() => {
      try { return JSON.parse(localStorage.getItem('tailwag_nav_user') || 'null'); } catch { return null; }
    })();
    if (cachedUser) renderWidget(container, cachedUser);

    // Fetch fresh data
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: 'Bearer ' + session.access_token }
      });
      if (!res.ok) { if (res.status === 401) doLogout(); return; }
      const data = await res.json();

      const userData = {
        first_name: data.profile?.first_name || '',
        last_name:  data.profile?.last_name  || '',
        email:      data.user?.email          || '',
        role:       data.role                 || 'staff',
        daycare:    data.daycare?.name        || ''
      };

      // Cache for instant load next time
      localStorage.setItem('tailwag_nav_user', JSON.stringify(userData));

      // Make role available globally for permission checks
      window.TailWagUserRole = userData.role;

      renderWidget(container, userData);
    } catch (e) {
      console.warn('nav-user fetch failed', e);
    }
  }

  function renderWidget(container, u) {
    const initials = getInitials(u.first_name, u.last_name, u.email);
    const displayName = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email;
    const roleLabel = ROLE_LABELS[u.role] || 'Staff';
    const roleStyle = ROLE_COLORS[u.role] || ROLE_COLORS.staff;

    container.innerHTML = `
      <div class="nu-wrap" id="nuWrap" onclick="window.__nuToggle(event)">
        <div class="nu-avatar">${initials}</div>
        <div class="nu-info">
          <div class="nu-name">${esc(displayName)}</div>
          <span class="nu-role" style="${roleStyle}">${roleLabel}</span>
        </div>
        <span class="nu-caret">▾</span>
        <div class="nu-dropdown" id="nuDropdown">
          <div class="nu-dd-header">
            <div class="nu-dd-name">${esc(displayName)}</div>
            <div class="nu-dd-email">${esc(u.email)}</div>
            <div class="nu-dd-role-wrap">
              <span class="nu-dd-role ${u.role}">${roleLabel}${u.daycare ? ' · ' + esc(u.daycare) : ''}</span>
            </div>
          </div>
          <a href="/profile.html" class="nu-dd-item">👤 &nbsp;My Profile</a>
          <div class="nu-dd-divider"></div>
          <button class="nu-dd-item danger" onclick="window.__nuLogout()">Sign Out</button>
        </div>
      </div>`;
  }

  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Global helpers (attached to window so inline onclick works)
  window.__nuToggle = function (e) {
    e.stopPropagation();
    const dd = document.getElementById('nuDropdown');
    if (dd) dd.classList.toggle('open');
  };
  window.__nuLogout = doLogout;

  // Close dropdown when clicking outside
  document.addEventListener('click', function () {
    const dd = document.getElementById('nuDropdown');
    if (dd) dd.classList.remove('open');
  });

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNavUser);
  } else {
    initNavUser();
  }
})();
