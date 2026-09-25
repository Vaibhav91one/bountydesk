import assert from "node:assert/strict";
import { test } from "node:test";

import { caseLiveView } from "./case-view";
import type { CaseFile } from "./case-facts";

/**
 * caseLiveView is what the case page renders and what its poll returns, so these fixtures are
 * the contract between the two. Pure: no database, no harness, no clock.
 */

const AT = new Date("2026-08-31T12:00:00Z");

function caseFile(overrides: Partial<CaseFile> = {}): CaseFile {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    title: "Stored XSS in the review field",
    body: "steps to reproduce",
    channel: "github",
    sourceRef: "github:Vaibhav91one/juice-shop#18",
    sourceLabel: "#18",
    issueNumber: "18",
    issueUrl: "https://github.com/Vaibhav91one/juice-shop/issues/18",
    repositoryFullName: "Vaibhav91one/juice-shop",
    repositoryUrl: "https://github.com/Vaibhav91one/juice-shop",
    reporterHandle: "reporter",
    reporterUrl: null,
    reporterAvatarUrl: null,
    repliesTo: null,
    state: "TRIAGING",
    createdAt: AT,
    updatedAt: AT,
    turnStatus: null,
    sessionError: null,
    finalSummary: null,
    target: null,
    sandbox: null,
    verdict: null,
    verdictHistory: [],
    approval: null,
    delivery: null,
    handoff: null,
    ownerAdvisory: null,
    awaitingVerdictId: null,
    events: [],
    artifacts: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<NonNullable<CaseFile["verdict"]>> = {}) {
  return {
    id: "00000000-0000-0000-0000-0000000000v1",
    outcome: "REPRODUCED",
    summary: "The payload executes.",
    payload: "comment body",
    contentHash: "abc123",
    revision: 1,
    evidence: { source: "agent-drafted", findings: [] },
    createdAt: AT,
    ...overrides,
  };
}

function toolCallEvent(seq: number) {
  return {
    seq,
    type: "agent.tool_call:probe_target",
    channel: "agent",
    // Shaped as the poller mirrors it: the tool name and the allowlisted preview the hover
    // falls back to when live detail is out of reach.
    data: { toolName: "probe_target", argumentsPreview: `{"call":${seq}}` },
    eventKey: `agent.tool_call:call-${seq}`,
    at: AT,
  };
}

function step(view: ReturnType<typeof caseLiveView>, key: string) {
  const found = view.steps.find((s) => s.key === key);
  assert.ok(found, `no ${key} step`);
  return found;
}

test("a live run reads as investigating, with no verdict yet", () => {
  const view = caseLiveView(
    caseFile({ turnStatus: "RUNNING", events: [toolCallEvent(1), toolCallEvent(2)] }),
  );

  assert.equal(view.investigating, true);
  assert.equal(view.verdict, null);
  assert.equal(view.eventCount, 2);
  assert.equal(step(view, "investigation").state, "current");
  assert.equal(step(view, "investigation").note, "In progress");
  assert.equal(step(view, "verdict").state, "pending");

  // The two tool calls land on the investigation row, and carry the key the hover matches on.
  assert.equal(step(view, "investigation").events.length, 2);
  assert.equal(step(view, "investigation").events[0].eventKey, "agent.tool_call:call-1");

  // The mirrored tool name and preview ride along, so the hover has something to show even
  // where the live TrueForge detail never arrives.
  assert.equal(step(view, "investigation").events[0].toolName, "probe_target");
  assert.equal(step(view, "investigation").events[0].argsPreview, '{"call":1}');
});

test("a turn that has started but done nothing is not yet investigating", () => {
  // A session sits in RUNNING from the instant createTurn returns. Claiming an investigation is
  // under way with no observed activity would be a stronger claim than the record supports.
  const view = caseLiveView(caseFile({ turnStatus: "RUNNING", events: [] }));

  assert.equal(view.investigating, false);
  assert.equal(step(view, "investigation").state, "pending");
});

