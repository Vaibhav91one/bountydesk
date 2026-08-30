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
type AgentQueueModule = typeof import("../agent-sessions/queue");
type DbModule = typeof import("@/lib/db");

let worker: WorkerModule;
let queue: QueueModule;
let agentQueue: AgentQueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("approval_submission_worker");

  dbm = await import("@/lib/db");
  worker = await import("./worker");
  queue = await import("./queue");
  agentQueue = await import("../agent-sessions/queue");
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
    badPayloadHash?: boolean;
    /** Point the submission's agent_session at a different report than the decision's verdict. */
    crossSession?: boolean;
  } = {},
) {
  const { computeContentHash } = await import("@/lib/verdicts/hash");
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

  const payload = `payload ${n}`;
  const contentHash = computeContentHash(payload);

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "summary",
      payload,
      contentHash,
    })
    .returning({ id: dbm.verdict.id });

  const [session] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}`,
      sessionId: `session-${n}`,
      turnId: `turn-${n}`,
      turnStatus: "AWAITING_APPROVAL_HARNESS",
      pendingThreadId: `thread-${n}`,
      pendingToolCallId: `call-${n}`,
      pendingVerdictId: v.id,
      pendingApprovedContentHash: contentHash,
    })
    .returning({ id: dbm.agentSession.id });

  let sessionId = session.id;
  if (opts.crossSession) {
    // A second, unrelated report/session; the submission below is deliberately wired to
    // this one instead of the session the verdict's own report actually owns.
    const [otherReport] = await dbm.db
      .insert(dbm.report)
      .values({
        channel: "github",
        sourceRef: `github:1:issue:${n}-other`,
        title: `other report ${n}`,
        body: "body",
      })
      .returning({ id: dbm.report.id });
    const [otherSession] = await dbm.db
      .insert(dbm.agentSession)
      .values({
        reportId: otherReport.id,
        capabilityToken: `cap-${n}-other`,
        sessionId: `session-${n}-other`,
        turnId: `turn-${n}-other`,
      })
      .returning({ id: dbm.agentSession.id });
    sessionId = otherSession.id;
  }

  const [decision] = await dbm.db
    .insert(dbm.approvalDecision)
    .values({
      verdictId: v.id,
      reviewer: "test-reviewer",
      decision: opts.decision ?? "APPROVED",
      payloadHash: opts.badPayloadHash ? `${contentHash}-stale` : contentHash,
      ...(opts.noPendingCall
        ? {}
        : { threadId: `thread-${n}`, toolCallId: `call-${n}` }),
      ...(opts.note ? { note: opts.note } : {}),
    })
    .returning({ id: dbm.approvalDecision.id });

  const [submission] = await dbm.db
    .insert(dbm.approvalSubmission)
    .values({
      agentSessionId: sessionId,
      approvalDecisionId: decision.id,
    })
    .returning({ id: dbm.approvalSubmission.id });

  return {
    agentSessionRowId: session.id,
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

function makeFakeClient(
  opts: {
    createTurn?: (sessionId: string, input: TurnInput[]) => Promise<{ turnId: string }>;
    findTurnByInput?: (
      sessionId: string,
      input: TurnInput[],
    ) => Promise<{ turnId: string } | null>;
  } = {},
) {
  const calls: { sessionId: string; input: TurnInput[] }[] = [];
  const client: TrueForgeClient = {
    createSession: async () => {
      throw new Error("not used by submitApprovalOnce");
    },
    deleteSession: async () => {
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
    ...(opts.findTurnByInput ? { findTurnByInput: opts.findTurnByInput } : {}),
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

test("a retry adopts an approval turn that TrueForge already accepted", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  const { client, calls } = makeFakeClient({
    findTurnByInput: async () => ({ turnId: "turn-from-ambiguous-first-attempt" }),
  });

  await worker.submitApprovalOnce("w-reconcile", { client });

  assert.equal(calls.length, 0, "reconciliation must happen before creating another turn");
  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "SUBMITTED");
  assert.equal(row.submittedTurnId, "turn-from-ambiguous-first-attempt");
});

test("the approval lease stays held while TrueForge is accepting the new turn", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { client } = makeFakeClient({
    createTurn: async () => {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return { turnId: "turn-after-heartbeats" };
    },
  });

  const submitting = worker.submitApprovalOnce("w-heartbeat", {
    client,
    leaseSeconds: 10,
  });
  const firstOutcome = await Promise.race([
    started.then(() => "started"),
    submitting.then((id) => `finished:${id}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 30_000)),
  ]);
  assert.equal(firstOutcome, "started", "the seeded submission must reach TrueForge");
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  const competingLease = await queue.claim("w-competing", 10);
  assert.equal(competingLease, null, "another worker must not reclaim an in-flight submission");
  assert.equal(await submitting, fixture.submissionId);
  assert.equal((await submissionRow(fixture.submissionId)).state, "SUBMITTED");
});

