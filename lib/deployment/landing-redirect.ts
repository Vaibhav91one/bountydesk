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
  "/api/auth/github",
  "/api/auth/github/callback",
  "/api/auth/logout",
  "/api/github/setup",
  "/api/health",
  "/api/intake/github",
  "/api/mcp/publish-verdict",
  "/api/mcp/scope-guard",
]);

const passthroughPrefixes = ["/_next/", "/backdrop/", "/mascot/"];

type LandingRedirectEnv = Record<string, string | undefined>;

export function landingRedirectEnabled(env: LandingRedirectEnv = process.env) {
  const explicit = env.BOUNTYDESK_LANDING_REDIRECT?.trim().toLowerCase();
  if (explicit) return ["1", "true", "yes", "on"].includes(explicit);

  return env.VERCEL === "1" || env.BOUNTYDESK_LANDING_REDIRECT === "1";
}

export function shouldRedirectToSource(pathname: string) {
  if (passthroughPaths.has(pathname)) return false;

  return !passthroughPrefixes.some((prefix) => pathname.startsWith(prefix));
}
