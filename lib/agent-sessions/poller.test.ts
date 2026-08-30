import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

import type { PendingToolCall, TrueForgeClient, TurnSnapshot } from "@/lib/trueforge/client";

/**
 * Real Postgres for the same reason as lib/delivery/worker.test.ts: the lease, the report
 * lifecycle transition, and the pending-columns check constraint are guarantees the database
 * enforces. Only the TrueForge boundary is faked.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

/**
 * Every terminal path this file exercises (finishWithoutApproval, refuseUnresolvablePending)
 * now tears down a session's sandbox, if it had one. Mocked here the same way
 * reproduce.test.ts fakes ./daytona: this file never provisions a real sandbox, so
 * lib/sandbox/provision.ts's teardownSandbox is the only thing under test, not Daytona itself.
 */
let deleteSandboxCalls: string[] = [];
mock.module("@/lib/sandbox/daytona", {
  namedExports: {
    createSandbox: async () => {
      throw new Error("not used by pollOnce");
    },
    getSandbox: async () => {
      throw new Error("not used by pollOnce");
    },
    execute: async () => {
      throw new Error("not used by pollOnce");
    },
    getSnapshot: async () => {
      throw new Error("not used by pollOnce");
    },
    deleteSandbox: async (id: string) => {
      deleteSandboxCalls.push(id);
    },
  },
});

type PollerModule = typeof import("./poller");
type QueueModule = typeof import("./queue");
type DbModule = typeof import("@/lib/db");

let poller: PollerModule;
let queue: QueueModule;
let dbm: DbModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("agent_sessions_poller");

  dbm = await import("@/lib/db");
  poller = await import("./poller");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedSession(
  opts: {
    reportState?:
      | "TRIAGING"
      | "REPRODUCING"
      | "ANALYSIS_ONLY"
      | "AWAITING_APPROVAL"
      | "CANCELLED";
    sandboxId?: string;
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
      state: opts.reportState ?? "TRIAGING",
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

  const [s] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}`,
      sessionId: `session-${n}`,
      turnId: `turn-${n}`,
      sandboxId: opts.sandboxId ?? null,
      appPort: opts.sandboxId ? 3000 : null,
    })
    .returning({ id: dbm.agentSession.id });

  return { reportId: r.id, verdictId: v.id, agentSessionId: s.id, capabilityToken: `cap-${n}` };
}

/** claim() is global; retire every other row first (see queue.test.ts). */
async function drainOthers() {
  await dbm.db
    .update(dbm.agentSession)
    .set({ turnStatus: "DONE_NO_ACTION", leaseOwner: null, leaseExpiresAt: null });
}

function fakeClient(snapshot: TurnSnapshot | (() => TurnSnapshot)): TrueForgeClient {
  return {
    createSession: async () => {
      throw new Error("not used by pollOnce");
    },
    deleteSession: async () => {
      throw new Error("not used by pollOnce");
    },
    createTurn: async () => {
      throw new Error("not used by pollOnce");
    },
    getTurn: async () => (typeof snapshot === "function" ? snapshot() : snapshot),
    getTurnInput: async () => {
      throw new Error("not used by pollOnce");
    },
  };
}

function publishVerdictCall(capability: string, overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    threadId: "thread-1",
    toolCallId: "call-1",
    toolName: "publish_verdict",
    toolInfoType: "mcp",
    argumentsJson: JSON.stringify({ capability }),
    ...overrides,
  };
}

function draftedPublishVerdictCall(
  capability: string,
  draft: { outcome?: string; summary?: string; findings?: unknown[] } = {},
  overrides: Partial<PendingToolCall> = {},
): PendingToolCall {
  return {
    threadId: "thread-1",
    toolCallId: "call-1",
    toolName: "publish_verdict",
    toolInfoType: "mcp",
    argumentsJson: JSON.stringify({
      capability,
      outcome: draft.outcome ?? "ANALYSIS_ONLY",
      summary: draft.summary ?? "drafted summary",
      findings: draft.findings ?? [],
    }),
    ...overrides,
  };
}

/** A session with no verdict pre-seeded, unlike seedSession above: the whole point of the
 * agent-drafted branch under test is that it mints that first verdict row itself. */
async function seedSessionWithoutVerdict(
  opts: { reportState?: "TRIAGING" | "REPRODUCING" } = {},
) {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:2:issue:${n}`,
      title: `report ${n}`,
      body: "body",
      state: opts.reportState ?? "TRIAGING",
    })
    .returning({ id: dbm.report.id });

  const [s] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `draft-cap-${n}`,
      sessionId: `draft-session-${n}`,
      turnId: `turn-${n}`,
    })
    .returning({ id: dbm.agentSession.id });

  return { reportId: r.id, agentSessionId: s.id, capabilityToken: `draft-cap-${n}` };
}

