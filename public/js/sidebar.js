/**
 * sidebar.js — shared left sidebar navigation for all post-login pages.
 *
 * Drop-in replacement for the old top-nav. Page only needs:
 *   <div id="tw-sidebar"></div>
 *   <script src="/js/sidebar.js"></script>
 *   <script src="/js/nav-user.js"></script>   (still required for the user widget)
 *
 * Behavior:
 *  - Fixed left rail (240px) on >=900px; body padding-left auto-adjusted.
 *  - Off-canvas drawer + hamburger trigger on <900px.
 *  - Active link auto-detected from window.location.pathname.
 *  - Reuses existing #navUserWidget mount so nav-user.js keeps working.
 */
(function () {
  const mount = document.getElementById('tw-sidebar');
  if (!mount) return;

  const NAV_ITEMS = [
    { href: '/dashboard.html',  label: 'Dashboard', icon: iconHome() },
    { href: '/clients.html',    label: 'Directory', icon: iconPaw(),     match: ['/clients', '/client-profile'] },
    { href: '/messaging.html',  label: 'Messaging', icon: iconMessage() },
    { href: '/schedule.html',   label: 'Schedule',  icon: iconCalendar() },
    { href: '/reviews.html',    label: 'Reviews',   icon: iconStar() },
    { href: '/insights.html',   label: 'Insights',  icon: iconChart() },
    { href: '/team.html',       label: 'Team',      icon: iconUsers() },
    { href: '/resources.html',  label: 'Resources', icon: iconBook() },
    { href: '/settings.html',   label: 'Settings',  icon: iconGear() }
  ];

  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const activeItem = NAV_ITEMS.find(it => {
    if (path === it.href || path === it.href.replace('.html','')) return true;
    if (it.match) return it.match.some(m => path.startsWith(m));
    return false;
  });

  // ── Styles ────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    :root { --tw-sidebar-w: 240px; }

    body { margin: 0; }
    @media (min-width: 900px) {
      body { padding-left: var(--tw-sidebar-w); }
    }

    /* Hamburger (mobile only) */
    .tw-burger {
      display: none;
      position: fixed; top: 14px; left: 14px; z-index: 130;
      width: 40px; height: 40px; border-radius: 10px;
      background: #0F1410; color: #F5F0E8; border: 1px solid rgba(245,240,232,0.12);
      align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.18);
    }
    @media (max-width: 899px) {
      .tw-burger { display: flex; }
    }

    /* Backdrop (mobile drawer) */
    .tw-backdrop {
      display: none; position: fixed; inset: 0; z-index: 110;
      background: rgba(15,20,16,0.55); backdrop-filter: blur(2px);
    }
    .tw-backdrop.open { display: block; }

    /* Sidebar */
    .tw-sidebar {
      position: fixed; top: 0; left: 0; height: 100vh;
      width: var(--tw-sidebar-w);
      background: #0F1410; color: #F5F0E8;
      display: flex; flex-direction: column;
      border-right: 1px solid rgba(245,240,232,0.06);
      z-index: 120;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    @media (max-width: 899px) {
      .tw-sidebar {
        transform: translateX(-100%);
        transition: transform 0.22s ease;
        box-shadow: 0 0 24px rgba(0,0,0,0.25);
      }
      .tw-sidebar.open { transform: translateX(0); }
    }

    .tw-brand {
      display: flex; align-items: center; gap: 10px;
      padding: 18px 18px 14px;
      text-decoration: none; color: inherit;
    }
    .tw-brand img { height: 26px; width: auto; }
    .tw-brand-name {
      font-family: 'Plus Jakarta Sans', sans-serif;
      font-weight: 800; font-size: 18px; letter-spacing: -0.01em;
    }
    .tw-daycare {
      padding: 0 18px 14px;
      font-size: 11px; font-weight: 600; color: rgba(245,240,232,0.45);
      text-transform: uppercase; letter-spacing: 0.06em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .tw-nav {
      flex: 1; overflow-y: auto;
      padding: 6px 10px 14px;
      display: flex; flex-direction: column; gap: 2px;
    }
    .tw-link {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; border-radius: 8px;
      color: rgba(245,240,232,0.66); text-decoration: none;
      font-size: 14px; font-weight: 500;
      transition: background 0.12s, color 0.12s;
    }
    .tw-link:hover { color: #F5F0E8; background: rgba(255,255,255,0.05); }
    .tw-link.active {
      color: #F5F0E8;
      background: rgba(30,107,74,0.22);
      box-shadow: inset 2px 0 0 #1E6B4A;
    }
    .tw-link svg { flex-shrink: 0; opacity: 0.85; }
    .tw-link.active svg { opacity: 1; color: #4ade80; }

    .tw-foot {
      border-top: 1px solid rgba(245,240,232,0.06);
      padding: 12px 14px;
    }
    /* nav-user.js styles already work; just give the widget room */
    .tw-foot .nu-wrap { padding: 8px 8px; }
    .tw-foot .nu-name { max-width: 130px; }
    .tw-foot .nu-dropdown {
      bottom: calc(100% + 6px); top: auto;
      right: auto; left: 0;
    }
  `;
  document.head.appendChild(style);

  // ── Markup ────────────────────────────────────────────────────────────
  const burger = document.createElement('button');
  burger.className = 'tw-burger';
  burger.setAttribute('aria-label', 'Open navigation');
  burger.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  document.body.appendChild(burger);

  const backdrop = document.createElement('div');
  backdrop.className = 'tw-backdrop';
  document.body.appendChild(backdrop);

  const sidebar = document.createElement('aside');
  sidebar.className = 'tw-sidebar';
  sidebar.innerHTML = `
    <a href="/dashboard.html" class="tw-brand">
      <img src="/images/tailwag-icon.svg" alt="" />
      <span class="tw-brand-name">TailWag</span>
    </a>
    <div class="tw-daycare" id="twDaycareName"></div>
    <nav class="tw-nav">
      ${NAV_ITEMS.map(it => `
        <a href="${it.href}" class="tw-link${activeItem === it ? ' active' : ''}">
          ${it.icon}<span>${it.label}</span>
        </a>
      `).join('')}
    </nav>
    <div class="tw-foot">
      <div id="navUserWidget"></div>
    </div>
  `;
  mount.replaceWith(sidebar);

  // ── Drawer behavior ───────────────────────────────────────────────────
  function openDrawer()  { sidebar.classList.add('open');  backdrop.classList.add('open'); }
  function closeDrawer() { sidebar.classList.remove('open'); backdrop.classList.remove('open'); }
  burger.addEventListener('click', openDrawer);
  backdrop.addEventListener('click', closeDrawer);
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.tw-link, .tw-brand')) closeDrawer();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // ── Daycare name (read from cached nav-user payload if available) ────
  try {
    const cached = JSON.parse(localStorage.getItem('tailwag_nav_user') || 'null');
    if (cached && cached.daycare) {
      document.getElementById('twDaycareName').textContent = cached.daycare;
    }
  } catch {}

  // ── Inline SVG icons ──────────────────────────────────────────────────
  function svg(d) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  }
  function iconHome()     { return svg('<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'); }
  function iconPaw()      { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="15" r="4"/><circle cx="6" cy="10" r="2.2"/><circle cx="18" cy="10" r="2.2"/><circle cx="9" cy="5.5" r="1.9"/><circle cx="15" cy="5.5" r="1.9"/></svg>'; }
  function iconMessage()  { return svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'); }
  function iconCalendar() { return svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'); }
  function iconStar()     { return svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'); }
  function iconChart()    { return svg('<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>'); }
  function iconUsers()    { return svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'); }
  function iconBook()     { return svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'); }
  function iconGear()     { return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'); }
})();
