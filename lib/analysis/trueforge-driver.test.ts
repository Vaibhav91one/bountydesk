import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import type { TrueForgeClient } from "@/lib/trueforge/client";

/**
 * Runs against a real Postgres, same convention as stub-driver.test.ts: the idempotency
 * under test rests on the agent_session unique index, not on anything a mock could stand in
 * for. TrueForge itself is faked: the driver's whole testing seam is the injected client,
 * so there is nothing to fake at the HTTP layer.
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

async function seedReport(
  state: "TRIAGING" | "REPRODUCING" = "TRIAGING",
  targetProfileId: string | null = null,
  content: { title?: string; body?: string } = {},
  connectedRepositoryId: string | null = null,
): Promise<string> {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `test:${randomUUID()}`,
      title: content.title ?? "SQL injection in search",
      body: content.body ?? "The search endpoint concatenates the query string directly.",
      reporterHandle: null,
      connectedRepositoryId,
      targetProfileId,
      state,
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

async function seedTargetProfile(overrides: { name?: string } = {}): Promise<{
  id: string;
  name: string;
  imageName: string;
  imageDigest: string;
  snapshotId: string | null;
}> {
  const imageDigest = `sha256:${randomUUID().replace(/-/g, "")}`;
  const imageName = "ghcr.io/vaibhav91one/juice-shop";
  const name = overrides.name ?? `juice-shop-${randomUUID()}`;
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name,
      imageName,
      imageDigest,
      snapshotId: "snapshot-1",
      config: { baseUrl: "http://localhost:3000" },
      scopeRules: [],
    })
    .returning({ id: dbm.targetProfile.id });
  return { id: row.id, name, imageName, imageDigest, snapshotId: "snapshot-1" };
}

async function seedConnectedTargetProfile(opts: {
  active?: boolean;
  archived?: boolean;
  suspended?: boolean;
  deleted?: boolean;
} = {}): Promise<Awaited<ReturnType<typeof seedTargetProfile>> & { connectedRepositoryId: string }> {
  const target = await seedTargetProfile();
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: Number(`9${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
      accountLogin: `acct-${randomUUID()}`,
      accountId: Number(`8${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
      suspendedAt: opts.suspended ? new Date() : null,
      deletedAt: opts.deleted ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });
  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId: Number(`7${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
      fullName: `owner/repo-${randomUUID()}`,
      targetProfileId: target.id,
      active: opts.active ?? true,
      archivedAt: opts.archived ? new Date() : null,
    })
    .returning({ id: dbm.connectedRepository.id });
  return { ...target, connectedRepositoryId: repo.id };
}

function context(reportId: string, signal: AbortSignal = new AbortController().signal) {
  return { reportId, lease: {} as never, signal };
}

/** A minimal fake: only the methods the driver actually calls. */
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
    async deleteSession() {},
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

test("ensureSession on a fresh report creates only an agent session row, no verdict", async () => {
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient();

  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId));

  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 0, "ensureSession must not decide or persist any verdict");

  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].capabilityToken.length > 20, "capability token should be a long opaque string");
  assert.ok(sessions[0].sessionId.startsWith("truesession-"), "sessionId must come from the fake createSession call");
  assert.equal(sessions[0].turnId, null);
});

test("ensureSession on a report bound to a target still creates no verdict", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const client = fakeClient();

  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId));

  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 0, "a bound target no longer triggers any pre-decided verdict");
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
});

test("ensureSession cancels an in-flight TrueForge session request and does not persist it", async () => {
  const reportId = await seedReport("TRIAGING");
  const controller = new AbortController();
  const reason = new Error("tick deadline exceeded");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const client = fakeClient({
    async createSession(opts) {
      markStarted();
      assert.ok(opts?.signal, "the driver must pass its cancellation signal to TrueForge");
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    },
  });

  const pending = driver
    .createTrueforgeAnalysisDriver(client)
    .ensureSession(context(reportId, controller.signal));
  await started;
  controller.abort(reason);

  await assert.rejects(() => pending, (error: unknown) => error === reason);
  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 0);
});

test("ensureSession persists a session if cancellation arrives after TrueForge created it", async () => {
  const reportId = await seedReport("TRIAGING");
  const controller = new AbortController();
  const reason = new Error("lease lost after session creation");
  const client = fakeClient({
    async createSession() {
      controller.abort(reason);
      return { sessionId: "truesession-late-cancel" };
    },
  });

  await driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId, controller.signal));

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(session.sessionId, "truesession-late-cancel");
});

