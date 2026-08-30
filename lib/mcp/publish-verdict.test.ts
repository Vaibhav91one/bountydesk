import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// No DB dependency, so this is safe to import before createSchema sets DATABASE_SCHEMA.
import { computeContentHash } from "@/lib/verdicts/hash";

/**
 * Real Postgres is required: the point of this suite is that the check constraints and the
 * unique index on approval_decision.verdict_id are what make "no approval, no publish" hold,
 * not application code that a mock could disagree with.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

let dbm: typeof import("@/lib/db");
let publishVerdictModule: typeof import("./publish-verdict");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("publish_verdict");

  dbm = await import("@/lib/db");
  publishVerdictModule = await import("./publish-verdict");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/**
 * A report, a verdict (ANALYSIS_ONLY, AWAITING_APPROVAL), and an agent_session with pending
 * markers set. opts control what approval_decision row (if any) exists, so each test can
 * exercise exactly one refusal path.
 */
async function seedFixture(
  opts: {
    approval?: "none" | "approved" | "denied" | "stale";
    tamperPayloadAfterDecision?: boolean;
    channel?: "github" | "manual";
    outcome?: "ANALYSIS_ONLY" | "REPRODUCED" | "NOT_REPRODUCED";
  } = {},
) {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: opts.channel ?? "github",
      sourceRef: opts.channel === "manual" ? `manual:${n}` : `github:1:issue:${n}`,
      title: `report ${n}`,
      body: "body",
      state: "AWAITING_APPROVAL",
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const payload = `Analysis-only result.\n<!-- bountydesk-delivery:${verdictId} -->`;
  const contentHash = computeContentHash(payload);

  // verdict rows are insert-only (AGENTS.md: a DB trigger refuses UPDATE/DELETE), so
  // "tampering" is simulated at insert time: the stored payload differs from the one the
  // hash below was computed from, the same shape a stored-corruption bug would produce.
  const storedPayload = opts.tamperPayloadAfterDecision ? `${payload}\ntampered` : payload;

  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: opts.outcome ?? "ANALYSIS_ONLY",
    summary: "summary",
    payload: storedPayload,
    contentHash,
  });

  const threadId = `thread-${n}`;
  const toolCallId = `call-${n}`;

  const [session] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `cap-${n}-${randomUUID()}`,
      sessionId: `session-${n}`,
      pendingThreadId: threadId,
      pendingToolCallId: toolCallId,
      pendingVerdictId: verdictId,
      pendingApprovedContentHash: contentHash,
    })
    .returning({ id: dbm.agentSession.id, capabilityToken: dbm.agentSession.capabilityToken });

  if (opts.approval && opts.approval !== "none") {
    await dbm.db.insert(dbm.approvalDecision).values({
      verdictId,
      reviewer: "test-reviewer",
      decision: opts.approval === "denied" ? "DENIED" : "APPROVED",
      payloadHash: contentHash,
      threadId: opts.approval === "stale" ? `${threadId}-stale` : threadId,
      toolCallId: opts.approval === "stale" ? `${toolCallId}-stale` : toolCallId,
    });
  }

  return { reportId: r.id, verdictId, capability: session.capabilityToken, contentHash };
}

async function deliveryCount(verdictId: string): Promise<number> {
  const rows = await dbm.db
    .select({ id: dbm.outboundDelivery.id })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.verdictId, verdictId));
  return rows.length;
}

async function reportState(reportId: string): Promise<string> {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  return row.state;
}

async function sessionPendingColumns(capability: string) {
  const [row] = await dbm.db
    .select({
      pendingThreadId: dbm.agentSession.pendingThreadId,
      pendingToolCallId: dbm.agentSession.pendingToolCallId,
      pendingVerdictId: dbm.agentSession.pendingVerdictId,
      pendingApprovedContentHash: dbm.agentSession.pendingApprovedContentHash,
    })
    .from(dbm.agentSession)
    .where(dbm.eq(dbm.agentSession.capabilityToken, capability));
  return row;
}

