import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, mock } from "node:test";

import type { PendingToolCall, TrueForgeClient, TurnSnapshot } from "@/lib/trueforge/client";

/**
 * The tier-3 static fallback end to end: the real driver starts the turn, the real poller reads the
 * agent's publish_verdict, and the real publish-verdict gate writes the verdict. Only TrueForge,
 * Daytona and GitHub are faked, since those are the network boundaries. Real Postgres because the
 * guarantees under test (the event written with the turn, the report lifecycle, the insert-only
 * verdict) are the database's.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

mock.module("@/lib/sandbox/daytona", {
  namedExports: {
    createSandbox: async () => {
      throw new Error("not used: provisioning is injected");
    },
    getSandbox: async () => {
      throw new Error("not used: provisioning is injected");
    },
    execute: async () => {
      throw new Error("not used: provisioning is injected");
    },
    getSnapshot: async () => {
      throw new Error("not used: provisioning is injected");
    },
    deleteSandbox: async () => undefined,
  },
});

let dbm: typeof import("@/lib/db");
let driver: typeof import("./trueforge-driver");
let poller: typeof import("@/lib/agent-sessions/poller");
let provisionModule: typeof import("@/lib/sandbox/provision");
let staticReview: typeof import("./static-review");

const realFetch = globalThis.fetch;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("static_fallback");
  dbm = await import("@/lib/db");
  driver = await import("./trueforge-driver");
  poller = await import("@/lib/agent-sessions/poller");
  provisionModule = await import("@/lib/sandbox/provision");
  staticReview = await import("./static-review");
});

after(async () => {
  globalThis.fetch = realFetch;
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

const COMMIT = "a".repeat(40);

/** GitHub as the static review sees it: one tree listing and raw file reads at the pinned commit. */
function fakeGitHub(repoFullName: string, files: Record<string, string>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    if (url === `https://api.github.com/repos/${repoFullName}/git/trees/${COMMIT}?recursive=1`) {
      const tree = Object.keys(files).map((path) => ({ path, type: "blob", size: files[path].length }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    const prefix = `https://raw.githubusercontent.com/${repoFullName}/${COMMIT}/`;
    if (url.startsWith(prefix)) {
      const body = files[url.slice(prefix.length)];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return requested;
}

async function seedRepo(onboarding: { state: string; analysisOnlyReason: string | null } | null) {
  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: Number(`9${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
      accountLogin: `acct-${randomUUID()}`,
      accountId: Number(`8${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
    })
    .returning({ id: dbm.githubInstallation.id });
  const repoId = Number(`7${randomUUID().replace(/\D/g, "").slice(0, 8)}`);
  const fullName = `owner/unbuildable-${randomUUID().slice(0, 8)}`;
  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({ installationId: installation.id, repoId, fullName })
    .returning({ id: dbm.connectedRepository.id });
  if (onboarding) {
    await dbm.db.insert(dbm.targetOnboarding).values({
      repoId,
      repoFullName: fullName,
      sourceRef: "main",
      resolvedCommitSha: COMMIT,
      state: onboarding.state,
      analysisOnlyReason: onboarding.analysisOnlyReason,
    });
  }
  return { connectedRepositoryId: repo.id, fullName };
}

async function seedUndeployableTarget() {
  const [row] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `undeployable-${randomUUID()}`,
      imageName: "ghcr.io/example/app",
      imageDigest: `sha256:${"b".repeat(64)}`,
      snapshotId: "snapshot-undeployable",
      resolvedCommitSha: COMMIT,
      config: {
        baseUrl: "http://localhost:3000",
        provisioning: { readinessPath: "/", expectedBuildMarker: "marker", startCommand: "start-app" },
      },
      scopeRules: [],
    })
    .returning({ id: dbm.targetProfile.id });
  return row.id;
}

async function seedReport(opts: { connectedRepositoryId?: string | null; targetProfileId?: string | null }) {
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `test:${randomUUID()}`,
      title: "SQL injection in the search route",
      body: "routes/search.js builds its query by concatenating the q parameter.",
      reporterHandle: null,
      connectedRepositoryId: opts.connectedRepositoryId ?? null,
      targetProfileId: opts.targetProfileId ?? null,
      state: "TRIAGING",
    })
    .returning({ id: dbm.report.id });
  return row.id;
}

