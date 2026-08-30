export const SOURCE_URL = "https://github.com/Vaibhav91one/bountydesk";

const passthroughPaths = new Set([
  "/",
  "/favicon.ico",
  "/icon.svg",
  "/logo-lockup.svg",
  "/logo-mark.svg",
  "/logo-small.svg",
  "/logo-tick.svg",
  "/trix.svg",
]);

const passthroughPrefixes = ["/_next/", "/backdrop/", "/mascot/"];

export function shouldRedirectToSource(pathname: string) {
  if (passthroughPaths.has(pathname)) return false;

  return !passthroughPrefixes.some((prefix) => pathname.startsWith(prefix));
}
