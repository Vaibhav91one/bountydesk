import assert from "node:assert/strict";
import test from "node:test";

import { isReviewer, isReviewerEmail, reviewerEmails, reviewerIds } from "./reviewers";

test("the dashboard allowlist matches emails case-insensitively", () => {
  process.env.REVIEWER_EMAILS = " Reviewer@Bountydesk.test , second@bountydesk.test ";

  assert.deepEqual([...reviewerEmails()].sort(), [
    "reviewer@bountydesk.test",
    "second@bountydesk.test",
  ]);
  assert.equal(isReviewerEmail("reviewer@bountydesk.test"), true);
  assert.equal(isReviewerEmail("REVIEWER@bountydesk.test"), true);
  assert.equal(isReviewerEmail("stranger@example.com"), false);
  assert.equal(isReviewerEmail(null), false);
  assert.equal(isReviewerEmail(undefined), false);
  assert.equal(isReviewerEmail(""), false);
});

test("a missing or empty email allowlist fails closed", () => {
  delete process.env.REVIEWER_EMAILS;
  assert.throws(() => reviewerEmails(), /REVIEWER_EMAILS is not set/);

  for (const bad of ["", "   ", ",,,"]) {
    process.env.REVIEWER_EMAILS = bad;
    assert.throws(() => reviewerEmails(), /REVIEWER_EMAILS/, bad);
  }
});

test("the GitHub-webhook allowlist is a set of numeric ids", () => {
  process.env.REVIEWER_GITHUB_IDS = " 42 , 583231 ";

  assert.deepEqual([...reviewerIds()].sort((a, b) => a - b), [42, 583231]);
  assert.equal(isReviewer(42), true);
  assert.equal(isReviewer(43), false);
});

test("a missing, empty or malformed id allowlist fails closed", () => {
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
