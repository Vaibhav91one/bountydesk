import assert from "node:assert/strict";
import test from "node:test";

import {
  ADVISORY_LABEL,
  canSubmitReviewerMessage,
  responseRequestId,
  reviewerMessagePayload,
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
  assert.equal(ADVISORY_LABEL, "Advisory conversation, not approval");
  assert.equal(canSubmitReviewerMessage("Question", false, "ready"), true);
  assert.equal(canSubmitReviewerMessage("Question", true, "ready"), false);
  assert.equal(canSubmitReviewerMessage("Question", false, "loading"), false);
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
