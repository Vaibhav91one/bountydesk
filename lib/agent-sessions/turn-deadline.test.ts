import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TURN_MAX_MS, isOpenTurnStatus, isTurnOverdue } from "./turn-deadline";

test("a turn is overdue at the deadline boundary", () => {
  const startedAt = new Date("2026-09-21T10:00:00Z");
  const now = new Date(startedAt.getTime() + DEFAULT_TURN_MAX_MS);

  assert.equal(isTurnOverdue(startedAt, new Date(now.getTime() - 1)), false);
  assert.equal(isTurnOverdue(startedAt, now), true);
});

test("a missing timestamp is not overdue", () => {
  assert.equal(isTurnOverdue(null, new Date("2026-09-21T10:30:00Z")), false);
  assert.equal(isTurnOverdue(undefined, new Date("2026-09-21T10:30:00Z")), false);
});

test("a terminal turn is not overdue", () => {
  const startedAt = new Date("2026-09-21T10:00:00Z");
  const now = new Date(startedAt.getTime() + DEFAULT_TURN_MAX_MS);

  assert.equal(isOpenTurnStatus("DONE_NO_ACTION"), false);
  assert.equal(
    isOpenTurnStatus("DONE_NO_ACTION") && isTurnOverdue(startedAt, now),
    false,
  );
});
