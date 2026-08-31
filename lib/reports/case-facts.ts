import { findingSchema, type Finding } from "@/lib/mcp/verdict-draft";
import type { ReportState } from "@/lib/reports/states";

/**
 * The shape of a case file, and the questions that can be answered from one without asking the
 * database anything.
 *
 * Split out of case.ts, which opens a connection pool at module load, for the same reason
 * columns.ts was split out of queue.ts: these are the definitions the derived view and its
 * tests need, and pulling the pg driver in behind them made a pure function untestable without
 * a database and unimportable from a client bundle. case.ts re-exports all of it, so every
 * existing import still resolves.
 */

export type CaseEvent = {
  seq: number;
  type: string;
  /** intake, worker, sandbox, oracle, control. Taken from the type's first segment. */
  channel: string;
  data: unknown;
  // The event's idempotency key. A mirrored tool call carries "agent.tool_call:<call id>" here,
  // which is how a lifecycle row is matched to its live TrueForge detail: the row's type only
  // holds the tool name, the id lives on this key. Null for events written without one.
  eventKey: string | null;
  at: Date;
};

export type CaseVerdict = {
  id: string;
  outcome: string;
  summary: string;
  payload: string;
  contentHash: string;
  revision: number;
  /** Whatever the driver recorded. Today: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" }. */
  evidence: unknown;
  createdAt: Date;
};

export type CaseFile = {
  id: string;
  title: string;
  body: string;
  channel: string;
  sourceRef: string;
  sourceLabel: string;
  /** The issue number alone, for the GitHub-style "title #482". Null off GitHub. */
  issueNumber: string | null;
  /** Null unless the source is a GitHub issue on a repository still connected. */
  issueUrl: string | null;
  repositoryFullName: string | null;
  repositoryUrl: string | null;
  reporterHandle: string | null;
  /** The reporter's GitHub profile, and their avatar. Null when the handle is not a login. */
  reporterUrl: string | null;
  reporterAvatarUrl: string | null;
  state: ReportState;
  createdAt: Date;
  updatedAt: Date;
  /** Local agent-session bookkeeping, never a report state (see lib/db/schema.ts on
   * agentSession): RUNNING | INVESTIGATING | AWAITING_APPROVAL_HARNESS | DONE_NO_ACTION |
   * ERROR | CANCELLED. Null when no session exists yet for this report. */
  turnStatus: string | null;
  /** Why the session stopped, when it stopped badly. Written by the poller alongside a
   * turnStatus of ERROR (lib/agent-sessions/poller.ts). Null on a run that went fine. */
  sessionError: string | null;
  /** The agent's own closing message for this investigation (reproduction steps, finding,
   * remediation), captured by the poller. Null until a turn produces one. Rendered as text, never
   * HTML, and never the outbound comment. */
  finalSummary: string | null;
  target: { name: string; imageDigest: string } | null;
  /** The Daytona sandbox this session's investigation actually ran against, if one was
   * provisioned. Null when no target was bound or provisioning never happened, which is most
   * reports today. Read from agent_session, where the driver records it. */
  sandbox: { id: string; appPort: number | null } | null;
  verdict: CaseVerdict | null;
  approval: { decision: string; reviewer: string; note: string | null; decidedAt: Date } | null;
  delivery: {
    state: string;
    attempts: number;
    /** The outbox's own ceiling. attempts reaching it means nothing will retry again. */
    maxAttempts: number;
    lastError: string | null;
    target: string;
  } | null;
  /**
   * Whether the reviewer's decision ever reached the harness.
   *
   * Null for a synthesized verdict, which the approval action enqueues inline without a harness
   * round-trip, and null before anyone has decided. Present only on the harness-backed path,
   * where this row is what triggers delivery: a failed handoff means no delivery row is ever
   * written, so the delivery step reads "not enqueued" for a report that is permanently stuck.
   */
  handoff: {
    /** PENDING | SUBMITTED | ACKNOWLEDGED | FAILED. */
    state: string;
    attempts: number;
    /** MAX_ATTEMPTS from the submission queue. A constant there, not a column on the row. */
    maxAttempts: number;
    lastError: string | null;
  } | null;
  /** The exact verdict a reviewer can answer right now, or null if there is no pending call. */
  awaitingVerdictId: string | null;
  events: CaseEvent[];
  /** Files this report's run left behind, content-addressed. `stored` is false when the bytes
   * were never uploaded (Storage unconfigured or the upload failed), so the case file shows the
   * row as recorded-but-not-downloadable rather than a broken link. Newest first. */
  artifacts: CaseArtifact[];
};

export type CaseArtifact = {
  id: string;
  kind: string;
  sha256: string;
  bytes: number;
  contentType: string;
  stored: boolean;
  createdAt: Date;
};

/**
 * Whether the agent is actively working this report right now.
 *
 * Requires all three: its harness turn is live (`RUNNING` or `INVESTIGATING`), it has at least
 * one mirrored `agent.tool_call:*` event (lib/agent-sessions/poller.ts), and no verdict has
 * been drafted yet. The live path mints a verdict only once the agent calls `publish_verdict`,
 * the last thing it does in its turn (see lib/mcp/publish-verdict.ts), so a verdict already
 * existing means whatever the turn status still says is stale or about to be.
 *
 * The tool-call requirement is deliberate, not incidental: a turn sits in `RUNNING` from the
 * instant the driver calls `createTurn`, before the agent has done anything at all, and a
 * report claiming to be "under investigation" with zero observed activity would be a stronger
 * claim than the evidence supports -- the same fail-closed standard `oracleDecided` and
 * `verdictFindings` already hold this page to. This is also the single definition the board
 * badge, the case-file badge, and the case-file's "Investigation" lifecycle step all read, so
 * the three surfaces can never disagree with each other about whether a run is live.
 */
export function isAgentInvestigating(
  turnStatus: string | null,
  hasVerdict: boolean,
  hasToolCallEvents: boolean,
): boolean {
  return !hasVerdict && hasToolCallEvents && (turnStatus === "RUNNING" || turnStatus === "INVESTIGATING");
}

/**
 * Whether a canary oracle, not just the agent's own reasoning, decided this verdict.
 *
 * True only for evidence that positively records one: an `oracle` object carrying a string
 * `result`. The agent's own drafted investigation is the primary and permanent source of a
 * verdict today (see docs/decisions.md Q22); the canary/fixture/negative-control pipeline in
 * lib/sandbox/reproduce.ts is retained as a strictly stronger, optional evidence source, not
 * yet wired into the live path. Anything else, including an empty or unrecognised evidence
 * object, means this verdict is the agent's own conclusion, and saying otherwise would attribute
 * it to a check that never ran.
 */
export function oracleDecided(evidence: unknown): boolean {
  if (typeof evidence !== "object" || evidence === null) return false;
  const oracle = (evidence as { oracle?: unknown }).oracle;
  if (typeof oracle !== "object" || oracle === null) return false;

  return typeof (oracle as { result?: unknown }).result === "string";
}

/**
 * The agent's own drafted findings off a verdict's evidence, if it recorded any.
 *
 * Defensive about the shape because evidence is jsonb and pre-redesign rows, or a report that
 * never reached a target, may carry something else entirely. Reuses the same `findingSchema`
 * `publish_verdict` validates a draft against, so a finding renders here exactly if it would
 * have been accepted there.
 */
export function verdictFindings(evidence: unknown): Finding[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const value = (evidence as { source?: unknown; findings?: unknown }).findings;
  if ((evidence as { source?: unknown }).source !== "agent-drafted" || !Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const parsed = findingSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
