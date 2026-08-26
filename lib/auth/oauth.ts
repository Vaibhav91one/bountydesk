import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { requireEnv, requireSecret } from "@/lib/env";

/**
 * GitHub OAuth, used to answer one question: which GitHub account is this.
 *
 * The token this flow returns is a GitHub App user access token, and it is privileged. Its
 * reach is the intersection of the App's permissions, the repositories the installation
 * covers, and what the user can already see, so with Issues read and write on the App it can
 * carry issue access. BountyDesk uses it for a single GET /user and then drops it. It is
 * never stored, logged, returned, or put in an error, and nothing downstream touches it:
 * posting a comment later mints a short-lived installation token instead.
 */
export const STATE_COOKIE = "bd_oauth_state";
export const VERIFIER_COOKIE = "bd_oauth_verifier";
export const OAUTH_COOKIE_TTL_SECONDS = 600;

/** GitHub is not a dependency we want a login request to hang on. */
const GITHUB_TIMEOUT_MS = 10_000;

/** Hosts where plain http is a development machine rather than a downgrade. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Our own origin, validated.
 *
 * Everything security-relevant here is derived from this one string: the OAuth redirect
 * URI, the Origin that logout accepts, and whether cookies carry Secure. An `http://` value
 * pointing anywhere but a development machine silently drops Secure from the session
 * cookie, which puts it on the wire in clear text and leaves no trace in any log. So http is
 * allowed only for loopback, and anything with a path, query, fragment, or embedded
 * credentials is refused rather than quietly normalised away: those are configuration
 * mistakes, and guessing what was meant is how a redirect ends up somewhere unintended.
 */
export function appBaseUrl(): string {
  const raw = requireEnv("APP_BASE_URL");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`APP_BASE_URL must be an absolute URL, for example https://bountydesk.example. Got "${raw}".`);
  }

  if (url.username || url.password) {
    throw new Error("APP_BASE_URL must not carry credentials");
  }

  if (url.search || url.hash) {
    throw new Error("APP_BASE_URL must not carry a query string or fragment");
  }

  if (url.pathname !== "/") {
    throw new Error(`APP_BASE_URL must be an origin with no path. Got "${url.pathname}".`);
  }

  // URL keeps the brackets on an IPv6 literal, so http://[::1]:3000 has hostname "[::1]".
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `APP_BASE_URL must use https, except on ${[...LOOPBACK_HOSTS].join(", ")} where http is allowed for development. Got "${url.protocol}//${host}".`,
    );
  }

  // origin drops any trailing slash, so callers can concatenate a path onto it.
  return url.origin;
}

export function callbackUrl(): string {
  return `${appBaseUrl()}/api/auth/github/callback`;
}

/** Whether cookies should carry Secure. Plain http is only ever local development. */
export function isSecureOrigin(): boolean {
  return appBaseUrl().startsWith("https://");
}

export function newState(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE code verifier. GitHub accepts 43 to 128 characters; 32 bytes encodes to 43. */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function statesMatch(fromCookie: string | undefined, fromQuery: string | null): boolean {
  if (!fromCookie || !fromQuery) return false;

  const a = Buffer.from(fromCookie);
  const b = Buffer.from(fromQuery);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * The authorization request.
 *
 * No scopes are asked for, and PKCE binds the eventual code to this browser: the token
 * exchange only succeeds for whoever holds the verifier, so a code intercepted in a redirect
 * or a log is not enough on its own.
 */
export function authorizeUrl(state: string, verifier: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", requireEnv("GITHUB_APP_CLIENT_ID"));
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

/** Where the operator goes to pick an account and repositories. */
export function installUrl(): string {
  return `https://github.com/apps/${requireEnv("GITHUB_APP_SLUG")}/installations/new`;
}

export type GitHubUser = { login: string; id: number };

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`github responded ${response.status}`);
  return response.json();
}

/**
 * Trade the callback code for the operator's identity.
 *
 * Everything GitHub controls is treated as a possible failure: a refused connection, a
 * timeout, a non-2xx, a body that is not JSON, a body that is JSON but the wrong shape. All
 * of them come back as null, which the callback turns into a login error, rather than
 * escaping as a 500 that says nothing useful. The thrown error is deliberately not
 * propagated: the token could be in it.
 */
export async function identify(code: string, verifier: string): Promise<GitHubUser | null> {
  // Configuration is read before the try, so a missing client secret still fails loudly
  // instead of being reported to the operator as "GitHub is having a moment".
  const clientId = requireEnv("GITHUB_APP_CLIENT_ID");
  const clientSecret = requireSecret("GITHUB_APP_CLIENT_SECRET");

  try {
    const token = await postJson("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl(),
      code_verifier: verifier,
    });

    const accessToken = (token as { access_token?: unknown }).access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) return null;

    const response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "bountydesk",
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const user = (await response.json()) as Record<string, unknown>;
    if (typeof user.login !== "string" || user.login.length === 0) return null;
    if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) return null;

    return { login: user.login, id: user.id };
  } catch {
    return null;
  }
}
