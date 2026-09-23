/**
 * Rasterize the mascot states the verdict email uses.
 *
 * A mail client runs no CSS animation and most of them drop SVG outright, so the email cannot use
 * the artwork the app uses. These are flat PNGs of the same characters, committed to public/email
 * so they are served from the app's own origin at a stable URL: the email body has to be a pure
 * function of the payload, and a generated or cache-busted URL would break the idempotency key
 * that makes a delivery retry safe.
 *
 * Rasterizing runs the SVG through sharp, which renders the authored rest state and ignores the
 * @keyframes entirely. That is what we want for a still, but it does mean a frame can come out
 * looking wrong where the artwork relies on the animation to place something (celebrating's
 * confetti follows an offset-path, and sits at the path origin without it). Look at what this
 * writes before committing it; there is no test that can tell you a picture looks silly.
 *
 * Run: npx tsx scripts/build-email-assets.ts
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

/**
 * One state, not one per outcome.
 *
 * The outcome is already said in words and colour in the band above the body, so the mascot is
 * decoration and does not need to vary. It also avoids the failure this rasterizer has: with the
 * animation ignored, `celebrating` renders a blank face and drops its confetti at the origin of
 * the offset-path, which is a worse picture than a neutral one. `scanning` renders cleanly.
 */
const STATES = ["scanning"] as const;

/** Twice the 48px the email asks for, so it stays sharp on a retina display. */
const SIZE = 96;

async function main() {
  const root = process.cwd();
  const outDir = path.join(root, "public", "email");
  await mkdir(outDir, { recursive: true });

  for (const state of STATES) {
    const source = path.join(root, "public", "mascot", `${state}.svg`);
    const svg = await readFile(source, "utf8");

    // The app's loader strips these before injecting the markup, and sharp needs a concrete size
    // to rasterize into rather than the viewBox's own units.
    const sized = svg.replace(
      "<svg ",
      `<svg width="${SIZE}" height="${SIZE}" `,
    );

    const target = path.join(outDir, `${state}.png`);
    const { size } = await sharp(Buffer.from(sized))
      .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(target);

    console.log(`${path.relative(root, target)}  ${(size / 1024).toFixed(1)} KB`);
  }
}

// Not top-level await: tsx compiles this file as CJS, where that is a syntax error.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
