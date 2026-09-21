import { mascotKeyForState, type MascotKey } from "@/lib/mascot/catalog";
import { isStorageConfigured } from "@/lib/storage/artifacts";
import type { Finding } from "@/lib/mcp/verdict-draft";
import {
  isAgentInvestigating,
  oracleDecided,
  verdictFindings,
  type CaseFile,
} from "@/lib/reports/case-facts";
import type { RecheckSummary } from "@/lib/reports/recheck-summary";
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
  /** The tool's name, and the allowlisted argument preview the poller mirrored, on a tool-call
   *  row. This is what the hover falls back to when the live TrueForge detail is out of reach,
   *  which is every request on the Vercel tier, where the harness is not routable. The same
   *  already-sanitised subset the transcript artifact is built from, so it carries no secret. */
  toolName: string | null;
  argsPreview: string | null;
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
  /** The revision this artifact belongs to. 0 when the row predates verdict linkage. */
  verdictRevision: number;
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
  /** True when a later run superseded this verdict: immutable history, not approvable. */
  superseded: boolean;
  payloadArtifactId: string | null;
  findingsArtifactId: string | null;
};

/** The revision list the artifacts panel groups by; see CaseVerdictHistoryEntry. */
export type CaseVerdictHistoryView = {
  id: string;
  revision: number;
  outcome: string;
  outcomeLabel: string;
  summary: string;
  createdAt: string;
  superseded: boolean;
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
  /** What the re-check dialog shows about the run being superseded. Null when there is no
   * run row or no verdict to summarize, and the dialog falls back to its default text. */
  recheckSummary: RecheckSummary | null;

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
  /** Every revision on record, newest first. Drives the artifacts panel's grouping and the
   * superseded labels, so a reviewer can see which run produced what. */
  verdictHistory: CaseVerdictHistoryView[];
  /** Whether this deployment can store artifact bytes at all right now. An artifact row records
   *  whether its own upload succeeded, and the table is append-only, so a row that missed
   *  storage stays empty for good; this says whether the next one will miss it too, which is
   *  the part an operator can still do something about. */
  storageConfigured: boolean;
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
 * The newest run as the lifecycle reads it. Optional fields keep fixtures written before run
 * timestamps existed typechecking, and the extra columns stay optional here because this file
 * is pure: case.ts owns the database read, this file only branches on what it was given.
 */
type LifecycleRun = {
  id: string;
  runNumber: number;
  status: string;
  reason: string;
  createdAt?: Date;
  updatedAt?: Date;
  attempts?: number;
} | null | undefined;

type LifecycleFile = CaseFile & { latestRun?: LifecycleRun };

/**
 * Whether the verdict on screen is dead history. A re-check supersedes revision 1 without
 * deleting it, so the page keeps showing it while the fresh run works. Without this check the
 * lifecycle would read the old revision as the current answer.
 */
function isSupersededVerdict(file: LifecycleFile): boolean {
  if (!file.verdict) return false;
  return file.verdictHistory.find((entry) => entry.id === file.verdict!.id)?.superseded ?? false;
}

/**
 * The re-check run that owns the lifecycle while it is in flight. Only a REVIEWER_GUIDANCE run
 * over a superseded verdict counts: any other run is either the initial investigation (which the
 * existing verdict and event logic already describes) or a finished run whose verdict is the one
 * on screen.
 */
function activeRecheck(file: LifecycleFile): NonNullable<LifecycleRun> | null {
  const run = file.latestRun ?? null;
  if (!run || run.reason !== "REVIEWER_GUIDANCE") return null;
  if (run.status !== "PENDING" && run.status !== "RUNNING") return null;
  if (!file.verdict || !isSupersededVerdict(file)) return null;
  return run;
}

/** Same gate for a re-check that died. The daemon releases the run as ERROR with no new verdict. */
function failedRecheck(file: LifecycleFile): NonNullable<LifecycleRun> | null {
  const run = file.latestRun ?? null;
  if (!run || run.reason !== "REVIEWER_GUIDANCE") return null;
  if (run.status !== "ERROR") return null;
  if (!file.verdict || !isSupersededVerdict(file)) return null;
  return run;
}

/** Same gate for a re-check the reviewer stopped. Cancel parks the report with no new verdict. */
function cancelledRecheck(file: LifecycleFile): NonNullable<LifecycleRun> | null {
  const run = file.latestRun ?? null;
  if (!run || run.reason !== "REVIEWER_GUIDANCE") return null;
  if (run.status !== "CANCELLED") return null;
  if (!file.verdict || !isSupersededVerdict(file)) return null;
  return run;
}

/**
 * Why a re-check run stopped, on one line.
 *
 * Reads the newest agent.recheck_failed event when one exists. The text is worker output, so it
 * is treated as untrusted plain text like every other event body here: first line only, trimmed,
 * capped, never parsed for a target or tool. Null when no such event was recorded, and the row
 * falls back to the bare failed label.
 */
function recheckFailureDetail(file: LifecycleFile): string | null {
  const found = [...file.events].reverse().find((event) => event.type === "agent.recheck_failed");
  if (!found) return null;
  const data =
    found.data && typeof found.data === "object"
      ? (found.data as { message?: unknown; error?: unknown; lastError?: unknown; reason?: unknown })
      : null;
  const raw = data?.message ?? data?.error ?? data?.lastError ?? data?.reason ?? null;
  if (typeof raw !== "string") return null;
  const line = raw.split("\n")[0].trim();
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The pipeline, and how far this report got through it.
 *
 * Derived from state and from what exists, never from a stored step counter: there is no such
 * column, and inventing one that could drift from the report's own state would make the
 * picture and the truth two different things.
 */
function lifecycle(file: LifecycleFile, investigating: boolean, investigationSteps: number) {
  const past = (states: string[]) => states.includes(file.state);
  const deliveryFailed = file.delivery?.state === "FAILED";

  // A delivery that has burned every attempt is not "retrying", and the row saying so was the
  // only place a stalled report explained itself. Nothing moves it again without a human.
  const deliveryExhausted =
    deliveryFailed && (file.delivery?.attempts ?? 0) >= (file.delivery?.maxAttempts ?? 0);

  const handoff = file.handoff;
  const handoffDead = handoffExhausted(file);
  // A denial posts nothing, so the delivery row must never read as in flight for
  // one: the deny relay to the harness is a handoff, not an outbound comment, and
  // while it is pending the row below would otherwise say "Handing off".
  const denied = file.approval?.decision === "DENIED";

  // A re-check supersedes the verdict on screen without deleting it. The newest verdict is still
  // revision 1, so without this branch a REPRODUCING report with a PENDING run would render
  // "Investigation done" and "Revision 1, done" while nothing is actually decided.
  const recheck = activeRecheck(file);
  const recheckFailed = failedRecheck(file);
  const recheckCancelled = cancelledRecheck(file);
  const recheckActive = recheck !== null;
  const recheckOver = recheckFailed !== null || recheckCancelled !== null;
  const failureDetail = recheckFailed ? recheckFailureDetail(file) : null;
  const recheckNote = recheck
    ? `Re-check run ${recheck.runNumber} ${recheck.status === "PENDING" ? "queued" : "running"}`
    : recheckFailed
      ? failureDetail
        ? `Re-check failed (run ${recheckFailed.runNumber}): ${failureDetail}`
        : `Re-check failed (run ${recheckFailed.runNumber})`
      : recheckCancelled
        ? `Re-check cancelled (run ${recheckCancelled.runNumber})`
        : null;

  // While a re-check owns the report there is nothing to approve: requestRecheck clears the
  // pending tuple, so any awaiting id here would be stale. The row stays "Not reached" until the
  // fresh run drafts its own revision.
  const approvalBlocked = recheckActive || recheckOver;

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
      // verdict here. A re-check outranks both: the superseded verdict is history, and the fresh
      // run is the work being watched.
      note:
        recheckNote ??
        (turnErrored(file)
          ? stoppedNote(file.sessionError)
          : file.verdict
            ? `${investigationSteps} ${investigationSteps === 1 ? "step" : "steps"} recorded`
            : investigating
              ? "In progress"
              : "Not started"),
      // Otherwise done the moment a verdict exists: the live path mints revision 1 only once
      // the agent calls publish_verdict, which is also the last thing that happens in its turn
      // (see lib/mcp/publish-verdict.ts), so a verdict existing means the turn is over.
      state:
        recheckActive
          ? ("current" as const)
          : recheckOver
            ? ("skipped" as const)
            : turnErrored(file)
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
      note:
        recheck && file.verdict
          ? `Revision ${file.verdict.revision} superseded, re-check ${recheck.status === "PENDING" ? "queued" : "running"}`
          : recheckFailed && file.verdict
            ? `Revision ${file.verdict.revision} superseded, re-check failed`
            : recheckCancelled && file.verdict
              ? `Revision ${file.verdict.revision} superseded, re-check cancelled`
              : file.verdict
                ? `Revision ${file.verdict.revision}`
                : "None yet",
      state:
        recheckActive || recheckOver
          ? ("pending" as const)
          : file.verdict
            ? ("done" as const)
            : ("pending" as const),
    },
    {
      key: "approval",
      label: "Human approval",
      note: approvalBlocked
        ? "Not reached"
        : file.approval
          ? `${file.approval.decision === "APPROVED" ? "Approved" : "Denied"} by ${file.approval.reviewer}`
          : file.awaitingVerdictId
            ? "Waiting on a reviewer"
            : "Not reached",
      state: approvalBlocked
        ? ("pending" as const)
        : file.approval
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
      note: denied
        ? "Denied, nothing posted"
        : deliveryExhausted
          ? `failed after ${file.delivery?.attempts} attempts`
          : deliveryFailed
            ? `failed, retrying (${file.delivery?.attempts}/${file.delivery?.maxAttempts})`
            : file.delivery
              ? file.delivery.state.toLowerCase()
              : approvalBlocked
                ? "Not enqueued"
                : // No delivery row yet. On the harness-backed path that is not necessarily "not
                  // started": the handoff has to reach TrueForge and come back through
                  // publish_verdict before an outbox row exists at all, so a handoff that died
                  // leaves this step honestly reporting "Not enqueued" forever.
                  handoffNote(handoff) ?? "Not enqueued",
      state:
        denied || deliveryFailed || handoffDead
          ? ("skipped" as const)
          : // A re-check owns the report, so a stale handoff must not read as in flight.
            approvalBlocked && !file.delivery
            ? ("pending" as const)
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

/**
 * What the re-check dialog shows about the run being superseded.
 *
 * Null when there is no run row or no verdict, so the dialog falls back to its default
 * text. Only plain counts and truncated titles cross into the view, never argument previews
 * or sandbox output: reviewer text and sandbox output are untrusted, and must never select
 * a target, tool or scope.
 */
function recheckSummaryFor(
  file: CaseFile & {
    latestRun?: LifecycleRun;
  },
  investigationSteps: number,
): RecheckSummary | null {
  // latestRun is optional so pure fixtures built before run rows existed still typecheck.
  // Missing counts as no run.
  const run = file.latestRun ?? null;
  const current = file.verdict;
  if (!run || !current) return null;

  // Mirrored tool-call events carry the tool name on data. Both target probes count as one
  // capability from a reviewer's view; an exact list keeps an unknown tool name out of the count.
  const probeCount = file.events.filter((event) => {
    if (event.channel !== "agent") return false;
    const data =
      event.data && typeof event.data === "object"
        ? (event.data as { toolName?: unknown })
        : null;
    return data?.toolName === "probe_target" || data?.toolName === "probe_target_write";
  }).length;

  const findings = verdictFindings(current.evidence)
    .slice(0, 5)
    .map((finding) => ({
      title: finding.title.slice(0, 120),
      severity: finding.severity,
    }));

  const last = file.events.length > 0 ? file.events[file.events.length - 1] : null;

  return {
    runId: run.id,
    runNumber: run.runNumber,
    runStatus: run.status,
    runReason: run.reason,
    verdictRevision: current.revision,
    outcome: current.outcome,
    probeCount,
    eventCount: investigationSteps,
    artifactCount: file.artifacts.length,
    findings,
    lastEventAt: last ? last.at.toISOString().slice(11, 19) : null,
  };
}

export function caseLiveView(
  file: CaseFile & {
    latestRun?: LifecycleRun;
  },
): CaseLiveView {
  const deliveryState = file.delivery?.state ?? null;
  const verdictOutcome = file.verdict?.outcome ?? null;

  // The step's own step log, not the dead REPRODUCING report state: nothing transitions into
  // REPRODUCING under the agent-authored model, so a step fed from it would sit on "Coming
  // soon" for every real run. Fed instead from the poller's mirrored tool-call events
  // (EVENT_PHASE's "agent" entry) and the session's own turnStatus, both of which move during
  // a live investigation.
  const investigationSteps = file.events.filter((e) => e.channel === "agent").length;
  // Unchanged for a re-check: a superseded verdict still counts as a verdict here, so this stays
  // false while the fresh run works. The lifecycle above names the re-check from latestRun
  // instead, which keeps this flag consistent with the board badge while the status poll behind
  // a REPRODUCING report keeps asking.
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
    const mirrored =
      event.data && typeof event.data === "object"
        ? (event.data as { toolName?: unknown; argumentsPreview?: unknown })
        : {};
    bucket.push({
      seq: event.seq,
      type: event.type,
      at: event.at.toISOString().slice(11, 19),
      eventKey: event.eventKey,
      toolName: typeof mirrored.toolName === "string" ? mirrored.toolName : null,
      argsPreview: typeof mirrored.argumentsPreview === "string" ? mirrored.argumentsPreview : null,
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
    // Same superseded flag the board passes, so a re-check hides the old outcome here too.
    showOutcomeBadge: verdictOutcome
      ? shouldShowOutcomeBadge(file.state, verdictOutcome, {
          superseded: isSupersededVerdict(file),
        })
      : false,
    approvalDecision: file.approval?.decision ?? null,
    awaitingVerdictId: file.awaitingVerdictId,
    recheckSummary: recheckSummaryFor(file, investigationSteps),

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
          superseded:
            file.verdictHistory.find((v) => v.id === file.verdict!.id)?.superseded ?? false,
          // The stored exact-comment artifact for THIS verdict, when the post-commit recorder
          // managed to write it. The download prefers its signed URL and falls back to the
          // payload text. Scoped to this verdict's rows, never the first verdict-payload on
          // file: a re-check run means several revisions share the report.
          payloadArtifactId:
            file.artifacts.find(
              (art) => art.kind === "verdict-payload" && art.verdictId === file.verdict!.id,
            )?.id ?? null,
          // What the findings table and the sheet offer in place of the evidence reference the
          // agent cited. Only when the bytes actually landed: artifact recording is best-effort
          // and writes a row with no stored path when storage is off or an upload failed, and a
          // download keyed to such a row would only error. Null here makes the views fall back
          // to showing the reference inline, so a reviewer is never left with neither.
          findingsArtifactId:
            file.artifacts.find(
              (art) =>
                art.kind === "findings-evidence" &&
                art.stored &&
                art.verdictId === file.verdict!.id,
            )?.id ?? null,
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
    storageConfigured: isStorageConfigured(),
    artifacts: file.artifacts.map((art) => ({
      id: art.id,
      kind: art.kind,
      sha256: art.sha256,
      bytes: art.bytes,
      contentType: art.contentType,
      stored: art.stored,
      verdictRevision: art.verdictRevision,
    })),
    // Serialized at the same moment as everything else on this view, so the revision the
    // artifacts panel groups by never disagrees with the verdict card beside it.
    verdictHistory: file.verdictHistory.map((v) => ({
      id: v.id,
      revision: v.revision,
      outcome: v.outcome,
      outcomeLabel: outcomeLabel(v.outcome),
      summary: v.summary,
      createdAt: v.createdAt.toISOString(),
      superseded: v.superseded,
    })),
  };
}
