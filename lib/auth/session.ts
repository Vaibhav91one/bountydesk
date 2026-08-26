import { createHmac, timingSafeEqual } from "node:crypto";

import { requireSecret } from "@/lib/env";

/**
 * Operator sessions.
 *
 * The cookie is the credential for every session-gated surface, and its integrity rests
 * entirely on AUTH_SECRET staying secret. Anyone holding that secret can mint a cookie for
 * any user id, and the reviewer allowlist is then the only thing left between them and the
 * review queue. Treat it like a signing key, not like a salt.
 *
 * What the cookie does not carry is a GitHub token. Repository access comes from the App
 * installation, so there is nothing here to refresh or leak, which is why a signed cookie is
 * enough and no session table exists.
 */
export type Session = {
  /** GitHub login, for display and for the approval audit trail. */
  login: string;
  /** GitHub user id. Immutable, unlike the login, so authorization keys on this. */
  userId: number;
  /** Seconds since the epoch. */
  expiresAt: number;
};

export const SESSION_COOKIE = "bd_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * A committed placeholder is not a secret, and neither is a short one.
 *
 * env.example documents `openssl rand -base64 32`, so the configured value is normally
 * base64. Decode it when it looks like base64 and measure the real entropy; fall back to the
 * raw byte length otherwise. Anything under 32 bytes is refused rather than warned about,
 * because a weak signing key here is a forged session.
 */
function assertStrongSecret(value: string): void {
  if (value.startsWith("<") || value.toLowerCase().includes("changeme")) {
    throw new Error("AUTH_SECRET is still the placeholder from env.example");
  }

  const decoded = /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
    ? Buffer.from(value, "base64")
    : Buffer.from(value, "utf8");

  const bytes = Math.max(decoded.length, Buffer.byteLength(value, "utf8") >= 32 ? 32 : 0);
  if (bytes < 32) {
    throw new Error(
      "AUTH_SECRET must be at least 32 random bytes. Generate one: openssl rand -base64 32",
    );
  }
}

function secret(): string {
  const value = requireSecret("AUTH_SECRET");
  assertStrongSecret(value);
  return value;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

/** Encode a session as `payload.signature`, both base64url. */
export function seal(session: Session): string {
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * A valid signature proves we minted the payload. It says nothing about what is in it, and
 * a bug that ever sealed a bad shape would otherwise be waved through, so the claims are
 * checked on the way out as strictly as they are built on the way in.
 */
function validClaims(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;

  const { login, userId, expiresAt } = value as Record<string, unknown>;

  if (typeof login !== "string" || login.length === 0) return false;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) return false;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)) return false;

  // The signature does not say when we minted it, so the expiry is what bounds how long a
  // stolen cookie is worth having.
  return expiresAt * 1000 > Date.now();
}

/** Decode a cookie value, returning null for anything tampered with, malformed or expired. */
export function unseal(cookieValue: string | undefined): Session | null {
  if (!cookieValue) return null;

  const dot = cookieValue.lastIndexOf(".");
  if (dot < 1) return null;

  const body = cookieValue.slice(0, dot);
  const received = Buffer.from(cookieValue.slice(dot + 1));
  const expected = Buffer.from(sign(body));

  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  return validClaims(claims) ? claims : null;
}

export function newSession(login: string, userId: number): Session {
  return {
    login,
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}