test("ensureSession deletes the remote session when local session persistence fails", async () => {
  const existingReportId = await seedReport("TRIAGING");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: existingReportId,
    capabilityToken: `cap-${randomUUID()}`,
    sessionId: "truesession-duplicate",
  });
  const reportId = await seedReport("TRIAGING");
  const deletedSessions: string[] = [];
  const client = fakeClient({
    async createSession() {
      return { sessionId: "truesession-duplicate" };
    },
    async deleteSession(sessionId) {
      deletedSessions.push(sessionId);
    },
  });

  await assert.rejects(
    () => driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId)),
    /Failed query: insert into "agent_session"/,
  );

  assert.deepEqual(deletedSessions, ["truesession-duplicate"]);
  const claimsAfterFailure = await dbm.db
    .select()
    .from(dbm.agentSessionClaim)
    .where(dbm.eq(dbm.agentSessionClaim.reportId, reportId));
  assert.equal(claimsAfterFailure.length, 0);
});

test("ensureSession keeps the claim when remote cleanup fails after local persistence failure", async () => {
  const existingReportId = await seedReport("TRIAGING");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: existingReportId,
    capabilityToken: `cap-${randomUUID()}`,
    sessionId: "truesession-cleanup-fails",
  });
  const reportId = await seedReport("TRIAGING");
  const client = fakeClient({
    async createSession() {
      return { sessionId: "truesession-cleanup-fails" };
    },
    async deleteSession() {
      throw new Error("trueforge delete failed");
    },
  });

  await assert.rejects(
    () => driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId)),
    /trueforge delete failed/,
  );

  const claimsAfterFailure = await dbm.db
    .select()
    .from(dbm.agentSessionClaim)
    .where(dbm.eq(dbm.agentSessionClaim.reportId, reportId));
  assert.equal(claimsAfterFailure.length, 1);
});

test("ensureSession fails before remote creation when cleanup support is unavailable", async () => {
  const existingReportId = await seedReport("TRIAGING");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: existingReportId,
    capabilityToken: `cap-${randomUUID()}`,
    sessionId: "truesession-no-cleanup",
  });
  const reportId = await seedReport("TRIAGING");
  let createSessionCalls = 0;
  const client = {
    ...fakeClient({
      async createSession() {
        createSessionCalls++;
        return { sessionId: "truesession-no-cleanup" };
      },
    }),
    deleteSession: undefined,
  } as unknown as TrueForgeClient;

  await assert.rejects(
    () => driver.createTrueforgeAnalysisDriver(client).ensureSession(context(reportId)),
    /without deleteSession support/,
  );

  assert.equal(createSessionCalls, 0);
  const claimsAfterFailure = await dbm.db
    .select()
    .from(dbm.agentSessionClaim)
    .where(dbm.eq(dbm.agentSessionClaim.reportId, reportId));
  assert.equal(claimsAfterFailure.length, 0);
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

test("run cancels an in-flight TrueForge turn request and does not persist its id", async () => {
  const reportId = await seedReport("TRIAGING");
  const controller = new AbortController();
  const reason = new Error("tick deadline exceeded");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const client = fakeClient({
    async createTurn(_sessionId, _input, opts) {
      markStarted();
      assert.ok(opts?.signal, "the driver must pass its cancellation signal to TrueForge");
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
      });
    },
  });
  const analysis = driver.createTrueforgeAnalysisDriver(client);
  await analysis.ensureSession(context(reportId));

  const pending = analysis.run(context(reportId, controller.signal));
  await started;
  controller.abort(reason);

  await assert.rejects(() => pending, (error: unknown) => error === reason);
  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(session.turnId, null);
});

