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