function ctx(reportId: string) {
  return { reportId, lease: {} as never, signal: new AbortController().signal };
}

/** The driver side of TrueForge: records the turn message the agent would receive. */
function driverClient(): TrueForgeClient & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    async createSession() {
      return { sessionId: `session-${randomUUID()}` };
    },
    async deleteSession() {},
    async createTurn(_sessionId, input) {
      const first = input[0] as { content?: string };
      messages.push(first.content ?? "");
      return { turnId: `turn-${randomUUID()}`, snapshot: { status: "running" } };
    },
    async getTurn() {
      return { status: "running" };
    },
    async getTurnInput() {
      throw new Error("not used by the driver");
    },
    async listToolCalls() {
      return { calls: [], cursor: null };
    },
  };
}

/** The poller side of TrueForge: the turn ends in `snapshot`. */
function pollerClient(snapshot: TurnSnapshot): TrueForgeClient {
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
    getTurn: async () => snapshot,
    getTurnInput: async () => {
      throw new Error("not used by pollOnce");
    },
    listToolCalls: async () => ({ calls: [], cursor: null }),
  };
}

function publishCall(capability: string, outcome: string, findings: unknown[]): PendingToolCall {
  return {
    threadId: "thread-1",
    toolCallId: "call-1",
    toolName: "publish_verdict",
    toolInfoType: "mcp",
    argumentsJson: JSON.stringify({
      capability,
      outcome,
      summary: "Static review of the source; nothing was executed.",
      findings,
    }),
  };
}

const STATIC_FINDING = {
  title: "Search query is concatenated into SQL",
  severity: "high",
  description: "routes/search.js interpolates req.query.q into the SQL string without parameters.",
  evidenceRef: "routes/search.js",
};

async function capabilityOf(reportId: string): Promise<string> {
  const [row] = await dbm.db
    .select({ capabilityToken: dbm.agentSession.capabilityToken })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  return row.capabilityToken;
}

async function fallbackEvents(reportId: string) {
  return dbm.db
    .select({ data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(
      dbm.and(
        dbm.eq(dbm.sessionEvent.reportId, reportId),
        dbm.eq(dbm.sessionEvent.type, staticReview.STATIC_FALLBACK_EVENT),
      ),
    );
}

async function finalState(reportId: string) {
  const [rep] = await dbm.db.select({ state: dbm.report.state }).from(dbm.report).where(dbm.eq(dbm.report.id, reportId));
  const verdicts = await dbm.db
    .select({ outcome: dbm.verdict.outcome, evidence: dbm.verdict.evidence, payload: dbm.verdict.payload })
    .from(dbm.verdict)
    .where(dbm.eq(dbm.verdict.reportId, reportId));
  return { state: rep.state, verdicts };
}

/** pollOnce claims globally; finish every other session so the one under test is the one claimed. */
async function pollOnly(reportId: string, client: TrueForgeClient) {
  await dbm.db
    .update(dbm.agentSession)
    .set({ turnStatus: "DONE_NO_ACTION", leaseOwner: null, leaseExpiresAt: null })
    .where(dbm.sql`${dbm.agentSession.reportId} <> ${reportId}`);
  await poller.pollOnce(`w-${randomUUID()}`, { client });
}

test("a build failure ends in ANALYSIS_ONLY(COULD_NOT_BUILD) carrying the static findings", async () => {
  const repo = await seedRepo({ state: "FAILED", analysisOnlyReason: "COULD_NOT_BUILD" });
  const requested = fakeGitHub(repo.fullName, {
    "package.json": '{"name":"shop","dependencies":{"sqlite3":"5"}}',
    "routes/search.js": "db.all(`SELECT * FROM products WHERE name LIKE '%${req.query.q}%'`)",
    "lib/basket.js": "module.exports = basket",
  });
  const reportId = await seedReport({ connectedRepositoryId: repo.connectedRepositoryId });

  const client = driverClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));

  const message = client.messages[0];
  assert.match(message, /COULD_NOT_BUILD/);
  assert.match(message, /----- FILE: routes\/search\.js -----/, "the file the report names is in the corpus");
  assert.match(message, /----- FILE: package\.json -----/, "the manifest is in the corpus");
  assert.doesNotMatch(message, /FILE: lib\/basket\.js/, "an unrelated file is not");
  assert.ok(requested.every((url) => url.includes(COMMIT)), "source is read at the pinned commit, never HEAD");

  const events = await fallbackEvents(reportId);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { reason: "COULD_NOT_BUILD", ref: COMMIT, sourceFiles: ["package.json", "routes/search.js"] });

  const capability = await capabilityOf(reportId);
  await pollOnly(reportId, pollerClient({ status: "awaiting_approval", pending: [publishCall(capability, "ANALYSIS_ONLY", [STATIC_FINDING])] }));

  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "ANALYSIS_ONLY");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].outcome, "ANALYSIS_ONLY");
  const evidence = verdicts[0].evidence as { source: string; analysisOnlyReason: string; findings: unknown[] };
  assert.equal(evidence.source, "agent-drafted");
  assert.equal(evidence.analysisOnlyReason, "COULD_NOT_BUILD");
  assert.equal(evidence.findings.length, 1);
  assert.match(verdicts[0].payload, /Search query is concatenated into SQL/, "the static finding is the approved body");
});