test("a drafted verdict awaiting a reviewer offers the approval and its findings", () => {
  const view = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      turnStatus: "AWAITING_APPROVAL_HARNESS",
      verdict: verdict(),
      awaitingVerdictId: "00000000-0000-0000-0000-0000000000v1",
      events: [toolCallEvent(1)],
    }),
  );

  assert.equal(view.stateLabel, "Awaiting approval");
  assert.equal(view.awaitingVerdictId, "00000000-0000-0000-0000-0000000000v1");
  assert.equal(view.approvalDecision, null);
  assert.equal(view.verdict?.outcomeLabel, "Reproduced");
  assert.equal(view.verdict?.verdictLabel, "Agent Bounty says");
  assert.equal(view.verdict?.reproductionRan, false);
  assert.equal(view.investigating, false, "a verdict exists, so the turn is over");
  assert.equal(step(view, "investigation").state, "done");
  assert.equal(step(view, "investigation").note, "1 step recorded");
  assert.equal(step(view, "approval").state, "current");
  assert.equal(step(view, "approval").note, "Waiting on a reviewer");
});

test("approved but not yet delivered says Approved and offers nothing to sign", () => {
  // The shape report #18 was stuck in: the decision committed, the submission worker had not
  // moved the report on yet, and the page still offered an approval button.
  const view = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      verdict: verdict(),
      awaitingVerdictId: null,
      approval: {
        decision: "APPROVED",
        reviewer: "vaibhav",
        note: null,
        decidedAt: AT,
      },
    }),
  );

  assert.equal(view.stateLabel, "Approved");
  assert.equal(view.approvalDecision, "APPROVED");
  assert.equal(view.awaitingVerdictId, null, "nothing left to answer");
  assert.equal(step(view, "approval").state, "done");
  assert.equal(step(view, "approval").note, "Approved by vaibhav");
  assert.equal(step(view, "delivery").state, "pending");
});

test("a denial marks the approval row denied and draws the denied mascot", () => {
  const view = caseLiveView(
    caseFile({
      state: "DENIED",
      verdict: verdict(),
      approval: { decision: "DENIED", reviewer: "vaibhav", note: "wrong file", decidedAt: AT },
    }),
  );

  assert.equal(view.stateLabel, "Denied");
  assert.equal(view.mascotKey, "denied");
  assert.equal(step(view, "approval").state, "done");
  assert.equal(step(view, "approval").mascot, "denied");
  assert.equal(step(view, "delivery").state, "skipped");
});

test("a denial with the harness relay still in flight never reads as delivering", () => {
  const view = caseLiveView(
    caseFile({
      state: "DENIED",
      verdict: verdict(),
      approval: { decision: "DENIED", reviewer: "vaibhav", note: "wrong file", decidedAt: AT },
      handoff: handoff(),
    }),
  );

  assert.equal(step(view, "delivery").state, "skipped");
  assert.equal(step(view, "delivery").note, "Denied, nothing posted");
});

test("a delivery still retrying counts its attempts, and one that gave up says so", () => {
  const retrying = caseLiveView(
    caseFile({
      state: "DELIVERING",
      verdict: verdict(),
      delivery: {
        state: "FAILED",
        attempts: 3,
        maxAttempts: 8,
        lastError: "502 from GitHub",
        target: "issues/18",
        requiresHumanReview: false,
        deliveredAt: null,
      },
    }),
  );
  assert.equal(step(retrying, "delivery").note, "failed, retrying (3/8)");
  assert.equal(step(retrying, "delivery").state, "skipped");

  const exhausted = caseLiveView(
    caseFile({
      state: "DELIVERING",
      verdict: verdict(),
      delivery: {
        state: "FAILED",
        attempts: 8,
        maxAttempts: 8,
        lastError: "502 from GitHub",
        target: "issues/18",
        requiresHumanReview: false,
        deliveredAt: null,
      },
    }),
  );
  assert.equal(exhausted.steps.at(-1)?.note, "failed after 8 attempts");
});

test("a delivery held for review says so, rather than counting attempts nothing will spend", () => {
  const held = caseLiveView(
    caseFile({
      state: "DELIVERING",
      verdict: verdict(),
      delivery: {
        state: "FAILED",
        attempts: 1,
        maxAttempts: 8,
        lastError: "Permanent / General / mailbox does not exist",
        target: "reporter@example.test",
        requiresHumanReview: true,
        deliveredAt: null,
      },
    }),
  );
  // "failed, retrying (1/8)" would be the old answer here, and it would be a lie: claim() skips
  // a held row, so those seven attempts are never spent.
  assert.equal(
    step(held, "delivery").note,
    "held for review: Permanent / General / mailbox does not exist",
  );
  assert.equal(step(held, "delivery").state, "skipped");
});

