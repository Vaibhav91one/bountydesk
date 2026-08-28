/**
 * Split a Figma animated-SVG export into one self-contained file per mascot state.
 *
 * Figma exports a whole board as a single file: every state sits on it at its own offset, and
 * one <style> block carries the rules and @keyframes for every element on the board. This
 * pulls each state out with only what it references.
 *
 * Three things here are load-bearing and were each a bug once:
 *
 * Figma writes the animation shorthand as a comma-separated list, so one element routinely
 * has a transform track, an opacity track and an offset-distance track. Reading only the
 * first name drops the flashes, the blinks and the travelling data, and leaves motion that
 * looks vaguely right and is not.
 *
 * Every rule sets `transform-box: view-box` with `transform-origin: 0 0`, which pins each
 * rotate and scale to the viewBox's own origin. Cropping by moving that origin repivots the
 * artwork, so the state is placed with a wrapper translate and the origin is left at 0 0.
 *
 * Ids are namespaced per state because two boards both start numbering at Vector_1, and once
 * several states are inlined on one page a collision silently rebinds one state's rules to
 * another state's elements.
 *
 *   node scripts/split-mascot-export.mjs design/mascot/trix-state-animations.svg public/mascot
 *
 * Pass --only=a,b,c to take a subset, which is how a second board contributes its new states
 * without its duplicate of one this board already owns.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
const [source, outDir] = args.filter((a) => !a.startsWith("--"));
if (!source || !outDir) {
  throw new Error("usage: node scripts/split-mascot-export.mjs <export.svg> <out-dir> [--only=a,b]");
}

const svg = readFileSync(source, "utf8");
const style = svg.match(/<style>([\s\S]*?)<\/style>/)[1];

/** Every `@keyframes name { … }`, keyed by name. The blocks nest one level, so count braces. */
function readKeyframes(css) {
  const found = new Map();
  const re = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    found.set(m[1], css.slice(m.index, i));
  }
  return found;
}

/** Every `#id { … }` rule, keyed by the id it targets. */
function readRules(css) {
  const found = new Map();
  const re = /#([A-Za-z0-9_-]+)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) found.set(m[1], m[0]);
  return found;
}

const keyframes = readKeyframes(style);
const rules = readRules(style);

/** The balanced <g>…</g> that starts at `start`. */
function groupAt(text, start) {
  const re = /<g\b[^>]*>|<\/g>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(text))) {
    depth += m[0] === "</g>" ? -1 : 1;
    if (depth === 0) return text.slice(start, re.lastIndex);
  }
  throw new Error(`unbalanced <g> at ${start}`);
}


/**
 * Shrink an embedded bitmap to something the page can actually use.
 *
 * The cowboy hat exports as a 1024x1024 PNG and renders about 58 css px wide, so it carries
 * 300KB that gzip cannot touch and nobody can see. Squares stay square, so resizing does not
 * disturb how the pattern maps onto its rect.
 *
 * Uses sips, which ships with macOS. Elsewhere, or if it fails, the image is left alone: a
 * heavy asset beats a broken one, and this only ever runs by hand.
 */
function shrinkRasters(svg, maxEdge = 256) {
  return svg.replace(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g, (whole, b64) => {
    const raw = Buffer.from(b64, "base64");
    if (raw.length < 50_000) return whole;

    const file = join(tmpdir(), `mascot-raster-${raw.length}.png`);
    try {
      writeFileSync(file, raw);
      execFileSync("sips", ["-Z", String(maxEdge), file], { stdio: "ignore" });
      const small = readFileSync(file);
      return small.length < raw.length
        ? `data:image/png;base64,${small.toString("base64")}`
        : whole;
    } catch {
      return whole;
    } finally {
      rmSync(file, { force: true });
    }
  });
}

const defs = svg.match(/<defs>[\s\S]*<\/defs>/)?.[0] ?? "";
const report = [];
let total = 0;
let doubled = 0;

