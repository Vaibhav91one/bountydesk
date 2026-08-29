import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Imported dynamically, after createSchema has set DATABASE_SCHEMA: case.ts pulls in @/lib/db,
 * which builds its pool at import time, so a static import would bind the pool to the wrong
 * schema before the harness got a say.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let cases: typeof import("./case");
let targetProfileId: string;
let repositoryId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reports_case");

  dbm = await import("@/lib/db");
  cases = await import("./case");

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "juice-shop-v17.3.0", imageDigest: `sha256:${"0".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });
  targetProfileId = profile.id;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId: 5_000_001, accountLogin: "acme", accountId: 42, accountType: "User" })
    .returning({ id: dbm.githubInstallation.id });

  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId: 5_100_001,
      fullName: "acme/juice-shop",
      targetProfileId,
    })
    .returning({ id: dbm.connectedRepository.id });
  repositoryId = repo.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let issues = 0;

async function seedReport(
  state: import("@/lib/reports/states").ReportState,
  opts: { sourceRef?: string; withRepo?: boolean } = {},
): Promise<string> {
  issues += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: opts.sourceRef ?? `github:5100001:issue:${issues}`,
      title: `report ${issues}`,
      body: "the reporter's own words",
      reporterHandle: "someone",
      state,
      connectedRepositoryId: opts.withRepo === false ? null : repositoryId,
      targetProfileId,
    })
    .returning({ id: dbm.report.id });

  return row.id;
}

test("an id that matches nothing is null, not an error", async () => {
  assert.equal(await cases.readCase("00000000-0000-0000-0000-000000000000"), null);
});

test("caseSourceLabel names the issue, or falls back to a short id", () => {
  assert.equal(cases.caseSourceLabel("github:1:issue:482", "abcdef12-0000"), "Issue #482");
  assert.equal(cases.caseSourceLabel("email:someone@example.com", "abcdef12-0000"), "#abcdef12");
});

test("the issue link needs both a repository and an issue number", async () => {
  const linked = await cases.readCase(await seedReport("TRIAGING"));
  assert.equal(linked?.issueUrl, `https://github.com/acme/juice-shop/issues/${issues}`);
  assert.equal(linked?.repositoryFullName, "acme/juice-shop");

  // A report with no connected repository has no owner/name to build a URL from, and
  // guessing one would send a reviewer to a page that is not this report.
  const orphan = await cases.readCase(await seedReport("TRIAGING", { withRepo: false }));
  assert.equal(orphan?.issueUrl, null);

  const emailed = await cases.readCase(
    await seedReport("TRIAGING", { sourceRef: `email:${issues + 100}@example.com` }),
  );
  assert.equal(emailed?.issueUrl, null);
});

test("the case carries the latest verdict revision, not the first", async () => {
  const id = await seedReport("ANALYSIS_ONLY");

  for (const [revision, outcome] of [
    [1, "INCONCLUSIVE"],
    [2, "ANALYSIS_ONLY"],
  ] as const) {
    await dbm.db.insert(dbm.verdict).values({
      reportId: id,
      outcome,
      summary: `revision ${revision}`,
      payload: `payload ${revision}`,
      contentHash: `hash-${id}-${revision}`,
      revision,
    });
  }

  const file = await cases.readCase(id);
  assert.equal(file?.verdict?.revision, 2);
  assert.equal(file?.verdict?.outcome, "ANALYSIS_ONLY");
});

test("events come back in sequence, with their channel taken from the type", async () => {
  const id = await seedReport("REPRODUCING");
  const { recordEvent } = await import("./lifecycle");
  await recordEvent(id, "intake.accepted");
  await recordEvent(id, "analysis.stub_session.created");
  await recordEvent(id, "analysis.completed");

  const file = await cases.readCase(id);
  assert.deepEqual(
    file?.events.map((e) => e.type),
    ["intake.accepted", "analysis.stub_session.created", "analysis.completed"],
  );
  assert.deepEqual(
    file?.events.map((e) => e.channel),
    ["intake", "analysis", "analysis"],
  );
  assert.deepEqual(
    file?.events.map((e) => e.seq),
    [1, 2, 3],
  );
});

