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
  const decoded = Buffer.from(githubAppPrivateKeyBase64(), "base64").toString("utf8");
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
  const iat = Math.floor(now.getTime() / 1000) - CLOCK_SKEW_SECONDS;
  const exp = iat + JWT_TTL_SECONDS;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp, iss: githubAppId() }));
  const signingInput = `${header}.${payload}`;

  // Validate the key before signing so a malformed secret fails with a clear message instead
  // of an opaque OpenSSL error, and fails before the signature (and thus the JWT) ever exists.
  const signature = createSign("RSA-SHA256").update(signingInput).sign(decodedPrivateKey(), "base64url");

  return `${signingInput}.${signature}`;
}

export type InstallationToken = { token: string; expiresAt: string };

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
  opts?: { fetchImpl?: typeof fetch },
): Promise<InstallationToken> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`installationId must be a positive integer, got ${installationId}`);
  }
  if (!Number.isInteger(repoId) || repoId <= 0) {
    throw new Error(`repoId must be a positive integer, got ${repoId}`);
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
      body: JSON.stringify({ repository_ids: [repoId] }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    // GitHub's own error body is safe to surface; it never contains the Authorization header
    // we sent, only its own complaint about the request.
    const body = await response.text();
    throw new Error(`GitHub installation token request failed with ${response.status}: ${body}`);
  }

  const json = (await response.json()) as { token: string; expires_at: string };
  return { token: json.token, expiresAt: json.expires_at };
}
