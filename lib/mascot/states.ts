import { readFileSync } from "node:fs";
import { join } from "node:path";

export {
  MASCOT_FOR_STATE,
  MASCOT_STATES,
  mascotKeyForState,
  type MascotKey,
} from "./catalog";
import { MASCOT_STATES, mascotKeyForState, type MascotKey } from "./catalog";

/**
 * The mascot states, as inline SVG markup.
 *
 * They are inlined rather than pointed at with <img> because the animation lives in a <style>
 * block inside each file, and an SVG referenced as an image does not reliably run it. In the
 * document the keyframes are ordinary CSS and simply work.
 *
 * The order is the order a report travels, so the strip reads as the pipeline. Three of
 * them come from a second board (bountydesk-mascot-animation) whose own idle duplicates
 * this one's, which is why the splitter takes that board with --only.
 */
export type MascotState = { key: string; markup: string };

/**
 * Read once per server process. The files are build output from
 * scripts/split-mascot-export.mjs and never change while the server is up.
 */
const cache = new Map<string, string>();

function read(state: string): string {
  const cached = cache.get(state);
  if (cached) return cached;

  const file = join(process.cwd(), "public", "mascot", `${state}.svg`);
  // The intrinsic size would fight the slot it is rendered into. viewBox stays, so the
  // artwork still scales correctly once CSS gives it a width and height.
  const markup = readFileSync(file, "utf8").replace(
    /^<svg width="\d+" height="\d+"/,
    "<svg",
  );

  cache.set(state, markup);
  return markup;
}

export function mascotStates(): MascotState[] {
  return MASCOT_STATES.map((key) => ({ key, markup: read(key) }));
}

/** One state, for the places that want a single mascot rather than the whole strip. */
export function mascotState(key: MascotKey): MascotState {
  return { key, markup: read(key) };
}

/** The mascot for a state, ready to inline. Falls back to idle for anything unmapped. */
export function mascotForState(state: string): MascotState {
  return mascotState(mascotKeyForState(state));
}