async function sessionRow(id: string) {
  const [row] = await dbm.db
    .select({
      turnStatus: dbm.agentSession.turnStatus,
      lastError: dbm.agentSession.lastError,
      pendingThreadId: dbm.agentSession.pendingThreadId,
      pendingToolCallId: dbm.agentSession.pendingToolCallId,
      pendingVerdictId: dbm.agentSession.pendingVerdictId,
      pendingApprovedContentHash: dbm.agentSession.pendingApprovedContentHash,
      leaseOwner: dbm.agentSession.leaseOwner,
      fence: dbm.agentSession.fence,
    })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.id, id));
  return row;
}

async function reportRow(id: string) {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, id));
  return row;
}

test("a running snapshot reschedules and never touches report state", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({ status: "running" });

  const id = await poller.pollOnce("w-running", { client });
  assert.equal(id, fixture.agentSessionId);

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "INVESTIGATING");
  assert.equal(row.leaseOwner, null);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "TRIAGING");
});

test("a valid single publish_verdict call moves the report and records the pending markers", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall(fixture.capabilityToken)],
  });

  const id = await poller.pollOnce("w-awaiting", { client });
  assert.equal(id, fixture.agentSessionId);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "AWAITING_APPROVAL");

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "AWAITING_APPROVAL_HARNESS");
  assert.equal(row.pendingThreadId, "thread-1");
  assert.equal(row.pendingToolCallId, "call-1");
  assert.equal(row.pendingVerdictId, fixture.verdictId);
  assert.equal(row.pendingApprovedContentHash, `hash-${seq}`);
  assert.equal(row.leaseOwner, null);
});

test("the pending call stays bound to the verdict prepared before the turn started", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const [newer] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: fixture.reportId,
      outcome: "ANALYSIS_ONLY",
      summary: "later draft",
      payload: "payload the model never saw",
      contentHash: "hash-the-model-never-saw",
      revision: 2,
    })
    .returning({ id: dbm.verdict.id });
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall(fixture.capabilityToken)],
  });

  await poller.pollOnce("w-prepared-verdict", { client });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.pendingVerdictId, fixture.verdictId);
  assert.notEqual(row.pendingVerdictId, newer.id);
});

test("a wrong tool name is refused loudly and never touches report state", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall(fixture.capabilityToken, { toolName: "delete_everything" })],
  });

  const id = await poller.pollOnce("w-wrong-tool", { client });
  assert.equal(id, fixture.agentSessionId);

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.match(row.lastError ?? "", /unsupported pending tool call/);
  assert.equal(row.pendingThreadId, null);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("a capability mismatch is refused loudly and never touches report state", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall("someone-elses-token")],
  });

  const id = await poller.pollOnce("w-wrong-capability", { client });
  assert.equal(id, fixture.agentSessionId);

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.match(row.lastError ?? "", /capability/);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("more than one pending call is refused loudly rather than guessed at", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [
      publishVerdictCall(fixture.capabilityToken),
      publishVerdictCall(fixture.capabilityToken, { toolCallId: "call-2" }),
    ],
  });

  const id = await poller.pollOnce("w-too-many", { client });
  assert.equal(id, fixture.agentSessionId);

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.match(row.lastError ?? "", /2 pending calls, expected 1/);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("a retried poll on a report already at AWAITING_APPROVAL is a safe no-op", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall(fixture.capabilityToken)],
  });

  await poller.pollOnce("w-first", { client });
  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "AWAITING_APPROVAL");

  // Force the row claimable again, as if a second tick picked up the same still-open turn.
  await dbm.db
    .update(dbm.agentSession)
    .set({ nextPollAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionId));

  await assert.doesNotReject(poller.pollOnce("w-second", { client }));

  const repAfter = await reportRow(fixture.reportId);
  assert.equal(repAfter.state, "AWAITING_APPROVAL");

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "AWAITING_APPROVAL_HARNESS");
  assert.equal(row.pendingVerdictId, fixture.verdictId);
});

