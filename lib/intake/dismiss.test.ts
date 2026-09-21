import assert from "node:assert/strict";
import { test } from "node:test";

import { githubIssueSourceRef } from "./dismiss";

// The ref must match exactly what worker.ts's parse() writes as report.sourceRef, or the
// closed-issue handler dismisses nothing. This is the whole reason the format lives in one place.
test("the github issue source ref matches the intake format", () => {
  assert.equal(githubIssueSourceRef(123456, 26), "github:123456:issue:26");
});