test("a send the transport has not confirmed yet reads as waiting, not as delivered", () => {
  const awaiting = caseLiveView(
    caseFile({
      state: "DELIVERING",
      verdict: verdict(),
      delivery: {
        state: "SENT",
        attempts: 1,
        maxAttempts: 8,
        lastError: null,
        target: "reporter@example.test",
          requiresHumanReview: false,
        deliveredAt: null,
      },
    }),
  );
  assert.equal(step(awaiting, "delivery").note, "sent, waiting for the delivery receipt");
});

test("a delivered report is done, and the outcome badge is not repeated", () => {
  const delivered = caseLiveView(
    caseFile({
      state: "DELIVERED",
      verdict: verdict(),
      approval: { decision: "APPROVED", reviewer: "vaibhav", note: null, decidedAt: AT },
      delivery: {
        state: "SENT",
        attempts: 1,
        maxAttempts: 8,
        lastError: null,
        target: "issues/18",
        requiresHumanReview: false,
        // A GitHub 201 is itself the receipt, so a sent row is confirmed in the same write.
        deliveredAt: AT,
      },
    }),
  );

  assert.equal(delivered.stateLabel, "Delivered");
  assert.equal(delivered.mascotKey, "celebrating");
  assert.equal(step(delivered, "delivery").state, "done");
  assert.equal(delivered.showOutcomeBadge, true);

  // ANALYSIS_ONLY in both places is the state badge saying the same word twice.
  const analysed = caseLiveView(
    caseFile({ state: "ANALYSIS_ONLY", verdict: verdict({ outcome: "ANALYSIS_ONLY" }) }),
  );
  assert.equal(analysed.showOutcomeBadge, false);
});

test("an unrecognised event lands on the step matching the report's own state", () => {
  const view = caseLiveView(
    caseFile({
      state: "DELIVERING",
      verdict: verdict(),
      events: [
        { seq: 1, type: "mystery.thing", channel: "mystery", data: {}, eventKey: null, at: AT },
      ],
    }),
  );

  assert.equal(step(view, "delivery").events.length, 1, "an event nobody placed is not dropped");
});

test("every field crossing the wire survives JSON", () => {
  const view = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      verdict: verdict(),
      approval: { decision: "APPROVED", reviewer: "vaibhav", note: null, decidedAt: AT },
      events: [toolCallEvent(1)],
      artifacts: [
        {
          id: "a1",
          kind: "verdict-payload",
          sha256: "deadbeef",
          bytes: 42,
          contentType: "text/plain",
          stored: true,
          createdAt: AT,
          verdictId: "00000000-0000-0000-0000-0000000000v1",
          verdictRevision: 1,
        },
      ],
    }),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  assert.equal(view.verdict?.payloadArtifactId, "a1");
});

test("a findings file is offered only once its bytes are stored", () => {
  const build = (stored: boolean) =>
    caseLiveView(
      caseFile({
        state: "AWAITING_APPROVAL",
        verdict: verdict(),
        artifacts: [
          {
            id: "f1",
            kind: "findings-evidence",
            sha256: "beef",
            bytes: 10,
            contentType: "text/markdown",
            stored,
            createdAt: AT,
            verdictId: "00000000-0000-0000-0000-0000000000v1",
            verdictRevision: 1,
          },
        ],
      }),
    );

  // A row with bytes is a real download; one without (storage off, or a failed upload) would
  // only error, so the views fall back to the inline reference instead.
  assert.equal(build(true).verdict?.findingsArtifactId, "f1");
  assert.equal(build(false).verdict?.findingsArtifactId, null);
});

function handoff(overrides: Partial<NonNullable<CaseFile["handoff"]>> = {}) {
  return { state: "PENDING", attempts: 0, maxAttempts: 8, lastError: null, ...overrides };
}

test("a handoff still being retried says so and keeps the report alive", () => {
  const view = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      verdict: verdict(),
      approval: { decision: "APPROVED", reviewer: "vaibhav", note: null, decidedAt: AT },
      handoff: handoff({ state: "FAILED", attempts: 3, lastError: "Session not found" }),
    }),
  );

  assert.equal(view.failed, false, "three of eight attempts is not a dead run");
  assert.equal(view.stateLabel, "Approved");
  assert.equal(step(view, "delivery").note, "handoff failed, retrying (3/8)");
  assert.equal(step(view, "delivery").state, "current");
});

