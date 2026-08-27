import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { TrueForgeClient, TurnInput } from "@/lib/trueforge/client";

/**
 * Real Postgres for the lease and row mechanics; the TrueForge boundary stays fake so these
 * tests can force a createTurn failure deterministically (same split as
 * lib/delivery/worker.test.ts).
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type WorkerModule = typeof import("./worker");
type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let worker: WorkerModule;
let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("approval_submission_worker");

  dbm = await import("@/lib/db");
  worker = await import("./worker");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedSubmission(
  opts: {
    decision?: "APPROVED" | "DENIED";
    note?: string;
    noPendingCall?: boolean;
  } = {},
) {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${n}`,
      title: `report ${n}`,
      body: "body",
    })
    .returning({ id: dbm.report.id });

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "summary",
      payload: `payload ${n}`,
      contentHash: `hash-${n}`,
    })
    .returning({ id: dbm.verdict.id });

  const [session] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}`,
      sessionId: `session-${n}`,
      turnId: `turn-${n}`,
    })
    .returning({ id: dbm.agentSession.id });

  const [decision] = await dbm.db
    .insert(dbm.approvalDecision)
    .values({
      verdictId: v.id,
      reviewer: "test-reviewer",
      decision: opts.decision ?? "APPROVED",
      payloadHash: `hash-${n}`,
      ...(opts.noPendingCall
        ? {}
        : { threadId: `thread-${n}`, toolCallId: `call-${n}` }),
      ...(opts.note ? { note: opts.note } : {}),
    })
    .returning({ id: dbm.approvalDecision.id });

  const [submission] = await dbm.db
    .insert(dbm.approvalSubmission)
    .values({
      agentSessionId: session.id,
      approvalDecisionId: decision.id,
    })
    .returning({ id: dbm.approvalSubmission.id });

  return {
    sessionId: `session-${n}`,
    approvalDecisionId: decision.id,
    submissionId: submission.id,
    threadId: `thread-${n}`,
    toolCallId: `call-${n}`,
  };
}

/** claim() is global; retire every other row first (see queue.test.ts). */
async function drainOthers() {
  await dbm.db
    .update(dbm.approvalSubmission)
    .set({ state: "SUBMITTED", leaseOwner: null, leaseExpiresAt: null });
}

function makeFakeClient(opts: { createTurn?: (sessionId: string, input: TurnInput[]) => Promise<{ turnId: string }> } = {}) {
  const calls: { sessionId: string; input: TurnInput[] }[] = [];
  const client: TrueForgeClient = {
    createSession: async () => {
      throw new Error("not used by submitApprovalOnce");
    },
    createTurn: async (sessionId, input) => {
      calls.push({ sessionId, input });
      if (opts.createTurn) {
        const result = await opts.createTurn(sessionId, input);
        return { turnId: result.turnId, snapshot: { status: "running" } };
      }
      return { turnId: "turn-default", snapshot: { status: "running" } };
    },
    getTurn: async () => {
      throw new Error("not used by submitApprovalOnce");
    },
    getTurnInput: async () => {
      throw new Error("not used by submitApprovalOnce");
    },
  };
  return { client, calls };
}

async function submissionRow(id: string) {
  const [row] = await dbm.db
    .select({
      state: dbm.approvalSubmission.state,
      submittedTurnId: dbm.approvalSubmission.submittedTurnId,
      lastError: dbm.approvalSubmission.lastError,
      attempts: dbm.approvalSubmission.attempts,
    })
    .from(dbm.approvalSubmission)
    .where(dbm.eq(dbm.approvalSubmission.id, id));
  return row;
}

test("an APPROVED decision submits an allow tool_approval and lands SUBMITTED", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  const { client, calls } = makeFakeClient({
    createTurn: async () => ({ turnId: "turn-approved" }),
  });

  const id = await worker.submitApprovalOnce("w-approve", { client });
  assert.equal(id, fixture.submissionId);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, fixture.sessionId);
  assert.deepEqual(calls[0].input, [
    {
      type: "user.tool_approval",
      threadId: fixture.threadId,
      toolCallId: fixture.toolCallId,
      approval: { status: "allow" },
    },
  ]);

  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "SUBMITTED");
  assert.equal(row.submittedTurnId, "turn-approved");
});

test("a DENIED decision submits a deny tool_approval carrying the reviewer's note", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "DENIED", note: "not in scope" });
  const { client, calls } = makeFakeClient({
    createTurn: async () => ({ turnId: "turn-denied" }),
  });

  const id = await worker.submitApprovalOnce("w-deny", { client });
  assert.equal(id, fixture.submissionId);

  assert.deepEqual(calls[0].input, [
    {
      type: "user.tool_approval",
      threadId: fixture.threadId,
      toolCallId: fixture.toolCallId,
      approval: { status: "deny", reason: "not in scope" },
    },
  ]);

  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "SUBMITTED");
  assert.equal(row.submittedTurnId, "turn-denied");
});

test("a DENIED decision with no note omits the reason", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "DENIED" });
  const { client, calls } = makeFakeClient({
    createTurn: async () => ({ turnId: "turn-denied-no-note" }),
  });

  await worker.submitApprovalOnce("w-deny-no-note", { client });

  assert.deepEqual(calls[0].input, [
    {
      type: "user.tool_approval",
      threadId: fixture.threadId,
      toolCallId: fixture.toolCallId,
      approval: { status: "deny" },
    },
  ]);
});

test("a createTurn failure retries with backoff and eventually reaches FAILED", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  const { client } = makeFakeClient({
    createTurn: async () => {
      throw new Error("TrueForge unavailable");
    },
  });

  for (let attempt = 1; attempt < queue.MAX_ATTEMPTS; attempt++) {
    await dbm.db
      .update(dbm.approvalSubmission)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(dbm.eq(dbm.approvalSubmission.id, fixture.submissionId));

    await worker.submitApprovalOnce(`w-retry-${attempt}`, { client });

    const row = await submissionRow(fixture.submissionId);
    assert.equal(row.state, "PENDING", `attempt ${attempt} should remain retryable`);
    assert.match(row.lastError ?? "", /TrueForge unavailable/);
  }

  await dbm.db
    .update(dbm.approvalSubmission)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.approvalSubmission.id, fixture.submissionId));

  await worker.submitApprovalOnce("w-retry-final", { client });

  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.attempts, queue.MAX_ATTEMPTS);
});

test("a submission with no pending call to answer never calls TrueForge", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ noPendingCall: true });
  const { client, calls } = makeFakeClient();

  await worker.submitApprovalOnce("w-no-pending", { client });

  assert.equal(calls.length, 0, "a malformed request must never reach TrueForge");

  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "PENDING");
  assert.match(row.lastError ?? "", /threadId\/toolCallId missing/);
});
