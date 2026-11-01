import assert from "node:assert/strict";
import test from "node:test";

import { ProvisionCouldNotDeployError, SnapshotMissingError, ensureSnapshotActive } from "./provision";

// A reclaimed upload snapshot is a 404 from Daytona. It must surface as a named error the
// re-check worker can show a reviewer, while staying a ProvisionCouldNotDeployError for the
// other callers.
async function withStatus(status: number, run: () => Promise<void>) {
  process.env.DAYTONA_API_KEY ??= "test-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("x", { status })) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a 404 snapshot lookup becomes SnapshotMissingError", () =>
  withStatus(404, () =>
    assert.rejects(ensureSnapshotActive("snap-gone", "target t1"), (error) => {
      assert.ok(error instanceof SnapshotMissingError);
      assert.ok(error instanceof ProvisionCouldNotDeployError);
      assert.match((error as Error).message, /snap-gone.*no longer exists/);
      return true;
    }),
  ));

test("a non-404 failure is not reported as a missing snapshot", () =>
  withStatus(500, () =>
    assert.rejects(ensureSnapshotActive("snap-x", "target t1"), (error) => {
      assert.ok(!(error instanceof SnapshotMissingError));
      return true;
    }),
  ));
