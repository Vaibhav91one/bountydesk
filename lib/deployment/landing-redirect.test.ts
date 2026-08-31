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
  assert.equal(landingRedirectEnabled({ BOUNTYDESK_LANDING_REDIRECT: "true" }), true);
  assert.equal(
    landingRedirectEnabled({ VERCEL: "1", BOUNTYDESK_LANDING_REDIRECT: "0" }),
    false,
  );
});

test("keeps the landing page and its assets on Vercel", () => {
  for (const pathname of [
    "/",
    "/icon.svg",
    "/logo-lockup.svg",
    "/backdrop/hero.webp",
    "/mascot/idle.svg",
    "/_next/static/chunks/app.js",
    "/api/health",
  ]) {
    assert.equal(shouldRedirectToSource(pathname), false, pathname);
  }
});

test("lets GitHub connection endpoints run during landing fallback", () => {
  for (const pathname of [
    "/api/auth/github",
    "/api/auth/github/callback",
    "/api/auth/logout",
    "/api/github/setup",
    "/api/intake/github",
  ]) {
    assert.equal(shouldRedirectToSource(pathname), false, pathname);
  }
});

test("lets TrueForge MCP connector endpoints run during landing fallback", () => {
  for (const pathname of ["/api/mcp/publish-verdict", "/api/mcp/scope-guard"]) {
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
    "/api/internal/jobs/tick",
    "/terms",
    "/privacy",
    "/anything-else.txt",
  ]) {
    assert.equal(shouldRedirectToSource(pathname), true, pathname);
  }
});

test("does not redirect the configured app host", () => {
  const env = {
    APP_BASE_URL: "https://app.bounty-desk.vaibhav.quest",
    BOUNTYDESK_LANDING_REDIRECT: "1",
  };

  assert.equal(
    shouldRedirectToSource("/login", "app.bounty-desk.vaibhav.quest", env),
    false,
  );
  assert.equal(shouldRedirectToSource("/login", "bounty-desk.vaibhav.quest", env), true);
});
