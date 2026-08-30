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

test("the case shows the verdict the gate would approve, not merely the newest one", async () => {
  const id = await seedReport("AWAITING_APPROVAL");

  const [pending] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: id,
      outcome: "ANALYSIS_ONLY",
      summary: "the revision the tool call was prepared for",
      payload: "the comment the reviewer is signing",
      contentHash: `pending-${id}`,
      revision: 1,
    })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.agentSession).values({
    reportId: id,
    capabilityToken: `token-${id}`,
    sessionId: `session-${id}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: pending.id,
    pendingApprovedContentHash: `pending-${id}`,
  });

  // A newer revision lands after the tool call was prepared. Approving still binds revision 1,
  // so showing revision 2 beside that button would let somebody sign text they never read.
  await dbm.db.insert(dbm.verdict).values({
    reportId: id,
    outcome: "REPRODUCED",
    summary: "a later revision nobody was asked about",
    payload: "different words entirely",
    contentHash: `newer-${id}`,
    revision: 2,
  });

  const file = await cases.readCase(id);
  assert.equal(file?.awaitingVerdictId, pending.id);
  assert.equal(file?.verdict?.id, pending.id, "the page must show the pending revision");
  assert.equal(file?.verdict?.revision, 1);
  assert.equal(file?.verdict?.contentHash, `pending-${id}`);
  // What is displayed and what is submitted have to be the same row, or the approval gate is
  // approving something the human did not read.
  assert.equal(file?.verdict?.id, file?.awaitingVerdictId);
});

test("delivery is read for the verdict on screen, not for whichever row the report has", async () => {
  const id = await seedReport("DELIVERED");

  const revisions = [];
  for (const revision of [1, 2] as const) {
    const [row] = await dbm.db
      .insert(dbm.verdict)
      .values({
        reportId: id,
        outcome: "ANALYSIS_ONLY",
        summary: `revision ${revision}`,
        payload: `payload ${revision}`,
        contentHash: `delivery-hash-${id}-${revision}`,
        revision,
      })
      .returning({ id: dbm.verdict.id });
    revisions.push(row.id);
  }

  // One delivery per revision, inserted oldest first so a report-only predicate is likely to
  // return the wrong one.
  for (const [index, verdictId] of revisions.entries()) {
    await dbm.db.insert(dbm.outboundDelivery).values({
      reportId: id,
      verdictId,
      target: `https://github.com/acme/juice-shop/issues/${index + 1}`,
      approvedContentHash: `delivery-hash-${id}-${index + 1}`,
      idempotencyKey: `delivery-${id}-${index}`,
      attempts: index + 1,
    });
  }

  const file = await cases.readCase(id);
  assert.equal(file?.verdict?.revision, 2);
  assert.equal(file?.delivery?.attempts, 2, "the delivery must belong to the verdict shown");
});

