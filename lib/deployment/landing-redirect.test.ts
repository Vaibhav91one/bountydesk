import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SOURCE_URL,
  landingRedirectEnabled,
  shouldRedirectToSource,
} from "./landing-redirect";

test("enables the landing redirect only for Vercel or an explicit override", () => {
  assert.equal(landingRedirectEnabled({}), false);
  assert.equal(landingRedirectEnabled({ VERCEL: "1" }), true);
  assert.equal(landingRedirectEnabled({ BOUNTYDESK_LANDING_REDIRECT: "1" }), true);
});

test("keeps the landing page and its assets on Vercel", () => {
  for (const pathname of [
    "/",
    "/icon.svg",
    "/logo-lockup.svg",
    "/backdrop/hero.webp",
    "/mascot/idle.svg",
    "/_next/static/chunks/app.js",
  ]) {
    assert.equal(shouldRedirectToSource(pathname), false, pathname);
  }
});

test("redirects non-landing routes to the GitHub repository", () => {
  assert.equal(SOURCE_URL, "https://github.com/Vaibhav91one/bountydesk");

  for (const pathname of [
    "/login",
    "/home",
    "/reports",
    "/reports/r1",
    "/api/intake/github",
    "/terms",
    "/privacy",
    "/anything-else.txt",
  ]) {
    assert.equal(shouldRedirectToSource(pathname), true, pathname);
  }
});
