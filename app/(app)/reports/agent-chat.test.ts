import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVISORY_LABEL,
  canSubmitReviewerMessage,
  chatStatusSignature,
  failedRequestFromStatus,
  isFreshAgentMessage,
  newlyObservedAgentIds,
  optimisticReviewerRows,
  QUICK_PROMPTS,
  responseRequestId,
  reviewerMessagePayload,
  shouldFollowChat,
  type ChatMessage,
  type ChatRequest,
  type ChatStatus,
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

test("only agent rows created after mount earn the streaming reveal", () => {
  const mountedAt = Date.parse("2026-09-15T12:00:00.000Z");
  assert.equal(isFreshAgentMessage("2026-09-15T12:00:05.000Z", mountedAt), true);
  assert.equal(isFreshAgentMessage("2026-09-15T11:00:00.000Z", mountedAt), false);
  assert.equal(isFreshAgentMessage("", mountedAt), false);
  assert.equal(isFreshAgentMessage("not-a-date", mountedAt), false);
  assert.equal(
    isFreshAgentMessage(new Date(mountedAt - 30_000).toISOString(), mountedAt),
    true,
    "30s grace covers server clock skew",
  );
  assert.equal(
    isFreshAgentMessage(new Date(mountedAt - 30_001).toISOString(), mountedAt),
    false,
  );
  assert.equal(isFreshAgentMessage(new Date(mountedAt + 5_000).toISOString(), mountedAt), true);
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

function statusWithThread(
  status: ChatStatus["threads"][number]["status"],
  message: ChatMessage,
): ChatStatus {
  return {
    reportId: "report-1",
    threads: [{ id: "thread-1", status, messages: [message] }],
  };
}

test("an ERROR thread yields a retryable failed request, a CANCELLED one does not", () => {
  const reviewerMessage: ChatMessage = {
    id: "m1",
    clientRequestId: "req-1",
    sender: "REVIEWER",
    body: "Any update?",
    createdAt: "",
  };

  const errored = failedRequestFromStatus(statusWithThread("ERROR", reviewerMessage));
  assert.equal(errored?.terminalStatus, "ERROR");

  const cancelled = failedRequestFromStatus(statusWithThread("CANCELLED", reviewerMessage));
  assert.equal(cancelled?.terminalStatus, "CANCELLED");

  const open = failedRequestFromStatus(statusWithThread("OPEN", reviewerMessage));
  assert.equal(open, null, "a thread still in flight has no failed request");
});

test("a failed request is only reported when the reviewer's own row has no reply", () => {
  const reviewerMessage: ChatMessage = {
    id: "m1",
    clientRequestId: "req-1",
    sender: "REVIEWER",
    body: "Any update?",
    createdAt: "",
  };
  const reply: ChatMessage = {
    id: "m2",
    clientRequestId: responseRequestId("req-1"),
    sender: "AGENT",
    body: "Here you go",
    createdAt: "",
  };
  const status: ChatStatus = {
    reportId: "report-1",
    threads: [{ id: "thread-1", status: "ERROR", messages: [reviewerMessage, reply] }],
  };

  assert.equal(failedRequestFromStatus(status), null);
});

test("the polling signature changes when thread status changes with unchanged ids", () => {
  const reviewerMessage: ChatMessage = {
    id: "m1",
    clientRequestId: "req-1",
    sender: "REVIEWER",
    body: "Any update?",
    createdAt: "",
  };

  const running = statusWithThread("RUNNING", reviewerMessage);
  const runningAgain = statusWithThread("RUNNING", reviewerMessage);
  const errored = statusWithThread("ERROR", reviewerMessage);
  const cancelled = statusWithThread("CANCELLED", reviewerMessage);

  assert.equal(chatStatusSignature(running), chatStatusSignature(runningAgain));
  assert.notEqual(chatStatusSignature(running), chatStatusSignature(errored));
  assert.notEqual(chatStatusSignature(running), chatStatusSignature(cancelled));
});

test("an in-flight message shows optimistically, then defers to the server row", () => {
  const sending: ChatRequest = { clientRequestId: "req-1", body: "Is this exploitable?" };

  // Before the server echoes it back, the optimistic reviewer bubble stands in.
  const optimistic = optimisticReviewerRows(sending, null, []);
  assert.equal(optimistic.length, 1);
  assert.equal(optimistic[0].sender, "REVIEWER");
  assert.equal(optimistic[0].clientRequestId, "req-1");
  assert.equal(optimistic[0].body, "Is this exploitable?");

  // Once the real row lands (same clientRequestId), the optimistic one drops out.
  const server: ChatMessage[] = [
    { id: "server-1", clientRequestId: "req-1", sender: "REVIEWER", body: "Is this exploitable?", createdAt: "2026-09-21T00:00:00Z" },
  ];
  assert.deepEqual(optimisticReviewerRows(sending, null, server), []);
});

test("a failed request keeps its bubble; nothing optimistic when idle", () => {
  const failed: ChatRequest = { clientRequestId: "req-2", body: "Summarize" };
  const rows = optimisticReviewerRows(null, failed, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clientRequestId, "req-2");
  assert.deepEqual(optimisticReviewerRows(null, null, []), []);
});

test("the composer stays locked until the reply lands, not just while sending", () => {
  // busy = sending || a reply still pending. Either keeps the send button disabled.
  assert.equal(canSubmitReviewerMessage("Question", true, "ready"), false);
  assert.equal(canSubmitReviewerMessage("Question", false, "ready"), true);
});
