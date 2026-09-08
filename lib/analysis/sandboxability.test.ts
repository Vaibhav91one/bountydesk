import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { TrueForgeClient } from "@/lib/trueforge/client";
import type { SourceReader } from "@/lib/build-onboarding/classify";

// The read-only sandboxability review, exercised for real on a disposable schema: it mints a token,
// runs a turn, reads back the verdict the tool wrote, and clears the token. The turn is faked; the DB
// round-trip through the review tool is real.
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let sandboxability: typeof import("./sandboxability");
let review: typeof import("@/lib/mcp/review");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("sandboxability_review");
  dbm = await import("@/lib/db");
  sandboxability = await import("./sandboxability");
  review = await import("@/lib/mcp/review");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function onboardingRow(): Promise<string> {
  seq += 1;
  const [row] = await dbm.db
    .insert(dbm.targetOnboarding)
    .values({ repoId: 900_000 + seq, repoFullName: `acme/repo${seq}`, sourceRef: "https://x/r.git" })
    .returning({ id: dbm.targetOnboarding.id });
  return row.id;
}

const emptySource: SourceReader = { async readFile() { return null; } };

/** A fake turn that calls report_sandboxability with the row's current capability token, standing in
 *  for the review agent's one tool call. */
function fakeClientThatReports(verdict: string, reason: string): TrueForgeClient {
  return {
    async createSession() { return { sessionId: "s1" }; },
    async createTurn() {
      const [row] = await dbm.db
        .select({ token: dbm.targetOnboarding.agentCapabilityToken })
        .from(dbm.targetOnboarding)
        .where(dbm.isNotNull(dbm.targetOnboarding.agentCapabilityToken))
        .limit(1);
      await review.reportSandboxability(row!.token!, verdict, reason);
      return { turnId: "t1" };
    },
    async getTurn() { return { status: "done_no_action" }; },
    async deleteSession() {},
  } as unknown as TrueForgeClient;
}

test("a verdict written by the tool is returned to the caller and cleared", async () => {
  const id = await onboardingRow();
  const result = await sandboxability.runSandboxabilityReview(
    fakeClientThatReports("no", "three interdependent services"),
    { onboardingId: id, repoFullName: "acme/multi" },
    { source: emptySource },
  );
  assert.deepEqual(result, { verdict: "no", reason: "three interdependent services" });
  const [row] = await dbm.db
    .select({ token: dbm.targetOnboarding.agentCapabilityToken, rr: dbm.targetOnboarding.reviewResult })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.id, id));
  assert.equal(row.token, null, "the capability token is cleared");
  assert.deepEqual(row.rr, { verdict: "no", reason: "three interdependent services" }, "the verdict is kept as the durable record");
});

test("a review that cannot run is unsure, and clears its token", async () => {
  const id = await onboardingRow();
  const throwing = { async createSession() { throw new Error("agent not registered"); } } as unknown as TrueForgeClient;
  const result = await sandboxability.runSandboxabilityReview(
    throwing,
    { onboardingId: id, repoFullName: "acme/x" },
    { source: emptySource },
  );
  assert.equal(result.verdict, "unsure", "a failed review falls through to the build agent");
  const [row] = await dbm.db
    .select({ token: dbm.targetOnboarding.agentCapabilityToken })
    .from(dbm.targetOnboarding)
    .where(dbm.eq(dbm.targetOnboarding.id, id));
  assert.equal(row.token, null, "the token is cleared even when the review throws");
});

test("a turn that ends without a tool call is unsure", async () => {
  const id = await onboardingRow();
  const silent = {
    async createSession() { return { sessionId: "s" }; },
    async createTurn() { return { turnId: "t" }; },
    async getTurn() { return { status: "done_no_action" }; },
    async deleteSession() {},
  } as unknown as TrueForgeClient;
  const result = await sandboxability.runSandboxabilityReview(
    silent,
    { onboardingId: id, repoFullName: "acme/y" },
    { source: emptySource },
  );
  assert.equal(result.verdict, "unsure");
});
