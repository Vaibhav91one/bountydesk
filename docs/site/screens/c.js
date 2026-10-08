// Variant C behaviors. Screens are markup only: everything here is driven by data attributes (contract in c.css).
// Plain script, no build. Every URL it builds keeps ?platform, ?theme, ?data and the embed options.
(() => {
  'use strict';
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  const PF = q.get('platform') === 'android' || q.get('platform') === 'web' ? q.get('platform') : 'ios';
  const EMBED = q.has('embed');
  const EMPTY = q.get('data') === 'empty';
  const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const device = $('.device');
  if (!device) return;
  const page = (location.pathname.match(/(m\d+|c\d+)\.html$/) || [])[1] || '';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- icons: <i data-icon="bell"></i> becomes an inline svg ----------
  const D = (x, y) => `<circle cx="${x}" cy="${y}" r="1.2" fill="currentColor"/>`;
  const ICONS = {
    bell: '<path d="M6 9a6 6 0 1112 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 004 0"/>',
    more: D(5, 12) + D(12, 12) + D(19, 12),
    back: '<path d="M15 5l-7 7 7 7"/>', chev: '<path d="M9 5l7 7-7 7"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 001 1h12a1 1 0 001-1v-7"/>',
    home: '<path d="M3 11l9-7.5 9 7.5v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
    queue: '<path d="M3 13l2.5-7.5A2 2 0 017.4 4h9.2a2 2 0 011.9 1.5L21 13v5a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M3 13h5l1 2h6l1-2h5"/>',
    reports: '<path d="M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    chat: '<path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2h-7l-5 4v-4H6a2 2 0 01-2-2z"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 017.5 4H15"/>',
    userplus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20a6.5 6.5 0 0113 0M19 8v6M16 11h6"/>',
    github: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4.5-12 2-12 5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    arrowup: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>',
    file: '<path d="M6 3h9l4 4v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14 3v5h5"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 14v5a1 1 0 001 1h12a1 1 0 001-1v-5"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>',
    refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/>'
  };
  const icons = (scope = document) => $$('[data-icon]', scope).forEach(n => {
    const p = ICONS[n.dataset.icon]; if (!p) return;
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', ('i ' + (n.getAttribute('class') || '')).trim());
    if (n.getAttribute('style')) s.setAttribute('style', n.getAttribute('style'));
    s.innerHTML = p; n.replaceWith(s);
  });
  const svg = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  // ---------- chrome: wrap the moving part, inject status bar, island, home indicator, tag ----------
  if (!$('.screen', device)) {
    const w = document.createElement('div'); w.className = 'screen';
    [...device.children].filter(c => !c.matches('.sheet,.scrim,.pop,.toast,script')).forEach(c => w.appendChild(c));
    device.prepend(w);
  }
  const screen = $('.screen', device);
  if (!$('.status', device)) {
    device.insertAdjacentHTML('afterbegin', '<div class="island"></div><div class="status"><span>9:41</span><span class="r" aria-hidden="true">' +
      '<svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>' +
      '<svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 4.2a10 10 0 0114 0M3.5 7a6.4 6.4 0 019 0"/><circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none"/></svg>' +
      '<svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="22" height="12" rx="3.5" stroke="currentColor" opacity=".4"/><rect x="2" y="2" width="19" height="9" rx="2.2" fill="currentColor"/><path d="M24.5 4.5v4c.9-.3 1.5-1.2 1.5-2s-.6-1.7-1.5-2z" fill="currentColor" opacity=".45"/></svg></span></div>');
  }
  if (!$('.hind', device)) device.insertAdjacentHTML('beforeend', '<div class="hind"></div>');
  if (!$('.tag')) document.body.insertAdjacentHTML('afterbegin', '<div class="tag">Proposed mobile app (not built)</div>');
  device.insertAdjacentHTML('beforeend', '<div class="toast glass" role="status"></div><div class="scrim" hidden></div>');

  // ---------- builders: tab dock and the top-right pill ----------
  const TABS = [['home', 'Home', 'm4.html'], ['queue', 'Queue', 'm5.html'], ['reports', 'Reports', 'm6.html']];
  $$('nav[data-tabs]').forEach(nav => {
    nav.classList.add('dock'); nav.setAttribute('aria-label', 'Primary');
    const cur = nav.dataset.tabs, n = nav.dataset.review || '0';
    const fab = EMPTY
      ? `<a class="fab" href="#" data-go="m14.html" aria-label="Connect a repository">${svg('plus')}</a>`
      : `<a class="fab" href="#" data-go="m11.html" aria-label="Review next verdict, ${n} waiting">${svg('check')}${+n ? `<b aria-hidden="true">${esc(n)}</b>` : ''}</a>`;
    nav.innerHTML = '<div class="tabs glass">' + TABS.map(([k, l, f]) =>
      `<a class="tab${k === cur ? ' on' : ''}" href="#" data-go="${f}" data-kind="tab"${k === cur ? ' aria-current="page"' : ''}>${svg(k)}${l}</a>`).join('') + '</div>' + fab;
  });
  $$('[data-topbar="tab"]').forEach(bar => {
    bar.classList.add('topbar', 'glass');
    bar.innerHTML = `<a class="ib" href="#" data-go="m23.html" aria-label="Inbox, 2 unread">${svg('bell')}</a>` +
      `<button class="ib" type="button" data-menu="#moremenu" aria-label="More, includes Settings" aria-haspopup="menu" aria-expanded="false">${svg('more')}</button>`;
    device.insertAdjacentHTML('beforeend', '<div class="menu pop" id="moremenu" role="menu" aria-label="More" hidden>' +
      `<a role="menuitem" href="#" data-go="m19.html">Settings${svg('cog')}</a><a role="menuitem" href="#" data-go="m14.html">Connections${svg('github')}</a><a role="menuitem" href="#" data-go="m16.html">Integrations${svg('mail')}</a></div>`);
  });
  $$('.pop').forEach(p => device.appendChild(p));
  icons();
  $$('[data-full]').forEach(n => n.toggleAttribute('hidden', EMPTY));   // toggleAttribute: svg has no .hidden
  $$('[data-empty]').forEach(n => n.toggleAttribute('hidden', !EMPTY));
  $$('[data-go]:not(a,button,.device)').forEach(n => { n.tabIndex = 0; n.setAttribute('role', 'link'); });
  $$('.item:has(.switch)').forEach(n => n.setAttribute('data-switch-row', ''));

  // ---------- navigation ----------
  const KEEP = ['platform', 'theme', 'data', 'text', 'embed', 'sr', 'targets', 'guides', 'hot'];
  const href = file => {
    const u = new URL(file, location.href);
    KEEP.forEach(k => { if (q.has(k) && !(k === 'data' && q.get(k) === 'demo')) u.searchParams.set(k, q.get(k)); });
    return u.href;
  };
  const setFlag = k => { try { sessionStorage.setItem('bd-nav', k + '|' + Date.now()); } catch (_) {} };
  const readFlag = () => { try { const [k, t] = (sessionStorage.getItem('bd-nav') || '').split('|'); return k && Date.now() - +t < 3000 ? k : ''; } catch (_) { return ''; } };
  const clearFlag = () => { try { sessionStorage.removeItem('bd-nav'); } catch (_) {} };
  const tell = m => parent.postMessage({ proto: true, ...m }, '*');
  const go = (file, kind = 'push') => {
    if (EMBED) { tell({ go: file.replace(/\.html.*$/, ''), kind: kind === 'back' ? 'pop' : kind }); return; }
    setFlag(kind === 'pop' ? 'back' : kind); location.href = href(file);
  };
  const nav = window.navigation;
  const back = file => {
    if (EMBED) { tell({ go: (file || 'm4.html').replace(/\.html.*$/, ''), kind: 'pop', back: true }); return; }
    const prev = nav && nav.entries()[nav.currentEntry.index - 1];
    if (prev && new URL(prev.url).origin === location.origin && /\/m\d+\.html/.test(prev.url)) { setFlag('back'); history.back(); }
    else go(file || 'm4.html', 'pop');
  };
  const quiet = vt => ['ready', 'finished', 'updateCallbackDone'].forEach(k => vt[k] && vt[k].catch(() => {}));
  addEventListener('pageswap', e => { if (e.viewTransition) quiet(e.viewTransition); });
  addEventListener('pagereveal', e => {
    const vt = e.viewTransition; if (!vt) return;
    if (EMBED) { quiet(vt); vt.skipTransition(); return; }
    let kind = readFlag();
    const act = nav && nav.activation;
    if (!kind && act && act.navigationType === 'traverse') kind = act.from && act.from.index > act.entry.index ? 'back' : 'push';
    quiet(vt);
    if (kind === 'tab' || PF === 'web') { vt.skipTransition(); return; }   // tabs are peers, the web look is instant
    vt.types.add(kind || 'push');
  });
  addEventListener('pageshow', clearFlag);
  const auto = $('[data-auto-go]');
  if (auto && !EMBED) setTimeout(() => go(auto.dataset.autoGo, auto.dataset.kind || 'modal'), +auto.dataset.autoMs || 1600);

  // ---------- haptic tag (embed only, never on the web platform) ----------
  let hapEl, hapT;
  const hap = kind => {
    if (!EMBED || PF === 'web') return false;
    if (!hapEl) { hapEl = document.createElement('div'); hapEl.className = 'bd-hap'; hapEl.setAttribute('aria-hidden', 'true'); device.appendChild(hapEl); }
    hapEl.innerHTML = '<svg viewBox="0 0 24 24"><rect x="8" y="4" width="8" height="16" rx="2"/><path d="M4.5 9v6M19.5 9v6"/></svg>Haptic: ' + kind;
    hapEl.classList.add('on'); clearTimeout(hapT); hapT = setTimeout(() => hapEl.classList.remove('on'), 1500);
    return true;
  };

  // ---------- toast ----------
  const toastEl = $('.toast', device); let toastT = 0;
  const toast = msg => {
    clearTimeout(toastT); toastEl.textContent = msg; toastEl.classList.add('show');
    toastT = setTimeout(() => toastEl.classList.remove('show'), 2000);
  };

  // ---------- bottom sheets: spring, drag to dismiss, scaled screen behind ----------
  const ZETA = 0.8, OMEGA = (2 * Math.PI) / 0.3;
  const scrimEl = $('.scrim', device);
  const sheets = {}; let active = null;
  const useCss = () => PF === 'web' || reducedMQ.matches;
  const makeSheet = sheet => {
    let y = null, v = 0, raf = 0, isOpen = false, focusBack = null, drag = null;
    const closedY = () => sheet.offsetHeight + 64;
    const apply = () => {
      sheet.style.transform = `translate3d(0,${y}px,0)`;
      device.style.setProperty('--p', Math.max(0, Math.min(1, 1 - y / closedY())).toFixed(3));
    };
    const settleClosed = () => { sheet.style.transform = ''; sheet.classList.remove('js'); device.style.removeProperty('--p'); device.classList.remove('sheeting'); sheet.inert = true; y = null; };
    const spring = (to, v0) => {
      cancelAnimationFrame(raf); if (v0 !== undefined) v = v0;
      let t0 = performance.now();
      const step = now => {
        const dt = Math.min((now - t0) / 1000, 1 / 30); t0 = now;
        const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
        for (let i = 0; i < n; i++) { v += (-OMEGA * OMEGA * (y - to) - 2 * ZETA * OMEGA * v) * h; y += v * h; }
        apply();
        if (Math.abs(y - to) < 0.3 && Math.abs(v) < 8) { y = to; v = 0; apply(); if (!isOpen) settleClosed(); return; }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const setOpen = (o, v0, instant) => {
      if (o === isOpen && !instant) return;
      isOpen = o; active = o ? api : (active === api ? null : active);
      device.classList.toggle('open', o); scrimEl.hidden = !o; sheet.inert = !o;
      if (o) { focusBack = document.activeElement; device.classList.add('sheeting'); if (!instant) $('.sbtn.x', sheet)?.focus({ preventScroll: true }); }
      else if (focusBack) { focusBack.focus?.({ preventScroll: true }); focusBack = null; }
      if (instant) { device.style.setProperty('--p', o ? 1 : 0); return; }
      if (useCss()) { sheet.style.transform = ''; device.style.setProperty('--p', o ? 1 : 0); if (!o) setTimeout(() => { if (!isOpen) settleClosed(); }, 340); return; }
      sheet.classList.add('js');
      if (y == null) { y = o ? closedY() : 0; apply(); }
      spring(o ? 0 : closedY(), v0);
    };
    // drag from the header strip: handle and title
    const rubber = d => { const L = 60; return (1 - 1 / ((d * 0.55) / L + 1)) * L; };
    sheet.addEventListener('pointerdown', e => {
      if (!isOpen || useCss() || e.target.closest('.sbtn,input,textarea,label,button')) return;
      if (e.clientY - sheet.getBoundingClientRect().top > 84) return;
      cancelAnimationFrame(raf); if (y == null) y = 0;
      drag = { id: e.pointerId, y0: e.clientY, base: y, s: [[performance.now(), e.clientY]] };
      try { sheet.setPointerCapture(e.pointerId); } catch (_) {}
    });
    sheet.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const raw = drag.base + (e.clientY - drag.y0);
      y = raw < 0 ? -rubber(-raw) : raw; apply();
      const now = performance.now(); drag.s.push([now, e.clientY]);
      while (drag.s.length > 2 && now - drag.s[0][0] > 100) drag.s.shift();
    });
    const release = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const a = drag.s[0], b = drag.s[drag.s.length - 1];
      const vel = b[0] > a[0] ? ((b[1] - a[1]) / (b[0] - a[0])) * 1000 : 0;
      drag = null;
      if (vel > 600 || y > sheet.offsetHeight * 0.35) setOpen(false, vel); else spring(0, vel);
    };
    sheet.addEventListener('pointerup', release); sheet.addEventListener('pointercancel', release);
    const api = { el: sheet, open: () => setOpen(true), close: v0 => setOpen(false, v0), isOpen: () => isOpen, instantOpen: () => setOpen(true, undefined, true) };
    sheet.inert = true;
    return api;
  };
  $$('.sheet', device).forEach(s => { sheets[s.id || 'sheet'] = makeSheet(s); });
  const firstSheet = Object.values(sheets)[0];
  window.bdSheet = { open: id => (sheets[id] || firstSheet)?.open(), close: () => active?.close(), isOpen: () => !!active };
  scrimEl.addEventListener('click', () => active?.close());
  addEventListener('keydown', e => { if (e.key === 'Escape') { active?.close(); closeMenu(); closeLP(); } });
  $$('.sheet[data-open]', device).forEach(s => sheets[s.id || 'sheet'].instantOpen());
  requestAnimationFrame(() => requestAnimationFrame(() => device.classList.add('cssm')));

  // ---------- popover menus ----------
  let menuEl = null, menuHit = null, menuTrig = null;
  function closeMenu() {
    if (!menuEl) return;
    menuEl.hidden = true; menuHit?.remove(); menuTrig?.setAttribute('aria-expanded', 'false'); menuEl = menuHit = menuTrig = null;
  }
  const openMenu = trig => {
    const m = $(trig.dataset.menu, device) || $(trig.dataset.menu); if (!m) return;
    if (menuEl === m) { closeMenu(); return; }
    closeMenu();
    m.hidden = false; menuEl = m; menuTrig = trig; trig.setAttribute('aria-expanded', 'true');
    const dv = device.getBoundingClientRect(), r = trig.getBoundingClientRect(), w = m.offsetWidth;
    m.style.top = (r.bottom - dv.top + 8) + 'px';
    m.style.left = Math.max(12, Math.min(r.right - dv.left - w + 8, dv.width - w - 12)) + 'px';
    menuHit = document.createElement('div'); menuHit.className = 'pop-hit'; device.insertBefore(menuHit, m);
    menuHit.addEventListener('click', closeMenu);
  };

  // ---------- long press overlay (data-lp) ----------
  let lp = null, lpStamp = 0;
  function closeLP() {
    if (!lp) return;
    lp.nodes.forEach(n => n.remove()); device.classList.remove('lp'); lp = null;
  }
  const openLP = el => {
    if (lp || !el) return;
    closeMenu();
    const id = el.dataset.lp || 'BD-1042', dv = device.getBoundingClientRect(), r = el.getBoundingClientRect();
    const x = r.left - dv.left, y = r.top - dv.top;
    const hit = document.createElement('div'); hit.className = 'lp-hit'; hit.addEventListener('click', closeLP);
    const lift = document.createElement('div');
    if (el.classList.contains('card')) { lift.className = el.className + ' lift'; lift.innerHTML = el.innerHTML; }
    else { lift.className = 'card lift'; const c = el.cloneNode(true); c.removeAttribute('href'); c.removeAttribute('data-go'); lift.appendChild(c); }
    lift.style.cssText = `left:${x}px;top:${y}px;width:${r.width}px;height:${r.height}px`;
    const menu = document.createElement('div'); menu.className = 'menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', id + ' actions');
    menu.innerHTML = [['open', 'Open case file', 'open'], ['copy', 'Copy report id', 'copy'], ['share', 'Share', 'share'], ['assign', 'Assign to me', 'userplus']]
      .map(([k, l, ic]) => `<button type="button" role="menuitem" data-k="${k}">${l}${svg(ic)}</button>`).join('');
    const mh = 4 * 54, below = y + r.height + 14;
    menu.style.left = Math.max(16, Math.min(x, dv.width - 268 - 16)) + 'px';
    menu.style.top = (below + mh < dv.height - 40 ? below : Math.max(60, y - mh - 14)) + 'px';
    menu.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const dest = el.dataset.go; closeLP();
      if (b.dataset.k === 'open') go(dest || 'm7.html');
      else if (b.dataset.k === 'copy') { try { navigator.clipboard?.writeText(id).catch(() => {}); } catch (_) {} toast('Copied ' + id); }
      else if (b.dataset.k === 'share') toast('Link to ' + id + ' ready to share');
      else toast('Assigned to you');
    });
    device.append(hit, lift, menu); device.classList.add('lp');
    lp = { nodes: [hit, lift, menu] }; lpStamp = performance.now();
  };
  window.bdLongPress = openLP; window.bdCloseLongPress = closeLP;
  $$('[data-lp]').forEach(el => {
    let timer = 0, x = 0, y = 0;
    const stop = () => clearTimeout(timer);
    el.addEventListener('pointerdown', e => { if (e.button) return; x = e.clientX; y = e.clientY; timer = setTimeout(() => openLP(el), 450); });
    el.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - x, e.clientY - y) > 8) stop(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => el.addEventListener(n, stop));
    el.addEventListener('contextmenu', e => e.preventDefault());
  });
  // the finger lifting after a hold must not also open the card
  document.addEventListener('click', e => { if (lp || performance.now() - lpStamp < 500) { if (!e.target.closest('.menu,.lp-hit')) { e.preventDefault(); e.stopPropagation(); } } }, true);

  // ---------- switches ----------
  const flip = sw => { const on = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(on)); hap('selection'); };
  // ---------- click routing ----------
  const later = (el, file, kind, ms) => { el._busy = true; setTimeout(() => { el._busy = false; go(file, kind); }, ms); };
  const act = (el, e) => {
    if (el.closest('a[href="#"]')) e.preventDefault();
    if (el._busy) return;
    const d = el.dataset;
    if (d.sheetOpen) { sheets[d.sheetOpen]?.open(); if (d.haptic) hap(d.haptic); return; }
    const shown = d.haptic ? hap(d.haptic) : false;
    if (el.hasAttribute('data-sheet-close') || el.hasAttribute('data-sheet-confirm')) active?.close();
    if (el.hasAttribute('data-back')) { back(d.go); return; }
    if (el.matches('.tab') && d.go && location.pathname.endsWith('/' + d.go)) return;
    const dest = d.then || d.go;
    if (d.toast) { toast(d.toast); if (dest) later(el, dest, d.kind, 1100); }
    else if (dest) { if (shown) later(el, dest, d.kind, 550); else go(dest, d.kind); }
  };
  document.addEventListener('click', e => {
    if (e.target.closest('a[href="#"]')) e.preventDefault();
    const m = e.target.closest('[data-menu]');
    if (m) { openMenu(m); return; }
    if (e.target.closest('.menu.pop')) closeMenu();
    const row = e.target.closest('.item:has(.switch)'), sw = row ? $('.switch', row) : e.target.closest('.switch');
    if (sw) { flip(sw); return; }
    const sg = e.target.closest('.seg button');
    if (sg) {
      const seg = sg.closest('.seg');
      $$('button', seg).forEach(b => { b.setAttribute('aria-checked', String(b === sg)); if (b.dataset.segShow) { const p = $(b.dataset.segShow); if (p) p.hidden = b !== sg; } });
      hap('selection'); return;
    }
    const t = e.target.closest('[data-go],[data-toast],[data-haptic],[data-sheet-open],[data-sheet-close],[data-sheet-confirm]');
    if (t) act(t, e);
  });
  addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-go]:not(a,button)')) { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener('change', e => { if (e.target.matches('input[type=radio]')) hap('selection'); });

  // ---------- reports: chips and search filter rows, with a no-results state ----------
  const list = $('[data-filter-list]');
  if (list) {
    const rows = $$('[data-phase]', list), input = $('[data-search]'), chips = $$('[data-chip]'), none = $('[data-noresult]'), cnt = $('[data-count]');
    let phase = 'all';
    const apply = () => {
      const term = input ? input.value.trim().toLowerCase() : '';
      let n = 0;
      rows.forEach(r => {
        const show = (phase === 'all' || r.dataset.phase === phase) && (!term || r.textContent.toLowerCase().includes(term));
        r.hidden = !show; r.classList.toggle('vf', show && !n); if (show) n++;
      });
      list.hidden = !n;
      if (none) {
        none.hidden = !!n;
        const lab = chips.find(c => c.dataset.chip === phase);
        $$('[data-term]', none).forEach(s => { s.textContent = term ? '“' + input.value.trim() + '”' : (lab ? lab.textContent.trim() : ''); });
      }
      if (cnt) cnt.textContent = `${n} ${n === 1 ? 'report' : 'reports'}`;
    };
    chips.forEach(c => {
      c.setAttribute('aria-pressed', String(c.classList.contains('on')));
      c.addEventListener('click', () => {
        phase = c.dataset.chip || 'all';
        chips.forEach(o => { o.classList.toggle('on', o === c); o.setAttribute('aria-pressed', String(o === c)); });
        hap('selection'); apply();
      });
    });
    input?.addEventListener('input', apply);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    $$('[data-clear-search]').forEach(b => b.addEventListener('click', () => {
      if (input) input.value = ''; phase = 'all';
      chips.forEach(o => { const on = o.dataset.chip === 'all'; o.classList.toggle('on', on); o.setAttribute('aria-pressed', String(on)); });
      apply();
    }));
    apply();
  }

  // ---------- six box code field ----------
  $$('[data-otp]').forEach(box => {
    const ins = $$('input', box); let done = false;
    ins.forEach((inp, i) => {
      inp.setAttribute('placeholder', ' '); inp.setAttribute('aria-label', `Digit ${i + 1} of ${ins.length}`);
      if (!inp.inputMode) inp.inputMode = 'numeric'; if (i === 0) inp.autocomplete = 'one-time-code';
      inp.addEventListener('input', () => {
        inp.value = inp.value.replace(/\D/g, '').slice(-1);
        if (inp.value && ins[i + 1]) ins[i + 1].focus();
        check();
      });
      inp.addEventListener('keydown', e => { if (e.key === 'Backspace' && !inp.value && ins[i - 1]) { ins[i - 1].value = ''; ins[i - 1].focus(); e.preventDefault(); } });
      inp.addEventListener('paste', e => {
        const t = (e.clipboardData?.getData('text') || '').replace(/\D/g, ''); if (!t) return;
        e.preventDefault(); [...t.slice(0, ins.length - i)].forEach((ch, k) => { ins[i + k].value = ch; });
        ins[Math.min(i + t.length, ins.length - 1)].focus(); check();
      });
    });
    const check = () => {
      if (done || !ins.every(x => x.value)) return;
      done = true; hap('success');
      const d = box.dataset;
      if (d.otpShow) { const n = $(d.otpShow); if (n) { n.hidden = false; n.scrollIntoView?.({ block: 'nearest' }); } }
      if (d.otpDone) toast(d.otpDone);
      if (d.then) setTimeout(() => go(d.then, d.kind || 'pop'), d.otpDone ? 1100 : 400);
    };
  });

  // ---------- chat composer ----------
  const thread = $('[data-chat-thread]');
  if (thread) {
    const input = $('[data-chat-input]'), sendBtn = $('[data-chat-send]'), scroller = $('.scroll');
    const toBottom = () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMQ.matches ? 'auto' : 'smooth' });
    const add = (cls, text) => { const b = document.createElement('div'); b.className = 'bub ' + cls + ' new'; if (text != null) b.textContent = text; thread.appendChild(b); return b; };
    const REPLIES = [
      [/probe/i, 'Three probes ran inside the sandbox: a GET on the search page, a POST to the feedback endpoint, and a re-read of the stored value. The canary executed on the re-read.'],
      [/re-?check/i, 'Queued a re-check against the pinned snapshot. I will post the result here when it finishes.'],
      [/./, 'I can answer from the drafted findings and the reproduction run. Ask about a probe, the severity or the suggested fix.']
    ];
    const sugg = $('.sugg', thread.parentElement);
    const send = raw => {
      const text = raw.trim(); if (!text) return;
      add('me', text); toBottom();
      const reply = REPLIES.find(r => r[0].test(text))[1];
      setTimeout(() => {
        const t = add('ag typing'); t.innerHTML = '<i></i><i></i><i></i>'; t.setAttribute('aria-label', 'Agent is typing'); toBottom();
        setTimeout(() => {
          t.remove();
          const w = document.createElement('div'); w.className = 'who'; w.textContent = 'Agent Bounty'; thread.appendChild(w);
          add('ag', reply); if (sugg) thread.appendChild(sugg);
          if (/re-?check/i.test(text)) toast('Re-check queued');
          toBottom();
        }, 900);
      }, 250);
    };
    const submit = () => { const t = input.value; input.value = ''; send(t); };
    sendBtn?.addEventListener('click', submit);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    $$('.sugg .fchip').forEach(c => c.addEventListener('click', () => send(c.textContent)));
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // ---------- add a reviewer ----------
  const addBtn = $('[data-add-reviewer]');
  if (addBtn) {
    const input = $('[data-add-input]'), list2 = $('[data-reviewer-list]');
    const submit = () => {
      const email = input.value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Enter a valid email'); return; }
      if ($$('.t', list2).some(t => t.textContent.toLowerCase() === email.toLowerCase())) { toast('Already on the list'); return; }
      const r = document.createElement('div'); r.className = 'item';
      r.innerHTML = `<span class="av">${esc(email[0].toUpperCase())}</span><span class="main"><span class="t">${esc(email)}</span><span class="s">Code sent just now</span></span><span class="pill c-approval">Pending</span>`;
      list2.appendChild(r); input.value = ''; toast('Code sent to ' + email);
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }

  // ---------- theme row ----------
  const themeRow = $('[data-theme-cycle]');
  if (themeRow) {
    const val = $('[data-theme-val]', themeRow), order = ['system', 'light', 'dark'], label = { system: 'System', light: 'Light', dark: 'Dark' };
    let cur = q.get('theme') === 'light' ? 'light' : q.get('theme') === 'dark' ? 'dark' : 'system';
    val.textContent = label[cur];
    themeRow.addEventListener('click', () => {
      cur = order[(order.indexOf(cur) + 1) % order.length];
      val.textContent = label[cur]; root.classList.toggle('light', cur === 'light'); hap('selection');
      const u = new URL(location.href);
      if (cur === 'system') { u.searchParams.delete('theme'); q.delete('theme'); } else { u.searchParams.set('theme', cur); q.set('theme', cur); }
      history.replaceState(null, '', u);
    });
  }

  // reduced motion can change at runtime; the sheet reads it on every open
  window.bdKit = { hap, toast, go, back };
})();