test("run's turn message describes the report and carries no pre-decided outcome, when no target is bound", async () => {
  const reportId = await seedReport("TRIAGING", null, {
    title: "SQL injection in search",
    body: "The search endpoint concatenates the query string directly.",
  });
  let capturedInput: unknown;
  const client = fakeClient({
    async createTurn(_sessionId, input) {
      capturedInput = input;
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));

  await d.run(context(reportId));

  const inputArray = capturedInput as { type: string; content: string }[];
  const message = inputArray[0].content;
  assert.ok(message.includes("SQL injection in search"), "message must carry the report title");
  assert.ok(message.includes("concatenates the query string"), "message must carry the report body");
  assert.ok(
    message.includes("No authorized target is bound"),
    "message must say plainly that there is nothing to reproduce against",
  );
  assert.ok(
    message.includes("ANALYSIS_ONLY"),
    "message must instruct the agent to draft ANALYSIS_ONLY without a target",
  );
  // The message tells the agent not to claim REPRODUCED/NOT_REPRODUCED here, so those words
  // legitimately appear; what must never appear is the old pipeline's own pre-decided phrasing.
  for (const preDecided of ["already ran", "tripped the canary", "did not reproduce"]) {
    assert.ok(!message.includes(preDecided), `message must not carry a pre-decided "${preDecided}"`);
  }
});

test("run's turn message describes the bound target's name and pinned image, when a target is authorized", async () => {
  const target = await seedTargetProfile({ name: "juice-shop-demo" });
  const reportId = await seedReport("TRIAGING", target.id);
  let capturedInput: unknown;
  const client = fakeClient({
    async createTurn(_sessionId, input) {
      capturedInput = input;
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));

  await d.run(context(reportId));

  const inputArray = capturedInput as { type: string; content: string }[];
  const message = inputArray[0].content;
  assert.ok(message.includes("juice-shop-demo"), "message must name the bound target");
  assert.ok(message.includes(target.imageName), "message must carry the pinned image reference");
  assert.ok(message.includes(target.imageDigest), "message must carry the pinned digest");
  assert.ok(
    !message.includes("No authorized target is bound"),
    "an authorized target must not be described as unbound",
  );
});

test("run's turn message treats a revoked repository grant the same as no target at all", async () => {
  const target = await seedConnectedTargetProfile({ active: false });
  const reportId = await seedReport(
    "TRIAGING",
    target.id,
    {},
    target.connectedRepositoryId,
  );
  let capturedInput: unknown;
  const client = fakeClient({
    async createTurn(_sessionId, input) {
      capturedInput = input;
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(context(reportId));

  await d.run(context(reportId));

  const inputArray = capturedInput as { type: string; content: string }[];
  const message = inputArray[0].content;
  assert.ok(
    message.includes("No authorized target is bound"),
    "a revoked repository grant must read exactly like having no target bound",
  );
  assert.ok(!message.includes(target.name), "a revoked target's name must not be handed to the agent as authorized");
});

test("run() provisions the target before opening its row-locking transaction, and persists the result", async () => {
  const target = await seedTargetProfile({ name: "juice-shop-provision-order" });
  const reportId = await seedReport("TRIAGING", target.id);
  const order: string[] = [];

  const client = fakeClient({
    async createTurn() {
      order.push("createTurn");
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const fakeProvision: typeof import("@/lib/sandbox/provision").provisionTarget = async (_authorization, appPort) => {
    order.push("provision");
    return { sandboxId: "sandbox-from-provisioning", appPort };
  };

  const d = driver.createTrueforgeAnalysisDriver(client, fakeProvision);
  await d.ensureSession(context(reportId));
  await d.run(context(reportId));

  assert.deepEqual(order, ["provision", "createTurn"], "provisioning must run before the turn-creating transaction");

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(session.sandboxId, "sandbox-from-provisioning");
  assert.equal(session.appPort, 3000);
});

test("run() falls back to the no-target turn message when provisioning fails, and still creates a turn", async () => {
  const target = await seedTargetProfile({ name: "juice-shop-provision-failure" });
  const reportId = await seedReport("TRIAGING", target.id);
  let capturedInput: unknown;
  // A custom createTurn override replaces the fake's own createTurnCalls counter entirely (see
  // the concurrent-run() test above), so this test tracks the call itself.
  let createTurnCalls = 0;

  const client = fakeClient({
    async createTurn(_sessionId, input) {
      createTurnCalls++;
      capturedInput = input;
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const fakeProvision: typeof import("@/lib/sandbox/provision").provisionTarget = async () => {
    throw new Error("daytona is down");
  };

  const d = driver.createTrueforgeAnalysisDriver(client, fakeProvision);
  await d.ensureSession(context(reportId));
  await d.run(context(reportId));

  assert.equal(createTurnCalls, 1, "a provisioning failure must never block the turn from starting");

  const inputArray = capturedInput as { type: string; content: string }[];
  const message = inputArray[0].content;
  assert.ok(message.includes(target.name), "the target must still be named even though it could not be provisioned");
  assert.ok(
    message.includes("could not be provisioned"),
    "the agent must be told plainly that the sandbox isn't reachable this run",
  );
  assert.ok(
    message.includes("ANALYSIS_ONLY"),
    "the agent must be pointed at ANALYSIS_ONLY when there is nothing reachable",
  );

  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(session.sandboxId, null);
  assert.equal(session.appPort, null);
});

test("run() never calls provisioning a second time once a turn already exists", async () => {
  const target = await seedTargetProfile({ name: "juice-shop-provision-once" });
  const reportId = await seedReport("TRIAGING", target.id);
  let provisionCalls = 0;

  const client = fakeClient();
  const fakeProvision: typeof import("@/lib/sandbox/provision").provisionTarget = async (_authorization, appPort) => {
    provisionCalls++;
    return { sandboxId: "sandbox-once", appPort };
  };

  const d = driver.createTrueforgeAnalysisDriver(client, fakeProvision);
  await d.ensureSession(context(reportId));
  await d.run(context(reportId));
  await d.run(context(reportId));

  assert.equal(provisionCalls, 1, "a report whose turn already started must never be provisioned again");
});
