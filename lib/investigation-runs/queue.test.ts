import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

import { computeContentHash } from "@/lib/verdicts/hash";
import type { TrueForgeClient, TurnSnapshot } from "@/lib/trueforge/client";

/**
 * runRecheckOnce runs against a real Postgres (disposable schema) with a fake TrueForge
 * client and an injected provisioner: the claims, locks, and sandbox bookkeeping are the
 * database's and the module's, the only network is what the fakes replace. Daytona's
 * deleteSandbox is mocked the way poller.test.ts mocks it, so teardown is observable.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

let deleteSandboxCalls: string[] = [];
mock.module("@/lib/sandbox/daytona", {
  namedExports: {
    createSandbox: async () => {
      throw new Error("not used by runRecheckOnce tests");
    },
    getSandbox: async () => {
      throw new Error("not used by runRecheckOnce tests");
    },
    execute: async () => {
      throw new Error("not used by runRecheckOnce tests");
    },
    getSnapshot: async () => {
      throw new Error("not used by runRecheckOnce tests");
    },
    deleteSandbox: async (id: string) => {
      deleteSandboxCalls.push(id);
    },
  },
});

type DbModule = typeof import("@/lib/db");
type RecheckModule = typeof import("./recheck");
type QueueModule = typeof import("./queue");

let dbm: DbModule;
let recheck: RecheckModule;
let queue: QueueModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("recheckq");

  dbm = await import("@/lib/db");
  recheck = await import("./recheck");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

type RecordedTurn = { sessionId: string; turnId: string; input: string };

function fakeClient(overrides: Partial<TrueForgeClient> = {}): TrueForgeClient & { turns: RecordedTurn[]; deletedSessions: string[] } {
  const turns: RecordedTurn[] = [];
  const deletedSessions: string[] = [];
  seq += 1;
  const n = seq;
  const client = {
    createSession: async () => ({ sessionId: `recheck-session-${n}` }),
    deleteSession: async (id: string) => {
      deletedSessions.push(id);
    },
    createTurn: async (sessionId: string, input: Array<{ type: string; content: string }>) => {
      const turn = { sessionId, turnId: `recheck-turn-${n}`, input: input.map((m) => m.content).join("\n") };
      turns.push(turn);
      return { turnId: turn.turnId, snapshot: { status: "running" } as TurnSnapshot };
    },
    getTurn: async () => ({ status: "running" } as TurnSnapshot),
    getTurnInput: async () => [],
    listToolCalls: async () => ({ calls: [], cursor: null }),
    ...overrides,
  };
  return Object.assign(client as TrueForgeClient, { turns, deletedSessions });
}

/** Provisioner stub: no network, records the context it was handed. */
function stubProvisioner(
  outcomes: Array<{ sandboxId: string; appPort: number; sandboxIds: string[] } | Error>,
): import("./queue").RecheckProvisioner & { contexts: Array<Record<string, unknown>> } {
  const contexts: Array<Record<string, unknown>> = [];
  const fn = async (context: Parameters<import("./queue").RecheckProvisioner>[0]) => {
    contexts.push({ ...context });
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? null;
  };
  return Object.assign(fn, { contexts });
}