test("a handoff that ran out of attempts reads as failed, not as approved", () => {
  // Report #18: the decision committed, the harness never heard about it, and no
  // outbound_delivery row was ever written. The page said "Approved" over "Not enqueued",
  // which is what a report waiting its turn looks like.
  const view = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      verdict: verdict(),
      approval: { decision: "APPROVED", reviewer: "vaibhav", note: null, decidedAt: AT },
      handoff: handoff({ state: "FAILED", attempts: 8, lastError: "Session not found" }),
    }),
  );

  assert.equal(view.failed, true);
  assert.equal(view.stateLabel, "Failed");
  assert.equal(step(view, "delivery").note, "handoff failed after 8 attempts");
  assert.equal(step(view, "delivery").state, "skipped");

  // The decision itself is still on the record. A failed handoff is not an unapproved report,
  // and hiding the signature would be a second wrong answer.
  assert.equal(step(view, "approval").state, "done");
  assert.equal(step(view, "approval").note, "Approved by vaibhav");
});

test("a handoff in flight is not mistaken for a delivery that never started", () => {
  const pending = caseLiveView(
    caseFile({ state: "AWAITING_APPROVAL", verdict: verdict(), handoff: handoff() }),
  );
  assert.equal(step(pending, "delivery").note, "Handing off to the agent");
  assert.equal(step(pending, "delivery").state, "current");

  const submitted = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      verdict: verdict(),
      handoff: handoff({ state: "SUBMITTED" }),
    }),
  );
  assert.equal(step(submitted, "delivery").note, "Handed off, waiting on the agent");

  // No handoff at all is the synthesized path, enqueued inline without the harness.
  const none = caseLiveView(caseFile({ state: "ANALYSIS_ONLY", verdict: verdict() }));
  assert.equal(step(none, "delivery").note, "Not enqueued");
  assert.equal(step(none, "delivery").state, "pending");
});

test("once a delivery exists the handoff has done its job and stops being the story", () => {
  const view = caseLiveView(
    caseFile({
      state: "DELIVERED",
      verdict: verdict(),
      handoff: handoff({ state: "FAILED", attempts: 8, lastError: "a stale error" }),
      delivery: {
        state: "SENT",
        attempts: 1,
        maxAttempts: 8,
        lastError: null,
        target: "issues/18",
        requiresHumanReview: false,
        // A GitHub 201 is itself the receipt, so a sent row is confirmed in the same write.
        deliveredAt: AT,
      },
    }),
  );

  assert.equal(view.failed, false);
  assert.equal(view.stateLabel, "Delivered");
  assert.equal(step(view, "delivery").note, "sent");
  assert.equal(step(view, "delivery").state, "done");
});

test("a turn that errored is not drawn as an investigation that finished", () => {
  // The poller synthesizes an ANALYSIS_ONLY verdict for a dead turn so the report still
  // reaches a reviewer, which is exactly why a verdict existing cannot mean "this went fine".
  const view = caseLiveView(
    caseFile({
      state: "ANALYSIS_ONLY",
      turnStatus: "ERROR",
      sessionError: "TrueForge session or turn was not found: session-1",
      verdict: verdict({ outcome: "ANALYSIS_ONLY" }),
      events: [toolCallEvent(1)],
    }),
  );

  assert.equal(step(view, "investigation").state, "skipped");
  assert.match(step(view, "investigation").note, /^Stopped: TrueForge session or turn was not/);
  assert.equal(view.sessionError, "TrueForge session or turn was not found: session-1");
});

test("a long harness error is trimmed to one line for the row", () => {
  const view = caseLiveView(
    caseFile({
      turnStatus: "ERROR",
      sessionError: `${"x".repeat(200)}\nsecond line`,
      verdict: verdict(),
    }),
  );

  const note = step(view, "investigation").note;
  assert.ok(note.length <= 70, `note was ${note.length} characters`);
  assert.ok(!note.includes("second line"), "only the first line reaches the row");
});