test("an UNSUPPORTED repo takes the same static review", async () => {
  const repo = await seedRepo({ state: "UNSUPPORTED", analysisOnlyReason: "COULD_NOT_BUILD" });
  fakeGitHub(repo.fullName, { "routes/search.js": "query(q)" });
  const reportId = await seedReport({ connectedRepositoryId: repo.connectedRepositoryId });

  const client = driverClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));

  assert.match(client.messages[0], /COULD_NOT_BUILD/);
  assert.match(client.messages[0], /FILE: routes\/search\.js/);
  assert.equal((await fallbackEvents(reportId)).length, 1);
});

test("a deploy failure ends in ANALYSIS_ONLY(COULD_NOT_DEPLOY) carrying the static findings", async () => {
  const targetProfileId = await seedUndeployableTarget();
  const reportId = await seedReport({ targetProfileId });
  const provision: typeof import("@/lib/sandbox/provision").provisionTarget = async () => {
    throw new provisionModule.ProvisionCouldNotDeployError("sandbox booted the wrong build");
  };

  const client = driverClient();
  const d = driver.createTrueforgeAnalysisDriver(client, provision);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));

  // No connected repository, so nothing to read: the turn still runs as a static review of the
  // report text, and the reason is recorded all the same.
  assert.match(client.messages[0], /COULD_NOT_DEPLOY/);
  assert.match(client.messages[0], /from the report text alone/);
  const events = await fallbackEvents(reportId);
  assert.deepEqual(events[0].data, { reason: "COULD_NOT_DEPLOY", ref: null, sourceFiles: [] });

  const capability = await capabilityOf(reportId);
  await pollOnly(reportId, pollerClient({ status: "awaiting_approval", pending: [publishCall(capability, "ANALYSIS_ONLY", [STATIC_FINDING])] }));

  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "ANALYSIS_ONLY", "a deploy failure is no longer a terminal OUT_OF_SCOPE");
  assert.equal(verdicts[0].outcome, "ANALYSIS_ONLY");
  assert.equal((verdicts[0].evidence as { analysisOnlyReason: string }).analysisOnlyReason, "COULD_NOT_DEPLOY");
});

