import assert from "node:assert/strict";
import test from "node:test";

import { previewArguments } from "@/lib/agent-sessions/preview-arguments";
import { safeErrorText } from "./safe-error";

test("removes bearer tokens from error messages", () => {
  assert.equal(safeErrorText(new Error("request failed Authorization: Bearer secret-token")), "request failed [REDACTED]");
});

test("drops a JSON error body", () => {
  assert.equal(safeErrorText(new Error("request failed\nBody: {\"token\":\"secret\"}")), "request failed");
});

test("bounds error text", () => {
  assert.equal(safeErrorText(new Error("x".repeat(20)), 7), "xxxxxxx");
});

test("handles non-Error input", () => {
  assert.equal(safeErrorText("plain failure"), "plain failure");
});

test("redacts preview values while retaining the allowlist", () => {
  const preview = previewArguments(JSON.stringify({
    url: "https://user:password@example.test/path?token=secret",
    host: "example.test?api_key=secret",
    target: { nestedToken: "secret" },
    capability: "do-not-copy",
  }));

  assert.equal(preview, '{"url":"https://example.test/path","host":"example.test","target":{"nestedToken":"[REDACTED]"}}');
  assert.doesNotMatch(preview ?? "", /password|secret|do-not-copy/);
});
