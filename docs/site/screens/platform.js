// Variant C: reads ?platform=ios|android|web and ?theme=light|dark, sets pf-* and light classes on <html>.
// Load synchronously in <head> so the classes exist before first paint. iOS (default) adds only an inert pf-ios class.
const q = new URLSearchParams(location.search), r = document.documentElement, p = q.get('platform');
const pf = p === 'android' || p === 'web' ? p : 'ios';
r.classList.add('pf-' + pf);
if (q.get('theme') === 'light') r.classList.add('light');
if (q.get('text') === 'large') r.classList.add('text-large');   // type is in rem, so this scales the whole screen
// ?embed: the prototype page draws the device, so the screen drops its own frame. Options come from the URL.
if (q.has('embed')) {
  r.classList.add('embed');
  for (const k of ['sr', 'targets', 'guides']) if (q.has(k)) r.classList.add('o-' + k);
  const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'embed.css'; document.head.appendChild(l);
  const s = document.createElement('script'); s.src = 'embed.js'; document.head.appendChild(s);
}
