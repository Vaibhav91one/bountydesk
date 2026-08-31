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

const passthroughPrefixes = ["/_next/", "/backdrop/", "/mascot/", "/api/reports/"];

type LandingRedirectEnv = Record<string, string | undefined>;

export function landingRedirectEnabled(env: LandingRedirectEnv = process.env) {
  const explicit = env.BOUNTYDESK_LANDING_REDIRECT?.trim().toLowerCase();
  if (explicit) return ["1", "true", "yes", "on"].includes(explicit);

  return env.VERCEL === "1" || env.BOUNTYDESK_LANDING_REDIRECT === "1";
}

function configuredAppHost(env: LandingRedirectEnv): string | null {
  const raw = env.APP_BASE_URL?.trim();
  if (!raw) return null;

  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return null;
  }
}

export function shouldRedirectToSource(
  pathname: string,
  host?: string | null,
  env: LandingRedirectEnv = process.env,
) {
  if (host && host.toLowerCase() === configuredAppHost(env)) return false;
  if (passthroughPaths.has(pathname)) return false;

  return !passthroughPrefixes.some((prefix) => pathname.startsWith(prefix));
}
