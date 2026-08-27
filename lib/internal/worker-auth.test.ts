import assert from "node:assert/strict";
import test from "node:test";

process.env.WORKER_INTERNAL_SECRET = "a-secure-worker-secret-for-tests";

import { hasValidWorkerAuthorization } from "./worker-auth";

test("worker authorization accepts only the complete bearer secret", () => {
  assert.equal(
    hasValidWorkerAuthorization("Bearer a-secure-worker-secret-for-tests"),
    true,
  );
  assert.equal(
    hasValidWorkerAuthorization("Bearer a-secure-worker-secret-for-test"),
    false,
  );
  assert.equal(hasValidWorkerAuthorization("Bearer wrong"), false);
  assert.equal(hasValidWorkerAuthorization(null), false);
});
