import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recheckActionsFor,
  recheckDialogCopy,
  recheckFailedAnswerError,
  recheckThrownError,
} from "./recheck-actions-view";
import type { RecheckSummary } from "./recheck-summary";

function summary(overrides: Partial<RecheckSummary> = {}): RecheckSummary {
  return {
    runId: "run-1",
    runNumber: 2,
    runStatus: "RUNNING",
    runReason: "REVIEWER_GUIDANCE",
    verdictRevision: 1,
    outcome: "REPRODUCED",
    probeCount: 0,
    eventCount: 0,
    artifactCount: 0,
    findings: [],
    lastEventAt: null,
    ...overrides,
  };
}

test("re-check action buttons follow the run reason and status", () => {
  assert.deepEqual(recheckActionsFor(summary({ runStatus: "ERROR" })), ["retry", "cancel"]);
  assert.deepEqual(recheckActionsFor(summary({ runStatus: "PENDING" })), ["cancel"]);
  assert.deepEqual(recheckActionsFor(summary({ runStatus: "RUNNING" })), []);
  assert.deepEqual(recheckActionsFor(summary({ runStatus: "DONE" })), []);
  assert.deepEqual(
    recheckActionsFor(summary({ runReason: "INITIAL", runStatus: "ERROR" })),
    [],
  );
});

test("dialog copy keeps the retry strings", () => {
  assert.deepEqual(recheckDialogCopy("retry"), {
    title: "Retry this re-check?",
    description: "This puts the failed re-check back in the queue. It does not approve anything.",
  });
});

test("dialog copy keeps the cancel strings", () => {
  assert.deepEqual(recheckDialogCopy("cancel"), {
    title: "Cancel this re-check?",
    description:
      "This stops waiting on the re-check and moves the report to Analysis only, where a reviewer decides. The earlier verdict stays superseded.",
  });
});

test("failed answers use their error or the generic fallback", () => {
  assert.equal(recheckFailedAnswerError({ error: "run refused" }), "run refused");
  assert.equal(recheckFailedAnswerError({ error: "" }), "");
  assert.equal(
    recheckFailedAnswerError({}),
    "The re-check could not be updated.",
  );
});

test("thrown errors use an Error message or the generic fallback", () => {
  assert.equal(recheckThrownError(new Error("network failed")), "network failed");
  assert.equal(recheckThrownError("network failed"), "The re-check could not be updated.");
  assert.equal(recheckThrownError(null), "The re-check could not be updated.");
});