for (const m of svg.matchAll(/<g id="(mascot-[a-z0-9-]+)"/g)) {
  const state = m[1].replace(/^mascot-/, "");
  if (only && !only.includes(state)) continue;

  let chunk = groupAt(svg, m.index);

  // Each state frame carries the white artboard square it was drawn on. On a near-black page
  // that reads as a print stuck to the wall.
  chunk = chunk.replace(/<path id="Vector(_\d+)?" d="M0 0H256V256H0V0Z" fill="white"\/>\n?/, "");

  // Where the state sits on the board. An animated frame keeps a transform attribute and
  // bakes the same offset into its keyframes; a frame with no animation of its own gets a CSS
  // `translate` instead, and reading only the attribute leaves that state cropped to nothing.
  const attr = chunk.match(/^<g id="[^"]+"[^>]*transform="translate\((-?[\d.]+) (-?[\d.]+)\)"/);
  const css = rules.get(m[1])?.match(/translate:\s*(-?[\d.]+)px\s+(-?[\d.]+)px/);
  const placed = attr ?? css;
  if (!placed) throw new Error(`${state}: no board offset found`);
  const [x, y] = [Number(placed[1]), Number(placed[2])];

  const ids = [...new Set([...chunk.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((i) => i[1]))];
  const used = ids.map((id) => rules.get(id)).filter(Boolean);

  // Figma places motion-path elements twice: a CSS `translate` in the rule and a transform
  // attribute on the element carrying the same numbers. The browser composes the two, so the
  // element lands at double its offset. It is a defect in the export, visible on the board
  // itself, and it wrecks out-of-scope where 21 of 22 elements are affected. Drop the
  // attribute and keep the CSS, which is the base the offset-path animation composes with.
  for (const id of ids) {
    const rule = rules.get(id);
    const css = rule?.match(/translate:\s*(-?[\d.]+)px\s+(-?[\d.]+)px/);
    if (!css) continue;

    const tag = new RegExp(`(<[a-z]+ id="${id}"[^>]*?) transform="translate\\((-?[\\d.]+) (-?[\\d.]+)\\)"`);
    const el = chunk.match(tag);
    if (!el) continue;

    const same = Math.abs(Number(css[1]) - Number(el[2])) < 0.01
      && Math.abs(Number(css[2]) - Number(el[3])) < 0.01;
    if (same) {
      chunk = chunk.replace(tag, "$1");
      doubled++;
    }
  }

  // Every track the rules name, not just the first of each shorthand.
  const wanted = used.flatMap((rule) => [...rule.matchAll(/kf_[A-Za-z0-9_-]+/g)].map((k) => k[0]));
  const blocks = wanted.map((name) => keyframes.get(name)).filter(Boolean);
  if (blocks.length !== wanted.length) {
    const missing = wanted.filter((name) => !keyframes.has(name));
    throw new Error(`${state}: ${missing.length} tracks have no @keyframes: ${missing.slice(0, 3)}`);
  }

  // Definitions the state points at, lifted out of the shared <defs>. References nest: the
  // cowboy hat is a rect filled with a pattern, the pattern uses an image, and the image is
  // where the actual bitmap lives. Following only the first hop loses the hat.
  const findDef = (id) =>
    defs.match(new RegExp(`<(clipPath|linearGradient|radialGradient|pattern|filter|mask|image|symbol)[^>]*id="${id}"[\\s\\S]*?</\\1>`))?.[0]
    ?? defs.match(new RegExp(`<image[^>]*id="${id}"[^>]*/>`))?.[0];

  const pointsAt = (text) => [
    ...[...text.matchAll(/url\(#([A-Za-z0-9_-]+)\)/g)].map((r) => r[1]),
    ...[...text.matchAll(/(?:xlink:)?href="#([A-Za-z0-9_-]+)"/g)].map((r) => r[1]),
  ];

  const kept = new Map();
  const queue = pointsAt(chunk);
  while (queue.length) {
    const id = queue.shift();
    if (kept.has(id)) continue;
    const def = findDef(id);
    if (!def) continue;
    kept.set(id, def);
    queue.push(...pointsAt(def));
  }

  const scope = (text) =>
    text
      .replace(/id="([A-Za-z0-9_-]+)"/g, `id="${state}__$1"`)
      .replace(/url\(#([A-Za-z0-9_-]+)\)/g, `url(#${state}__$1)`)
      .replace(/((?:xlink:)?href=")#([A-Za-z0-9_-]+)"/g, `$1#${state}__$2"`)
      .replace(/#([A-Za-z0-9_-]+)(\s*\{)/g, `#${state}__$1$2`)
      .replace(/\bkf_([A-Za-z0-9_-]+)/g, `kf_${state}__$1`);

  const out = [
    `<svg viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">`,
    `<style>\n${scope(used.join("\n"))}\n${scope(blocks.join("\n"))}\n</style>`,
    // Placing the state with a translate rather than a viewBox offset keeps every
    // transform-origin where the board put it.
    `<g transform="translate(${-x} ${-y})">`,
    scope(chunk),
    `</g>`,
    kept.size ? `<defs>\n${scope([...kept.values()].join("\n"))}\n</defs>` : "",
    `</svg>`,
  ].join("\n");

  mkdirSync(outDir, { recursive: true });
  const shrunk = shrinkRasters(out);
  writeFileSync(join(outDir, `${state}.svg`), shrunk);

  total += blocks.length;
  report.push(`${state.padEnd(20)} ${String(blocks.length).padStart(3)} tracks  ${String(used.length).padStart(3)} elements  ${(shrunk.length / 1024).toFixed(0)}KB`);
}

console.log(report.join("\n"));
console.log(`${"TOTAL".padEnd(20)} ${String(total).padStart(3)} tracks`);
console.log(`repaired ${doubled} double-placed elements`);