test("a static-review run cannot publish NOT_REPRODUCED even with a bound, granted target", async () => {
  const targetProfileId = await seedUndeployableTarget();
  const repo = await seedRepo(null);
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ targetProfileId })
    .where(dbm.eq(dbm.connectedRepository.id, repo.connectedRepositoryId));
  const reportId = await seedReport({ targetProfileId, connectedRepositoryId: repo.connectedRepositoryId });
  fakeGitHub(repo.fullName, { "routes/search.js": "query(q)" });
  const provision: typeof import("@/lib/sandbox/provision").provisionTarget = async () => {
    throw new provisionModule.ProvisionCouldNotDeployError("image will not start");
  };

  const d = driver.createTrueforgeAnalysisDriver(driverClient(), provision);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));

  const capability = await capabilityOf(reportId);
  await pollOnly(reportId, pollerClient({ status: "awaiting_approval", pending: [publishCall(capability, "NOT_REPRODUCED", [])] }));

  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "ANALYSIS_ONLY");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].outcome, "ANALYSIS_ONLY", "the refused claim becomes the server-authored ANALYSIS_ONLY");
  assert.equal((verdicts[0].evidence as { analysisOnlyReason: string }).analysisOnlyReason, "COULD_NOT_DEPLOY");
});

test("a static review that read source but drafts nothing still ends in ANALYSIS_ONLY with the reason recorded", async () => {
  const repo = await seedRepo({ state: "FAILED", analysisOnlyReason: "COULD_NOT_BUILD" });
  fakeGitHub(repo.fullName, { "routes/search.js": "query(q)" });
  const reportId = await seedReport({ connectedRepositoryId: repo.connectedRepositoryId });

  const d = driver.createTrueforgeAnalysisDriver(driverClient());
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));
  await pollOnly(reportId, pollerClient({ status: "error", message: "the static review turn failed" }));

  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "ANALYSIS_ONLY");
  assert.equal(verdicts.length, 1, "the report has a verdict a human can approve, not a dead job");
  const evidence = verdicts[0].evidence as { source: string; analysisOnlyReason: string };
  assert.equal(evidence.source, "server-synthesized");
  assert.equal(evidence.analysisOnlyReason, "COULD_NOT_BUILD");
});

async function outOfScopeEvents(reportId: string) {
  return dbm.db
    .select({ data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.and(dbm.eq(dbm.sessionEvent.reportId, reportId), dbm.eq(dbm.sessionEvent.type, "target.out_of_scope")));
}

test("a static review with no source that drafts nothing ends OUT_OF_SCOPE with the reason recorded", async () => {
  const repo = await seedRepo({ state: "UNSUPPORTED", analysisOnlyReason: "COULD_NOT_BUILD" });
  // GitHub unreachable: the review has no source, and its turn then errors.
  globalThis.fetch = (async () => new Response("", { status: 502 })) as typeof fetch;
  const reportId = await seedReport({ connectedRepositoryId: repo.connectedRepositoryId });

  const d = driver.createTrueforgeAnalysisDriver(driverClient());
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));
  await pollOnly(reportId, pollerClient({ status: "error", message: "the static review turn failed" }));

  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "OUT_OF_SCOPE", "a target that can be neither reproduced nor analyzed is out of scope");
  assert.equal(verdicts.length, 0, "no ANALYSIS_ONLY verdict is synthesized for it");
  const events = await outOfScopeEvents(reportId);
  assert.equal(events.length, 1);
  assert.equal((events[0].data as { reason: string }).reason, "COULD_NOT_BUILD");

  const [session] = await dbm.db
    .select({ turnStatus: dbm.agentSession.turnStatus, pendingVerdictId: dbm.agentSession.pendingVerdictId })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.reportId, reportId));
  assert.equal(session.turnStatus, "ERROR", "the session is finished, not left to be polled again");
  assert.equal(session.pendingVerdictId, null);
});

test("an undeployable target with no source that drafts nothing also ends OUT_OF_SCOPE", async () => {
  const targetProfileId = await seedUndeployableTarget();
  const reportId = await seedReport({ targetProfileId });
  const provision: typeof import("@/lib/sandbox/provision").provisionTarget = async () => {
    throw new provisionModule.ProvisionCouldNotDeployError("image will not start");
  };

  const d = driver.createTrueforgeAnalysisDriver(driverClient(), provision);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));
  await pollOnly(reportId, pollerClient({ status: "done_no_action" }));

  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "OUT_OF_SCOPE");
  assert.equal(verdicts.length, 0);
  assert.equal(((await outOfScopeEvents(reportId))[0].data as { reason: string }).reason, "COULD_NOT_DEPLOY");
});

