import { createHmac, timingSafeEqual } from "node:crypto";

import { requireSecret } from "@/lib/env";

/**
 * Operator sessions.
 *
 * A session says who is logged in and nothing more. Repository access comes from the App
 * installation, never from the person's OAuth token, so there is no token here to store,
 * refresh or leak. That is also why a signed cookie is enough: the only thing an attacker
 * gains by forging one is a name, and forging it means finding a SHA-256 HMAC collision.
 */
export type Session = {
  /** GitHub login, for display and for the approval audit trail. */
  login: string;
  /** GitHub user id. Immutable, unlike the login. */
  userId: number;
  /** Seconds since the epoch. */
  expiresAt: number;
};

export const SESSION_COOKIE = "bd_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function sign(body: string): string {
  return createHmac("sha256", requireSecret("AUTH_SECRET")).update(body).digest("base64url");
}

/** Encode a session as `payload.signature`, both base64url. */
export function seal(session: Session): string {
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${body}.${sign(body)}`;
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

  let session: Session;
  try {
    session = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
  } catch {
    return null;
  }

  // The signature proves we issued this cookie. It says nothing about when, so the expiry
  // still has to be checked: a stolen cookie would otherwise be valid forever.
  if (!session.login || !session.userId || session.expiresAt * 1000 < Date.now()) return null;

  return session;
}

export function newSession(login: string, userId: number): Session {
  return {
    login,
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
}

/** Cookie attributes. Secure is dropped on plain http so local development still works. */
export function cookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
