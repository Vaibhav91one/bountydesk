import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import type {
  GetRecipesForTargetFn,
  ReproduceFn,
  ReproductionEvidence,
  ReproductionOutcome,
  ReproductionRecipe,
} from "@/lib/reproduction/types";
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

/** A bound target profile. imageDigest/snapshotId are what decideFreshVerdict must hand to
 * reproduceFn verbatim. */
async function seedTargetProfile(): Promise<{
  id: string;
  imageName: string;
  imageDigest: string;
  snapshotId: string | null;
}> {
  const imageDigest = `sha256:${randomUUID().replace(/-/g, "")}`;
  const imageName = "ghcr.io/vaibhav91one/juice-shop";
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `juice-shop-${randomUUID()}`,
      imageName,
      imageDigest,
      snapshotId: "snapshot-1",
      config: { baseUrl: "http://localhost:3000" },
      scopeRules: [],
    })
    .returning({ id: dbm.targetProfile.id });
  return { id: row.id, imageName, imageDigest, snapshotId: "snapshot-1" };
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

function fakeRecipe(overrides: Partial<ReproductionRecipe> = {}): ReproductionRecipe {
  return {
    id: "juice-shop-sqli-search",
    title: "SQL injection in the search endpoint",
    keywords: ["sql injection", "sqli", "search", "union select"],
    fixture: { request: { method: "POST", path: "/rest/canary", body: { value: "{{canary}}" } } },
    negativeControl: { method: "GET", path: "/rest/search?q=harmless" },
    exploit: { method: "GET", path: "/rest/search?q=%27%20OR%201%3D1--" },
    oracleCheck: () => false,
    ...overrides,
  };
}

/** getRecipes fake that always hands back one recipe, regardless of the target it's asked
 * about, so tests don't have to thread config shape through it. */
function fakeGetRecipes(recipe: ReproductionRecipe = fakeRecipe()): GetRecipesForTargetFn {
  return () => [recipe];
}

const noRecipes: GetRecipesForTargetFn = () => [];

/** reproduceFn fake that ignores its input and always resolves to the given outcome, while
 * counting calls so tests can assert it never runs twice for the same report. */
function fakeReproduce(outcome: ReproductionOutcome): ReproduceFn & { calls: number } {
  let calls = 0;
  const fn = async () => {
    calls++;
    return outcome;
  };
  return Object.defineProperty(fn, "calls", { get: () => calls }) as typeof fn & {
    calls: number;
  };
}

function reproducedEvidence(overrides: Partial<ReproductionEvidence> = {}): ReproductionEvidence {
  const evidence: ReproductionEvidence = {
    recipeId: "juice-shop-sqli-search",
    sandboxId: `sandbox-${randomUUID()}`,
    fixture: { ranToCompletion: true, at: new Date().toISOString() },
    negativeControl: { ranToCompletion: true, canaryFound: false, at: new Date().toISOString() },
    exploit: { ranToCompletion: true, canaryFound: true, at: new Date().toISOString() },
    canaryHash: "deadbeef".repeat(8),
    requestBodyHashes: {
      fixture: { dispatched: true, sha256: "cc".repeat(32) },
      negativeControl: { dispatched: true, sha256: null },
      exploit: { dispatched: true, sha256: null },
    },
  };
  return { ...evidence, ...overrides };
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

test("ensureSession keeps the verdict and claim when session creation fails", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  let reproduceCalls = 0;
  const evidence = reproducedEvidence();
  const reproduceFn: ReproduceFn = async () => {
    reproduceCalls++;
    return { outcome: "REPRODUCED", evidence };
  };
  let createSessionCalls = 0;
  const client = fakeClient({
    async createSession() {
      createSessionCalls++;
      throw new Error("trueforge unavailable");
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe));

  await assert.rejects(() => d.ensureSession(context(reportId)), /trueforge unavailable/);

  const verdictsAfterFailure = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdictsAfterFailure.length, 1, "the completed verdict must survive session failure");
  assert.equal(verdictsAfterFailure[0].outcome, "REPRODUCED");
  const sessionsAfterFailure = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessionsAfterFailure.length, 0);
  const claimsAfterFailure = await dbm.db
    .select()
    .from(dbm.agentSessionClaim)
    .where(dbm.eq(dbm.agentSessionClaim.reportId, reportId));
  assert.equal(reproduceCalls, 1);
  assert.equal(createSessionCalls, 1);
  assert.equal(claimsAfterFailure.length, 1, "an ambiguous remote failure must not be retried automatically");
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

test("ensureSession refuses to persist a verdict if reproduction returns after cancellation", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  const controller = new AbortController();
  const reason = new Error("lease lost");
  const reproduceFn: ReproduceFn = async (_input, opts) => {
    assert.equal(opts?.signal, controller.signal);
    controller.abort(reason);
    return { outcome: "ANALYSIS_ONLY", reason: "TARGET_UNAVAILABLE" };
  };
  const client = fakeClient();

  await assert.rejects(
    () =>
      driver
        .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
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

test("a bound target with no matching recipe behaves exactly like today's unconditional analysis-only path", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const client = fakeClient();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, noRecipes)
    .ensureSession(context(reportId));

  assert.equal(reproduceFn.calls, 0, "no recipe means reproduceFn must never be called");
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
  assert.deepEqual(v.evidence, { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" });
  assert.ok(v.payload.startsWith("Automated reproduction was not run for this report."));
});

test("a report unrelated to the recipe's own scenario never triggers reproduction", async () => {
  const target = await seedTargetProfile();
  // Neither "search" nor "sql" nor anything scenario-relevant: this report is about a
  // completely different vulnerability class than the one recipe this target has configured.
  const reportId = await seedReport("TRIAGING", target.id, {
    title: "Broken access control on invoice downloads",
    body: "Any authenticated user can view another customer's invoice PDF simply by incrementing the numeric id in the download URL. No crafted query strings or unexpected input are needed to trigger this.",
  });
  const client = fakeClient();
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(
    reproduceFn.calls,
    0,
    "an unrelated report must never trigger the one recipe this target happens to have",
  );
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
  assert.deepEqual(v.evidence, { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" });
});

test("a matching vulnerability class on the wrong endpoint never triggers reproduction", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id, {
    title: "SQL injection in login",
    body: "The login form accepts a crafted SQLi payload and returns an authenticated session.",
  });
  const client = fakeClient();
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(reproduceFn.calls, 0, "a class-only match must not run a different endpoint's recipe");
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
});

test("a matching endpoint with a different vulnerability class never triggers reproduction", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id, {
    title: "XSS in product search",
    body: "The search endpoint reflects a script tag in the page.",
  });
  const client = fakeClient();
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(reproduceFn.calls, 0, "an endpoint-only match must not run another vulnerability's recipe");
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
});

test("a NoSQL report on the same endpoint never triggers the SQL recipe", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id, {
    title: "NoSQL injection in product search",
    body: "The product search endpoint accepts a Mongo selector and returns hidden inventory records.",
  });
  const client = fakeClient();
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(reproduceFn.calls, 0, "NoSQL must not satisfy the SQL injection recipe keyword");
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
});

