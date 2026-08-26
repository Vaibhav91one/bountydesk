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
