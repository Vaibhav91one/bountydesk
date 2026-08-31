import { mascotKeyForState, type MascotKey } from "@/lib/mascot/catalog";
import type { Finding } from "@/lib/mcp/verdict-draft";
import {
  isAgentInvestigating,
  oracleDecided,
  verdictFindings,
  type CaseFile,
} from "@/lib/reports/case-facts";
import { phaseOf } from "@/lib/reports/columns";
import {
  outcomeLabel,
  reportStateLabel,
  shouldShowOutcomeBadge,
} from "@/lib/reports/labels";

/**
 * Everything on a case file that can change while a reviewer is looking at it, as plain JSON.
 *
 * One derivation, read by two callers: the server component builds it once for first paint, and
 * GET /api/reports/[id]/status returns the same shape for the poll behind it. That is the whole
 * point of the file. When the page derived its own lifecycle rows and the endpoint derived its
 * own badge labels, the two could disagree, and for a while they did: the badge said Approved
 * while the Human approval row still said "Waiting on a reviewer", because only one of them had
 * been taught about a decision that had landed.
 *
 * Everything here is a pure function of CaseFile. Nothing reads the database, nothing reaches
 * TrueForge, and nothing decides anything: the approval gate re-reads and locks its own rows in
 * app/review/actions.ts at the moment it matters. A field here is a claim about the last read.
 */

/** A lifecycle event as the list renders it. `detail` is merged in client-side, by eventKey. */
export type LifecycleEventView = {
  seq: number;
  type: string;
  /** HH:MM:SS. Cut server-side so the row does not depend on the reader's clock. */
  at: string;
  /** "agent.tool_call:<trueforge id>" on a mirrored tool call, null on everything else. */
  eventKey: string | null;
};

export type StepState = "done" | "current" | "pending" | "skipped";

export type LifecycleStepView = {
  key: string;
  label: string;
  note: string;
  state: StepState;
  /** A mascot key, not markup: components/animated-mascot-svg.tsx fetches the artwork itself. */
  mascot: MascotKey;
  events: LifecycleEventView[];
};

export type CaseArtifactView = {
  id: string;
  kind: string;
  sha256: string;
  bytes: number;
  contentType: string;
  stored: boolean;
};

export type CaseVerdictView = {
  id: string;
  outcome: string;
  outcomeLabel: string;
  summary: string;
  payload: string;
  contentHash: string;
  revision: number;
  findings: Finding[];
  /** "Agent Bounty says" or "The oracle says". See draftedByAgent below. */
  verdictLabel: string;
  reproductionRan: boolean;
  payloadArtifactId: string | null;
};

export type CaseLiveView = {
  id: string;
  state: string;
  phase: string;
  stateLabel: string;
  updatedAt: string;

  mascotKey: MascotKey;
  investigating: boolean;
  turnStatus: string | null;
  /** Why the turn stopped, when it stopped badly. The lifecycle row shows a trimmed line. */
  sessionError: string | null;
  eventCount: number;

  /**
   * The pipeline stopped somewhere and will not start again on its own.
   *
   * True for a delivery that spent its attempts and for a handoff that did, which are two
   * different places a run can die with the same consequence for a reviewer. The badge reads
   * this rather than the delivery state alone, so a stalled report cannot present itself as
   * merely in progress.
   */
  failed: boolean;

  deliveryState: string | null;
  verdictOutcome: string | null;
  outcomeLabel: string | null;
  showOutcomeBadge: boolean;
  approvalDecision: string | null;
  awaitingVerdictId: string | null;

  target: { name: string; imageDigest: string } | null;
  sandbox: { id: string; appPort: number | null } | null;
  finalSummary: string | null;
  destination: string;

  verdict: CaseVerdictView | null;
  approval: {
    decision: string;
    reviewer: string;
    note: string | null;
    decidedAt: string;
  } | null;
  delivery: {
    state: string;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    target: string;
  } | null;
  handoff: CaseFile["handoff"];

  steps: LifecycleStepView[];
  artifacts: CaseArtifactView[];
};

/**
 * Which lifecycle step an event belongs to, by the prefix its type carries.
 *
 * Anything unrecognised falls to the step the report is currently in rather than being
 * dropped. An event nobody placed is still an event that happened, and a log that quietly
 * loses lines is worse than one with a line in the wrong place.
 */
