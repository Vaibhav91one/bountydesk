import assert from "node:assert/strict";
import test from "node:test";

import { createHeartbeat } from "./health";

const START = 1_000_000;

function heartbeat(budgets?: Record<string, number>) {
  return createHeartbeat({
    names: ["jobs", "jobs-sweep"],
    startedAt: START,
    defaultBudgetMs: 90_000,
    budgets,
    failureBudgetMs: 180_000,
  });
}

test("a loop that has never finished an iteration goes stale on its own", () => {
  const beat = heartbeat();

  assert.deepEqual(beat.snapshot(START + 89_000).stale, []);

  const snapshot = beat.snapshot(START + 91_000);
  assert.equal(snapshot.ok, false);
  assert.deepEqual(snapshot.stale, ["jobs", "jobs-sweep"]);
  assert.equal(snapshot.ages.jobs, 91_000);
});

test("an idle loop is healthy: a claim that found nothing is still progress", () => {
  const beat = heartbeat();

  // What an idle queue does for five minutes: nothing to claim, back off, claim again.
  for (let at = START; at <= START + 300_000; at += 2_000) {
    beat.record("jobs", at);
    beat.record("jobs-sweep", at);
  }

  assert.equal(beat.snapshot(START + 300_000).ok, true);
});

test("only the wedged loop is named, not the ones still ticking", () => {
  const beat = heartbeat();
  beat.record("jobs-sweep", START + 100_000);

  const snapshot = beat.snapshot(START + 120_000);
  assert.equal(snapshot.ok, false);
  assert.deepEqual(snapshot.stale, ["jobs"]);
  assert.equal(snapshot.ages["jobs-sweep"], 20_000);
});

test("a queue with its own budget is held to it, not to the default", () => {
  // The jobs queue spends minutes inside a single claim while a sandbox boots, so restarting
  // the worker on the default budget would throw that work away part-built.
  const beat = heartbeat({ jobs: 300_000 });

  const snapshot = beat.snapshot(START + 200_000);
  assert.deepEqual(snapshot.stale, ["jobs-sweep"]);
  assert.equal(beat.snapshot(START + 301_000).stale.includes("jobs"), true);
});

test("a loop failing every iteration goes stale once it is past the failure budget", () => {
  // What an unreachable Postgres looks like from here: the loop is ticking on its error backoff,
  // so nothing about the gap between iterations is wrong, and no work is getting done.
  const beat = heartbeat();

  for (let at = START; at <= START + 200_000; at += 5_000) {
    beat.record("jobs", at, "failed");
    beat.record("jobs-sweep", at, "failed");
  }

  assert.equal(beat.snapshot(START + 179_000).ok, true);

  const snapshot = beat.snapshot(START + 200_000);
  assert.equal(snapshot.ok, false);
  assert.deepEqual(snapshot.stale, ["jobs", "jobs-sweep"]);
  assert.equal(snapshot.failingFor.jobs, 200_000);
  // The loop is ticking, so the check is not firing on silence.
  assert.equal(snapshot.ages.jobs, 0);
});

test("one iteration that succeeds ends the run of failures", () => {
  const beat = heartbeat();

  for (let at = START; at <= START + 170_000; at += 5_000) beat.record("jobs", at, "failed");
  beat.record("jobs", START + 175_000, "ok");
  for (let at = START + 180_000; at <= START + 340_000; at += 5_000) {
    beat.record("jobs", at, "failed");
  }

  // Counted from the recovery, not from the first failure: 160s of failing is inside the budget,
  // where 340s measured from the first one would be well past it.
  const snapshot = beat.snapshot(START + 340_000);
  assert.equal(snapshot.stale.includes("jobs"), false);
  assert.equal(snapshot.failingFor.jobs, 160_000);
});

test("a healthy loop reports no failure run at all", () => {
  const beat = heartbeat();
  beat.record("jobs", START + 1_000, "ok");
  beat.record("jobs-sweep", START + 1_000, "ok");

  assert.deepEqual(beat.snapshot(START + 2_000).failingFor, {});
});