test("the approval panel opens only for a call a reviewer can answer", async () => {
  // No session at all: awaiting approval on paper, nothing pending to answer.
  const stranded = await seedReport("AWAITING_APPROVAL");
  assert.equal((await cases.readCase(stranded))?.awaitingVerdictId, null);

  const id = await seedReport("AWAITING_APPROVAL");
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: id,
      outcome: "REPRODUCED",
      summary: "reproduced",
      payload: "the exact comment",
      contentHash: `hash-${id}`,
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.agentSession).values({
    reportId: id,
    capabilityToken: `token-${id}`,
    sessionId: `session-${id}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: v.id,
    pendingApprovedContentHash: `hash-${id}`,
  });

  assert.equal((await cases.readCase(id))?.awaitingVerdictId, v.id);
});

test("a decided verdict reports its decision and closes the gate", async () => {
  const id = await seedReport("DENIED");
  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: id,
      outcome: "NOT_REPRODUCED",
      summary: "not reproduced",
      payload: "the exact comment",
      contentHash: `hash-${id}`,
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: v.id,
    reviewer: "someone",
    decision: "DENIED",
    payloadHash: `hash-${id}`,
    note: "not enough to go on",
  });

  const file = await cases.readCase(id);
  assert.equal(file?.approval?.decision, "DENIED");
  assert.equal(file?.approval?.reviewer, "someone");
  assert.equal(file?.approval?.note, "not enough to go on");
  // Already decided, so nothing is awaiting one.
  assert.equal(file?.awaitingVerdictId, null);
});

test("evidence is passed through as recorded, not interpreted", async () => {
  const id = await seedReport("ANALYSIS_ONLY");
  await dbm.db.insert(dbm.verdict).values({
    reportId: id,
    outcome: "ANALYSIS_ONLY",
    summary: "did not run",
    evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    payload: "the exact comment",
    contentHash: `hash-${id}`,
  });

  const file = await cases.readCase(id);
  // The page renders whatever is here verbatim. If a driver ever writes a canary result, it
  // shows up without a code change; until then it says exactly what it says.
  assert.deepEqual(file?.verdict?.evidence, { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" });
});

test("a reporter is only linked when the handle could actually be a GitHub login", async () => {
  const linked = await cases.readCase(await seedReport("TRIAGING"));
  assert.equal(linked?.reporterUrl, "https://github.com/someone");
  assert.equal(linked?.reporterAvatarUrl, "https://github.com/someone.png?size=64");
  assert.equal(linked?.repositoryUrl, "https://github.com/acme/juice-shop");

  // An email address is a perfectly good reporter handle and a terrible GitHub login. Building
  // github.com/<that> lands on a 404 at best, and on somebody else's account at worst.
  issues += 1;
  const [row] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "email",
      sourceRef: `email:reporter-${issues}@example.com`,
      title: "sent by email",
      body: "body",
      reporterHandle: "reporter@example.com",
      state: "TRIAGING",
      connectedRepositoryId: repositoryId,
      targetProfileId,
    })
    .returning({ id: dbm.report.id });

  const emailed = await cases.readCase(row.id);
  assert.equal(emailed?.reporterHandle, "reporter@example.com", "the handle is still shown");
  assert.equal(emailed?.reporterUrl, null);
  assert.equal(emailed?.reporterAvatarUrl, null);
  assert.equal(emailed?.issueNumber, null);
});

test("every report state maps to a mascot that exists", async () => {
  const { MASCOT_FOR_STATE, MASCOT_STATES } = await import("@/lib/mascot/states");
  const { TERMINAL_STATES } = await import("./states");

  const all = [
    "TRIAGING",
    "REPRODUCING",
    "ANALYSIS_ONLY",
    "AWAITING_APPROVAL",
    "DELIVERING",
    ...TERMINAL_STATES,
  ];

  for (const state of all) {
    const mascot = MASCOT_FOR_STATE[state];
    assert.ok(mascot, `${state} has no mascot`);
    // The splitter writes one file per name in MASCOT_STATES. A name outside that list would
    // throw at render, on the page, in front of whoever opened the report.
    assert.ok(
      (MASCOT_STATES as readonly string[]).includes(mascot),
      `${state} maps to ${mascot}, which is not a mascot the splitter produces`,
    );
  }

  // The board and the case file both read this map, so a state missing from it would show
  // Agent Bounty doing one thing on the queue and another on the report.
  assert.equal(Object.keys(MASCOT_FOR_STATE).length, all.length);
});
