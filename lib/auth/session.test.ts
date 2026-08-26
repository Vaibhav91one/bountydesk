import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = Buffer.alloc(32, "s").toString("base64");

import { SESSION_TTL_SECONDS, newSession, seal, unseal } from "./session";

const future = () => Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

/** Sign an arbitrary claim set, so the tests can prove the checks after the signature. */
async function sealRaw(claims: unknown): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", process.env.AUTH_SECRET as string)
    .update(body)
    .digest("base64url");

  return `${body}.${signature}`;
}

test("a sealed session round-trips", () => {
  const back = unseal(seal(newSession("octocat", 583231)));

  assert.equal(back?.login, "octocat");
  assert.equal(back?.userId, 583231);
});

test("an edited payload is refused", async () => {
  const [, signature] = seal(newSession("octocat", 583231)).split(".");
  const forged = Buffer.from(
    JSON.stringify({ login: "attacker", userId: 1, expiresAt: future() }),
  ).toString("base64url");

  assert.equal(unseal(`${forged}.${signature}`), null);
});

test("a session signed with another secret is refused", () => {
  const cookie = seal(newSession("octocat", 583231));

  process.env.AUTH_SECRET = Buffer.alloc(32, "x").toString("base64");
  assert.equal(unseal(cookie), null);

  process.env.AUTH_SECRET = Buffer.alloc(32, "s").toString("base64");
  assert.equal(unseal(cookie)?.login, "octocat");
});

test("an expired session is refused even though the signature is ours", () => {
  const expired = seal({
    login: "octocat",
    userId: 583231,
    expiresAt: Math.floor(Date.now() / 1000) - 1,
  });

  assert.equal(unseal(expired), null);
});

test("junk cookie values are refused rather than thrown on", () => {
  for (const value of [undefined, "", "no-dot", ".", "a.b", "...."]) {
    assert.equal(unseal(value), null);
  }
});

test("a correctly signed cookie with malformed claims is refused", async () => {
  const cases: Record<string, unknown> = {
    // Comparing a string expiry produces NaN, and NaN > now is false, so a truthiness check
    // would read this as "not expired" and let it through.
    "string expiry": { login: "octocat", userId: 1, expiresAt: "not-a-number" },
    "missing expiry": { login: "octocat", userId: 1 },
    "fractional expiry": { login: "octocat", userId: 1, expiresAt: future() + 0.5 },
    "empty login": { login: "", userId: 1, expiresAt: future() },
    "numeric login": { login: 12, userId: 1, expiresAt: future() },
    "string user id": { login: "octocat", userId: "1", expiresAt: future() },
    "zero user id": { login: "octocat", userId: 0, expiresAt: future() },
    "negative user id": { login: "octocat", userId: -1, expiresAt: future() },
    "unsafe user id": { login: "octocat", userId: 2 ** 60, expiresAt: future() },
    "not an object": "octocat",
    "null claims": null,
    "array claims": ["octocat", 1, future()],
  };

  for (const [name, claims] of Object.entries(cases)) {
    assert.equal(unseal(await sealRaw(claims)), null, name);
  }
});

test("a weak or placeholder AUTH_SECRET fails closed", () => {
  const good = process.env.AUTH_SECRET;

  for (const bad of ["<random-32-bytes-base64>", "changeme", "short", "a".repeat(31)]) {
    process.env.AUTH_SECRET = bad;
    assert.throws(() => seal(newSession("octocat", 1)), /AUTH_SECRET/, bad);
  }

  // A raw 32-character string is accepted as well as base64: env.example documents base64,
  // but refusing a long random string nobody base64-encoded would be surprising.
  process.env.AUTH_SECRET = "a".repeat(32);
  assert.ok(seal(newSession("octocat", 1)));

  process.env.AUTH_SECRET = good;
});