test("no approval_decision row at all is refused, and nothing is enqueued or transitioned", async () => {
  const fixture = await seedFixture({ approval: "none" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, {
    ok: false,
    reason: "no approval recorded for this verdict",
  });
  assert.equal(await deliveryCount(fixture.verdictId), 0);
  assert.equal(await reportState(fixture.reportId), "AWAITING_APPROVAL");
});

test("a DENIED decision is refused", async () => {
  const fixture = await seedFixture({ approval: "denied" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: false, reason: "denied" });
  assert.equal(await deliveryCount(fixture.verdictId), 0);
});

test("an approval recorded for a stale thread/tool-call binding is refused", async () => {
  const fixture = await seedFixture({ approval: "stale" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, {
    ok: false,
    reason: "stale thread/tool-call binding",
  });
  assert.equal(await deliveryCount(fixture.verdictId), 0);
});

test("a tampered verdict payload fails the content-hash check", async () => {
  const fixture = await seedFixture({
    approval: "approved",
    tamperPayloadAfterDecision: true,
  });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: false, reason: "content hash mismatch" });
  assert.equal(await deliveryCount(fixture.verdictId), 0);
});

test("the happy path enqueues delivery, moves the report to DELIVERING, and clears pending state", async () => {
  const fixture = await seedFixture({ approval: "approved" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: true });

  const deliveries = await dbm.db
    .select()
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.verdictId, fixture.verdictId));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].idempotencyKey, `verdict:${fixture.verdictId}`);
  assert.equal(deliveries[0].approvedContentHash, fixture.contentHash);

  assert.equal(await reportState(fixture.reportId), "DELIVERING");

  const pending = await sessionPendingColumns(fixture.capability);
  assert.equal(pending.pendingThreadId, null);
  assert.equal(pending.pendingToolCallId, null);
  assert.equal(pending.pendingVerdictId, null);
  assert.equal(pending.pendingApprovedContentHash, null);
});

test("an approved REPRODUCED verdict publishes", async () => {
  const fixture = await seedFixture({ approval: "approved", outcome: "REPRODUCED" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: true });
  assert.equal(await deliveryCount(fixture.verdictId), 1);
  assert.equal(await reportState(fixture.reportId), "DELIVERING");
});

test("an approved NOT_REPRODUCED verdict publishes", async () => {
  const fixture = await seedFixture({ approval: "approved", outcome: "NOT_REPRODUCED" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: true });
  assert.equal(await deliveryCount(fixture.verdictId), 1);
  assert.equal(await reportState(fixture.reportId), "DELIVERING");
});

test("a non-GitHub report is not moved into the GitHub delivery queue", async () => {
  const fixture = await seedFixture({ approval: "approved", channel: "manual" });

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: false, reason: "unsupported delivery channel: manual" });
  assert.equal(await deliveryCount(fixture.verdictId), 0);
  assert.equal(await reportState(fixture.reportId), "AWAITING_APPROVAL");
});

test("a malformed GitHub source reference is refused before delivery is enqueued", async () => {
  const fixture = await seedFixture({ approval: "approved" });
  await dbm.db
    .update(dbm.report)
    .set({ sourceRef: "github:not-a-repository:issue:1" })
    .where(dbm.eq(dbm.report.id, fixture.reportId));

  const result = await publishVerdictModule.publishVerdict(fixture.capability);

  assert.deepEqual(result, { ok: false, reason: "invalid GitHub delivery target" });
  assert.equal(await deliveryCount(fixture.verdictId), 0);
  assert.equal(await reportState(fixture.reportId), "AWAITING_APPROVAL");
});

test("calling publishVerdict again after a successful call finds nothing pending", async () => {
  const fixture = await seedFixture({ approval: "approved" });

  const first = await publishVerdictModule.publishVerdict(fixture.capability);
  assert.deepEqual(first, { ok: true });

  const second = await publishVerdictModule.publishVerdict(fixture.capability);
  assert.deepEqual(second, {
    ok: false,
    reason: "no pending approval for this session",
  });

  assert.equal(await deliveryCount(fixture.verdictId), 1);
});