function supersededFile(
  run: { id: string; runNumber: number; status: string; reason: string },
  overrides: Partial<CaseFile> = {},
) {
  // A report just after Ask to re-check: state moved on, the pending tuple is gone, revision 1
  // is dead history, and the fresh run has not drafted anything yet.
  const v = verdict();
  const base = caseFile({
    state: "REPRODUCING",
    turnStatus: "CANCELLED",
    verdict: v,
    verdictHistory: [
      {
        id: v.id,
        revision: 1,
        outcome: v.outcome,
        summary: v.summary,
        createdAt: AT,
        superseded: true,
      },
    ],
    awaitingVerdictId: null,
    events: [toolCallEvent(1)],
    ...overrides,
  });
  return { ...base, latestRun: run };
}

test("a queued re-check is its own visible step, not a done investigation", () => {
  const view = caseLiveView(
    supersededFile({
      id: "00000000-0000-0000-0000-0000000000r2",
      runNumber: 2,
      status: "PENDING",
      reason: "REVIEWER_GUIDANCE",
    }),
  );

  assert.equal(view.steps.length, 5, "the re-check reuses the five rows");
  assert.equal(step(view, "investigation").state, "current");
  assert.equal(step(view, "investigation").note, "Re-check run 2 queued");
  assert.equal(step(view, "verdict").state, "pending");
  assert.equal(step(view, "verdict").note, "Revision 1 superseded, re-check queued");
  assert.equal(step(view, "approval").state, "pending");
  assert.equal(step(view, "approval").note, "Not reached");
  assert.equal(step(view, "delivery").state, "pending");
  assert.equal(view.investigating, false, "a verdict exists, so the shared flag stays false");
});

test("a running re-check reads as running with no approval on offer", () => {
  const view = caseLiveView(
    supersededFile(
      {
        id: "00000000-0000-0000-0000-0000000000r2",
        runNumber: 2,
        status: "RUNNING",
        reason: "REVIEWER_GUIDANCE",
      },
      { turnStatus: "RUNNING" },
    ),
  );

  assert.equal(step(view, "investigation").state, "current");
  assert.equal(step(view, "investigation").note, "Re-check run 2 running");
  assert.equal(step(view, "verdict").note, "Revision 1 superseded, re-check running");
  assert.equal(step(view, "approval").note, "Not reached");
  assert.equal(view.awaitingVerdictId, null);
});

test("a stale pending id behind a re-check never reopens approval", () => {
  // requestRecheck clears the tuple, so any id still present is a stale read. The row must not
  // flip back to Waiting on a reviewer while the fresh run owns the report.
  const v = verdict();
  const view = caseLiveView(
    supersededFile(
      {
        id: "00000000-0000-0000-0000-0000000000r2",
        runNumber: 2,
        status: "PENDING",
        reason: "REVIEWER_GUIDANCE",
      },
      { awaitingVerdictId: v.id },
    ),
  );

  assert.equal(step(view, "approval").state, "pending");
  assert.equal(step(view, "approval").note, "Not reached");
});

test("a failed re-check names the recorded message as plain text", () => {
  const view = caseLiveView(
    supersededFile(
      {
        id: "00000000-0000-0000-0000-0000000000r2",
        runNumber: 2,
        status: "ERROR",
        reason: "REVIEWER_GUIDANCE",
      },
      {
        events: [
          toolCallEvent(1),
          {
            seq: 2,
            type: "agent.recheck_failed",
            channel: "agent",
            data: { message: "sandbox quota spent\nsecond line" },
            eventKey: null,
            at: AT,
          },
        ],
      },
    ),
  );

  assert.equal(step(view, "investigation").state, "skipped");
  assert.equal(
    step(view, "investigation").note,
    "Re-check failed (run 2): sandbox quota spent",
  );
  assert.equal(step(view, "verdict").note, "Revision 1 superseded, re-check failed");
  assert.equal(step(view, "approval").note, "Not reached");
});

test("a failed re-check without an event still reads as failed", () => {
  const view = caseLiveView(
    supersededFile({
      id: "00000000-0000-0000-0000-0000000000r3",
      runNumber: 3,
      status: "ERROR",
      reason: "REVIEWER_GUIDANCE",
    }),
  );

  assert.equal(step(view, "investigation").note, "Re-check failed (run 3)");
  assert.equal(step(view, "investigation").state, "skipped");
});