test("a different pending call cannot replace the call already shown for approval", async () => {
  await drainOthers();
  const fixture = await seedSession();
  await poller.pollOnce("w-original-call", {
    client: fakeClient({
      status: "awaiting_approval",
      pending: [publishVerdictCall(fixture.capabilityToken)],
    }),
  });
  await dbm.db
    .update(dbm.agentSession)
    .set({ nextPollAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.agentSession.id, fixture.agentSessionId));

  await poller.pollOnce("w-new-call", {
    client: fakeClient({
      status: "awaiting_approval",
      pending: [
        publishVerdictCall(fixture.capabilityToken, {
          threadId: "thread-new",
          toolCallId: "call-new",
        }),
      ],
    }),
  });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.equal(row.pendingThreadId, "thread-1");
  assert.equal(row.pendingToolCallId, "call-1");
  assert.match(row.lastError ?? "", /does not match the pending call already recorded/);
});

test("a pending call cannot attach approval state to a terminal report", async () => {
  await drainOthers();
  const fixture = await seedSession({ reportState: "CANCELLED" });
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall(fixture.capabilityToken)],
  });

  await poller.pollOnce("w-terminal-report", { client });

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "CANCELLED");
  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.equal(row.pendingThreadId, null);
  assert.match(row.lastError ?? "", /report is CANCELLED/);
});

test("an error snapshot sets ERROR and moves unfinished analysis to ANALYSIS_ONLY", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({ status: "error", message: "the model blew up" });

  await poller.pollOnce("w-error", { client });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.equal(row.lastError, "the model blew up");
  assert.equal(row.pendingThreadId, null);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("an error snapshot tears down the session's provisioned sandbox", async () => {
  await drainOthers();
  deleteSandboxCalls = [];
  await seedSession({ sandboxId: "sandbox-error-path" });
  const client = fakeClient({ status: "error", message: "the model blew up" });

  await poller.pollOnce("w-error-sandbox", { client });

  assert.deepEqual(deleteSandboxCalls, ["sandbox-error-path"]);
});

test("a session with no provisioned sandbox never calls teardown", async () => {
  await drainOthers();
  deleteSandboxCalls = [];
  await seedSession();
  const client = fakeClient({ status: "done_no_action" });

  await poller.pollOnce("w-no-sandbox", { client });

  assert.deepEqual(deleteSandboxCalls, []);
});

test("a wrong tool name tears down the session's provisioned sandbox", async () => {
  await drainOthers();
  deleteSandboxCalls = [];
  const fixture = await seedSession({ sandboxId: "sandbox-refused-path" });
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [publishVerdictCall(fixture.capabilityToken, { toolName: "delete_everything" })],
  });

  await poller.pollOnce("w-wrong-tool-sandbox", { client });

  assert.deepEqual(deleteSandboxCalls, ["sandbox-refused-path"]);
});

test("a cancelled snapshot sets CANCELLED and moves unfinished analysis to ANALYSIS_ONLY", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({ status: "cancelled" });

  await poller.pollOnce("w-cancelled", { client });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "CANCELLED");
  assert.equal(row.pendingThreadId, null);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("a done_no_action snapshot is a real terminal outcome, not an error", async () => {
  await drainOthers();
  const fixture = await seedSession();
  const client = fakeClient({ status: "done_no_action" });

  await poller.pollOnce("w-done", { client });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "DONE_NO_ACTION");
  assert.equal(row.pendingThreadId, null);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("a fence lost between claim and release surfaces as LeaseLostError", async () => {
  await drainOthers();
  const fixture = await seedSession();

  const client: TrueForgeClient = fakeClient(() => {
    // Simulate a second worker reclaiming this row mid-poll: bump the fence out from under
    // the lease pollOnce is currently holding.
    return { status: "running" };
  });
  // Bump the fence directly, standing in for a competing claim that happened while getTurn
  // was in flight.
  const originalGetTurn = client.getTurn.bind(client);
  client.getTurn = async (sessionId, turnId) => {
    await dbm.db.execute(
      dbm.sql`update ${dbm.agentSession} set fence = fence + 1 where id = ${fixture.agentSessionId}`,
    );
    return originalGetTurn(sessionId, turnId);
  };

  await assert.rejects(poller.pollOnce("w-fence-loss", { client }), queue.LeaseLostError);
});

test("pollOnce rejects a lease that cannot reach its first heartbeat", async () => {
  await drainOthers();

  await assert.rejects(
    poller.pollOnce("w-too-short", { leaseSeconds: 0.05 }),
    /leaseSeconds must exceed the 50 ms heartbeat floor/,
  );
});

test("a pending call carrying a full agent-drafted payload mints the verdict and moves the report", async () => {
  await drainOthers();
  const fixture = await seedSessionWithoutVerdict();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [
      draftedPublishVerdictCall(fixture.capabilityToken, {
        outcome: "ANALYSIS_ONLY",
        summary: "the agent's own drafted conclusion",
        findings: [],
      }),
    ],
  });

  const id = await poller.pollOnce("w-drafted", { client });
  assert.equal(id, fixture.agentSessionId);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "AWAITING_APPROVAL");

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "AWAITING_APPROVAL_HARNESS");
  assert.ok(row.pendingVerdictId, "a verdict must have been minted for this report");

  const [verdictRow] = await dbm.db
    .select({ outcome: dbm.verdict.outcome, summary: dbm.verdict.summary })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, fixture.reportId));
  assert.equal(verdictRow.outcome, "ANALYSIS_ONLY");
  assert.equal(verdictRow.summary, "the agent's own drafted conclusion");
});

