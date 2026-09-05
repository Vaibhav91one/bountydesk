import assert from "node:assert/strict";
import test from "node:test";

import { searchQueue, type QueueCardView, type QueueColumnView } from "./queue-view";

function card(over: Partial<QueueCardView>): QueueCardView {
  return {
    id: "card",
    title: "SQL injection in product search",
    sourceLabel: "juice-shop#19",
    targetName: "juice-shop",
    state: "TRIAGING",
    outcome: null,
    deliveryState: null,
    awaitingVerdictId: null,
    handoffFailed: false,
    investigating: false,
    eventCount: 0,
    updatedAt: "2026-08-31T10:00:00.000Z",
    ...over,
  } as QueueCardView;
}

function board(cards: QueueCardView[]): QueueColumnView[] {
  return [
    { key: "triage", label: "Triage", states: ["TRIAGING"], total: 7, cards },
    { key: "approval", label: "Approval", states: ["AWAITING_APPROVAL"], total: 2, cards: [] },
  ] as QueueColumnView[];
}

test("a blank term leaves the columns exactly as they were", () => {
  const columns = board([card({ id: "a" })]);

  assert.equal(searchQueue(columns, ""), columns);
  assert.equal(searchQueue(columns, "   "), columns);
});

test("a term matches title, source and target, and ignores case", () => {
  const columns = board([
    card({ id: "title", title: "Juice Shop XSS in the search box", sourceLabel: "other#3", targetName: "storefront" }),
    card({ id: "source", title: "Something else", sourceLabel: "juice-shop#42" }),
    card({ id: "target", title: "Something else", sourceLabel: "other#1", targetName: "Juice-Shop" }),
    card({ id: "miss", title: "Something else", sourceLabel: "other#2", targetName: "storefront" }),
  ]);

  const [triage] = searchQueue(columns, "JUICE");
  assert.deepEqual(
    triage.cards.map((c) => c.id),
    ["title", "source", "target"],
  );
});

test("a card with no target bound is searchable on everything else", () => {
  const columns = board([card({ id: "a", sourceLabel: "upload#4", targetName: null })]);

  assert.equal(searchQueue(columns, "product")[0].cards.length, 1);
  assert.equal(searchQueue(columns, "upload")[0].cards.length, 1);
  // Nothing to match on, rather than a null that throws on toLowerCase.
  assert.equal(searchQueue(columns, "juice-shop")[0].cards.length, 0);
});

test("the column total becomes the number of matches, not the server's count", () => {
  // The board caps how many cards a column carries, so the search only ever sees those. Keeping
  // total at 7 would have the header claim matches it never looked at, and would leave the
  // column's own "3 of 7 shown" line contradicting the cards under it.
  const columns = board([card({ id: "a" }), card({ id: "b", title: "unrelated" })]);

  const [triage] = searchQueue(columns, "injection");
  assert.equal(triage.total, 1);
  assert.equal(triage.cards.length, 1);
});

test("a column the search misses is emptied rather than dropped", () => {
  // The board draws a column per phase whether or not it holds anything, so losing one to a
  // search would move the remaining columns sideways under the reviewer.
  const result = searchQueue(board([card({ id: "a" })]), "nothing matches this");

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((column) => column.total),
    [0, 0],
  );
});