test("an initial run never reads as a re-check", () => {
  const v = verdict();
  const base = caseFile({
    state: "AWAITING_APPROVAL",
    verdict: v,
    verdictHistory: [
      { id: v.id, revision: 1, outcome: v.outcome, summary: v.summary, createdAt: AT, superseded: false },
    ],
    awaitingVerdictId: v.id,
  });
  const view = caseLiveView({
    ...base,
    latestRun: {
      id: "00000000-0000-0000-0000-0000000000r1",
      runNumber: 1,
      status: "AWAITING_APPROVAL",
      reason: "INITIAL",
    },
  });

  assert.equal(step(view, "investigation").state, "done");
  assert.equal(step(view, "approval").note, "Waiting on a reviewer");
});

test("a guidance run over a current verdict is not a re-check", () => {
  // The supersession link is what makes the on screen verdict history. A run row alone, without
  // it, leaves the normal verdict and approval rows in place.
  const v = verdict();
  const base = caseFile({
    state: "REPRODUCING",
    turnStatus: "RUNNING",
    verdict: v,
    verdictHistory: [
      { id: v.id, revision: 1, outcome: v.outcome, summary: v.summary, createdAt: AT, superseded: false },
    ],
    events: [toolCallEvent(1)],
  });
  const view = caseLiveView({
    ...base,
    latestRun: {
      id: "00000000-0000-0000-0000-0000000000r2",
      runNumber: 2,
      status: "RUNNING",
      reason: "REVIEWER_GUIDANCE",
    },
  });

  assert.equal(step(view, "investigation").note, "1 step recorded");
  assert.equal(step(view, "verdict").note, "Revision 1");
});

test("a superseded verdict hides the header outcome badge until the re-check lands", () => {
  // The board hides the old outcome once a re-check supersedes it. The header must match,
  // or the same report shows a current answer in one place and history in another.
  for (const status of ["PENDING", "RUNNING", "ERROR", "CANCELLED"]) {
    const view = caseLiveView(
      supersededFile(
        {
          id: "00000000-0000-0000-0000-0000000000r2",
          runNumber: 2,
          status,
          reason: "REVIEWER_GUIDANCE",
        },
        status === "CANCELLED" ? { state: "ANALYSIS_ONLY" } : {},
      ),
    );
    assert.equal(view.verdict?.superseded, true);
    assert.equal(view.showOutcomeBadge, false, status);
  }

  const v = verdict();
  const current = caseLiveView(
    caseFile({
      state: "AWAITING_APPROVAL",
      verdict: v,
      verdictHistory: [
        { id: v.id, revision: 1, outcome: v.outcome, summary: v.summary, createdAt: AT, superseded: false },
      ],
      awaitingVerdictId: v.id,
    }),
  );
  assert.equal(current.showOutcomeBadge, true);
});

test("a cancelled re-check parks the report with no current verdict", () => {
  // After cancel the report is ANALYSIS_ONLY and the old verdict is dead history.
  // The lifecycle must name the cancelled run instead of rendering the old revision as done.
  const view = caseLiveView(
    supersededFile(
      {
        id: "00000000-0000-0000-0000-0000000000r2",
        runNumber: 2,
        status: "CANCELLED",
        reason: "REVIEWER_GUIDANCE",
      },
      { state: "ANALYSIS_ONLY" },
    ),
  );

  assert.equal(step(view, "investigation").note, "Re-check cancelled (run 2)");
  assert.equal(step(view, "investigation").state, "skipped");
  assert.equal(step(view, "verdict").note, "Revision 1 superseded, re-check cancelled");
  assert.equal(step(view, "verdict").state, "pending");
  assert.equal(step(view, "approval").note, "Not reached");
  assert.equal(view.showOutcomeBadge, false);
});

test("the summary carries the run id the dialog retries or cancels", () => {
  const runId = "11111111-1111-1111-1111-111111111111";
  const view = caseLiveView(
    supersededFile(
      { id: runId, runNumber: 2, status: "PENDING", reason: "REVIEWER_GUIDANCE" },
      { state: "REPRODUCING" },
    ),
  );

  assert.equal(view.recheckSummary?.runId, runId);
  assert.equal(view.recheckSummary?.runNumber, 2);
});

test("the live view carries the channel, so the approval copy can name where a verdict goes", () => {
  // Without this the components under CaseApproval cannot tell a GitHub report from an email one,
  // which is how "post this comment to the issue" ended up on a working email path.
  assert.equal(caseLiveView(caseFile({ channel: "github" })).channel, "github");
  assert.equal(caseLiveView(caseFile({ channel: "email" })).channel, "email");
});
