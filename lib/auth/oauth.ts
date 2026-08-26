import { randomBytes, timingSafeEqual } from "node:crypto";

import { requireEnv, requireSecret } from "@/lib/env";

/**
 * GitHub OAuth, used for identity only.
 *
 * No scopes are requested. The operator's token grants nothing beyond their public profile,
 * and it is used once to read a login and an id and then dropped. Repository access is the
 * App installation's business, which is what keeps a compromised session from turning into
 * repository access.
 */
export const STATE_COOKIE = "bd_oauth_state";
const STATE_TTL_SECONDS = 600;

export function appBaseUrl(): string {
  return requireEnv("APP_BASE_URL").replace(/\/$/, "");
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

export function stateCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  };
}

export function statesMatch(fromCookie: string | undefined, fromQuery: string | null): boolean {
  if (!fromCookie || !fromQuery) return false;

  const a = Buffer.from(fromCookie);
  const b = Buffer.from(fromQuery);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

export function authorizeUrl(state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", requireEnv("GITHUB_APP_CLIENT_ID"));
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

/** Where the operator goes to pick an account and repositories. */
export function installUrl(): string {
  return `https://github.com/apps/${requireEnv("GITHUB_APP_SLUG")}/installations/new`;
}

export type GitHubUser = { login: string; id: number };

/**
 * Trade the callback code for the operator's identity.
 *
 * The access token never leaves this function. Nothing downstream needs it: posting a
 * comment later uses a short-lived installation token instead, so storing this one would be
 * a long-lived credential kept for no reason.
 */
export async function identify(code: string): Promise<GitHubUser | null> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: requireEnv("GITHUB_APP_CLIENT_ID"),
      client_secret: requireSecret("GITHUB_APP_CLIENT_SECRET"),
      code,
      redirect_uri: callbackUrl(),
    }),
  });

  if (!tokenResponse.ok) return null;

  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token.access_token) return null;

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "bountydesk",
    },
  });

  if (!userResponse.ok) return null;

  const user = (await userResponse.json()) as Partial<GitHubUser>;
  if (!user.login || !user.id) return null;

  return { login: user.login, id: user.id };
}
