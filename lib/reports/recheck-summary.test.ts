import assert from "node:assert/strict";
import { test } from "node:test";

import { caseLiveView } from "./case-view";
import type { CaseFile } from "./case-facts";

/**
 * The re-check summary is plain data for the dialog, derived from rows the page already
 * loads. Pure: no database, no harness, no clock.
 */

const AT = new Date("2026-08-31T12:00:00Z");
const LATER = new Date("2026-08-31T12:04:05Z");

type FileWithRun = CaseFile & {
  latestRun:
    | {
        id: string;
        runNumber: number;
        status: string;
        reason: string;
        createdAt?: Date;
        updatedAt?: Date;
        attempts?: number;
      }
    | null;
};

function caseFile(overrides: Partial<FileWithRun> = {}): FileWithRun {
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
    state: "AWAITING_APPROVAL",
    createdAt: AT,
    updatedAt: AT,
    turnStatus: "AWAITING_APPROVAL_HARNESS",
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
    latestRun: null,
    ...overrides,
  };
}

function finding(title: string, severity = "high") {
  return { title, severity, description: "what the agent saw", evidenceRef: "body:1" };
}

function verdictWithFindings(titles: string[]) {
  return {
    id: "00000000-0000-0000-0000-0000000000v2",
    outcome: "REPRODUCED",
    summary: "The payload executes.",
    payload: "comment body",
    contentHash: "abc123",
    revision: 2,
    evidence: { source: "agent-drafted", findings: titles.map((title) => finding(title)) },
    createdAt: AT,
  };
}

function agentEvent(seq: number, toolName: string, at: Date = AT) {
  return {
    seq,
    type: `agent.tool_call:${toolName}`,
    channel: "agent",
    data: { toolName, argumentsPreview: `{"call":${seq}}` },
    eventKey: `agent.tool_call:call-${seq}`,
    at,
  };
}

test("a pending run summarizes probes, caps findings, and names the last event time", () => {
  const longTitle = "t".repeat(150);
  const view = caseLiveView(
    caseFile({
      latestRun: {
        id: "00000000-0000-0000-0000-0000000000r1",
        runNumber: 1,
        status: "AWAITING_APPROVAL",
        reason: "INITIAL",
      },
      verdict: verdictWithFindings([longTitle, "second", "third", "fourth", "fifth", "sixth", "seventh"]),
      awaitingVerdictId: "00000000-0000-0000-0000-0000000000v2",
      events: [
        agentEvent(1, "probe_target"),
        agentEvent(2, "probe_target_write"),
        agentEvent(3, "read_file"),
        // Same tool name outside the mirrored agent channel is not a probe the agent ran.
        { seq: 4, type: "sandbox.note", channel: "sandbox", data: { toolName: "probe_target" }, eventKey: null, at: LATER },
      ],
      artifacts: [
        {
          id: "a1",
          kind: "transcript",
          sha256: "deadbeef",
          bytes: 42,
          contentType: "text/plain",
          stored: true,
          createdAt: AT,
          verdictId: "00000000-0000-0000-0000-0000000000v2",
          verdictRevision: 2,
        },
        {
          id: "a2",
          kind: "transcript",
          sha256: "beef",
          bytes: 10,
          contentType: "text/plain",
          stored: false,
          createdAt: AT,
          verdictId: null,
          verdictRevision: 0,
        },
      ],
    }),
  );

  const summary = view.recheckSummary;
  assert.ok(summary, "a run with a verdict has a summary");
  assert.equal(summary.runId, "00000000-0000-0000-0000-0000000000r1");
  assert.equal(summary.runNumber, 1);
  assert.equal(summary.runStatus, "AWAITING_APPROVAL");
  assert.equal(summary.runReason, "INITIAL");
  assert.equal(summary.verdictRevision, 2);
  assert.equal(summary.outcome, "REPRODUCED");
  assert.equal(summary.probeCount, 2);
  assert.equal(summary.eventCount, 3);
  assert.equal(summary.artifactCount, 2);
  assert.equal(summary.findings.length, 5);
  assert.deepEqual(
    summary.findings.map((entry) => entry.title),
    [longTitle.slice(0, 120), "second", "third", "fourth", "fifth"],
  );
  assert.equal(summary.findings[0].title.length, 120);
  assert.equal(summary.findings[0].severity, "high");
  assert.equal(summary.lastEventAt, LATER.toISOString().slice(11, 19));

  // The summary carries counts and truncated titles only, never the mirrored previews.
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  assert.ok(!JSON.stringify(summary).includes("call"));
});

test("the initial run summarizes from its verdict without a run row", () => {
  const view = caseLiveView(
    caseFile({
      latestRun: null,
      verdict: verdictWithFindings(["only"]),
      awaitingVerdictId: "00000000-0000-0000-0000-0000000000v2",
    }),
  );

  assert.equal(view.recheckSummary?.runId, null);
  assert.equal(view.recheckSummary?.runNumber, 1);
  assert.equal(view.recheckSummary?.runStatus, "COMPLETED");
  assert.equal(view.recheckSummary?.runReason, "INITIAL");
});

test("there is no summary without a verdict", () => {
  const withRunNoVerdict = caseLiveView(
    caseFile({
      latestRun: {
        id: "00000000-0000-0000-0000-0000000000r1",
        runNumber: 1,
        status: "AWAITING_APPROVAL",
        reason: "INITIAL",
      },
      verdict: null,
      awaitingVerdictId: null,
    }),
  );
  assert.equal(withRunNoVerdict.recheckSummary, null);
});

test("no events means zero counts and no last event time", () => {
  const view = caseLiveView(
    caseFile({
      latestRun: {
        id: "00000000-0000-0000-0000-0000000000r3",
        runNumber: 3,
        status: "RUNNING",
        reason: "REVIEWER_GUIDANCE",
      },
      verdict: verdictWithFindings([]),
      awaitingVerdictId: "00000000-0000-0000-0000-0000000000v2",
      events: [],
      artifacts: [],
    }),
  );

  assert.deepEqual(view.recheckSummary, {
    runId: "00000000-0000-0000-0000-0000000000r3",
    runNumber: 3,
    runStatus: "RUNNING",
    runReason: "REVIEWER_GUIDANCE",
    verdictRevision: 2,
    outcome: "REPRODUCED",
    probeCount: 0,
    eventCount: 0,
    artifactCount: 0,
    findings: [],
    lastEventAt: null,
  });
});

test("run timestamps and attempts ride along without changing the summary", () => {
  // readCase now selects createdAt, updatedAt and attempts so a stuck re-check is describable
  // without a second query. The dialog only needs the counts, so the extra columns must not
  // change what it shows.
  const view = caseLiveView(
    caseFile({
      latestRun: {
        id: "00000000-0000-0000-0000-0000000000r2",
        runNumber: 2,
        status: "PENDING",
        reason: "REVIEWER_GUIDANCE",
        createdAt: AT,
        updatedAt: LATER,
        attempts: 3,
      },
      verdict: verdictWithFindings([]),
      events: [],
      artifacts: [],
    }),
  );

  assert.equal(view.recheckSummary?.runId, "00000000-0000-0000-0000-0000000000r2");
  assert.equal(view.recheckSummary?.runNumber, 2);
  assert.equal(view.recheckSummary?.runStatus, "PENDING");
  assert.equal(view.recheckSummary?.runReason, "REVIEWER_GUIDANCE");
});
