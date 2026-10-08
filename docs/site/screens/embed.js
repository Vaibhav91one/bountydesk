// Embed mode for Variant C. platform.js loads this only when ?embed is present.
// The prototype page (../prototype.html) sends { showHot } and { demo } in; navigation and wheel go out
// as { proto, go, kind, back } (from c.js) and { proto, wheel } (from here). Options come from the URL: sr, targets, guides.
(() => {
  'use strict';
  const q = new URLSearchParams(location.search);
  const root = document.documentElement;
  const PF = root.classList.contains('pf-android') ? 'android' : root.classList.contains('pf-web') ? 'web' : 'ios';
  const page = (location.pathname.match(/(m\d+)\.html$/) || [])[1] || '';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const post = m => parent.postMessage({ proto: true, ...m }, '*');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // Calm spring as a CSS linear() easing (same maths as the prototype page).
  const spring = (zeta, response) => {
    const w = 2 * Math.PI / response, dt = 1 / 240; let x = 0, v = 0, calm = 0; const s = [];
    for (let i = 0; i < 240 * 3; i++) {
      v += (-w * w * (x - 1) - 2 * zeta * w * v) * dt; x += v * dt; s.push(x);
      if (Math.abs(x - 1) < .0015 && Math.abs(v) < .03) { if (++calm > 10) break; } else calm = 0;
    }
    const step = Math.max(1, Math.floor(s.length / 48)), pts = [0];
    for (let i = step; i < s.length; i += step) pts.push(+s[i].toFixed(4));
    pts.push(1);
    return { easing: `linear(${pts.join(', ')})`, duration: Math.round(s.length * dt * 1000) };
  };
  const CALM = spring(1, 0.45);

  const init = () => {
    const dev = $('.device');
    if (!dev) return;
    const rel = e => { const r = e.getBoundingClientRect(), d = dev.getBoundingClientRect(); return { x: r.left - d.left, y: r.top - d.top, w: r.width, h: r.height }; };
    const STATUS = PF === 'web' ? 80 : PF === 'android' ? 40 : 54;
    const barBottom = () => { const b = $$('.topbar').map(n => n.getBoundingClientRect().bottom); return b.length ? Math.max(...b) : STATUS; };

    // ---- wheel: hand the gesture to the prototype once this screen's own scroller is at its end ----
    addEventListener('wheel', e => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      for (let n = e.target; n && n !== document.body; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1 &&
            (e.deltaY > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) return;
      }
      post({ wheel: e.deltaY });
    }, { passive: true });

    // ---- tap hotspots ----
    if (q.has('hot')) root.classList.add('showhot');
    addEventListener('message', e => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if ('showHot' in d) root.classList.toggle('showhot', !!d.showHot);
      if (d.demo && DEMO[d.demo]) DEMO[d.demo]();
    });

    // ---- overlay layer: target check, screen reader labels, spacing grid ----
    const wantSr = q.has('sr'), wantTargets = q.has('targets'), wantGuides = q.has('guides');
    const TAP = 'a[href],button,input:not([type=hidden]),textarea,select,[data-go],[data-sheet-open],[data-menu],[data-switch-row],[role=button],[role=switch],[role=radio],.tab,.switch,.fchip,label.item';
    const txt = n => {
      const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT, { acceptNode: t => t.parentElement.closest('svg,.dot,[aria-hidden=true]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      const out = []; while (w.nextNode()) out.push(w.currentNode.textContent);
      return out.join(' ').replace(/\s+/g, ' ').trim();
    };
    const roleOf = n => n.getAttribute('role') ||
      (n.matches('.tab') ? 'tab' : n.matches('.switch') ? 'switch' : n.matches('input[type=radio],label.item:has(input[type=radio])') ? 'radio' :
       n.matches('input[type=checkbox]') ? 'checkbox' : n.matches('input[type=search]') ? 'searchbox' : n.matches('input,textarea') ? 'textbox' :
       n.matches('button') ? 'button' : n.matches('a[href]:not([href="#"]),a[data-go],a.item') ? 'link' : 'button');
    const nameOf = n => {
      let t = n.getAttribute('aria-label');
      if (!t && n.getAttribute('aria-labelledby')) t = (document.getElementById(n.getAttribute('aria-labelledby')) || {}).textContent;
      if (!t && n.matches('input,textarea')) t = n.placeholder;
      if (!t && n.matches('.switch')) { const r = n.closest('.item'); t = r ? txt($('.t', r) || r) : ''; }
      return (t || txt(n) || 'no name').trim();
    };
    if (wantSr) {
      $$('svg:not([role]):not([aria-label]),.status,.island,.hind,.av,.dot,.ch,.bd-finger').forEach(n => { n.setAttribute('aria-hidden', 'true'); n.classList.add('sr-dim'); });
      $$(TAP).forEach(n => {
        if (n === dev) return;
        if (!n.getAttribute('role') && n.matches('.tab,.switch')) n.setAttribute('role', roleOf(n));
        if (!n.getAttribute('aria-label') && !n.matches('input,textarea')) n.setAttribute('aria-label', nameOf(n));
      });
    }
    if (wantSr || wantTargets || wantGuides) {
      const layer = el('div'); layer.id = 'bd-layer'; layer.setAttribute('aria-hidden', 'true'); dev.appendChild(layer);
      const MIN = PF === 'android' ? 48 : 44;
      let sig = '';
      const paint = () => {
        const D = dev.getBoundingClientRect();
        const tops = $$('.dock,.tabs,.fbar,.composer').map(e => e.getBoundingClientRect().top).filter(t => t > 0 && t < D.height);
        const hi = tops.length ? Math.min(...tops) : D.height;
        const sheetOpen = dev.classList.contains('open');
        const seen = (n2, r) => {
          if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= D.height || r.right <= 0 || r.left >= D.width) return false;
          if (n2.closest('[hidden]') || getComputedStyle(n2).visibility === 'hidden') return false;
          if (n2.closest('.sheet') ? !sheetOpen : (sheetOpen && !n2.closest('.toast'))) return false;
          if (n2.closest('.scroll')) { const c = r.top + r.height / 2; if (c < STATUS || c > hi) return false; }
          return true;
        };
        const boxes = [];
        if (wantTargets || wantSr) {
          $$(TAP).forEach(n2 => {
            if (n2 === dev || n2.matches('input') && n2.closest('label.item')) return;
            const up = n2.parentElement && n2.parentElement.closest(TAP);
            if (up && up !== dev) return;
            const r = n2.getBoundingClientRect();
            if (!seen(n2, r)) return;
            if (wantTargets) {
              const ok = r.width >= MIN - 0.01 && r.height >= MIN - 0.01;
              boxes.push([r, ok ? 'ok' : 'bad', `${Math.round(r.width)}x${Math.round(r.height)}${ok ? '' : ' < ' + MIN}`]);
            }
            if (wantSr) boxes.push([r, 'sr', `${roleOf(n2)}: ${nameOf(n2)}`]);
          });
        }
        if (wantSr) {
          $$('h1,nav.dock,.fbar,.topbar,.sheet').forEach(n2 => {
            const r = n2.getBoundingClientRect();
            if (!seen(n2, r)) return;
            const role = n2.matches('h1') ? 'heading 1' : n2.matches('nav.dock') ? 'navigation' : n2.matches('.fbar') ? 'toolbar' : n2.matches('.topbar') ? 'banner' : 'dialog';
            boxes.push([r, 'lm', `${role}: ${n2.matches('h1') ? (n2.firstChild.textContent || '').trim() : (n2.getAttribute('aria-label') || txt(n2).slice(0, 40))}`]);
          });
        }
        const s = boxes.map(b => [b[1], b[2], Math.round(b[0].left), Math.round(b[0].top), Math.round(b[0].width), Math.round(b[0].height)].join('|')).join(';');
        if (s === sig) return;
        sig = s;
        layer.innerHTML = (wantGuides ? '<div class="g"></div>' : '') + boxes.map(([r, c, t]) =>
          `<div class="bx ${c}" style="left:${r.left - D.left}px;top:${r.top - D.top}px;width:${r.width}px;height:${r.height}px"><b>${t.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))}</b></div>`).join('');
      };
      paint();
      addEventListener('scroll', paint, { capture: true, passive: true });
      addEventListener('resize', paint);
      setInterval(paint, 150);
    }

    // ---- gesture demos (message { demo }) ----
    let running = false;
    const finger = (x, y) => { const f = el('div', 'bd-finger'); f.setAttribute('aria-hidden', 'true'); f.style.left = x + 'px'; f.style.top = y + 'px'; dev.appendChild(f); return f; };
    const fadeOut = (n, ms = 200) => n.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced() ? 1 : ms, fill: 'forwards' }).finished.then(() => n.remove());
    const tap = f => f.animate([{ transform: 'scale(1)' }, { transform: 'scale(.8)', offset: .5 }, { transform: 'scale(1)' }], { duration: 500 });
    const once = fn => async () => { if (running) return; running = true; try { await fn(); } finally { running = false; } };
    const DEMO = {};

    // sheet: open (or already open on m13), a finger drags it down, it dismisses; m13 reopens so the screen stays itself
    DEMO.sheet = once(async () => {
      const api = window.bdSheet, sh = $('.sheet');
      if (!api || !sh) return;
      const was = api.isOpen();
      if (!was) { api.open(); await wait(900); } else await wait(400);
      if (PF === 'web' || reduced()) {
        let f; if (PF === 'web') { f = finger(195, Math.max(120, rel(sh).y - 50)); tap(f); }
        await wait(500); api.close(); await wait(700); if (f) f.remove();
        if (was) api.open();
        return;
      }
      // Real pointer events drive the sheet's own drag handler, so release velocity and the spring are the shipped ones.
      const r = rel(sh), x = 195, y0 = r.y + 40, D = 240, DUR = 450;
      const ev = (type, y) => sh.dispatchEvent(new PointerEvent(type, { pointerId: 77, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true }));
      const f = finger(x, y0); await wait(200);
      ev('pointerdown', y0);
      const t0 = performance.now();
      await new Promise(res => {
        const tick = now => { const k = Math.min(1, (now - t0) / DUR), dy = D * k * k; f.style.top = (y0 + dy) + 'px'; ev('pointermove', y0 + dy); k < 1 ? requestAnimationFrame(tick) : res(); };
        requestAnimationFrame(tick);
      });
      ev('pointerup', y0 + D); fadeOut(f);
      await wait(900);
      if (was) api.open();
    });

    // refresh: the list pulls down under a finger, the platform's indicator shows, it springs back
    DEMO.refresh = once(async () => {
      const sc = $('.scroll'); if (!sc) return;
      sc.scrollTop = 0;
      const R = reduced(), top = barBottom(), D = PF === 'android' ? 80 : 70;
      const f = finger(195, top + 120); f.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: 'forwards' });
      let ind;
      if (PF === 'ios') ind = el('div', 'bd-ptr ios', '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' + [...Array(8)].map((_, i) => `<path d="M14 3v5" opacity="${.2 + i * .1}" transform="rotate(${i * 45} 14 14)"/>`).join('') + '</svg>');
      else ind = el('div', 'bd-ptr md', PF === 'android' ? '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1-8.5 6"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>');
      ind.setAttribute('aria-hidden', 'true');
      ind.style.top = (PF === 'ios' ? top + 14 : top - 20) + 'px'; ind.style.opacity = '0';
      dev.appendChild(ind);
      if (R) {
        ind.style.top = (top + 20) + 'px'; ind.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, fill: 'forwards' }); await wait(1400);
        fadeOut(ind); fadeOut(f); await wait(300); return;
      }
      const pull = { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' };
      f.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${D + 40}px)` }], pull);
      const moved = sc.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${D}px)` }], pull);
      if (PF === 'ios') ind.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'forwards' });
      else ind.animate([{ opacity: 0, transform: 'translateY(0) scale(.6)' }, { opacity: 1, transform: `translateY(${D + 4}px) scale(1)` }], pull);
      await wait(650); fadeOut(f);
      await wait(900);
      const back = sc.animate([{ transform: `translateY(${D}px)` }, { transform: 'translateY(0)' }], { ...CALM, fill: 'forwards' });
      ind.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' });
      await wait(CALM.duration + 50); moved.cancel(); back.cancel(); ind.remove();
    });

    // press: long press on the first report card opens the kit's own overlay (blur, lifted card, menu)
    DEMO.press = once(async () => {
      const card = $$('[data-lp]').find(n => { const b = n.getBoundingClientRect(); return b.top > barBottom() && b.bottom < 760 && b.right > 0 && b.left < 390; });
      if (!card || !window.bdLongPress) return;
      const R = reduced(), r = rel(card);
      const f = finger(r.x + r.w * 0.35, r.y + r.h / 2);
      f.animate([{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1)', offset: .25 }, { opacity: 1, transform: R ? 'scale(1)' : 'scale(1.25)' }], { duration: 520, fill: 'forwards' });
      card.classList.add('bd-pressing');
      await wait(540);
      card.classList.remove('bd-pressing');
      window.bdLongPress(card); fadeOut(f);
      await wait(2400);
      window.bdCloseLongPress && window.bdCloseLongPress();
    });

    // push: a notification arrives from the top, drawn the way each platform shows one. Ids and short titles only.
    DEMO.push = once(async () => {
      $$('.bd-push').forEach(n => n.remove());
      const R = reduced(), icon = '<img src="../assets/app-icon.svg" alt="" width="38" height="38">', ttl = 'BD-1042 needs your approval', sub = 'Stored XSS in search results';
      const n = el('div', 'bd-push ' + PF);
      n.setAttribute('role', 'alert');
      n.innerHTML = PF === 'ios'
        ? `${icon}<span class="t"><b>BountyDesk<i>now</i></b><span class="m">${ttl}</span></span>`
        : PF === 'android'
          ? `<div class="h"><img src="../assets/app-icon.svg" alt="" width="16" height="16">BountyDesk · now</div><span class="t"><b>${ttl}</b><span class="m">${sub}</span></span>`
          : `<div class="h"><i></i>Chrome · app.bountydesk.vaibhav.quest · now</div><div class="row2">${icon}<span class="t"><b>${ttl}</b><span class="m">BountyDesk · ${sub}</span></span></div>`;
      n.addEventListener('click', () => { n.remove(); post({ go: 'm11', kind: 'push' }); });
      dev.appendChild(n);
      const inA = R ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: 'translateY(-150%)', opacity: PF === 'ios' ? 1 : 0 }, { transform: 'none', opacity: 1 }];
      n.animate(inA, R ? { duration: 150 } : PF === 'ios' ? { duration: 520, easing: 'cubic-bezier(.2,1.25,.4,1)' } : { duration: 360, easing: 'cubic-bezier(.05,.7,.1,1)' });
      await wait(3400);
      if (!n.isConnected) return;
      const outA = R ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-150%)', opacity: PF === 'ios' ? 1 : 0 }];
      n.animate(outA, { duration: R ? 150 : 280, easing: 'ease-in', fill: 'forwards' }).finished.then(() => n.remove());
      await wait(300);
    });

    window.bdEmbed = { DEMO };
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init); else init();
})();