test("a FAILED onboarding with no build reason, or a revoked grant, is not a static fallback", async () => {
  const classifyFailed = await seedRepo({ state: "FAILED", analysisOnlyReason: null });
  const revoked = await seedRepo({ state: "UNSUPPORTED", analysisOnlyReason: "COULD_NOT_BUILD" });
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ active: false })
    .where(dbm.eq(dbm.connectedRepository.id, revoked.connectedRepositoryId));
  globalThis.fetch = (async () => {
    throw new Error("no source may be read for these reports");
  }) as typeof fetch;

  for (const repo of [classifyFailed, revoked]) {
    const reportId = await seedReport({ connectedRepositoryId: repo.connectedRepositoryId });
    const client = driverClient();
    const d = driver.createTrueforgeAnalysisDriver(client);
    await d.ensureSession(ctx(reportId));
    await d.run(ctx(reportId));
    assert.doesNotMatch(client.messages[0], /COULD_NOT_BUILD/);
    assert.equal((await fallbackEvents(reportId)).length, 0);
  }
});

test("a private repository without Contents: read gets no static read and no sandbox (POLICY_REFUSED)", async () => {
  const unbuildable = await seedRepo({ state: "FAILED", analysisOnlyReason: "COULD_NOT_BUILD" });
  const bound = await seedRepo(null);
  const targetProfileId = await seedUndeployableTarget();
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ isPrivate: true })
    .where(dbm.inArray(dbm.connectedRepository.id, [unbuildable.connectedRepositoryId, bound.connectedRepositoryId]));
  await dbm.db
    .update(dbm.connectedRepository)
    .set({ targetProfileId })
    .where(dbm.eq(dbm.connectedRepository.id, bound.connectedRepositoryId));
  globalThis.fetch = (async () => {
    throw new Error("no source may be read from a refused private repository");
  }) as typeof fetch;
  const provision: typeof import("@/lib/sandbox/provision").provisionTarget = async () => {
    throw new Error("a refused private target must not be provisioned");
  };

  for (const [repo, profile] of [
    [unbuildable, null],
    [bound, targetProfileId],
  ] as const) {
    const reportId = await seedReport({ connectedRepositoryId: repo.connectedRepositoryId, targetProfileId: profile });
    const client = driverClient();
    const d = driver.createTrueforgeAnalysisDriver(client, provision);
    await d.ensureSession(ctx(reportId));
    await d.run(ctx(reportId));
    assert.doesNotMatch(client.messages[0], /COULD_NOT_BUILD|COULD_NOT_DEPLOY/);
    assert.equal((await fallbackEvents(reportId)).length, 0);
  }
});

/** One ustar file entry; the archive reader does not check header checksums. */
function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

/**
 * An upload released by a reviewer whose build then fails on every attempt, driven through the real
 * build loop (lib/upload/build.ts) with only the BuildDriver faked. Returns once the row is FAILED.
 */
