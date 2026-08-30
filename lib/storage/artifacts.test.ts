import assert from "node:assert/strict";
import test from "node:test";

/**
 * Storage is unconfigured in the test environment (the two env vars are commented out in
 * .env.local, and CI never sets them), which is the state this feature ships in. Every
 * operation must degrade to a no-op rather than throw, so the build, the tests and the rest of
 * the app keep working before the owner fills the keys in.
 */
test("storage degrades gracefully when it is not configured", async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const storage = await import("./artifacts");

  assert.equal(storage.isStorageConfigured(), false);
  assert.equal(await storage.uploadArtifact("a/b.md", Buffer.from("hi"), "text/markdown"), null);
  assert.equal(await storage.createSignedUrl("a/b.md"), null);
});
