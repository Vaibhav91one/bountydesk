import { createSign } from "node:crypto";

import { githubAppId, githubAppPrivateKeyBase64 } from "@/lib/env";

/**
 * The App JWT and the installation token it mints.
 *
 * No `@octokit/*`, `jsonwebtoken`, or `jose` here: RS256 is three base64url segments and a
 * signature, and the rest of this codebase already hand-rolls its GitHub calls with raw
 * `fetch` (see `lib/auth/oauth.ts`), so a JWT library would be one more dependency for
 * something `node:crypto` already does directly.
 */

const GITHUB_TIMEOUT_MS = 10_000;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** GitHub allows drift up to a few minutes; backdating `iat` absorbs a slow clock on our side. */
const CLOCK_SKEW_SECONDS = 60;

/** GitHub refuses a JWT with a longer lifetime, and a longer-lived one is a bigger thing to leak. */
const JWT_TTL_SECONDS = 600;

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Decode the App's private key and check it is actually a PEM block before anything signs
 * with it. `crypto.createSign(...).sign()` on a non-PEM string throws an OpenSSL error that
 * says nothing about which env var is wrong, so this catches the realistic mistake (the raw
 * key pasted instead of its base64, or a value re-encoded twice) with a message that names it.
 */
function decodedPrivateKey(): string {
  const decoded = Buffer.from(githubAppPrivateKeyBase64(), "base64").toString(
    "utf8",
  );
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(decoded)) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY_BASE64 does not decode to a PEM private key block. It should be " +
        "the base64 encoding of the .pem file GitHub issued for the App, not the file's raw " +
        "contents and not something base64-encoded a second time.",
    );
  }
  return decoded;
}

export function signAppJwt(now: Date = new Date()): string {
  const appId = githubAppId();
  if (!/^[1-9]\d*$/.test(appId)) {
    throw new Error("GITHUB_APP_ID must be a positive integer");
  }
  const iat = Math.floor(now.getTime() / 1000) - CLOCK_SKEW_SECONDS;
  const exp = iat + JWT_TTL_SECONDS;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp, iss: appId }));
  const signingInput = `${header}.${payload}`;

  // Validate the key before signing so a malformed secret fails with a clear message instead
  // of an opaque OpenSSL error, and fails before the signature (and thus the JWT) ever exists.
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(decodedPrivateKey(), "base64url");

  return `${signingInput}.${signature}`;
}

export type InstallationToken = { token: string; expiresAt: string };

/**
 * A non-2xx response from GitHub, carrying its status so a caller can tell an authoritative
 * refusal (a 403 the App is not authorized for, a 404 the installation is gone) apart from a
 * transient one (5xx, or a rate-limit 403). Delivery reads it to stop retrying a token mint
 * GitHub has permanently refused; reconcile reads it to fail safe on a read that did not answer.
 */
export class GitHubApiError extends Error {
  readonly status: number;
  /**
   * GitHub answers a rate limit with 403 as well as 429, so a 403 alone does not mean the App lost
   * access. Minting tokens in a burst is itself a documented secondary-rate-limit trigger.
   */
  readonly rateLimited: boolean;
  constructor(status: number, message: string, rateLimited = false) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

/** GitHub's rate-limit signals: an exhausted primary quota, a retry-after, or the limit named in the body. */
function isRateLimited(response: Response, text: string): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after") ||
    /rate limit/i.test(text)
  );
}

/**
 * POST the installation access-token endpoint and parse the result. The scoped and unscoped
 * mints differ only by the body, so the request, error surfacing, and validation live here once.
 */
async function requestInstallationToken(
  installationId: number,
  body: Record<string, unknown>,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<InstallationToken> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(
      `installationId must be a positive integer, got ${installationId}`,
    );
  }

  const doFetch = opts?.fetchImpl ?? fetch;
  const response = await doFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${signAppJwt()}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal: requestSignal(opts?.signal),
    },
  );

  if (!response.ok) {
    // GitHub's own error body is safe to surface; it never contains the Authorization header
    // we sent, only its own complaint about the request.
    const text = await response.text();
    throw new GitHubApiError(
      response.status,
      `GitHub installation token request failed with ${response.status}: ${text}`,
      isRateLimited(response, text),
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("GitHub returned a malformed installation token response");
  }

  if (
    typeof json !== "object" ||
    json === null ||
    !("token" in json) ||
    typeof json.token !== "string" ||
    json.token.length === 0 ||
    !("expires_at" in json) ||
    typeof json.expires_at !== "string" ||
    !Number.isFinite(Date.parse(json.expires_at))
  ) {
    throw new Error("GitHub returned a malformed installation token response");
  }

  return { token: json.token, expiresAt: json.expires_at };
}

/**
 * Mint a token scoped to exactly one repository.
 *
 * Passing `repository_ids: [repoId]` rather than leaving the installation's full repo set
 * implicit means a token minted for one report cannot be replayed against a different
 * repository the same installation happens to cover.
 */
export async function mintInstallationToken(
  installationId: number,
  repoId: number,
  opts?: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Narrow the token to these permissions. GitHub refuses (422) a permission the installation
     *  was never granted, so asking for `{ contents: "read" }` also proves the grant exists. */
    permissions?: Record<string, "read" | "write">;
  },
): Promise<InstallationToken> {
  if (!Number.isInteger(repoId) || repoId <= 0) {
    throw new Error(`repoId must be a positive integer, got ${repoId}`);
  }
  return requestInstallationToken(
    installationId,
    { repository_ids: [repoId], ...(opts?.permissions ? { permissions: opts.permissions } : {}) },
    opts,
  );
}

/**
 * Revoke an installation token before it expires. A clone into a build sandbox is followed by the
 * repository's own code running there, so a token that was ever inside it should be dead by then.
 * Best-effort: the token expires within the hour anyway, so this never throws.
 */
export async function revokeInstallationToken(
  token: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<void> {
  try {
    await (opts?.fetchImpl ?? fetch)("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: requestSignal(opts?.signal),
    });
  } catch {
    // Expiry is the backstop.
  }
}

/**
 * Mint a token for the whole installation, unscoped to any single repository.
 *
 * Reconciliation needs it to read `GET /installation/repositories`, which returns only the
 * repositories the presented token is scoped to: a per-repo token would list just that one repo
 * and make every other connected repo look removed. Nothing that posts uses this; keep the
 * scoped mint for delivery.
 */
export async function mintInstallationAccessToken(
  installationId: number,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<InstallationToken> {
  return requestInstallationToken(installationId, {}, opts);
}
