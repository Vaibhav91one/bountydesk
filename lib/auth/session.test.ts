import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_SECRET = "session-test-secret";

import { statesMatch } from "./oauth";
import { SESSION_TTL_SECONDS, newSession, seal, unseal } from "./session";

test("a sealed session round-trips", () => {
  const session = newSession("octocat", 583231);
  const back = unseal(seal(session));

  assert.equal(back?.login, "octocat");
  assert.equal(back?.userId, 583231);
});

test("an edited payload is refused", () => {
  const cookie = seal(newSession("octocat", 583231));
  const [body, signature] = cookie.split(".");

  const forged = Buffer.from(
    JSON.stringify({
      login: "attacker",
      userId: 1,
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  ).toString("base64url");

  assert.equal(unseal(`${forged}.${signature}`), null);
  assert.notEqual(body, forged);
});

test("a session signed with another secret is refused", () => {
  const cookie = seal(newSession("octocat", 583231));

  process.env.AUTH_SECRET = "a-different-secret";
  assert.equal(unseal(cookie), null);

  process.env.AUTH_SECRET = "session-test-secret";
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

test("the OAuth state must match exactly", () => {
  assert.equal(statesMatch("abc", "abc"), true);
  assert.equal(statesMatch("abc", "abd"), false);
  assert.equal(statesMatch("abc", "abcd"), false);
  assert.equal(statesMatch(undefined, "abc"), false);
  assert.equal(statesMatch("abc", null), false);
});
