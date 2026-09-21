import assert from "node:assert/strict";
import { test } from "node:test";

import { genericFailure, thrownActionError } from "./action-errors";

test("generic retry and cancel failures keep their existing messages", () => {
  assert.equal(genericFailure("retry"), "Could not retry the re-check.");
  assert.equal(genericFailure("cancel"), "Could not cancel the re-check.");
});

test("a thrown retry or cancel value maps to the matching failed result", () => {
  assert.deepEqual(thrownActionError(new Error("database failed"), "retry"), {
    ok: false,
    error: "Could not retry the re-check.",
  });
  assert.deepEqual(thrownActionError("database failed", "cancel"), {
    ok: false,
    error: "Could not cancel the re-check.",
  });
});