async function failedUploadBuild(material: { kind: "archive"; archive: Buffer } | { kind: "image" }) {
  const { gzipSync, createHash } = { ...(await import("node:zlib")), ...(await import("node:crypto")) };
  const gate = await import("@/lib/upload/gate");
  const build = await import("@/lib/upload/build");
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "upload",
      sourceRef: `upload:${randomUUID()}`,
      title: "SQL injection in the search route",
      body: "routes/search.js builds its query by concatenating the q parameter.",
      reporterHandle: null,
      state: "TRIAGING",
    })
    .returning({ id: dbm.report.id });
  const archive = material.kind === "archive" ? gzipSync(material.archive) : null;
  await dbm.db.insert(dbm.uploadIntake).values({
    reportId: row.id,
    senderKey: "someone@outside.test",
    senderDomain: "outside.test",
    materialKind: material.kind,
    archive,
    sourceArchiveDigest: archive ? `sha256:${createHash("sha256").update(archive).digest("hex")}` : null,
    imageRef: material.kind === "image" ? "nginx:1.27" : null,
    imageDigest: material.kind === "image" ? `sha256:${"c".repeat(64)}` : null,
    reviewedTarget: gate.reviewedUploadTarget(row.id, { port: 8080, readinessPath: "/health" }),
    approvedBy: "reviewer",
    buildState: "PENDING",
  });
  const failing = {
    async build(): Promise<never> {
      throw new Error("docker build exited 1");
    },
  };
  await build.buildUploadOnce({ driver: failing });
  await build.buildUploadOnce({ driver: failing });
  const [upload] = await dbm.db
    .select({ buildState: dbm.uploadIntake.buildState, digest: dbm.uploadIntake.sourceArchiveDigest })
    .from(dbm.uploadIntake)
    .where(dbm.eq(dbm.uploadIntake.reportId, row.id));
  assert.equal(upload.buildState, "FAILED", "the build gave up after its attempt cap");
  return { reportId: row.id, digest: upload.digest };
}

test("a failed upload build gets a static review of the stored archive and ends ANALYSIS_ONLY(COULD_NOT_BUILD)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("an upload review reads its archive, never GitHub");
  }) as typeof fetch;
  const { reportId, digest } = await failedUploadBuild({
    kind: "archive",
    archive: Buffer.concat([
      tarEntry("shop/package.json", '{"name":"shop"}'),
      tarEntry("shop/routes/search.js", "db.all(`SELECT * FROM products WHERE name LIKE '%${q}%'`)"),
      tarEntry("shop/lib/basket.js", "module.exports = basket"),
      Buffer.alloc(1024),
    ]),
  });

  const client = driverClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));

  const message = client.messages[0];
  assert.match(message, /COULD_NOT_BUILD/);
  assert.match(message, /static review of the uploaded archive/);
  assert.match(message, /----- FILE: routes\/search\.js -----/, "the file the report names is read from the archive");
  assert.match(message, /----- FILE: package\.json -----/);
  assert.doesNotMatch(message, /FILE: lib\/basket\.js/);
  const events = await fallbackEvents(reportId);
  assert.deepEqual(events[0].data, { reason: "COULD_NOT_BUILD", ref: digest, sourceFiles: ["package.json", "routes/search.js"] });

  // The run is held to ANALYSIS_ONLY: a REPRODUCED claim becomes the server-authored ANALYSIS_ONLY.
  const capability = await capabilityOf(reportId);
  await pollOnly(reportId, pollerClient({ status: "awaiting_approval", pending: [publishCall(capability, "REPRODUCED", [STATIC_FINDING])] }));
  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "ANALYSIS_ONLY");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].outcome, "ANALYSIS_ONLY");
  assert.equal((verdicts[0].evidence as { analysisOnlyReason: string }).analysisOnlyReason, "COULD_NOT_BUILD");
});

test("a failed image upload has no source, and a review that drafts nothing ends OUT_OF_SCOPE", async () => {
  const { reportId } = await failedUploadBuild({ kind: "image" });

  const client = driverClient();
  const d = driver.createTrueforgeAnalysisDriver(client);
  await d.ensureSession(ctx(reportId));
  await d.run(ctx(reportId));
  assert.match(client.messages[0], /COULD_NOT_BUILD/);
  assert.match(client.messages[0], /from the report text alone/);
  assert.deepEqual((await fallbackEvents(reportId))[0].data, { reason: "COULD_NOT_BUILD", ref: null, sourceFiles: [] });

  await pollOnly(reportId, pollerClient({ status: "done_no_action" }));
  const { state, verdicts } = await finalState(reportId);
  assert.equal(state, "OUT_OF_SCOPE");
  assert.equal(verdicts.length, 0);
  assert.equal(((await outOfScopeEvents(reportId))[0].data as { reason: string }).reason, "COULD_NOT_BUILD");
});