test("a full draft claiming REPRODUCED for a report with no bound target is refused, and no verdict is created", async () => {
  await drainOthers();
  const fixture = await seedSessionWithoutVerdict();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [
      draftedPublishVerdictCall(fixture.capabilityToken, {
        outcome: "REPRODUCED",
        summary: "the agent claims this reproduces",
      }),
    ],
  });

  await poller.pollOnce("w-drafted-unauthorized", { client });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.match(row.lastError ?? "", /publish_verdict draft refused/);

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, fixture.reportId));
  assert.equal(verdicts.length, 0);
});

test("a malformed draft attempt is refused rather than silently approved as the legacy shape", async () => {
  await drainOthers();
  // This session's pending verdict already exists (seedSession pre-seeds one), the same as a
  // real deterministic-pipeline report. A pending call that carries draft-specific keys but
  // fails validation must never fall through to the capability-only path and bind approval to
  // that pre-existing verdict instead of reporting the validation failure.
  const fixture = await seedSession();
  const client = fakeClient({
    status: "awaiting_approval",
    pending: [
      draftedPublishVerdictCall(fixture.capabilityToken, {
        outcome: "NOT_A_REAL_OUTCOME",
        summary: "",
        findings: [],
      }),
    ],
  });

  await poller.pollOnce("w-malformed-draft", { client });

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.turnStatus, "ERROR");
  assert.match(row.lastError ?? "", /publish_verdict arguments look like a drafted verdict but failed validation/);
  assert.equal(row.pendingVerdictId, null, "no approval may be bound to the pre-existing verdict");

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "ANALYSIS_ONLY");
});

test("pollOnce renews its lease while getTurn is slow, so an independent sweeper can't reclaim it mid-poll", async () => {
  await drainOthers();
  const fixture = await seedSession();

  // A leaseSeconds this short with a getTurn slower than the lease itself only completes
  // cleanly if the heartbeat is actually renewing in the background: without it, the lease
  // would expire partway through and the sweep below would reclaim the row before getTurn
  // ever resolves.
  const leaseSeconds = 1;
  const client: TrueForgeClient = {
    createSession: async () => {
      throw new Error("not used by pollOnce");
    },
    deleteSession: async () => {
      throw new Error("not used by pollOnce");
    },
    createTurn: async () => {
      throw new Error("not used by pollOnce");
    },
    getTurn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { status: "running" };
    },
    getTurnInput: async () => {
      throw new Error("not used by pollOnce");
    },
  };

  const pollPromise = poller.pollOnce("w-heartbeat", { client, leaseSeconds });

  // Past the original 1-second lease, but before getTurn resolves at 1200ms: only reachable
  // without reclaiming the row if a renewal already pushed the expiry further out.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const swept = await queue.sweepExpiredLeases();
  assert.equal(swept.released, 0, "the heartbeat should have kept this lease from expiring");

  const claimedId = await pollPromise;
  assert.equal(claimedId, fixture.agentSessionId);

  const row = await sessionRow(fixture.agentSessionId);
  assert.equal(row.leaseOwner, null);
  assert.equal(row.turnStatus, "INVESTIGATING");
});