test("a report matching the recipe's keywords does trigger reproduction", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id, {
    title: "SQL injection via UNION SELECT in product search",
    body: "Sending a crafted UNION SELECT payload to the search box returns rows from other tables.",
  });
  const client = fakeClient();
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(reproduceFn.calls, 1, "a report matching the recipe's own keywords must run it");
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "REPRODUCED");
});

test("a stale connected repository grant prevents reproduction", async () => {
  const target = await seedConnectedTargetProfile({ active: false });
  const reportId = await seedReport(
    "TRIAGING",
    target.id,
    {
      title: "SQL injection via UNION SELECT in product search",
      body: "Sending a crafted UNION SELECT payload to the search endpoint returns other rows.",
    },
    target.connectedRepositoryId,
  );
  const client = fakeClient();
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(reproduceFn.calls, 0, "a revoked repository grant must stop reproduction");
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
});

test("repository revocation during reproduction prevents a definitive verdict", async () => {
  const target = await seedConnectedTargetProfile();
  const reportId = await seedReport(
    "TRIAGING",
    target.id,
    {
      title: "SQL injection via UNION SELECT in product search",
      body: "Sending a crafted UNION SELECT payload to the search endpoint returns other rows.",
    },
    target.connectedRepositoryId,
  );
  const client = fakeClient();
  const recipe = fakeRecipe();
  let calls = 0;
  const reproduceFn: ReproduceFn = async () => {
    calls++;
    await dbm.db
      .update(dbm.connectedRepository)
      .set({ active: false })
      .where(dbm.eq(dbm.connectedRepository.id, target.connectedRepositoryId));
    return { outcome: "REPRODUCED", evidence: reproducedEvidence() };
  };

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(calls, 1);
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
  assert.deepEqual(v.evidence, { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" });
});

test("target artifact rotation during reproduction prevents a definitive verdict", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id, {
    title: "SQL injection via UNION SELECT in product search",
    body: "Sending a crafted UNION SELECT payload to the search endpoint returns other rows.",
  });
  const client = fakeClient();
  const recipe = fakeRecipe();
  let calls = 0;
  const reproduceFn: ReproduceFn = async () => {
    calls++;
    await dbm.db
      .update(dbm.targetProfile)
      .set({
        imageDigest: `sha256:${"f".repeat(64)}`,
        snapshotId: "snapshot-2",
      })
      .where(dbm.eq(dbm.targetProfile.id, target.id));
    return { outcome: "REPRODUCED", evidence: reproducedEvidence() };
  };

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(calls, 1);
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
  assert.deepEqual(v.evidence, { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" });
});

test("a recipe that reproduces the report records a REPRODUCED verdict without the raw canary", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  const evidence = reproducedEvidence();
  let seenInput:
    | { imageName: string; imageDigest: string; snapshotId: string | null; recipe: ReproductionRecipe }
    | undefined;
  const reproduceFn: ReproduceFn = async (input) => {
    seenInput = input;
    return { outcome: "REPRODUCED", evidence };
  };
  const client = fakeClient();

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  assert.equal(seenInput?.imageName, target.imageName, "the target's own imageName must be threaded through");
  assert.equal(seenInput?.imageDigest, target.imageDigest, "the target's own imageDigest must be threaded through");
  assert.equal(seenInput?.snapshotId, target.snapshotId);
  assert.equal(seenInput?.recipe.id, recipe.id);

  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "REPRODUCED");
  assert.deepEqual(v.evidence, evidence);
  assert.ok(v.payload.includes(recipe.title), "payload must name the scenario");
  assert.ok(v.payload.includes("reproduces"), "payload must state the reproduced result");
  assert.equal(
    Object.prototype.hasOwnProperty.call(v.evidence as object, "canary"),
    false,
    "evidence must never carry a raw canary field, only its hash",
  );
  assert.ok(!v.payload.includes(evidence.canaryHash), "payload must not echo any canary material");
});