test("a pending verdict that belongs to a different report is refused, not published", async () => {
  // Two independent fixtures, then splice all four of session A's pending markers to match
  // report B's verdict and its already-approved decision exactly (same thread/tool-call
  // binding too, so this reaches the report-ownership check rather than being caught earlier
  // by the thread/tool-call staleness check). agent_session.report_id and pending_verdict_id
  // are independent foreign keys, so nothing in the schema stops this splice on its own; the
  // handler has to catch it.
  const a = await seedFixture({ approval: "approved" });
  const b = await seedFixture({ approval: "approved" });

  const [bDecision] = await dbm.db
    .select({ threadId: dbm.approvalDecision.threadId, toolCallId: dbm.approvalDecision.toolCallId })
    .from(dbm.approvalDecision)
    .where(dbm.eq(dbm.approvalDecision.verdictId, b.verdictId));

  await dbm.db
    .update(dbm.agentSession)
    .set({
      pendingVerdictId: b.verdictId,
      pendingApprovedContentHash: b.contentHash,
      pendingThreadId: bDecision.threadId,
      pendingToolCallId: bDecision.toolCallId,
    })
    .where(dbm.eq(dbm.agentSession.capabilityToken, a.capability));

  const result = await publishVerdictModule.publishVerdict(a.capability);

  assert.deepEqual(result, {
    ok: false,
    reason: "verdict does not belong to this session's report",
  });
  assert.equal(await deliveryCount(a.verdictId), 0);
  assert.equal(await deliveryCount(b.verdictId), 0);
  assert.equal(await reportState(a.reportId), "AWAITING_APPROVAL");
});

test("an unknown capability is refused without touching any row", async () => {
  const result = await publishVerdictModule.publishVerdict(`unknown-${randomUUID()}`);

  assert.deepEqual(result, { ok: false, reason: "unknown capability" });
});

/**
 * draftVerdictFromPendingCall: the new agent-drafted path. Reports here have no pre-seeded
 * verdict or pending markers -- unlike seedFixture above, which sets up an already-approvable
 * publishVerdict fixture -- since this function's whole job is minting that first verdict row.
 */

let draftSeq = 0;

async function seedDraftableReport(
  opts: {
    targetProfileId?: string | null;
    connectedRepositoryId?: string | null;
    state?: "TRIAGING" | "REPRODUCING" | "ANALYSIS_ONLY" | "CANCELLED" | "DELIVERED" | "DELIVERING";
  } = {},
) {
  draftSeq += 1;
  const n = draftSeq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:2:issue:${n}`,
      title: `draftable report ${n}`,
      body: "body",
      state: opts.state ?? "TRIAGING",
      targetProfileId: opts.targetProfileId ?? null,
      connectedRepositoryId: opts.connectedRepositoryId ?? null,
    })
    .returning({ id: dbm.report.id });

  const [session] = await dbm.db
    .insert(dbm.agentSession)
    .values({
      reportId: r.id,
      capabilityToken: `draft-cap-${n}-${randomUUID()}`,
      sessionId: `draft-session-${n}`,
    })
    .returning({ capabilityToken: dbm.agentSession.capabilityToken });

  return { reportId: r.id, capability: session.capabilityToken };
}

/** A bound target profile, optionally behind a connected repository with a specific grant
 * state, the same shape trueforge-driver.test.ts exercises for the deterministic pipeline. */
async function seedTargetWithGrant(
  opts: { active?: boolean; suspended?: boolean } = {},
): Promise<{ targetProfileId: string; connectedRepositoryId: string }> {
  const [target] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `draft-target-${randomUUID()}`,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: `sha256:${randomUUID().replace(/-/g, "")}`,
      config: {},
      scopeRules: [],
    })
    .returning({ id: dbm.targetProfile.id });

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: Number(`9${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
      accountLogin: `acct-${randomUUID()}`,
      accountId: Number(`8${randomUUID().replace(/\D/g, "").slice(0, 8)}`),
      suspendedAt: opts.suspended ? new Date() : null,
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
    })
    .returning({ id: dbm.connectedRepository.id });

  return { targetProfileId: target.id, connectedRepositoryId: repo.id };
}

