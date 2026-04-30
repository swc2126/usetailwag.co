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

  // Inject global design tokens once per page (idempotent)
  if (!document.getElementById('tw-tokens-css')) {
    const link = document.createElement('link');
    link.id = 'tw-tokens-css';
    link.rel = 'stylesheet';
    link.href = '/css/tokens.css';
    document.head.appendChild(link);
  }

  // Lazy-load the global toast system once per page (idempotent)
  if (!window.tw || !window.tw.toast) {
    const ts = document.createElement('script');
    ts.src = '/js/toast.js';
    ts.async = false;
    document.head.appendChild(ts);
  }

  // Grouped sidebar — DAILY (the 5 daily-use surfaces) / ADMIN (less
  // frequently visited but still primary nav) / a demoted bottom slot
  // for Resources (help docs, lighter visual weight).
  const NAV_GROUPS = [
    {
      label: 'Daily',
      items: [
        { href: '/dashboard.html', label: 'Dashboard', icon: iconHome() },
        { href: '/schedule.html',  label: 'Schedule',  icon: iconCalendar() },
        { href: '/messaging.html', label: 'Messaging', icon: iconMessage() },
        { href: '/clients.html',   label: 'Directory', icon: iconPaw(), match: ['/clients', '/client-profile'] },
        { href: '/reviews.html',   label: 'Reviews',   icon: iconStar() }
      ]
    },
    {
      label: 'Admin',
      items: [
        { href: '/insights.html',  label: 'Insights',  icon: iconChart() },
        { href: '/team.html',      label: 'Team',      icon: iconUsers() },
        { href: '/settings.html',  label: 'Settings',  icon: iconGear() }
      ]
    },
    {
      label: null,
      bottom: true,
      items: [
        { href: '/resources.html', label: 'Resources', icon: iconBook() }
      ]
    }
  ];

  // Flattened — used by command palette + FAB to know about all pages
  const NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items);

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
      position: fixed; top: 14px; left: 14px; z-index: var(--tw-z-burger, 130);
      width: 40px; height: 40px; border-radius: var(--tw-radius-md, 10px);
      background: var(--tw-color-ink, #0F1410); color: var(--tw-color-on-dark, #F5F0E8);
      border: 1px solid var(--tw-color-on-dark-border, rgba(245,240,232,0.12));
      align-items: center; justify-content: center;
      cursor: pointer; box-shadow: var(--tw-shadow-2, 0 4px 14px rgba(0,0,0,0.18));
    }
    @media (max-width: 899px) {
      .tw-burger { display: flex; }
    }

    /* Backdrop (mobile drawer) */
    .tw-backdrop {
      display: none; position: fixed; inset: 0; z-index: var(--tw-z-drawer-bg, 110);
      background: rgba(15,20,16,0.55); backdrop-filter: blur(2px);
    }
    .tw-backdrop.open { display: block; }

    /* Sidebar */
    .tw-sidebar {
      position: fixed; top: 0; left: 0; height: 100vh;
      width: var(--tw-sidebar-w);
      background: var(--tw-color-ink, #0F1410); color: var(--tw-color-on-dark, #F5F0E8);
      display: flex; flex-direction: column;
      border-right: 1px solid var(--tw-color-on-dark-border, rgba(245,240,232,0.06));
      z-index: var(--tw-z-sidebar, 120);
      font-family: var(--tw-font-body, 'Inter', -apple-system, BlinkMacSystemFont, sans-serif);
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
    .tw-nav-group {
      display: flex; flex-direction: column; gap: 2px;
    }
    .tw-nav-group + .tw-nav-group { margin-top: 14px; }
    .tw-nav-group-label {
      font-size: 10px;
      font-weight: 800;
      color: rgba(245,240,232,0.40);
      letter-spacing: 0.10em;
      text-transform: uppercase;
      padding: 4px 14px 6px;
    }
    .tw-nav-bottom {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid rgba(245,240,232,0.06);
    }
    .tw-nav-bottom .tw-link {
      opacity: 0.72;
      font-size: 13px;
    }
    .tw-nav-bottom .tw-link:hover { opacity: 1; }

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
      ${NAV_GROUPS.map(g => `
        <div class="tw-nav-group${g.bottom ? ' tw-nav-bottom' : ''}">
          ${g.label ? `<div class="tw-nav-group-label">${g.label}</div>` : ''}
          ${g.items.map(it => `
            <a href="${it.href}" class="tw-link${activeItem === it ? ' active' : ''}">
              ${it.icon}<span>${it.label}</span>
            </a>
          `).join('')}
        </div>
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
    if (e.target.closest('.tw-link, .tw-brand, .tw-search-btn')) closeDrawer();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // ── Daycare name (read from cached nav-user payload if available) ────
  try {
    const cached = JSON.parse(localStorage.getItem('tailwag_nav_user') || 'null');
    if (cached && cached.daycare) {
      document.getElementById('twDaycareName').textContent = cached.daycare;
    }
  } catch {}

  // ── FAB (Floating Action Button) — global quick-create ───────────────
  const FAB_ACTIONS_ALL = [
    { label: 'New Pet Parent',  href: '/clients.html?action=add',  fn: 'openAddRecord', icon: iconPaw() },
    { label: 'New Appointment', href: '/schedule.html?action=add', fn: 'openAddModal',  icon: iconCalendar() },
    { label: 'Send Message',    href: '/messaging.html',           fn: null,            icon: iconMessage() },
    { label: 'Request Review',  href: '/reviews.html',             fn: null,            icon: iconStar() }
  ];

  // Hide the action that matches the current page — that page already
  // has its own primary "+" button up top, so duplicating it in the FAB
  // sheet just adds noise. Other pages still see all 4 quick-creates.
  const FAB_ACTIONS = FAB_ACTIONS_ALL.filter(a => {
    const targetPath = a.href.split('?')[0];
    return targetPath !== window.location.pathname;
  });

  const fabStyle = document.createElement('style');
  fabStyle.textContent = `
    .tw-fab {
      position: fixed; right: 24px; bottom: 24px; z-index: var(--tw-z-fab, 90);
      width: 56px; height: 56px; border-radius: 50%;
      background: #1E6B4A; color: #F5F0E8; border: none;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 6px 18px rgba(15,20,16,0.22);
      transition: transform 0.18s, box-shadow 0.18s, background 0.18s;
    }
    .tw-fab:hover { background: #164D35; box-shadow: 0 8px 22px rgba(15,20,16,0.28); }
    .tw-fab.open { transform: rotate(45deg); background: #0F1410; }
    .tw-fab svg { width: 26px; height: 26px; transition: transform 0.18s; }
    /* Hide FAB when any modal is open so it can't intercept modal clicks */
    body:has(.modal-overlay.open) .tw-fab,
    body:has(.modal-overlay.open) .tw-fab-sheet { display: none !important; }

    .tw-fab-sheet {
      position: fixed; right: 24px; bottom: 92px; z-index: calc(var(--tw-z-fab, 90) + 1);
      background: #fff; border-radius: 14px;
      box-shadow: 0 12px 32px rgba(15,20,16,0.18);
      min-width: 220px; padding: 6px;
      opacity: 0; transform: translateY(8px) scale(0.96);
      pointer-events: none;
      transition: opacity 0.16s, transform 0.16s;
    }
    .tw-fab-sheet.open {
      opacity: 1; transform: translateY(0) scale(1);
      pointer-events: auto;
    }
    .tw-fab-item {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 12px; border-radius: 8px;
      color: #2D3748; font-size: 14px; font-weight: 500;
      text-decoration: none; cursor: pointer;
      background: none; border: none; width: 100%; text-align: left;
      font-family: inherit;
      transition: background 0.12s, color 0.12s;
    }
    .tw-fab-item:hover { background: rgba(30,107,74,0.08); color: #1E6B4A; }
    .tw-fab-item svg { color: #1E6B4A; flex-shrink: 0; }

    @media (max-width: 899px) {
      .tw-fab        { right: 18px; bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
      .tw-fab-sheet  { right: 18px; bottom: calc(86px + env(safe-area-inset-bottom, 0px)); }
    }
  `;
  document.head.appendChild(fabStyle);

  // Skip the FAB entirely if every action is filtered (would happen
  // if every quick-create page got its own primary "+" — keeps the
  // floating button from appearing as an empty trigger).
  if (FAB_ACTIONS.length === 0) {
    // Nothing to do — fab/fabSheet/handlers below are bypassed.
  } else {

  const fab = document.createElement('button');
  fab.className = 'tw-fab';
  fab.setAttribute('aria-label', 'Quick create');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  document.body.appendChild(fab);

  const fabSheet = document.createElement('div');
  fabSheet.className = 'tw-fab-sheet';
  fabSheet.innerHTML = FAB_ACTIONS.map((a, i) =>
    `<button type="button" class="tw-fab-item" data-fab-i="${i}">${a.icon}<span>${a.label}</span></button>`
  ).join('');
  document.body.appendChild(fabSheet);

  function setFabOpen(open) {
    fab.classList.toggle('open', open);
    fabSheet.classList.toggle('open', open);
  }
  fab.addEventListener('click', (e) => {
    e.stopPropagation();
    setFabOpen(!fabSheet.classList.contains('open'));
  });
  document.addEventListener('click', (e) => {
    if (!fabSheet.contains(e.target) && !fab.contains(e.target)) setFabOpen(false);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setFabOpen(false); });

  fabSheet.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fab-i]');
    if (!btn) return;
    const action = FAB_ACTIONS[+btn.dataset.fabI];
    setFabOpen(false);

    const targetPath = action.href.split('?')[0];
    const onTargetPage = window.location.pathname === targetPath;
    if (onTargetPage && action.fn && typeof window[action.fn] === 'function') {
      window[action.fn]();
    } else {
      window.location.href = action.href;
    }
  });

  } // end if (FAB_ACTIONS.length > 0)

  // ── Cmd+K / Ctrl+K / "/" command palette ─────────────────────────────
  const cmdkStyle = document.createElement('style');
  cmdkStyle.textContent = `
    .tw-cmdk-backdrop {
      position: fixed; inset: 0; z-index: var(--tw-z-cmdk, 300);
      background: rgba(15,20,16,0.45); backdrop-filter: blur(2px);
      display: none;
    }
    .tw-cmdk-backdrop.open { display: block; }
    .tw-cmdk {
      position: fixed; z-index: calc(var(--tw-z-cmdk, 300) + 1);
      top: 12vh; left: 50%; transform: translateX(-50%);
      width: min(560px, calc(100vw - 32px));
      background: #fff; border-radius: 14px;
      box-shadow: 0 24px 60px rgba(15,20,16,0.30);
      overflow: hidden;
      display: none;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .tw-cmdk.open { display: block; }
    .tw-cmdk-input-wrap {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(0,0,0,0.06);
    }
    .tw-cmdk-input-wrap svg { color: #999; flex-shrink: 0; }
    .tw-cmdk-input {
      flex: 1; border: none; outline: none;
      font-size: 16px; color: #2D3748;
      font-family: inherit; background: transparent;
    }
    .tw-cmdk-hint {
      font-size: 11px; color: #aaa;
      padding: 3px 7px; border: 1px solid #e0dbd2;
      border-radius: 5px; flex-shrink: 0;
    }
    .tw-cmdk-results { max-height: 50vh; overflow-y: auto; padding: 6px 0; }
    .tw-cmdk-section-label {
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
      color: #aaa; padding: 8px 16px 4px;
    }
    .tw-cmdk-row {
      display: flex; align-items: center; gap: 12px;
      padding: 9px 16px; cursor: pointer;
      color: #2D3748; font-size: 14px;
      border: none; background: none; width: 100%; text-align: left;
      font-family: inherit;
    }
    .tw-cmdk-row.selected { background: rgba(30,107,74,0.08); }
    .tw-cmdk-row svg { color: #1E6B4A; flex-shrink: 0; }
    .tw-cmdk-row-main { flex: 1; min-width: 0; }
    .tw-cmdk-row-title { font-weight: 600; color: #0F1410; }
    .tw-cmdk-row-sub { font-size: 12px; color: #888; margin-top: 1px; }
    .tw-cmdk-empty { padding: 28px 16px; text-align: center; color: #888; font-size: 13px; }

    @media (max-width: 600px) {
      .tw-cmdk { top: 8px; width: calc(100vw - 16px); }
    }

    /* Sidebar search button */
    .tw-search-btn {
      display: flex; align-items: center; gap: 10px;
      margin: 4px 10px 8px; padding: 8px 12px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(245,240,232,0.10);
      border-radius: 8px;
      color: rgba(245,240,232,0.55);
      font-size: 13px; font-family: inherit;
      cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .tw-search-btn:hover {
      background: rgba(255,255,255,0.08);
      border-color: rgba(245,240,232,0.18);
      color: #F5F0E8;
    }
    .tw-search-btn span { flex: 1; }
    .tw-search-btn .tw-cmdk-hint {
      color: rgba(245,240,232,0.45);
      border-color: rgba(245,240,232,0.18);
      font-size: 10px;
    }
  `;
  document.head.appendChild(cmdkStyle);

  // Inject search button into sidebar (above nav items)
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'tw-search-btn';
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  searchBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <span>Search…</span>
    <span class="tw-cmdk-hint">${isMac ? '⌘' : 'Ctrl'} K</span>
  `;
  const navEl = sidebar.querySelector('.tw-nav');
  navEl.insertBefore(searchBtn, navEl.firstChild);

  // Build palette markup
  const cmdkBackdrop = document.createElement('div');
  cmdkBackdrop.className = 'tw-cmdk-backdrop';
  document.body.appendChild(cmdkBackdrop);

  const cmdk = document.createElement('div');
  cmdk.className = 'tw-cmdk';
  cmdk.setAttribute('role', 'dialog');
  cmdk.setAttribute('aria-label', 'Search and jump to');
  cmdk.innerHTML = `
    <div class="tw-cmdk-input-wrap">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" class="tw-cmdk-input" id="twCmdkInput" placeholder="Search clients, dogs, or jump to a page…" autocomplete="off" />
      <span class="tw-cmdk-hint">esc</span>
    </div>
    <div class="tw-cmdk-results" id="twCmdkResults">
      <div class="tw-cmdk-empty">Start typing to search…</div>
    </div>
  `;
  document.body.appendChild(cmdk);

  const cmdkInput   = cmdk.querySelector('#twCmdkInput');
  const cmdkResults = cmdk.querySelector('#twCmdkResults');
  let cmdkSelectedIndex = 0;
  let cmdkRows = [];   // [{kind, title, sub, href, icon}]
  let cmdkDebounce;

  const PAGE_TARGETS = NAV_ITEMS.map(it => ({
    kind: 'page',
    title: it.label,
    sub: 'Open page',
    href: it.href,
    icon: it.icon
  }));

  function openCmdk() {
    cmdkBackdrop.classList.add('open');
    cmdk.classList.add('open');
    cmdkInput.value = '';
    cmdkInput.focus();
    renderCmdkResults('');
  }
  function closeCmdk() {
    cmdkBackdrop.classList.remove('open');
    cmdk.classList.remove('open');
  }

  searchBtn.addEventListener('click', openCmdk);
  cmdkBackdrop.addEventListener('click', closeCmdk);

  // Global keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

    // Cmd/Ctrl+K — open palette (works even from inputs)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (cmdk.classList.contains('open')) closeCmdk(); else openCmdk();
      return;
    }
    // "/" — open palette only when not typing in an input
    if (e.key === '/' && !inField && !cmdk.classList.contains('open')) {
      e.preventDefault();
      openCmdk();
      return;
    }
    // Escape — close palette
    if (e.key === 'Escape' && cmdk.classList.contains('open')) {
      closeCmdk();
      return;
    }
  });

  cmdkInput.addEventListener('input', () => {
    clearTimeout(cmdkDebounce);
    const q = cmdkInput.value.trim();
    cmdkDebounce = setTimeout(() => renderCmdkResults(q), 150);
  });

  cmdkInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdkSelectedIndex = Math.min(cmdkSelectedIndex + 1, cmdkRows.length - 1);
      updateCmdkSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdkSelectedIndex = Math.max(cmdkSelectedIndex - 1, 0);
      updateCmdkSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = cmdkRows[cmdkSelectedIndex];
      if (row) {
        closeCmdk();
        window.location.href = row.href;
      }
    }
  });

  function updateCmdkSelection() {
    cmdkResults.querySelectorAll('.tw-cmdk-row').forEach((el, i) => {
      el.classList.toggle('selected', i === cmdkSelectedIndex);
      if (i === cmdkSelectedIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  async function renderCmdkResults(q) {
    cmdkSelectedIndex = 0;

    if (!q) {
      cmdkRows = PAGE_TARGETS.slice();
      renderCmdkRows([{ label: 'Pages', items: PAGE_TARGETS }]);
      return;
    }

    const ql = q.toLowerCase();
    const matchingPages = PAGE_TARGETS.filter(p => p.title.toLowerCase().includes(ql));

    // Hit existing /api/clients?q= which already searches owner name, phone, email, AND dog names
    let clientsHits = [];
    let dogsHits = [];
    try {
      const session = JSON.parse(localStorage.getItem('tailwag_session') || 'null');
      const headers = session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {};
      const res = await fetch('/api/clients?q=' + encodeURIComponent(q), { headers });
      if (res.ok) {
        const clients = await res.json();
        for (const c of clients.slice(0, 8)) {
          clientsHits.push({
            kind: 'client',
            title: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone || 'Unnamed',
            sub: [c.phone, c.email].filter(Boolean).join(' · ') || 'Pet parent',
            href: `/client-profile.html?id=${c.id}`,
            icon: iconPaw()
          });
          for (const d of (c.dogs || [])) {
            if ((d.name || '').toLowerCase().includes(ql)) {
              dogsHits.push({
                kind: 'dog',
                title: d.name,
                sub: `${[c.first_name, c.last_name].filter(Boolean).join(' ')}${d.breed ? ' · ' + d.breed : ''}`,
                href: `/client-profile.html?id=${c.id}`,
                icon: iconPaw()
              });
            }
          }
        }
      }
    } catch {}

    const sections = [];
    if (clientsHits.length) sections.push({ label: 'Pet Parents', items: clientsHits });
    if (dogsHits.length)    sections.push({ label: 'Dogs', items: dogsHits.slice(0, 8) });
    if (matchingPages.length) sections.push({ label: 'Pages', items: matchingPages });

    cmdkRows = sections.flatMap(s => s.items);
    renderCmdkRows(sections);
  }

  function renderCmdkRows(sections) {
    if (!sections.length || !cmdkRows.length) {
      cmdkResults.innerHTML = '<div class="tw-cmdk-empty">No results.</div>';
      return;
    }
    let html = '';
    let i = 0;
    for (const sec of sections) {
      html += `<div class="tw-cmdk-section-label">${sec.label}</div>`;
      for (const r of sec.items) {
        html += `<button type="button" class="tw-cmdk-row${i === 0 ? ' selected' : ''}" data-i="${i}">
          ${r.icon || ''}
          <div class="tw-cmdk-row-main">
            <div class="tw-cmdk-row-title">${escapeHtml(r.title)}</div>
            <div class="tw-cmdk-row-sub">${escapeHtml(r.sub || '')}</div>
          </div>
        </button>`;
        i++;
      }
    }
    cmdkResults.innerHTML = html;
    cmdkResults.querySelectorAll('.tw-cmdk-row').forEach(el => {
      el.addEventListener('mouseenter', () => {
        cmdkSelectedIndex = +el.dataset.i;
        updateCmdkSelection();
      });
      el.addEventListener('click', () => {
        closeCmdk();
        window.location.href = cmdkRows[+el.dataset.i].href;
      });
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  }

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
