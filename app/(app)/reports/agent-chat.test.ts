import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVISORY_LABEL,
  canSubmitReviewerMessage,
  newlyObservedAgentIds,
  QUICK_PROMPTS,
  responseRequestId,
  reviewerMessagePayload,
  shouldFollowChat,
  type ChatMessage,
  type ChatRequest,
} from "./[id]/agent-chat";

test("the durable chat payload stays plain text and preserves its request ID", () => {
  const request: ChatRequest = {
    clientRequestId: "request-123",
    body: "<b>Check the response</b>\nsecond line",
  };

  assert.deepEqual(reviewerMessagePayload(request), request);
  assert.equal(reviewerMessagePayload(request).body, "<b>Check the response</b>\nsecond line");
  assert.equal(responseRequestId(request.clientRequestId), "request-123:agent");
});

test("the chat is advisory and cannot submit while a request is in flight", () => {
  assert.equal(ADVISORY_LABEL, "Agent Bounty is on this case");
  assert.deepEqual(QUICK_PROMPTS.map(({ label }) => label), [
    "Summarize issue",
    "Review steps",
    "Suggest remediation",
    "Verify a fix",
    "Improve report",
  ]);
  assert.equal(canSubmitReviewerMessage("Question", false, "ready"), true);
  assert.equal(canSubmitReviewerMessage("Question", true, "ready"), false);
  assert.equal(canSubmitReviewerMessage("Question", false, "loading"), false);
});

test("only agent rows observed after hydration are presentation reveals", () => {
  const history: ChatMessage[] = [
    { id: "old", clientRequestId: "old", sender: "AGENT", body: "old", createdAt: "" },
    { id: "reviewer", clientRequestId: "reviewer", sender: "REVIEWER", body: "question", createdAt: "" },
  ];
  const current: ChatMessage[] = [
    ...history,
    { id: "new", clientRequestId: "new", sender: "AGENT", body: "new", createdAt: "" },
  ];

  assert.deepEqual(newlyObservedAgentIds(history, new Set(["old"])), []);
  assert.deepEqual(newlyObservedAgentIds(current, new Set(["old"])), ["new"]);
  assert.deepEqual(newlyObservedAgentIds(current, new Set(["old", "new"])), []);
});

test("chat only follows updates for an active reviewer near the bottom or their own send", () => {
  assert.equal(shouldFollowChat(true, true), true);
  assert.equal(shouldFollowChat(true, false), false);
  assert.equal(shouldFollowChat(false, true), false);
  assert.equal(shouldFollowChat(true, false, true), true);
});

test("a retry can reuse the exact payload without changing the durable identity", () => {
  const request: ChatRequest = {
    clientRequestId: "retry-me",
    body: "Ask for missing evidence",
  };
  const retry = reviewerMessagePayload(request);

  assert.notEqual(retry, request);
  assert.deepEqual(retry, request);
  assert.equal(retry.clientRequestId, request.clientRequestId);
});
