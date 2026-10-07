// Shared mind map renderer. Page defines `tree` before loading this.
const W = 220, COL = 300, GAP = 60, ROW = 250, PHONE_ROW = 560, SQ_ROW = 360;
const world = document.getElementById('world'), svg = document.getElementById('edges');
const edges = []; // [from, to, arrow]
// Optional on the tree: wrap = leaves per row (text maps: a grid, not one long line); row = row height for text nodes.
const WRAP = tree.wrap, R = tree.row || ROW;

// Groups of leaves go in a horizontal row, chained left to right (arrows when flow:true).
// Anything else stacks vertically; a parent sits at the middle of its children.
// drop:true = an item that folds: it starts closed ("▸ N items"), a click opens or closes it and the map re-lays out.
const kids = n => n.k && !n.closed ? n.k : null;
function place(node, x, side, cls, yStart) {
  node.cls = node.cls || cls;
  node.x = x;
  if (node.drop && node.closed === undefined) node.closed = true;
  if (!kids(node)) { node.y = yStart; return yStart + R; }
  if (WRAP && node.k.every(c => !c.k && !c.phone && !c.sq)) {
    const rows = Math.ceil(node.k.length / WRAP);
    node.k.forEach((c, i) => { c.cls = node.cls; c.x = x + side * (COL + (i % WRAP) * (W + GAP)); c.y = yStart + Math.floor(i / WRAP) * R; });
    node.k.forEach((c, i) => edges.push(i % WRAP ? [node.k[i - 1], c, node.flow] : [node, c, node.flow]));
    node.y = yStart + (rows - 1) * R / 2;
    return yStart + rows * R;
  }
  if (node.k.every(c => !c.k)) {
    // Tall phone rows sit lower so they don't reach up into the row above.
    node.y = yStart + (node.k.some(c => c.phone) ? (PHONE_ROW - ROW) / 2 : 0);
    node.k.forEach((c, i) => { c.cls = node.cls; c.x = x + side * (COL + i * (W + GAP)); c.y = node.y; });
    node.k.forEach((c, i) => edges.push(i ? [node.k[i - 1], c, node.flow] : [node, c, node.flow]));
    return yStart + (node.k.some(c => c.phone) ? PHONE_ROW : node.k.some(c => c.sq) ? SQ_ROW : ROW);
  }
  let y = yStart;
  for (const ch of node.k) { y = place(ch, x + side * COL, side, node.cls, y); edges.push([node, ch]); }
  node.y = (node.k[0].y + node.k[node.k.length - 1].y) / 2;
  return y;
}
// Focus: one branch shown on its own, laid out from x = 0 (readability on big maps). null = the whole map.
let focus = null;
function layout() {
edges.length = 0;
if (focus) {
  // A group of leaves becomes a grid, 4 per row, so the screens read large once the view zooms to fit.
  if (focus.k.every(c => !c.k)) {
    const per = 4, rowH = focus.k.some(c => c.phone) ? PHONE_ROW : focus.k.some(c => c.sq || c.i) ? SQ_ROW + 40 : R;
    focus.x = 0; focus.cls = focus.cls;
    focus.k.forEach((c, i) => { c.cls = focus.cls; c.x = COL + (i % per) * (W + GAP); c.y = Math.floor(i / per) * rowH; });
    focus.y = (Math.ceil(focus.k.length / per) - 1) * rowH / 2;
    focus.k.forEach((c, i) => { if (i % per === 0) edges.push([focus, c]); });
    return;
  }
  place(focus, 0, 1, focus.cls, 0); return;
}
const sides = {'-1': 0, '1': 0};
for (const ch of tree.k) { sides[ch.side] = place(ch, ch.side * COL, ch.side, ch.cls, sides[ch.side]) + R / 2; edges.push([tree, ch]); }
tree.x = 0;
// Root sits between the first two branches (PunchPass / Tap2), or, with mid:true, in the middle of all of them.
tree.y = tree.mid ? (Math.min(...tree.k.map(c => c.y)) + Math.max(...tree.k.map(c => c.y))) / 2 : (tree.k[0].y + tree.k[1].y) / 2;
}
layout();

