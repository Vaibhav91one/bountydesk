import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import type { TrueForgeClient } from "@/lib/trueforge/client";

/**
 * Runs against a real Postgres, same convention as stub-driver.test.ts: the idempotency
 * under test rests on the agent_session unique index and ensureInitialVerdict's own
 * idempotency, not on anything a mock could stand in for. TrueForge itself is faked: the
 * driver's whole testing seam is the injected client, so there is nothing to fake at the
 * HTTP layer.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type DriverModule = typeof import("./trueforge-driver");

let dbm: DbModule;
let driver: DriverModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("trueforge_driver");

  dbm = await import("@/lib/db");
  driver = await import("./trueforge-driver");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

async function seedReport(state: "TRIAGING" | "REPRODUCING" = "TRIAGING"): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `test:${randomUUID()}`,
      title: "SQL injection in search",
      body: "The search endpoint concatenates the query string directly.",
      reporterHandle: null,
      connectedRepositoryId: null,
      targetProfileId: null,
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

function context(reportId: string, signal: AbortSignal = new AbortController().signal) {
  return { reportId, lease: {} as never, signal };
}

/** A minimal fake: only the two methods the driver actually calls. */
function fakeClient(overrides: Partial<TrueForgeClient> = {}): TrueForgeClient & {
  createSessionCalls: number;
  createTurnCalls: number;
} {
  let createSessionCalls = 0;
  let createTurnCalls = 0;
  return {
    get createSessionCalls() {
      return createSessionCalls;
    },
    get createTurnCalls() {
      return createTurnCalls;
    },
    async createSession() {
      createSessionCalls++;
      return { sessionId: `truesession-${randomUUID()}` };
    },
    async createTurn() {
      createTurnCalls++;
      return {
        turnId: `trueturn-${randomUUID()}`,
        snapshot: { status: "running" },
      };
    },
    async getTurn() {
      throw new Error("not used by this driver");
    },
    async getTurnInput() {
      throw new Error("not used by this driver");
    },
    ...overrides,
  };
}

test("ensureSession on a fresh report creates one verdict and one agent session row", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();

  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId));

  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].outcome, "ANALYSIS_ONLY");
  const marker = `<!-- bountydesk-delivery:${verdicts[0].id} -->`;
  assert.equal(verdicts[0].payload.split(marker).length, 2, "marker must appear exactly once");
  const { computeContentHash } = await import("@/lib/verdicts/hash");
  assert.equal(verdicts[0].contentHash, computeContentHash(verdicts[0].payload));

  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].capabilityToken.length > 20, "capability token should be a long opaque string");
  assert.ok(sessions[0].sessionId.startsWith("truesession-"), "sessionId must come from the fake createSession call");
  assert.equal(sessions[0].turnId, null);
});

test("ensureSession is a no-op the second time", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();

  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId));
  const [first] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));

  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId));

  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].capabilityToken, first.capabilityToken);
  assert.equal(client.createSessionCalls, 1, "createSession must not be called again");
});

test("run starts a turn carrying the session's capability token", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));
  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));

  await d.run(context(reportId));

  assert.equal(client.createTurnCalls, 1);

  const [updated] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.ok(updated.turnId, "turnId must be set after run");
  assert.equal(updated.turnStatus, "RUNNING");
  assert.equal(updated.sessionId, session.sessionId);
});

test("run captures the real sessionId and embeds the capability token in the message", async () => {
  const reportId = await seedReport("TRIAGING");
  let capturedSessionId: string | undefined;
  let capturedInput: unknown;
  const client = fakeClient({
    async createTurn(sessionId, input) {
      capturedSessionId = sessionId;
      capturedInput = input;
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));
  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));

  await d.run(context(reportId));

  assert.equal(capturedSessionId, session.sessionId);
  const inputArray = capturedInput as { type: string; content: string }[];
  assert.equal(inputArray.length, 1);
  assert.equal(inputArray[0].type, "user.message");
  assert.ok(
    inputArray[0].content.includes(session.capabilityToken),
    "turn message must contain the exact capability token",
  );
});

test("run a second time does not start another turn", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));
  await d.run(context(reportId));
  const [afterFirst] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));

  await d.run(context(reportId));

  assert.equal(client.createTurnCalls, 1, "createTurn must not be called again");
  const [afterSecond] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.deepEqual(afterSecond, afterFirst);
});

