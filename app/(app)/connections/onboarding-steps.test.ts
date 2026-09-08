import assert from "node:assert/strict";
import test from "node:test";

import { onboardingStepDone, onboardingView } from "./onboarding-steps";

test("a fresh repo with no onboarding row is all pending", () => {
  const view = onboardingView(null);
  assert.equal(view.terminal, null);
  assert.ok(view.steps.every((s) => s.state === "pending"));
});

test("an in-flight state marks earlier steps done, the cursor current, later pending", () => {
  const view = onboardingView("PENDING_MANIFEST");
  assert.equal(view.terminal, null);
  assert.deepEqual(
    view.steps.map((s) => s.state),
    ["done", "done", "current", "pending", "pending", "pending"],
  );
});

test("AWAITING_APPROVAL sits on the approval step, APPROVED on verify", () => {
  assert.equal(onboardingView("AWAITING_APPROVAL").steps[3].state, "current");
  assert.equal(onboardingView("APPROVED").steps[4].state, "current");
});

test("CONFIGURED is all done", () => {
  const view = onboardingView("CONFIGURED");
  assert.equal(view.terminal, "configured");
  assert.ok(view.steps.every((s) => s.state === "done"));
  assert.equal(onboardingStepDone("CONFIGURED", "verify"), true);
});

test("UNSUPPORTED and FAILED are terminal: plan done, the rest skipped", () => {
  for (const state of ["UNSUPPORTED", "FAILED"] as const) {
    const view = onboardingView(state);
    assert.equal(view.terminal, state === "UNSUPPORTED" ? "unsupported" : "failed");
    assert.equal(view.steps[0].state, "done");
    assert.ok(view.steps.slice(1).every((s) => s.state === "skipped"));
  }
  assert.equal(onboardingStepDone("UNSUPPORTED", "build"), false);
});