test("draftVerdictFromPendingCall rejects an invalid draft before touching the database", async () => {
  // The capability below names no real session on purpose: if validation ran after a DB
  // lookup, this would come back "unknown capability" instead of a schema error.
  const result = await publishVerdictModule.draftVerdictFromPendingCall(`no-such-capability-${randomUUID()}`, {
    outcome: "SOMETHING_ELSE",
    summary: "",
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /^invalid draft:/);
});

test("draftVerdictFromPendingCall rejects a findings array with an out-of-range severity", async () => {
  const fixture = await seedDraftableReport();

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "ANALYSIS_ONLY",
    summary: "ok",
    findings: [{ title: "t", severity: "catastrophic", description: "d", evidenceRef: "e" }],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /^invalid draft:/);
  const verdicts = await dbm.db.select().from(dbm.verdict).where(dbm.eq(dbm.verdict.reportId, fixture.reportId));
  assert.equal(verdicts.length, 0);
});

test("draftVerdictFromPendingCall rejects an unknown capability", async () => {
  const result = await publishVerdictModule.draftVerdictFromPendingCall(`unknown-${randomUUID()}`, {
    outcome: "ANALYSIS_ONLY",
    summary: "ok",
    findings: [],
  });

  assert.deepEqual(result, { ok: false, reason: "unknown capability" });
});

test("draftVerdictFromPendingCall rejects REPRODUCED for a report with no bound target profile", async () => {
  const fixture = await seedDraftableReport();

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "REPRODUCED",
    summary: "the agent claims this reproduces",
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /ANALYSIS_ONLY is permitted/);
  const verdicts = await dbm.db.select().from(dbm.verdict).where(dbm.eq(dbm.verdict.reportId, fixture.reportId));
  assert.equal(verdicts.length, 0, "an unauthorized claim must never become a verdict row");
});

test("draftVerdictFromPendingCall rejects NOT_REPRODUCED for a revoked repository grant", async () => {
  const target = await seedTargetWithGrant({ active: false });
  const fixture = await seedDraftableReport({
    targetProfileId: target.targetProfileId,
    connectedRepositoryId: target.connectedRepositoryId,
  });

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "NOT_REPRODUCED",
    summary: "the agent claims this does not reproduce",
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /ANALYSIS_ONLY is permitted/);
});

test("draftVerdictFromPendingCall rejects REPRODUCED for a suspended installation", async () => {
  const target = await seedTargetWithGrant({ suspended: true });
  const fixture = await seedDraftableReport({
    targetProfileId: target.targetProfileId,
    connectedRepositoryId: target.connectedRepositoryId,
  });

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "REPRODUCED",
    summary: "the agent claims this reproduces",
    findings: [],
  });

  assert.equal(result.ok, false);
});