function render(node) {
  const el = document.createElement('div');
  el.className = 'node ' + (node.cls || '') + (node.root ? ' root' : node.k ? ' branch' : '') + (node.i ? '' : ' text') + (node.phone ? ' phone' : '') + (node.sq ? ' sq' : '');
  if (node.i) {
    const img = document.createElement('img');
    img.src = 'mindmap-thumbs/' + node.i + '.jpg?v=s41';
    img.alt = node.c;
    img.dataset.full = node.s + node.i + '.png?v=s41';
    img.onclick = () => { lbimg.src = img.dataset.full; lbcap.textContent = node.c; lb.showModal(); };
    el.appendChild(img);
  }
  el.insertAdjacentHTML('beforeend', `<div class="cap"></div>` + (node.n ? `<div class="note"></div>` : ''));
  el.querySelector('.cap').textContent = node.c;
  if (node.url) el.querySelector('.cap').innerHTML = `<a target="_blank" rel="noopener"></a>`, Object.assign(el.querySelector('.cap a'), { href: node.url, textContent: node.c + ' ↗' });
  if (node.n) el.querySelector('.note').textContent = node.n;
  if (node.h) el.insertAdjacentHTML('beforeend', `<div class="demo" aria-hidden="true">${node.h}</div>`);   // a small drawing of the thing (trusted, from the generator)
  if (node.drop) {
    el.classList.add('drop'); const t = document.createElement('button'); t.className = 'fold';
    t.textContent = (node.closed ? '▸ ' : '▾ ') + node.k.length + ' item' + (node.k.length === 1 ? '' : 's');
    t.setAttribute('aria-expanded', !node.closed); el.appendChild(t);
    el.addEventListener('click', e => { if (e.target.tagName === 'IMG' || e.target.tagName === 'A') return; e.stopPropagation(); node.closed = !node.closed; rebuild(); });
  }
  if (node.k && !node.root && node !== focus) {
    const f = document.createElement('button'); f.className = 'focusbtn'; f.textContent = '⤢ Focus';
    f.title = 'Show only this branch'; f.setAttribute('aria-label', 'Show only ' + node.c);
    f.addEventListener('click', e => { e.stopPropagation(); setFocus(node); });
    el.appendChild(f);
  }
  el.style.left = (node.x - (node.root || node === focus ? 130 : W / 2)) + 'px';
  world.appendChild(el);
  node.el = el;
  (kids(node) || []).forEach(render);
}
render(tree);