/** Seed a report whose re-check was requested: supersession recorded, report REPRODUCING. */
async function seedPendingRecheck(
  opts: { reportState?: string; withTarget?: boolean; withSnapshot?: boolean } = {},
) {
  seq += 1;
  const n = seq;

  const [target] = opts.withTarget
    ? await dbm.db
        .insert(dbm.targetProfile)
        .values({
          name: `target-${n}`,
          imageName: "ghcr.io/example/app",
          imageDigest: "sha256:" + "a".repeat(64),
          // Without a snapshot the run is refused before provisioning, so the refuse-branch
          // tests never touch the network; withSnapshot=true lets the happy path through.
          ...(opts.withSnapshot ? { snapshotId: `snapshot-${n}` } : {}),
          config: { port: 3000 },
        })
        .returning({ id: dbm.targetProfile.id })
    : [null];

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${9100 + n}`,
      title: `report ${n}`,
      body: "body",
      state: "AWAITING_APPROVAL",
      ...(target ? { targetProfileId: target.id } : {}),
    })
    .returning({ id: dbm.report.id });

  const payload = `payload ${n}`;
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "REPRODUCED",
      summary: "summary",
      payload,
      contentHash: computeContentHash(payload),
    })
    .returning({ id: dbm.verdict.id });

  const [s] = await dbm.db
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
      pendingApprovedContentHash: computeContentHash(payload),
    })
    .returning({ id: dbm.agentSession.id });

  const recheckResult = await recheck.requestRecheck(r.id, v.id, "check the auth flow again", "reviewer-1");
  assert.ok(recheckResult.ok, "seed recheck must succeed");

  if (opts.reportState) {
    await dbm.db
      .update(dbm.report)
      .set({ state: opts.reportState as (typeof dbm.report.state.enumValues)[number] })
      .where(dbm.eq(dbm.report.id, r.id));
  }

  return { reportId: r.id, verdictId: v.id, agentSessionId: s.id, runId: recheckResult.runId };
}

async function runRow(runId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.investigationRun)
    .where(dbm.eq(dbm.investigationRun.id, runId))
    .limit(1);
  return row;
}

test("a re-check run is claimed once and refuses a report that left REPRODUCING", async () => {
  const seed = await seedPendingRecheck({ reportState: "AWAITING_APPROVAL" });
  // Another report might exist; claimUntil must pick our run by created_at order, but the
  // refusal path is what is being asserted: state mismatch marks the run ERROR.
  const handled = await queue.runRecheckOnce("worker-test", { client: fakeClient() });
  assert.ok(handled, "one run must be claimed");
  const row = await runRow(seed.runId);
  assert.equal(row.status, "ERROR", "a report no longer REPRODUCING fails its re-check run");
  assert.ok(row.finishedAt, "an errored run is finished");
});

test("a re-check run without an active grant is refused, not provisioned", async () => {
  // A target profile exists on the report but no connected_repository grant rows, so
  // hasActiveRepositoryGrant must fail the run before any sandbox is booted.
  const seed = await seedPendingRecheck({ withTarget: true });
  const handled = await queue.runRecheckOnce("worker-test", { client: fakeClient() });
  assert.ok(handled);
  const row = await runRow(seed.runId);
  assert.equal(row.status, "ERROR");
});

test("claim is idempotent while a run is leased", async () => {
  await seedPendingRecheck({ reportState: "REPRODUCING" });
  // Claim twice in a row: the first marks RUNNING, the second claim must find nothing PENDING.
  const first = await queue.claimRecheckRun("owner-a");
  assert.ok(first, "first claim must succeed");
  const second = await queue.claimRecheckRun("owner-b");
  assert.equal(second, null, "a RUNNING run must not be claimable");
});

/** Read the agent_session row for a report. */
async function sessionRow(reportId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId))
    .limit(1);
  return row;
}

test("the happy path rotates the capability, persists the mesh, and deletes the old session", async () => {
  deleteSandboxCalls = [];
  const seed = await seedPendingRecheck({ withTarget: true, withSnapshot: true });
  const oldSession = await sessionRow(seed.reportId);
  const provisioner = stubProvisioner([
    { sandboxId: "sb-app", appPort: 3000, sandboxIds: ["sb-app", "sb-db"] },
  ]);
  const client = fakeClient();
  const handled = await queue.runRecheckOnce("worker-test", {
    client,
    provision: provisioner,
  });
  assert.ok(handled, "the run must be handled");

  const run = await runRow(seed.runId);
  assert.equal(run.status, "RUNNING");
  assert.ok(run.trueforgeSessionId, "the run row carries the new session");
  assert.equal(run.finishedAt, null, "a RUNNING run is not finished");

  const session = await sessionRow(seed.reportId);
  assert.notEqual(session.capabilityToken, oldSession.capabilityToken, "the capability rotates");
  assert.equal(session.turnStatus, "RUNNING");
  assert.deepEqual(session.sandboxIds, ["sb-app", "sb-db"], "every provisioned sandbox is persisted");
  assert.equal(session.sandboxId, "sb-app");
  assert.equal(session.appPort, 3000);
  assert.equal(session.pendingVerdictId, null, "the pending tuple is cleared");
  assert.ok(session.turnId, "the new turn is recorded");

  const turn = client.turns[0];
  assert.ok(turn, "a turn was created");
  assert.ok(turn.input.includes("check the auth flow again"), "the guidance reaches the turn");
  assert.ok(turn.input.includes("[UNTRUSTED_REVIEWER_GUIDANCE]"), "guidance is delimited as untrusted");
  assert.ok(turn.input.includes(session.capabilityToken), "the turn names the rotated capability");

  assert.ok(client.deletedSessions.includes(oldSession.sessionId as string), "the superseded session is deleted");
  assert.ok(!client.deletedSessions.includes(turn.sessionId), "the fresh session is kept");
  assert.deepEqual(deleteSandboxCalls, [], "a successful run keeps its sandboxes");
});

test("a failed turn tears down this attempt's sandboxes and session, then marks the run ERROR", async () => {
  deleteSandboxCalls = [];
  const seed = await seedPendingRecheck({ withTarget: true, withSnapshot: true });
  const oldSession = await sessionRow(seed.reportId);
  const provisioner = stubProvisioner([
    { sandboxId: "sb-x", appPort: 3000, sandboxIds: ["sb-x", "sb-y"] },
  ]);
  const client = fakeClient({
    createTurn: async () => {
      throw new Error("turn creation failed");
    },
  });
  const handled = await queue.runRecheckOnce("worker-test", {
    client,
    provision: provisioner,
  });
  assert.ok(handled, "the run must be handled, not thrown");

  const run = await runRow(seed.runId);
  assert.equal(run.status, "ERROR");
  assert.ok(run.finishedAt, "an errored run is finished");
  assert.deepEqual(deleteSandboxCalls.sort(), ["sb-x", "sb-y"], "every provisioned sandbox is torn down");
  assert.equal(client.deletedSessions.length, 1, "this attempt's new session is deleted");
  const session = await sessionRow(seed.reportId);
  assert.equal(session.sessionId, oldSession.sessionId, "the old agent_session row is untouched");
  assert.equal(session.turnStatus, "CANCELLED", "requestRecheck's cancelled row stands");
});

test("a stale worker that lost its lease cleans its own resources and mutates nothing", async () => {
  deleteSandboxCalls = [];
  const seed = await seedPendingRecheck({ withTarget: true, withSnapshot: true });
  const oldSession = await sessionRow(seed.reportId);
  const provisioner = stubProvisioner([
    { sandboxId: "sb-stale", appPort: 3000, sandboxIds: ["sb-stale"] },
  ]);

  // createTurn parks until the test releases it, mid-flight of the stale worker.
  let releaseTurn: () => void = () => undefined;
  const turnParked = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const client = fakeClient({
    createTurn: async () => {
      await turnParked;
      return { turnId: "stale-turn", snapshot: { status: "running" } as TurnSnapshot };
    },
  });

  const staleRun = queue.runRecheckOnce("worker-stale", { client, provision: provisioner });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Steal the lease while the stale worker is parked in createTurn: new owner, new fence.
  const [stolen] = await dbm.db
    .update(dbm.investigationRun)
    .set({
      leaseOwner: "worker-thief",
      leaseExpiresAt: new Date(Date.now() + 600_000),
      fence: dbm.sql`${dbm.investigationRun.fence} + 1`,
    })
    .where(dbm.eq(dbm.investigationRun.id, seed.runId))
    .returning({ fence: dbm.investigationRun.fence });
  assert.ok(stolen, "the lease was stolen");

  releaseTurn();
  await staleRun; // must not throw

  const run = await runRow(seed.runId);
  assert.equal(run.status, "RUNNING", "the stealer's claim stands; the stale worker did not overwrite it");
  assert.equal(run.leaseOwner, "worker-thief");

  const session = await sessionRow(seed.reportId);
  assert.equal(session.sessionId, oldSession.sessionId, "the stale worker never rewrote agent_session");

  assert.deepEqual(deleteSandboxCalls, ["sb-stale"], "the stale worker tore down only its own sandbox");
  assert.equal(client.deletedSessions.length, 1, "the stale worker deleted only its own new session");
  assert.ok(!client.deletedSessions.includes(oldSession.sessionId as string), "the superseded session is untouched by the stale worker");
});

test("target identity drift refuses the run before any provisioning", async () => {
  deleteSandboxCalls = [];
  const seed = await seedPendingRecheck({ withTarget: true, withSnapshot: true });
  // Rotate the image digest after the run was requested: the run's stored identity no longer
  // matches the live profile, so the worker must refuse rather than probe a different target.
  const [reportRow] = await dbm.db
    .select({ targetProfileId: dbm.report.targetProfileId })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, seed.reportId))
    .limit(1);
  await dbm.db
    .update(dbm.targetProfile)
    .set({ imageDigest: "sha256:" + "b".repeat(64) })
    .where(dbm.eq(dbm.targetProfile.id, reportRow.targetProfileId as string));

  const provisioner = stubProvisioner([]);
  const handled = await queue.runRecheckOnce("worker-test", {
    client: fakeClient(),
    provision: provisioner,
  });
  assert.ok(handled, "the run must be handled");
  const run = await runRow(seed.runId);
  assert.equal(run.status, "ERROR", "identity drift fails the run");
  assert.equal(provisioner.contexts.length, 0, "no sandbox is provisioned on drift");
  assert.deepEqual(deleteSandboxCalls, []);
});

test("guidance is the hash-matching message, not the newest one; a bad hash falls back", async () => {
  const seed = await seedPendingRecheck({ withTarget: true, withSnapshot: true });

  // A newer reviewer message in the same thread must not replace the recorded guidance.
  const [thread] = await dbm.db
    .select({ id: dbm.reviewerChatThread.id })
    .from(dbm.reviewerChatThread)
    .where(dbm.eq(dbm.reviewerChatThread.reportId, seed.reportId))
    .limit(1);
  assert.ok(thread, "the seed recheck created the thread");
  await dbm.db.insert(dbm.reviewerChatMessage).values({
    threadId: thread.id,
    clientRequestId: `newer-${seed.reportId}`,
    sender: "REVIEWER",
    body: "totally different newer guidance",
    bodyHash: computeContentHash("totally different newer guidance"),
  });

  const provisioner = stubProvisioner([
    { sandboxId: "sb-g", appPort: 3000, sandboxIds: ["sb-g"] },
  ]);
  const client = fakeClient();
  await queue.runRecheckOnce("worker-test", { client, provision: provisioner });
  let turn = client.turns[0];
  assert.ok(turn.input.includes("check the auth flow again"), "the hash-matching guidance is used");
  assert.ok(!turn.input.includes("totally different newer guidance"), "the newer message is ignored");

  // A corrupted run hash selects nothing: the neutral fallback prompt is used instead.
  const seed2 = await seedPendingRecheck({ withTarget: true, withSnapshot: true });
  await dbm.db
    .update(dbm.investigationRun)
    .set({ guidanceHash: "sha256:deadbeef" })
    .where(dbm.eq(dbm.investigationRun.id, seed2.runId));
  const provisioner2 = stubProvisioner([
    { sandboxId: "sb-g2", appPort: 3000, sandboxIds: ["sb-g2"] },
  ]);
  const client2 = fakeClient();
  await queue.runRecheckOnce("worker-test", { client: client2, provision: provisioner2 });
  turn = client2.turns[0];
  assert.ok(turn.input.includes("Investigate it from scratch"), "the fallback prompt is used");
  assert.ok(!turn.input.includes("check the auth flow again"), "the unmatchable guidance is not used");
});