const EVENT_PHASE: Record<string, string> = {
  intake: "intake",
  sandbox: "investigation",
  repro: "investigation",
  // The poller's mirrored tool-call events (lib/agent-sessions/poller.ts), type
  // "agent.tool_call:<toolName>". This is what actually populates the investigation step
  // during a live run, ahead of any sandbox/repro events the deterministic pipeline would add.
  agent: "investigation",
  analysis: "verdict",
  verdict: "verdict",
  approval: "approval",
  delivery: "delivery",
  target: "investigation",
};

const TERMINAL = ["DELIVERED", "DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];

/** A turn the poller gave up on. It writes the reason beside this status, never on its own. */
function turnErrored(file: CaseFile): boolean {
  return file.turnStatus === "ERROR";
}

/**
 * The handoff has spent its whole retry budget, so no worker will pick it up again.
 *
 * Deliberately not "state is FAILED". The submission worker writes FAILED with attempts left on
 * an error it judges unrepairable, and such a row is still claimable, so treating every FAILED
 * as final would tell a reviewer the run is dead while it is in fact about to try again. The
 * arithmetic is what the queue's own claim predicate uses.
 */
function handoffExhausted(file: CaseFile): boolean {
  const handoff = file.handoff;
  if (!handoff || handoff.state !== "FAILED") return false;

  return handoff.attempts >= handoff.maxAttempts && !file.delivery;
}

/** What the delivery step says while the decision is still on its way to the harness. */
function handoffNote(handoff: CaseFile["handoff"]): string | null {
  if (!handoff) return null;

  if (handoff.state === "FAILED") {
    return handoff.attempts >= handoff.maxAttempts
      ? `handoff failed after ${handoff.attempts} attempts`
      : `handoff failed, retrying (${handoff.attempts}/${handoff.maxAttempts})`;
  }

  if (handoff.state === "PENDING" && handoff.attempts > 0) {
    return `handing off, retrying (${handoff.attempts}/${handoff.maxAttempts})`;
  }

  return handoff.state === "PENDING"
    ? "Handing off to the agent"
    : "Handed off, waiting on the agent";
}

/**
 * The reason a turn stopped, on one line.
 *
 * The text is a harness error message, so its length is not ours to predict and a lifecycle row
 * is a single line. The whole message is not lost: it is on the view for anywhere that wants to
 * show it in full.
 */
function stoppedNote(sessionError: string | null): string {
  if (!sessionError) return "Stopped early";

  const line = sessionError.split("\n")[0].trim();
  return `Stopped: ${line.length > 60 ? `${line.slice(0, 59)}\u2026` : line}`;
}

/**
 * Which mascot stands for a lifecycle row.
 *
 * Keyed to the row and to what the record says happened in it, so a reproduction that never
 * ran and one that is running do not draw the same picture, and no two rows in the list carry
 * the same one. Drafting a verdict borrows scanning, because no mascot exists for it yet.
 */
function stepMascot(key: string, state: StepState, file: CaseFile): MascotKey {
  if (key === "intake") return "ingest";
  if (key === "investigation") {
    // idle when it has not been reached: scanning belongs to the verdict row below, and two
    // rows carrying the same picture is what made this list read as one repeated step.
    return state === "current" ? "reproducing" : state === "skipped" ? "infra-hiccup" : "idle";
  }
  if (key === "verdict") return "scanning";
  if (key === "approval") {
    return file.approval?.decision === "DENIED" ? "denied" : "awaiting-approval";
  }
  return state === "done" ? "celebrating" : "delivered";
}

/**
 * The pipeline, and how far this report got through it.
 *
 * Derived from state and from what exists, never from a stored step counter: there is no such
 * column, and inventing one that could drift from the report's own state would make the
 * picture and the truth two different things.
 */
function lifecycle(file: CaseFile, investigating: boolean, investigationSteps: number) {
  const past = (states: string[]) => states.includes(file.state);
  const deliveryFailed = file.delivery?.state === "FAILED";

  // A delivery that has burned every attempt is not "retrying", and the row saying so was the
  // only place a stalled report explained itself. Nothing moves it again without a human.
  const deliveryExhausted =
    deliveryFailed && (file.delivery?.attempts ?? 0) >= (file.delivery?.maxAttempts ?? 0);

  const handoff = file.handoff;
  const handoffDead = handoffExhausted(file);

  return [
    {
      key: "intake",
      label: "Intake",
      note: file.target ? "Authenticated, target bound" : "Authenticated, no target bound",
      state: "done" as const,
    },
    {
      key: "investigation",
      label: "Investigation",
      // A turn that errored still leaves a verdict behind: the poller synthesizes an
      // ANALYSIS_ONLY one so the report reaches a reviewer rather than vanishing. That made a
      // crashed run and a finished run draw the same row, which is why the error outranks the
      // verdict here.
      note: turnErrored(file)
        ? stoppedNote(file.sessionError)
        : file.verdict
          ? `${investigationSteps} ${investigationSteps === 1 ? "step" : "steps"} recorded`
          : investigating
            ? "In progress"
            : "Not started",
      // Otherwise done the moment a verdict exists: the live path mints revision 1 only once
      // the agent calls publish_verdict, which is also the last thing that happens in its turn
      // (see lib/mcp/publish-verdict.ts), so a verdict existing means the turn is over.
      state: turnErrored(file)
        ? ("skipped" as const)
        : file.verdict
          ? ("done" as const)
          : investigating
            ? ("current" as const)
            : ("pending" as const),
    },
    {
      key: "verdict",
      label: "Verdict drafted",
      note: file.verdict ? `Revision ${file.verdict.revision}` : "None yet",
      state: file.verdict ? ("done" as const) : ("pending" as const),
    },
    {
      key: "approval",
      label: "Human approval",
      note: file.approval
        ? `${file.approval.decision === "APPROVED" ? "Approved" : "Denied"} by ${file.approval.reviewer}`
        : file.awaitingVerdictId
          ? "Waiting on a reviewer"
          : "Not reached",
      state: file.approval
        ? ("done" as const)
        : file.awaitingVerdictId || past(["AWAITING_APPROVAL"])
          ? ("current" as const)
          : ("pending" as const),
    },
    {
      key: "delivery",
      // The send failed and the outbox will not try again, so the row says which of the two it
      // is. Reading "failed" beside a counter that has stopped is the difference between a
      // report that is still working and one that is waiting on somebody.
      label: "Delivery",
      note: deliveryExhausted
        ? `failed after ${file.delivery?.attempts} attempts`
        : deliveryFailed
          ? `failed, retrying (${file.delivery?.attempts}/${file.delivery?.maxAttempts})`
          : file.delivery
            ? file.delivery.state.toLowerCase()
            : // No delivery row yet. On the harness-backed path that is not necessarily "not
              // started": the handoff has to reach TrueForge and come back through
              // publish_verdict before an outbox row exists at all, so a handoff that died
              // leaves this step honestly reporting "Not enqueued" forever.
              handoffNote(handoff) ?? "Not enqueued",
      state: deliveryFailed || handoffDead
        ? ("skipped" as const)
        : // A handoff still in flight, including one that failed but has attempts left. Once a
          // delivery row exists the handoff has done its job and the outbox is the story.
          handoff && !file.delivery
          ? ("current" as const)
          : file.state === "DELIVERED"
            ? ("done" as const)
            : file.state === "DELIVERING"
              ? ("current" as const)
              : past(TERMINAL)
                ? ("skipped" as const)
                : ("pending" as const),
    },
  ];
}

/**
 * The label on the state badge.
 *
 * AWAITING_APPROVAL with a recorded decision reads "Approved" rather than "Awaiting approval".
 * The report genuinely still sits in AWAITING_APPROVAL for the moment between the decision
 * committing and the submission worker moving it to DELIVERING, and a reviewer who has just
 * signed should not be told their own click did not happen.
 */
function caseStateLabel(file: CaseFile, deliveryState: string | null): string {
  // Ahead of the approved-but-not-yet-delivering case below: a report whose handoff died is
  // also AWAITING_APPROVAL with an APPROVED decision on it, and "Approved" is exactly the
  // reading that made a permanently stuck report look like one that was still moving.
  if (handoffExhausted(file)) return "Failed";

  if (file.state === "AWAITING_APPROVAL" && file.approval?.decision === "APPROVED") {
    return "Approved";
  }
  return reportStateLabel(file.state, deliveryState);
}

export function caseLiveView(file: CaseFile): CaseLiveView {
  const deliveryState = file.delivery?.state ?? null;
  const verdictOutcome = file.verdict?.outcome ?? null;

  // The step's own step log, not the dead REPRODUCING report state: nothing transitions into
  // REPRODUCING under the agent-authored model, so a step fed from it would sit on "Coming
  // soon" for every real run. Fed instead from the poller's mirrored tool-call events
  // (EVENT_PHASE's "agent" entry) and the session's own turnStatus, both of which move during
  // a live investigation.
  const investigationSteps = file.events.filter((e) => e.channel === "agent").length;
  const investigating = isAgentInvestigating(
    file.turnStatus,
    file.verdict !== null,
    investigationSteps > 0,
  );

  // Events, grouped onto the step they belong to. The fallback step is the one matching the
  // report's own state, so an unknown prefix lands somewhere a reader would look for it.
  const fallback =
    file.state === "TRIAGING"
      ? "intake"
      : file.state === "REPRODUCING"
        ? "investigation"
        : file.state === "DELIVERING" || file.state === "DELIVERED"
          ? "delivery"
          : "verdict";

  const eventsByStep = new Map<string, LifecycleEventView[]>();
  for (const event of file.events) {
    const key = EVENT_PHASE[event.channel] ?? fallback;
    const bucket = eventsByStep.get(key) ?? [];
    bucket.push({
      seq: event.seq,
      type: event.type,
      at: event.at.toISOString().slice(11, 19),
      eventKey: event.eventKey,
    });
    eventsByStep.set(key, bucket);
  }

  const steps: LifecycleStepView[] = lifecycle(file, investigating, investigationSteps).map(
    (step) => ({
      ...step,
      mascot: stepMascot(step.key, step.state, file),
      events: eventsByStep.get(step.key) ?? [],
    }),
  );

  // Fail closed: only a recorded oracle result earns the oracle's name on the label. Anything
  // else, including evidence nobody recognises, is Agent Bounty speaking for itself. Agent
  // Bounty drafts every verdict today (docs/decisions.md Q22); the canary/oracle pipeline in
  // lib/sandbox/reproduce.ts is a stronger optional evidence source, and when a verdict's
  // evidence positively records one, the label credits it instead.
  const draftedByAgent = !file.verdict || !oracleDecided(file.verdict.evidence);

  return {
    id: file.id,
    state: file.state,
    phase: phaseOf(file.state),
    stateLabel: caseStateLabel(file, deliveryState),
    updatedAt: file.updatedAt.toISOString(),

    mascotKey: mascotKeyForState(file.state),
    investigating,
    turnStatus: file.turnStatus,
    sessionError: file.sessionError,
    eventCount: file.events.length,
    failed:
      (deliveryState === "FAILED" &&
        (file.delivery?.attempts ?? 0) >= (file.delivery?.maxAttempts ?? 0)) ||
      handoffExhausted(file),

    deliveryState,
    verdictOutcome,
    outcomeLabel: verdictOutcome ? outcomeLabel(verdictOutcome) : null,
    showOutcomeBadge: verdictOutcome
      ? shouldShowOutcomeBadge(file.state, verdictOutcome)
      : false,
    approvalDecision: file.approval?.decision ?? null,
    awaitingVerdictId: file.awaitingVerdictId,

    target: file.target,
    sandbox: file.sandbox,
    finalSummary: file.finalSummary,
    destination: file.delivery?.target ?? file.issueUrl ?? file.sourceLabel,

    verdict: file.verdict
      ? {
          id: file.verdict.id,
          outcome: file.verdict.outcome,
          outcomeLabel: outcomeLabel(file.verdict.outcome),
          summary: file.verdict.summary,
          payload: file.verdict.payload,
          contentHash: file.verdict.contentHash,
          revision: file.verdict.revision,
          findings: verdictFindings(file.verdict.evidence),
          verdictLabel: draftedByAgent ? "Agent Bounty says" : "The oracle says",
          reproductionRan: !draftedByAgent,
          // The stored exact-comment artifact, when the post-commit recorder managed to write
          // it. The download prefers its signed URL and falls back to the payload text.
          payloadArtifactId:
            file.artifacts.find((art) => art.kind === "verdict-payload")?.id ?? null,
        }
      : null,

    approval: file.approval
      ? {
          decision: file.approval.decision,
          reviewer: file.approval.reviewer,
          note: file.approval.note,
          decidedAt: file.approval.decidedAt.toISOString(),
        }
      : null,

    delivery: file.delivery,
    handoff: file.handoff,

    steps,
    artifacts: file.artifacts.map((art) => ({
      id: art.id,
      kind: art.kind,
      sha256: art.sha256,
      bytes: art.bytes,
      contentType: art.contentType,
      stored: art.stored,
    })),
  };
}