test("a recipe that does not reproduce the report records a NOT_REPRODUCED verdict", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  const evidence = reproducedEvidence({
    exploit: { ranToCompletion: true, canaryFound: false, at: new Date().toISOString() },
  });
  const reproduceFn = fakeReproduce({ outcome: "NOT_REPRODUCED", evidence });
  const client = fakeClient();

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "NOT_REPRODUCED");
  assert.deepEqual(v.evidence, evidence);
  assert.ok(v.payload.includes("does not reproduce"));
});

test("reproduceFn reporting an infra failure falls back to the analysis-only payload but keeps the reason", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "ANALYSIS_ONLY", reason: "COULD_NOT_DEPLOY" });
  const client = fakeClient();

  await driver
    .createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe))
    .ensureSession(context(reportId));

  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(v.outcome, "ANALYSIS_ONLY");
  assert.equal((v.evidence as { reason: string }).reason, "COULD_NOT_DEPLOY");
  assert.ok(
    v.payload.startsWith("Automated reproduction was not run for this report."),
    "an incomplete reproduction attempt still delivers the same honest analysis-only text",
  );
});

test("ensureSession called twice for the same report invokes reproduceFn exactly once", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });
  const client = fakeClient();
  const d = driver.createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe));

  await d.ensureSession(context(reportId));
  assert.equal(reproduceFn.calls, 1);

  // The second call must see the agent_session row already created by the first and return
  // immediately, never re-reading the verdict or re-running reproduction: this is exactly
  // the VerdictIntegrityError trap from AGENTS.md -- re-running would mint a fresh canary and
  // hash to evidence that disagrees with the row already committed.
  await d.ensureSession(context(reportId));
  assert.equal(reproduceFn.calls, 1, "a second ensureSession call must not run reproduction again");

  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 1, "still exactly one verdict row");
});

test("two concurrent first-time ensureSession calls for the same report converge on one persisted verdict", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  let calls = 0;
  const reproduceFn: ReproduceFn = async () => {
    calls++;
    // A real delay, so the two overlapping ensureSession calls actually race inside the
    // awaited reproduction call. The final short transaction must still converge on one
    // committed verdict.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { outcome: "REPRODUCED", evidence: reproducedEvidence() };
  };
  let createSessionCalls = 0;
  const client = fakeClient({
    async createSession() {
      createSessionCalls++;
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      return { sessionId: `truesession-${randomUUID()}` };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe));

  await Promise.all([d.ensureSession(context(reportId)), d.ensureSession(context(reportId))]);

  assert.ok(calls >= 1, "at least one caller must run reproduction for a matching report");
  assert.equal(createSessionCalls, 1, "only the worker holding the claim may create a TrueForge session");

  const verdicts = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  assert.equal(verdicts.length, 1, "the loser must converge on the winner's verdict, not fail");

  const sessions = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(sessions.length, 1);
});

test("run tells the model reproduction already ran and hands it the verdict summary, for a REPRODUCED report", async () => {
  const target = await seedTargetProfile();
  const reportId = await seedReport("TRIAGING", target.id);
  const recipe = fakeRecipe();
  const reproduceFn = fakeReproduce({ outcome: "REPRODUCED", evidence: reproducedEvidence() });
  let capturedInput: unknown;
  const client = fakeClient({
    async createTurn(_sessionId, input) {
      capturedInput = input;
      return { turnId: "trueturn-fixed", snapshot: { status: "running" } };
    },
  });
  const d = driver.createTrueforgeAnalysisDriver(client, reproduceFn, fakeGetRecipes(recipe));
  await d.ensureSession(context(reportId));
  const [session] = await dbm.db
    .select()
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  const [v] = await dbm.db
    .select()
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));

  await d.run(context(reportId));

  const inputArray = capturedInput as { type: string; content: string }[];
  assert.ok(inputArray[0].content.includes(session.capabilityToken));
  assert.ok(
    inputArray[0].content.includes(v.summary),
    "the turn message must carry the verdict's own summary text",
  );
  assert.ok(
    inputArray[0].content.includes("already ran"),
    "the turn message must tell the model reproduction already happened",
  );
  assert.ok(
    !inputArray[0].content.includes("there is no sandbox"),
    "the analysis-only disclaimer must not appear once a real reproduction ran",
  );
});
