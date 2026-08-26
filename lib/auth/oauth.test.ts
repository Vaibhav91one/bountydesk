import assert from "node:assert/strict";
import test from "node:test";

import { appBaseUrl, callbackUrl, isSecureOrigin } from "./oauth";

/**
 * APP_BASE_URL is the root of several security decisions at once: the OAuth redirect URI,
 * the Origin logout accepts, and whether cookies carry Secure. A bad value does not fail
 * loudly at runtime, it just quietly weakens all three, so it is checked at the source.
 */
function withBaseUrl<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.APP_BASE_URL;
  if (value === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = value;

  try {
    return run();
  } finally {
    process.env.APP_BASE_URL = previous;
  }
}

test("an https origin is accepted and normalised", () => {
  withBaseUrl("https://bountydesk.example", () => {
    assert.equal(appBaseUrl(), "https://bountydesk.example");
    assert.equal(isSecureOrigin(), true);
    assert.equal(callbackUrl(), "https://bountydesk.example/api/auth/github/callback");
  });

  // A trailing slash is the same origin, and callers concatenate paths onto the result.
  withBaseUrl("https://bountydesk.example/", () => {
    assert.equal(appBaseUrl(), "https://bountydesk.example");
  });

  withBaseUrl("https://bountydesk.example:8443", () => {
    assert.equal(appBaseUrl(), "https://bountydesk.example:8443");
  });
});

test("http is allowed on loopback and nowhere else", () => {
  for (const ok of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    withBaseUrl(ok, () => {
      assert.equal(appBaseUrl(), ok, ok);
      assert.equal(isSecureOrigin(), false, ok);
    });
  }

  // These are the ones that matter: each would drop Secure from the session cookie and put
  // it on the wire in clear text, with nothing in any log to say so.
  for (const bad of [
    "http://bountydesk.example",
    "http://192.168.1.10:3000",
    "http://localhost.evil.example",
    "http://staging.internal",
  ]) {
    withBaseUrl(bad, () => {
      assert.throws(() => appBaseUrl(), /must use https/, bad);
    });
  }
});

test("a value that is not a bare origin is refused", () => {
  const cases: Record<string, RegExp> = {
    "https://bountydesk.example/app": /no path/,
    "https://bountydesk.example/?next=/x": /query string or fragment/,
    "https://bountydesk.example/#frag": /query string or fragment/,
    "https://user:pass@bountydesk.example": /credentials/,
    "bountydesk.example": /absolute URL/,
    "/api": /absolute URL/,
    "ftp://bountydesk.example": /must use https/,
  };

  for (const [value, message] of Object.entries(cases)) {
    withBaseUrl(value, () => assert.throws(() => appBaseUrl(), message, value));
  }
});

test("a missing APP_BASE_URL is fatal", () => {
  withBaseUrl(undefined, () => {
    assert.throws(() => appBaseUrl(), /APP_BASE_URL is not set/);
  });
});