test("ensureSession and run never change the report's lifecycle state", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();
  const d = driver.createTrueforgeAnalysisDriver(client);

  await d.ensureSession(context(reportId));
  let [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  assert.equal(reportRow.state, "TRIAGING", "ensureSession must not touch report state");

  await d.run(context(reportId));
  [reportRow] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  assert.equal(reportRow.state, "TRIAGING", "run must not touch report state");
});

test("ensureSession recovers a retry after an earlier attempt committed the verdict but crashed before the session row", async () => {
  const reportId = await seedReport("TRIAGING");

  // Simulate the exact partial-failure window the fix closes: a first attempt's verdict
  // committed (ensureInitialVerdict succeeded), but the process died before the agent_session
  // insert. No production code path produces this on its own without a real crash, so it's
  // seeded directly here.
  // The driver always passes the same fixed summary/evidence/marker shape on every call, so a
  // genuine retry never disagrees with itself on those fields, only the id and marker text
  // that used to be re-randomized. Seed the fixture with those exact same fixed values, not an
  // arbitrary placeholder, so this test simulates a real retry rather than two different
  // callers legitimately disagreeing (which ensureInitialVerdict is supposed to keep refusing).
  const { computeContentHash } = await import("@/lib/verdicts/hash");
  const priorVerdictId = randomUUID();
  const priorPayload = `Automated reproduction was not run for this report. What follows is an analysis-only read of the report as submitted, not a check of whether the issue actually reproduces. A person still needs to review this before any next step.\n\n<!-- bountydesk-delivery:${priorVerdictId} -->`;
  await dbm.db.insert(dbm.verdict).values({
    id: priorVerdictId,
    reportId,
    outcome: "ANALYSIS_ONLY",
    summary: "Analysis-only result: automated reproduction was not run.",
    evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    payload: priorPayload,
    contentHash: computeContentHash(priorPayload),
    revision: 1,
  });

  const client = fakeClient();
  // Must not throw VerdictIntegrityError: a naive retry that minted a fresh random id and a
  // different payload would disagree with the row above and fail permanently.
  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId));

  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 1, "the retry must not create a second verdict row");
  assert.equal(verdicts[0].id, priorVerdictId);
  assert.equal(verdicts[0].payload, priorPayload);

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.ok(session, "the retry must still create the agent_session row it failed to create before");
});

test("concurrent run() calls for the same report start exactly one turn", async () => {
  const reportId = await seedReport("TRIAGING");
  // A custom createTurn override replaces the fake's own counter entirely, so this test
  // tracks calls itself rather than reading client.createTurnCalls.
  let calls = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  const client = fakeClient({
    async createTurn() {
      calls++;
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // A real delay so two overlapping run() calls actually race inside the awaited call,
      // not just in the microtask queue before either reaches it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      inFlight--;
      return { turnId: `trueturn-${randomUUID()}`, snapshot: { status: "running" } };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));

  await Promise.all([d.run(context(reportId)), d.run(context(reportId))]);

  // The row lock serializes the two calls at the database level: the second one always finds
  // the first one's committed turnId and returns without ever reaching createTurn, so the two
  // calls never actually overlap inside it, whatever the scheduler's raw concurrency was.
  assert.equal(maxConcurrent, 1, "createTurn must never run for two callers at once");
  assert.equal(calls, 1, "only one turn may ever be created for one report");

  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].turnId);
});

test("an already-aborted signal makes ensureSession throw and touch nothing", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();
  const controller = new AbortController();
  const reason = new Error("lease lost");
  controller.abort(reason);

  await assert.rejects(
    () =>
      driver
        .createTrueforgeAnalysisDriver(client)
        .ensureSession(context(reportId, controller.signal)),
    (error: unknown) => error === reason,
  );

  assert.equal(client.createSessionCalls, 0);
  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 0);
  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 0);
});

test("an already-aborted signal makes run throw and touch nothing", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));
  const controller = new AbortController();
  const reason = new Error("lease lost");
  controller.abort(reason);

  await assert.rejects(
    () => d.run(context(reportId, controller.signal)),
    (error: unknown) => error === reason,
  );

  assert.equal(client.createTurnCalls, 0);
  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(session.turnId, null);
});
