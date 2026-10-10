import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * A read-only reviewer is turned away before anything is read or written. The DAL is mocked, as in
 * actions.test.ts, and the retest module is replaced so a call that got through would be visible.
 */
let retestCalls = 0;
mock.module("@/lib/auth/dal", {
  namedExports: {
    requireWriteAccess: async () => ({ ok: false, error: "This reviewer has read-only access." }),
    requireReviewer: async () => ({ login: "viewer", email: "v@bountydesk.test", avatarUrl: null, role: "read_only" }),
    currentSession: async () => null,
  },
});
mock.module("next/cache", { namedExports: { revalidatePath: () => undefined } });
mock.module("@/lib/retests/retest", {
  namedExports: {
    startRetest: async () => {
      retestCalls += 1;
      return { ok: true, childReportId: "x" };
    },
  },
});

test("a read-only reviewer cannot start a retest", async () => {
  const { requestRetestAction } = await import("./actions");
  const result = await requestRetestAction("00000000-0000-4000-8000-000000000000", "a".repeat(40));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /read-only/);
  assert.equal(retestCalls, 0);
});
