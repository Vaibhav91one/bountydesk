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