test("only a recorded oracle result is attributed to the oracle", async () => {
  const { oracleDecided } = cases;

  // Everything a driver could plausibly leave behind before the oracle ships.
  for (const evidence of [
    null,
    undefined,
    {},
    { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    { reason: "SOMETHING_NOBODY_HAS_SEEN" },
    { oracle: null },
    { oracle: "confirmed" },
    { oracle: {} },
    "REPRODUCED",
  ]) {
    assert.equal(
      oracleDecided(evidence),
      false,
      `${JSON.stringify(evidence)} must not be read as an oracle verdict`,
    );
  }

  // The one shape that earns it. Nothing writes this yet; the page lights up on its own the
  // day something does.
  assert.equal(oracleDecided({ oracle: { result: "CANARY_OBSERVED" } }), true);
});

test("findings render only from an agent-drafted verdict, and only the entries that parse", async () => {
  const { verdictFindings } = cases;

  for (const evidence of [
    null,
    undefined,
    {},
    { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    { oracle: { result: "CANARY_OBSERVED" } },
    { source: "agent-drafted" },
    { source: "agent-drafted", findings: "not an array" },
    { findings: [{ title: "no source tag", severity: "high", description: "x", evidenceRef: "x" }] },
  ]) {
    assert.deepEqual(verdictFindings(evidence), [], `${JSON.stringify(evidence)} must render no findings`);
  }

  const good = { title: "Reflected in search", severity: "high", description: "d", evidenceRef: "ref-1" };
  const malformed = { title: "missing severity", description: "d", evidenceRef: "ref-2" };
  assert.deepEqual(
    verdictFindings({ source: "agent-drafted", findings: [good, malformed] }),
    [good],
    "a malformed entry is dropped, not thrown on, and a valid sibling still renders",
  );
});

test("a report id has to be a uuid, not thirty-six characters from its alphabet", () => {
  assert.equal(cases.isReportId("61395817-9dc9-4054-893c-0dbe43e87df9"), true);
  assert.equal(cases.isReportId("61395817-9DC9-4054-893C-0DBE43E87DF9"), true);

  // The old check counted characters, so every one of these reached Postgres as a uuid
  // comparison and returned a 500 where not-found is the honest answer.
  for (const value of [
    "-".repeat(36),
    "0".repeat(36),
    "61395817-9dc9-4054-893c-0dbe43e87df",
    "61395817-9dc9-4054-893c-0dbe43e87df99",
    "6139581779dc994054e893c40dbe43e87df9",
    "'; drop table report; --",
    "",
  ]) {
    assert.equal(cases.isReportId(value), false, `${value} must not be treated as an id`);
  }
});

test("a pending verdict belonging to another report is not shown or approvable", async () => {
  const victim = await seedReport("AWAITING_APPROVAL");
  const other = await seedReport("AWAITING_APPROVAL");

  // The other report's verdict. Nothing about it belongs on the victim's page.
  const [foreign] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: other,
      outcome: "REPRODUCED",
      summary: "another report's summary",
      payload: "ANOTHER REPORT'S COMMENT",
      contentHash: `foreign-${other}`,
    })
    .returning({ id: dbm.verdict.id });

  const [own] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: victim,
      outcome: "ANALYSIS_ONLY",
      summary: "this report's own summary",
      payload: "this report's own comment",
      contentHash: `own-${victim}`,
    })
    .returning({ id: dbm.verdict.id });

  // verdict.id and agent_session.report_id are independent foreign keys, so nothing in the
  // schema stops a session naming a verdict that belongs somewhere else.
  await dbm.db.insert(dbm.agentSession).values({
    reportId: victim,
    capabilityToken: `token-${victim}`,
    sessionId: `session-${victim}`,
    pendingThreadId: "thread-1",
    pendingToolCallId: "call-1",
    pendingVerdictId: foreign.id,
    pendingApprovedContentHash: `foreign-${other}`,
  });

  const file = await cases.readCase(victim);
  assert.equal(file?.verdict?.id, own.id, "the page must show this report's own verdict");
  assert.notEqual(file?.verdict?.payload, "ANOTHER REPORT'S COMMENT");
  // The call cannot be identified, so there is nothing here anybody may approve.
  assert.equal(file?.awaitingVerdictId, null);
});

test("the case file reads the session's own turn status", async () => {
  const withoutSession = await seedReport("TRIAGING");
  assert.equal((await cases.readCase(withoutSession))?.turnStatus, null);

  const investigating = await seedReport("TRIAGING");
  await dbm.db.insert(dbm.agentSession).values({
    reportId: investigating,
    capabilityToken: `token-${investigating}`,
    sessionId: `session-${investigating}`,
    turnStatus: "INVESTIGATING",
  });

  assert.equal((await cases.readCase(investigating))?.turnStatus, "INVESTIGATING");
});

test("a report is investigating only while its turn is live and no verdict has landed yet", () => {
  const { isAgentInvestigating } = cases;

  assert.equal(isAgentInvestigating("RUNNING", false), true);
  assert.equal(isAgentInvestigating("INVESTIGATING", false), true);

  // A verdict already exists: whatever the turn status still says, the investigation this
  // page cares about is over.
  assert.equal(isAgentInvestigating("RUNNING", true), false);
  assert.equal(isAgentInvestigating("INVESTIGATING", true), false);

  // Every other turn status, and no session at all, is not "investigating" either way.
  for (const status of ["AWAITING_APPROVAL_HARNESS", "DONE_NO_ACTION", "ERROR", "CANCELLED", null]) {
    assert.equal(isAgentInvestigating(status, false), false, `${status} must not read as investigating`);
  }
});
