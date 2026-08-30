/**
 * Timestamps, written the way a person reads them.
 *
 * Locale and time zone are both pinned. Neither is a preference here: an unpinned formatter
 * reads the server's locale on the server and the browser's on the client, which produces two
 * different strings for one moment and a hydration mismatch to go with it. Everything this
 * product records is UTC, and saying so is cheaper than making a reviewer wonder.
 */
const STAMP = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** "29 Aug 2026, 09:28 UTC" */
export function formatStamp(at: Date): string {
  return `${STAMP.format(at)} UTC`;
}
