import assert from "node:assert/strict";
import test from "node:test";

import {
  SNAPSHOT_ACTIVATION_POLL_MS,
  SNAPSHOT_ACTIVATION_TIMEOUT_MS,
  activationTimedOut,
  snapshotAction,
  snapshotProblem,
} from "./snapshot-state";

// Daytona parks an idle snapshot as inactive, so provisioning activates it on demand. These pin
// the pure half of that: which states boot now, which need the activate call, which wait, and
// which fail at once. No network, no database.
test("active boots now, inactive needs the activate call", () => {
  assert.equal(snapshotAction("active"), "ready");
  assert.equal(snapshotAction("inactive"), "activate");
});

test("transitional states wait for the snapshot to go active", () => {
  for (const state of ["pending", "pulling", "building", "snapshotting"]) {
    assert.equal(snapshotAction(state), "wait", state);
  }
});

test("terminal states fail at once instead of waiting out the bound", () => {
  for (const state of ["error", "build_failed", "removing"]) {
    assert.equal(snapshotAction(state), "fail", state);
  }
});

test("an unknown state fails closed rather than booting or waiting", () => {
  for (const state of ["", "ACTIVE", "ready", "archived"]) {
    assert.equal(snapshotAction(state), "fail", JSON.stringify(state));
  }
});

test("the activation bound is four minutes with a poll far inside it", () => {
  assert.equal(SNAPSHOT_ACTIVATION_TIMEOUT_MS, 4 * 60_000);
  assert.ok(SNAPSHOT_ACTIVATION_POLL_MS > 0, "the poll must advance");
  assert.ok(
    SNAPSHOT_ACTIVATION_POLL_MS < SNAPSHOT_ACTIVATION_TIMEOUT_MS,
    "many polls must fit inside one bound",
  );
});

test("activationTimedOut trips only once the bound is reached", () => {
  assert.equal(activationTimedOut(1_000, 1_000), false);
  assert.equal(activationTimedOut(1_000, 1_000 + SNAPSHOT_ACTIVATION_TIMEOUT_MS - 1), false);
  assert.equal(activationTimedOut(1_000, 1_000 + SNAPSHOT_ACTIVATION_TIMEOUT_MS), true);
  assert.equal(activationTimedOut(1_000, 1_000 + SNAPSHOT_ACTIVATION_TIMEOUT_MS + 1), true);
});

test("activationTimedOut honors an explicit bound", () => {
  assert.equal(activationTimedOut(0, 500, 1_000), false);
  assert.equal(activationTimedOut(0, 1_000, 1_000), true);
});

test("snapshotProblem names the state alone when there is no reason", () => {
  assert.equal(snapshotProblem("error", null), "error");
  assert.equal(snapshotProblem("error", undefined), "error");
  assert.equal(snapshotProblem("error", "   "), "error");
  assert.equal(snapshotProblem("error", 42 as unknown as string), "error");
});

test("snapshotProblem appends the provider reason when there is one", () => {
  assert.equal(snapshotProblem("build_failed", "disk full"), "build_failed: disk full");
  assert.equal(snapshotProblem("error", "  pulled apart  "), "error: pulled apart");
});

test("snapshotProblem caps a long provider reason", () => {
  const reason = "r".repeat(500);
  const problem = snapshotProblem("error", reason);
  assert.equal(problem, `error: ${"r".repeat(300)}`);
});
