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
    state: "TRIAGING",
    createdAt: AT,
    updatedAt: AT,
    turnStatus: null,
    sessionError: null,
    finalSummary: null,
    target: null,
    sandbox: null,
    verdict: null,
    approval: null,
    delivery: null,
    handoff: null,
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
      },
    }),
  );
  assert.equal(exhausted.steps.at(-1)?.note, "failed after 8 attempts");
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