test("draftVerdictFromPendingCall accepts ANALYSIS_ONLY with no bound target and renders findings deterministically", async () => {
  const fixture = await seedDraftableReport();

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "ANALYSIS_ONLY",
    summary: "Nothing conclusive found from a read of the report alone.",
    findings: [
      {
        title: "Reflected parameter in search",
        severity: "medium",
        description: "The query parameter is echoed back unescaped.",
        evidenceRef: "scope-guard-log:1",
      },
    ],
  });

  assert.equal(result.ok, true);
  const verdictId = (result as { verdictId: string }).verdictId;
  const [row] = await dbm.db.select().from(dbm.verdict).where(dbm.eq(dbm.verdict.id, verdictId));

  assert.equal(row.outcome, "ANALYSIS_ONLY");
  assert.equal(row.summary, "Nothing conclusive found from a read of the report alone.");
  assert.deepEqual(row.evidence, {
    source: "agent-drafted",
    findings: [
      {
        title: "Reflected parameter in search",
        severity: "medium",
        description: "The query parameter is echoed back unescaped.",
        evidenceRef: "scope-guard-log:1",
      },
    ],
  });
  assert.ok(row.payload.startsWith("## Outcome: ANALYSIS_ONLY"));
  assert.ok(row.payload.includes("Nothing conclusive found from a read of the report alone."));
  assert.ok(row.payload.includes("Reflected parameter in search"));
  assert.ok(row.payload.includes("MEDIUM"));
  assert.ok(row.payload.includes("scope-guard-log:1"));
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  assert.equal(row.payload.split(marker).length, 2, "marker must appear exactly once");
  assert.equal(row.contentHash, computeContentHash(row.payload));

  // Rendering is deterministic: the same draft always produces the same payload text, given
  // the same verdict id.
  const rebuilt = publishVerdictModule.buildAgentDraftedPayload(verdictId, {
    outcome: "ANALYSIS_ONLY",
    summary: "Nothing conclusive found from a read of the report alone.",
    findings: [
      {
        title: "Reflected parameter in search",
        severity: "medium",
        description: "The query parameter is echoed back unescaped.",
        evidenceRef: "scope-guard-log:1",
      },
    ],
  });
  assert.equal(rebuilt, row.payload);
});

test("draftVerdictFromPendingCall accepts REPRODUCED for a report with an active repository grant", async () => {
  const target = await seedTargetWithGrant();
  const fixture = await seedDraftableReport({
    targetProfileId: target.targetProfileId,
    connectedRepositoryId: target.connectedRepositoryId,
  });

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "REPRODUCED",
    summary: "the agent verified this against the sandboxed target",
    findings: [],
  });

  assert.equal(result.ok, true);
  const verdicts = await dbm.db.select().from(dbm.verdict).where(dbm.eq(dbm.verdict.reportId, fixture.reportId));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].outcome, "REPRODUCED");
});

test("draftVerdictFromPendingCall rejects a finding whose evidenceRef exceeds the length bound", async () => {
  const fixture = await seedDraftableReport();

  const result = await publishVerdictModule.draftVerdictFromPendingCall(fixture.capability, {
    outcome: "ANALYSIS_ONLY",
    summary: "ok",
    findings: [{ title: "t", severity: "low", description: "d", evidenceRef: "x".repeat(501) }],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /^invalid draft:/);
  const verdicts = await dbm.db.select().from(dbm.verdict).where(dbm.eq(dbm.verdict.reportId, fixture.reportId));
  assert.equal(verdicts.length, 0);
});

test("draftVerdictFromPendingCall refuses a report already past the analysis stages, for any outcome", async () => {
  const cancelled = await seedDraftableReport({ state: "CANCELLED" });

  const result = await publishVerdictModule.draftVerdictFromPendingCall(cancelled.capability, {
    outcome: "ANALYSIS_ONLY",
    summary: "the agent's read of a report nobody can act on any more",
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /report is CANCELLED/);
  const verdicts = await dbm.db.select().from(dbm.verdict).where(dbm.eq(dbm.verdict.reportId, cancelled.reportId));
  assert.equal(verdicts.length, 0, "a terminal report must never receive a fresh verdict");
});

test("draftVerdictFromPendingCall refuses a report already DELIVERING", async () => {
  const delivering = await seedDraftableReport({ state: "DELIVERING" });

  const result = await publishVerdictModule.draftVerdictFromPendingCall(delivering.capability, {
    outcome: "ANALYSIS_ONLY",
    summary: "a late draft for a report already on its way out",
    findings: [],
  });

  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /report is DELIVERING/);
});

test("buildAgentDraftedPayload states the outcome on its own line, independent of the summary text", () => {
  const payload = publishVerdictModule.buildAgentDraftedPayload("verdict-1", {
    outcome: "REPRODUCED",
    summary: "a summary that never mentions the word itself",
    findings: [],
  });

  assert.ok(payload.startsWith("## Outcome: REPRODUCED"));
});