const rootNode = () => focus || tree;
// Center each card vertically on its y, then draw edges from real card edges.
function layoutAndDraw() {
  const all = [];
  (function walk(n) { all.push(n); (kids(n) || []).forEach(walk); })(rootNode());
  for (const n of all) n.el.style.top = (n.y - n.el.offsetHeight / 2) + 'px';
  let plain = '', flow = '';
  for (const [a, b, arrow] of edges) {
    const s = Math.sign(b.x - a.x) || 1;
    const x1 = a.x + s * a.el.offsetWidth / 2, x2 = b.x - s * b.el.offsetWidth / 2, mx = (x1 + x2) / 2;
    const d = `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y} `;
    arrow ? flow += d : plain += d;
  }
  svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" fill="#888"/></marker></defs>
    <path d="${plain}" fill="none" stroke="#b5b5c3" stroke-width="2"/>` +
    flow.split('M').filter(Boolean).map(d => `<path d="M${d}" fill="none" stroke="#888" stroke-width="2.5" marker-end="url(#ah)"/>`).join('');
}
layoutAndDraw();
addEventListener('load', layoutAndDraw); // re-measure once fonts/images settle
function rebuild() { world.querySelectorAll('.node').forEach(e => e.remove()); layout(); render(rootNode()); layoutAndDraw(); }

// Pan / zoom
const view = document.getElementById('view');
let s = 1, tx = 0, ty = 0;
const apply = () => world.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
function fit() {
  const els = [...world.querySelectorAll('.node')];
  const minX = Math.min(...els.map(e => e.offsetLeft)), maxX = Math.max(...els.map(e => e.offsetLeft + e.offsetWidth));
  const minY = Math.min(...els.map(e => e.offsetTop)), maxY = Math.max(...els.map(e => e.offsetTop + e.offsetHeight));
  s = Math.min(innerWidth / (maxX - minX + 80), innerHeight / (maxY - minY + 80));
  tx = (innerWidth - (maxX + minX) * s) / 2; ty = (innerHeight - (maxY + minY) * s) / 2;
  apply();
}
fit();
view.addEventListener('wheel', e => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0015), ns = Math.min(3, Math.max(0.05, s * k));
  tx = e.clientX - (e.clientX - tx) * ns / s; ty = e.clientY - (e.clientY - ty) * ns / s; s = ns; apply();
}, {passive: false});
let drag = null;
view.addEventListener('pointerdown', e => { if (e.target.tagName === 'IMG' || e.target.closest('.drop')) return; drag = [e.clientX - tx, e.clientY - ty]; view.classList.add('drag'); });
addEventListener('pointermove', e => { if (drag) { tx = e.clientX - drag[0]; ty = e.clientY - drag[1]; apply(); } });
addEventListener('pointerup', () => { drag = null; view.classList.remove('drag'); });
addEventListener('keydown', e => { if (e.key === '0') fit(); if (e.key === 'Escape' && focus && !lb.open) setFocus(null); });

// Focus UI: a bar with the path back to the whole map; the focused branch is kept in the URL (#focus=Branch/Sub).
document.head.insertAdjacentHTML('beforeend', `<style>
  .focusbtn { display:block; margin:0 9px 8px; height:26px; padding:0 10px; border:1px solid #c9c9d2; border-radius:13px; background:#fff; color:#111; font:600 12px system-ui, sans-serif; cursor:pointer; }
  .focusbtn:hover { background:#111; color:#fff; border-color:#111; }
  #crumb { position:fixed; left:12px; top:12px; z-index:5; display:none; align-items:center; gap:8px; background:#fff; border:1px solid #c9c9d2; border-radius:20px; padding:6px 8px 6px 6px; font:13px system-ui, sans-serif; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  #crumb button { height:28px; padding:0 12px; border:0; border-radius:14px; background:#111; color:#fff; font-weight:600; cursor:pointer; }
  #crumb span { color:#666; } #crumb b { color:#111; }
</style>`);
const crumb = document.createElement('div'); crumb.id = 'crumb'; document.body.appendChild(crumb);
const pathTo = (n, t = tree, p = []) => t === n ? p : (t.k || []).reduce((r, c) => r || pathTo(n, c, [...p, c]), null);
function setFocus(n) {
  focus = n;
  const path = n ? pathTo(n) || [n] : [];
  history.replaceState(null, '', n ? '#focus=' + path.map(c => encodeURIComponent(c.c)).join('/') : location.pathname + location.search);
  crumb.style.display = n ? 'flex' : 'none';
  crumb.innerHTML = n ? `<button type="button">← Whole map</button><span></span>` : '';
  if (n) { crumb.querySelector('span').innerHTML = path.map((c, i) => i === path.length - 1 ? '<b></b>' : '<i></i> › ').join('');
    const parts = crumb.querySelectorAll('span i, span b'); path.forEach((c, i) => parts[i].textContent = c.c);
    crumb.querySelector('button').onclick = () => setFocus(null); }
  rebuild(); fit();
}
{ const m = location.hash.match(/^#focus=(.+)$/);
  if (m) { let n = tree; for (const part of m[1].split('/').map(decodeURIComponent)) n = (n && n.k || []).find(c => c.c === part);
    if (n && n.k) setFocus(n); } }
lb.addEventListener('click', () => lb.close());