test("an approved submission follows the new turn and preserves the binding for publish_verdict", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  const { client } = makeFakeClient({ createTurn: async () => ({ turnId: "turn-handoff" }) });

  // Simulate the poller having already parked pending markers on the old turn, the state
  // the reviewer's decision was made against. All four pending_* columns must move together
  // (a DB check constraint enforces it), so this seeds a placeholder verdict id/hash rather
  // than leaving them null.
  const [seededVerdict] = await dbm.db
    .select({ id: dbm.verdict.id, contentHash: dbm.verdict.contentHash })
    .from(dbm.verdict)
    .innerJoin(dbm.agentSession, dbm.eq(dbm.agentSession.reportId, dbm.verdict.reportId))
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionRowId));
  await dbm.db
    .update(dbm.agentSession)
    .set({
      turnStatus: "AWAITING_APPROVAL_HARNESS",
      pendingThreadId: fixture.threadId,
      pendingToolCallId: fixture.toolCallId,
      pendingVerdictId: seededVerdict.id,
      pendingApprovedContentHash: seededVerdict.contentHash,
    })
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionRowId));

  await worker.submitApprovalOnce("w-handoff", { client });

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionRowId));

  // Without this, the poller would keep asking TrueForge about the old, already-answered
  // turn forever and never discover what happened to the new chained one.
  assert.equal(session.turnId, "turn-handoff", "agent_session must follow the new turn");
  assert.equal(session.turnStatus, "RUNNING");
  assert.equal(session.pendingThreadId, fixture.threadId);
  assert.equal(session.pendingToolCallId, fixture.toolCallId);
  assert.equal(session.pendingVerdictId, seededVerdict.id);
  assert.equal(session.pendingApprovedContentHash, seededVerdict.contentHash);
  assert.ok(session.nextPollAt.getTime() <= Date.now() + 1000, "must be pollable again soon");
});

test("turn handoff invalidates a poller lease that belongs to the old turn", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  const [leasedSession] = await dbm.db
    .update(dbm.agentSession)
    .set({
      leaseOwner: "stale-poller",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      fence: dbm.sql`${dbm.agentSession.fence} + 1`,
    })
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionRowId))
    .returning();
  const staleLease: import("../agent-sessions/queue").AgentSessionLease = {
    id: leasedSession.id,
    reportId: leasedSession.reportId,
    capabilityToken: leasedSession.capabilityToken,
    sessionId: leasedSession.sessionId,
    turnId: leasedSession.turnId,
    turnStatus: leasedSession.turnStatus,
    pendingThreadId: leasedSession.pendingThreadId,
    pendingToolCallId: leasedSession.pendingToolCallId,
    pendingVerdictId: leasedSession.pendingVerdictId,
    pendingApprovedContentHash: leasedSession.pendingApprovedContentHash,
    sandboxId: leasedSession.sandboxId,
    lastMirroredEventId: leasedSession.lastMirroredEventId,
    fence: leasedSession.fence,
    leaseOwner: "stale-poller",
  };
  const { client } = makeFakeClient({
    createTurn: async () => ({ turnId: "turn-after-handoff" }),
  });

  await worker.submitApprovalOnce("w-handoff-fence", { client });

  await assert.rejects(
    agentQueue.release(staleLease, { turnStatus: "DONE_NO_ACTION" }),
    agentQueue.LeaseLostError,
  );
  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionRowId));
  assert.equal(session.turnId, "turn-after-handoff");
  assert.equal(session.turnStatus, "RUNNING");
});

test("a decision bound to a session for a different report is refused before contacting TrueForge", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED", crossSession: true });
  const { client, calls } = makeFakeClient();

  await worker.submitApprovalOnce("w-cross-session", { client });

  assert.equal(calls.length, 0, "a mismatched decision/session pairing must never reach TrueForge");
  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /is for report .* belongs to report/);
});

test("an approved decision whose verdict content no longer matches the approved hash is refused", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED", badPayloadHash: true });
  const { client, calls } = makeFakeClient();

  await worker.submitApprovalOnce("w-stale-hash", { client });

  assert.equal(calls.length, 0, "a stale-hash approval must never reach TrueForge");
  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /content hash no longer matches/);
});

test("a decision that no longer matches the session's pending call is refused before contacting TrueForge", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  await dbm.db
    .update(dbm.agentSession)
    .set({ pendingToolCallId: "call-from-a-newer-turn" })
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionRowId));
  const { client, calls } = makeFakeClient();

  await worker.submitApprovalOnce("w-stale-call", { client });

  assert.equal(calls.length, 0, "a stale decision must never answer a newer pending call");
  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.attempts, 1, "a permanent binding failure must not burn retry attempts");
  assert.match(row.lastError ?? "", /does not match the session's pending approval/);
});

test("a submission with no pending call to answer never calls TrueForge", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ noPendingCall: true });
  const { client, calls } = makeFakeClient();

  await worker.submitApprovalOnce("w-no-pending", { client });

  assert.equal(calls.length, 0, "a malformed request must never reach TrueForge");

  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /threadId\/toolCallId missing/);
});

test("an expired tick signal does not claim a submission or burn an attempt", async () => {
  await drainOthers();
  const fixture = await seedSubmission({ decision: "APPROVED" });
  const { client, calls } = makeFakeClient();
  const controller = new AbortController();
  controller.abort(new Error("tick deadline exceeded"));

  const id = await worker.submitApprovalOnce("w-expired-tick", {
    client,
    signal: controller.signal,
  });

  assert.equal(id, null);
  assert.equal(calls.length, 0);
  const row = await submissionRow(fixture.submissionId);
  assert.equal(row.attempts, 0);
  assert.equal(row.state, "PENDING");
});
