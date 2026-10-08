// Shared "Pages" dropdown for the BountyDesk docs. One <script src="site-nav.js"></script> per page.
(() => {
  const PAGES = [
    ['Maps', [
      ['mvp-mindmap.html', 'Mobile app flow', 'The 28 proposed phone screens'],
      ['screens-real.html', 'Real screenshots', 'The live desktop app'],
      ['components.html', 'Component library', 'Shared UI + product components'],
      ['design-system.html', 'Design system', 'Tokens, type, color, mascot'],
      ['native-feel.html', 'Native feel', 'Haptics, keyboard, gestures per platform'],
      ['competitor-audit.html', 'Competitor audit', 'Triage + pentest landscape'],
    ]],
    ['Architecture map', [
      ['architecture-mindmap.html', 'Stack', 'Next.js, Postgres, TrueForge, Daytona'],
      ['services.html', 'Services', 'Vercel, Zerops, Resend, GitHub App'],
      ['security.html', 'Security invariants', 'Scope, gate, sandbox, secrets'],
      ['data-model.html', 'Data model', 'Reports, jobs, verdicts, delivery'],
      ['motion.html', 'Motion', 'Keyframes, easing, where motion is used'],
      ['dev-testing.html', 'Dev & testing', 'Worktrees, schemas, CI'],
    ], true],
    ['Build & ship', [
      ['app-structure.html', 'App structure', 'Routes, workers, libs'],
      ['native-ui.html', 'Native UI & push', 'Expo UI, native components, notifications'],
      ['deploy.html', 'Build & deploy', 'Vercel, Zerops, migrations'],
      ['intake-delivery.html', 'Intake to delivery', 'Four channels in, verdict out'],
    ], true],
    ['Screens', [
      ['prototype.html', 'Prototype', 'Key screens, live, iOS · Android · web'],
      ['screens.html', 'All screens', '28 screens by journey'],
      ['review.html', 'Review grid', 'All 28 at one glance'],
    ]],
    ['Design', [
      ['brand.html', 'Brand assets', 'Logo, mascot, backdrops'],
      ['accessibility.html', 'Accessibility', 'Contrast, focus, motion'],
    ]],
    ['Plan', [
      ['roadmap.html', 'Roadmap', 'What is next'],
      ['status.html', 'Status', 'What is built and proven'],
    ]],
    ['References', [
      ['research.html', 'Research & sources', 'Decisions, docs, prior art'],
    ]],
  ];
  // Links resolve from the folder this script lives in, so pages under screens/ work too.
  const root = document.currentScript ? new URL('.', document.currentScript.src).href : '';
  const q = new URLSearchParams(location.search);
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  // Theme and desktop/mobile view ride along on every link, so a reader stays in the mode they picked.
  const keep = new URLSearchParams();
  for (const k of ['theme', 'view']) if (q.get(k)) keep.set(k, q.get(k));
  const suffix = keep.toString() ? '?' + keep : '';
  const view = q.get('view') === 'mobile' ? 'mobile' : 'desktop';
  document.documentElement.dataset.view = view;
  const css = document.createElement('style');
  css.textContent = `
  .snav { position:fixed; top:14px; right:14px; z-index:1000; font:14px/1.3 Inter, system-ui, sans-serif; letter-spacing:-.01em; }
  .snav > button { height:38px; padding:0 14px 0 16px; border:1px solid var(--border); border-radius:19px; background:var(--card); color:var(--ink); font:inherit; font-weight:500; display:flex; align-items:center; gap:8px; cursor:pointer; box-shadow:0 4px 12px var(--shadow-sm); }
  .snav svg { position:static; }   /* the mind maps position every svg absolutely */
  .snav > button svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; transition:transform .2s; }
  .snav.open > button svg { transform:rotate(180deg); }
  .snav .menu { position:absolute; right:0; top:46px; width:280px; max-height:calc(100vh - 80px); overflow:auto; padding:8px; background:var(--card); border:1px solid var(--border); border-radius:20px; box-shadow:0 18px 40px var(--shadow-lg); display:none; }
  .snav.open .menu { display:block; animation:snin .18s ease-out; } @keyframes snin { from { opacity:0; transform:translateY(-6px); } }
  .snav h6 { margin:8px 10px 4px; font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  :root .snav a { display:block; padding:8px 10px; border-radius:12px; color:var(--ink); text-decoration:none; }
  .snav a small { display:block; color:var(--muted); font-size:12px; margin-top:1px; }
  .snav a:hover, .snav a:focus-visible { background:var(--hover); outline:none; }
  .snav a.here { background:var(--brand); color:#fff; } .snav a.here small { color:rgba(255,255,255,.7); }
  .stabs { position:fixed; top:14px; left:50%; transform:translateX(-50%); z-index:999; display:flex; gap:4px; padding:4px; background:var(--card); border:1px solid var(--border); border-radius:22px; box-shadow:0 4px 12px var(--shadow-sm); font:14px/1 Inter, system-ui, sans-serif; max-width:calc(100vw - 200px); overflow-x:auto; }
  :root .stabs a { flex:none; height:32px; padding:0 14px; border-radius:16px; display:flex; align-items:center; color:var(--muted); text-decoration:none; font-weight:500; white-space:nowrap; }
  .stabs a:hover { background:var(--hover); } .stabs a[aria-current] { background:var(--brand); color:#fff; }
  .sview { position:fixed; top:14px; left:14px; z-index:999; display:flex; gap:4px; padding:4px; background:var(--card); border:1px solid var(--border); border-radius:22px; box-shadow:0 4px 12px var(--shadow-sm); font:14px/1 Inter, system-ui, sans-serif; }
  :root .sview a { height:32px; padding:0 14px; border-radius:16px; display:flex; align-items:center; color:var(--muted); text-decoration:none; font-weight:500; }
  .sview a:hover { background:var(--hover); } .sview a[aria-current] { background:var(--ink); color:var(--bg); }
  html:not([data-view=mobile]) [data-only=mobile], html[data-view=mobile] [data-only=desktop] { display:none !important; }
  @media (max-width: 900px) { .stabs { top:60px; } }
  @media (prefers-reduced-motion: reduce) { .snav.open .menu { animation:none; } .snav > button svg { transition:none; } }`;
  document.head.appendChild(css);
  const nav = document.createElement('nav'); nav.className = 'snav'; nav.setAttribute('aria-label', 'Pages');
  const cur = PAGES.flatMap(g => g[1]).find(p => p[0] === here);
  nav.innerHTML = `<button type="button" aria-haspopup="true" aria-expanded="false">${cur ? (g => g[2] ? g[0].replace(' map', '') + ' · ' : '')(PAGES.find(g => g[1].includes(cur))) + cur[1] : 'Pages'}<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button><div class="menu">` +
    PAGES.map(([g, items]) => `<h6>${g}</h6>` + items.map(([f, t, d]) => `<a href="${root}${f}${suffix}" target="_blank" rel="noopener"${f === here ? ' class="here" aria-current="page"' : ''}>${t}<small>${d}</small></a>`).join('')).join('') + '</div>';
  document.body.appendChild(nav);
  // A map split into several pages gets tabs across the top (same window, so it feels like one map).
  const fam = PAGES.find(g => g[2] && g[1].some(p => p[0] === here));
  if (fam) {
    const tabs = document.createElement('nav'); tabs.className = 'stabs'; tabs.setAttribute('aria-label', fam[0]);
    tabs.innerHTML = fam[1].map(([f, t]) => `<a href="${root}${f}${suffix}"${f === here ? ' aria-current="page"' : ''}>${t}</a>`).join('');
    document.body.appendChild(tabs);
  }
  // Pages that describe both apps opt in with <meta name="views" content="desktop mobile">.
  if (document.querySelector('meta[name="views"]')) {
    const sw = document.createElement('nav'); sw.className = 'sview'; sw.setAttribute('aria-label', 'App');
    const link = v => { const p = new URLSearchParams(location.search); v === 'mobile' ? p.set('view', 'mobile') : p.delete('view'); return location.pathname + (p.toString() ? '?' + p : ''); };
    sw.innerHTML = [['desktop', 'Desktop'], ['mobile', 'Mobile']].map(([v, t]) => `<a href="${link(v)}"${v === view ? ' aria-current="page"' : ''}>${t}</a>`).join('');
    document.body.appendChild(sw);
  }
  const btn = nav.querySelector('button');
  const set = open => { nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', open); if (open) (nav.querySelector('a.here') || nav.querySelector('a')).focus(); };
  btn.onclick = e => { e.stopPropagation(); set(!nav.classList.contains('open')); };
  document.addEventListener('click', e => { if (!nav.contains(e.target)) set(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav.classList.contains('open')) { set(false); btn.focus(); } });
})();
