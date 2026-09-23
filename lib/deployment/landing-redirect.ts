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
  "/api/github/setup",
  "/api/health",
  "/api/intake/github",
  "/api/mcp/publish-verdict",
  "/api/mcp/scope-guard",
  "/api/mcp/build",
  "/api/mcp/review",
  // The console's own list polls. The "/api/reports/" prefix below does not cover the bare
  // path, and a redirected poll is a board that silently never updates on a preview URL.
  "/api/reports",
  "/api/queue",
  "/api/home",
  "/api/active-reports",
  "/api/connections",
]);

const passthroughPrefixes = ["/_next/", "/backdrop/", "/mascot/", "/api/reports/"];

type LandingRedirectEnv = Record<string, string | undefined>;

export function landingRedirectEnabled(env: LandingRedirectEnv = process.env) {
  const explicit = env.BOUNTYDESK_LANDING_REDIRECT?.trim().toLowerCase();
  if (explicit) return ["1", "true", "yes", "on"].includes(explicit);

  return env.VERCEL === "1";
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

/**
 * Where a redirected landing request goes.
 *
 * A page path goes to the same path on the app host, so the landing page's "Get started",
 * "Approve" and legal links end up at sign-in instead of the source code. The origin and path
 * are concatenated rather than resolved with `new URL(path, base)`, which would send `//host`
 * to another host. API paths and deployments with no app host keep the repository fallback:
 * an API call that reached the landing host was not meant for production.
 */
export function landingRedirectTarget(
  pathname: string,
  search: string,
  env: LandingRedirectEnv = process.env,
): string {
  const appHost = configuredAppHost(env);
  if (!appHost || pathname.startsWith("/api/")) return SOURCE_URL;

  return `https://${appHost}${pathname}${search}`;
}
