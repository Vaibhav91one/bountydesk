import assert from "node:assert/strict";
import test from "node:test";

import { isReviewer, reviewerIds } from "./reviewers";

test("the allowlist is a set of numeric ids", () => {
  process.env.REVIEWER_GITHUB_IDS = " 42 , 583231 ";

  assert.deepEqual([...reviewerIds()].sort((a, b) => a - b), [42, 583231]);
  assert.equal(isReviewer(42), true);
  assert.equal(isReviewer(43), false);
});

test("a missing, empty or malformed allowlist fails closed", () => {
  delete process.env.REVIEWER_GITHUB_IDS;
  assert.throws(() => reviewerIds(), /REVIEWER_GITHUB_IDS is not set/);

  for (const bad of ["", "   ", ",,,"]) {
    process.env.REVIEWER_GITHUB_IDS = bad;
    assert.throws(() => reviewerIds(), /REVIEWER_GITHUB_IDS/, bad);
  }

  // A login rather than an id is the mistake worth catching: it would silently authorize
  // nobody, or worse, be read as a number by a laxer parser.
  for (const bad of ["octocat", "42,octocat", "4.2", "-1", "0x2a"]) {
    process.env.REVIEWER_GITHUB_IDS = bad;
    assert.throws(() => reviewerIds(), /numeric GitHub user ids|empty/, bad);
  }
});

test("a valid cookie stops authorizing once its reviewer leaves the allowlist", async () => {
  process.env.AUTH_SECRET = Buffer.alloc(32, "s").toString("base64");
  process.env.REVIEWER_GITHUB_IDS = "583231";

  const { newSession, seal } = await import("./session");
  const { authorizedSession } = await import("./reviewers");

  const cookie = seal(newSession("octocat", 583231));
  assert.equal(authorizedSession(cookie)?.userId, 583231);

  // Same cookie, still signed by us and nowhere near expiry. The allowlist is what changed.
  process.env.REVIEWER_GITHUB_IDS = "42";
  assert.equal(authorizedSession(cookie), null);

  assert.equal(authorizedSession(undefined), null);
  assert.equal(authorizedSession("not-a-cookie"), null);
});
