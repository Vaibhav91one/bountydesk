/**
 * How wide the finding sheet is allowed to be.
 *
 * The default is the width the panel already shipped with, so anyone who never touches the
 * handle sees exactly what they saw before. The ceiling is half the viewport: a finding is
 * prose, and prose stops being easier to read once the line gets long, so widening past the
 * middle of the page would be a worse default dressed up as more room.
 */

export const MIN_SHEET_WIDTH = 672;
export const MAX_SHEET_FRACTION = 0.5;
export const SHEET_WIDTH_STORAGE_KEY = "bountydesk:findings-sheet-width";

/**
 * Clamp a requested width to what the current viewport can honour.
 *
 * A stored width outlives the window it was chosen in: drag it wide on a large display, reopen
 * the report on a laptop, and the panel would cover the page. Clamping on read rather than on
 * write is what keeps the preference useful when the big screen comes back.
 */
export function clampSheetWidth(requested: number, viewportWidth: number): number {
  const ceiling = Math.round(viewportWidth * MAX_SHEET_FRACTION);
  // A viewport narrower than the default has no room to negotiate: the sheet's own responsive
  // rules take over below the `sm` breakpoint, so the floor wins and the handle does nothing.
  if (ceiling <= MIN_SHEET_WIDTH) return MIN_SHEET_WIDTH;
  if (!Number.isFinite(requested)) return MIN_SHEET_WIDTH;
  return Math.min(Math.max(Math.round(requested), MIN_SHEET_WIDTH), ceiling);
}

/**
 * The remembered width, or null to use the default.
 *
 * Every access is wrapped: localStorage throws outright in a private window and in an iframe
 * with site data blocked, and a panel that cannot remember its width must still open.
 */
export function readStoredSheetWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(SHEET_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeSheetWidth(width: number): void {
  try {
    window.localStorage.setItem(SHEET_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // A viewer who cannot persist the width still gets it for this session.
  }
}

/**
 * The width as an external store, so the panel can read it with useSyncExternalStore.
 *
 * It lives outside React because that is what it is: a value owned by localStorage and by a
 * pointer drag, neither of which is React state. Reading it in an effect and calling setState
 * would render the panel at the default width first and then jump, which is both a visible flash
 * and the cascading-render pattern the lint rule is there to stop.
 */
let current: number | null = null;
const listeners = new Set<() => void>();

export function subscribeSheetWidth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The browser's answer. Cached because useSyncExternalStore requires a stable snapshot. */
export function sheetWidthSnapshot(): number {
  current ??= clampSheetWidth(readStoredSheetWidth() ?? MIN_SHEET_WIDTH, window.innerWidth);
  return current;
}

/** The server has no viewport and no storage, so it renders the width everyone starts at. */
export function sheetWidthServerSnapshot(): number {
  return MIN_SHEET_WIDTH;
}

/** Live drag: updates every subscriber without touching storage. */
export function setSheetWidth(width: number): void {
  current = width;
  for (const listener of listeners) listener();
}
