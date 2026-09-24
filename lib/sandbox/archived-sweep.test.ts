import assert from "node:assert/strict";
import test from "node:test";

import { selectArchivedForCleanup, type ListedSandbox } from "./archived-sweep";

const now = new Date("2026-09-24T00:00:00Z");
const old = "2026-09-01T00:00:00Z";
const recent = "2026-09-22T00:00:00Z";

const sandbox = (id: string, fields: Partial<ListedSandbox> = {}): ListedSandbox => ({
  id,
  state: "archived",
  labels: { "code-toolbox-language": "python" },
  createdAt: old,
  updatedAt: old,
  lastActivityAt: old,
  ...fields,
});

const ids = (list: ListedSandbox[], days = 7) => selectArchivedForCleanup(list, days, now).map((s) => s.id);

test("an old, archived, unlabelled sandbox is selected", () => {
  assert.deepEqual(ids([sandbox("a"), sandbox("b", { labels: null }), sandbox("c", { labels: {} })]), ["a", "b", "c"]);
});

test("a BountyDesk-labelled sandbox is never selected", () => {
  assert.deepEqual(
    ids([
      sandbox("repro", { labels: { "bountydesk.purpose": "reproduction" } }),
      sandbox("build", { labels: { "bountydesk.purpose": "build" } }),
      sandbox("other", { labels: { "bountydesk.report": "r1" } }),
    ]),
    [],
  );
});

test("a sandbox in any state but archived is never selected", () => {
  const states = ["started", "stopped", "archiving", "error", "build_failed", "destroyed", "unknown"];
  assert.deepEqual(ids(states.map((state) => sandbox(state, { state }))), []);
});

test("age is the latest timestamp, and a sandbox with none is kept", () => {
  assert.deepEqual(
    ids([
      sandbox("touched", { lastActivityAt: recent }),
      sandbox("archived-recently", { updatedAt: recent }),
      sandbox("no-times", { createdAt: null, updatedAt: undefined, lastActivityAt: "not a date" }),
      sandbox("created-only", { updatedAt: null, lastActivityAt: null }),
    ]),
    ["created-only"],
  );
});

test("the day threshold is respected", () => {
  const list = [sandbox("two-days", { createdAt: recent, updatedAt: recent, lastActivityAt: recent })];
  assert.deepEqual(ids(list, 7), []);
  assert.deepEqual(ids(list, 1), ["two-days"]);
  assert.throws(() => ids(list, -1));
  assert.throws(() => ids(list, Number.NaN));
});
