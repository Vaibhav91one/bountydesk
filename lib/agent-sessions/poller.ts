import { and, db, eq, report, verdict } from "@/lib/db";
import {
  draftVerdictFromPendingCall,
  publishVerdictInputSchema,
  synthesizeAnalysisOnlyVerdict,
} from "@/lib/mcp/publish-verdict";
import { recordEvent, transition } from "@/lib/reports/lifecycle";
import { isTerminal } from "@/lib/reports/states";
import { teardownSandbox } from "@/lib/sandbox/provision";
import {
  createTrueForgeClient,
  isTrueForgeNotFoundError,
  type ObservedToolCall,
  type PendingToolCall,
  type TrueForgeClient,
  type TurnSnapshot,
} from "@/lib/trueforge/client";

import {
  claim,
  LeaseLostError,
  markMirrored,
  recordFinalSummary,
  release,
  renew,
  type AgentSessionLease,
  type AgentSessionReleaseUpdate,
} from "./queue";

/**
 * How long a poll waits before checking a running (or not-yet-started) turn again.
 *
 * ponytail: a fixed interval, not exponential backoff. TrueForge turns are expected to run
 * for seconds to low minutes, not hours, so growing the interval buys little here; add a
 * capped exponential (same formula as lib/jobs/queue.ts's fail()) if that stops being true.
 */
const POLL_BACKOFF_MS = 5000;
const MIN_HEARTBEAT_INTERVAL_MS = 50;

/** Once a pending call is verified, hold off polling again until the approval submission
 * worker has had a chance to act; a retried poll before then is a safe no-op (see below) but
 * there is no point spinning on it. */
const AWAITING_APPROVAL_POLL_MS = 30_000;

function inFuture(ms: number): Date {
  return new Date(Date.now() + ms);
}

/** Long enough to show what a safe field's value was, short enough that a chatty one never
 * makes session_event a second copy of the payload it was called with. */
const TOOL_ARGUMENTS_PREVIEW_LIMIT = 500;

/**
 * Argument field names safe to copy into the durable, reviewer-visible audit trail. An
 * allowlist, not a denylist: session_event has no UPDATE or DELETE (see AGENTS.md), so a field
 * let through here is there forever. Every scope-guard/bountydesk tool call carries a
 * `capability` token to identify the caller, and several also carry a `grant_token`/`token`
 * from `request_intrusive_approval`/`verify_grant` embedded in `headers` or `body` -- none of
 * that, and nothing this list doesn't name, ever gets copied. A new tool's arguments preview as
 * empty until someone deliberately adds its safe fields here, which is the direction this needs
 * to fail in.
 */
const ARGUMENT_PREVIEW_ALLOWLIST = new Set([
  "url",
  "method",
  "host",
  "port",
  "target",
  "entry",
  "action",
  "name",
  "ecosystem",
  "version",
  "id",
  "limit",
  "ttl_minutes",
  "timeout_seconds",
]);

/**
 * The safe subset of a tool call's arguments, or undefined when there is nothing safe to show
 * (including when the arguments aren't a plain JSON object at all, e.g. publish_verdict's
 * {capability, outcome, summary, findings}: none of those keys are on the allowlist, so its
 * arguments preview as nothing, which is deliberate -- the verdict itself is already visible in
 * the verdict panel, and its capability token must never repeat anywhere else).
 */
function previewArguments(argumentsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const safe = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([key]) =>
      ARGUMENT_PREVIEW_ALLOWLIST.has(key),
    ),
  );
  if (Object.keys(safe).length === 0) return undefined;

  const json = JSON.stringify(safe);
  return json.length > TOOL_ARGUMENTS_PREVIEW_LIMIT ? `${json.slice(0, TOOL_ARGUMENTS_PREVIEW_LIMIT)}…` : json;
}

/**
 * Mirror every tool call TrueForge has recorded for this turn into `session_event`, so a
 * reviewer sees what the agent actually did rather than "ran 1 step" for every real run (see
 * AGENTS.md's session-event tracing gap). Never the tool's result, only that it was called, and
 * only an allowlisted subset of its arguments (see `previewArguments`): matches
 * lib/reproduction/types.ts's rule that evidence never carries a raw secret or a canary value.
 *
 * Idempotent by construction: `recordEvent`'s `idempotencyKey` is unique per report, and the
 * call's own id is stable across repeated polls of the same turn, so a poller that runs this
 * every tick while a turn is RUNNING never inserts the same call twice. Best-effort: a failure
 * here is logged and swallowed rather than thrown, because a trace row is a nice-to-have and
 * the turn's actual status (running, errored, awaiting approval) still has to be handled either
 * way -- a database hiccup while writing the trace must never leave a claimed lease to expire
 * without moving the report forward.
 */
async function mirrorToolCalls(reportId: string, calls: ObservedToolCall[]): Promise<void> {
  try {
    for (const call of calls) {
      await recordEvent(
        reportId,
        `agent.tool_call:${call.toolName}`,
        { toolName: call.toolName, argumentsPreview: previewArguments(call.argumentsJson) },
        { idempotencyKey: `agent.tool_call:${call.id}` },
      );
    }
  } catch (error) {
    console.error(
      `agent session for report ${reportId}: failed to mirror tool-call trace events: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Refuse a pending call bounty-desk cannot resolve: not exactly one call, not
 * publish_verdict, not an MCP tool, or an unparseable/mismatched capability argument. This
 * is the only outcome for those cases; the poller never guesses which call was "the real
 * one," because a wrong guess here is a wrong verdict shipped to a human for approval.
 *
 * A refusal still needs to move the report out of TRIAGING/REPRODUCING, exactly like
 * finishWithoutApproval, or a report whose agent drafted something unresolvable (including
 * an unauthorized REPRODUCED claim caught by draftVerdictFromPendingCall) sits stuck forever
 * with no verdict and nothing to bring it back for human review. Both paths share
 * endWithoutAgentVerdict, which mints the server-authored ANALYSIS_ONLY verdict when the
 * report has none so it can still reach a human for approval; see that function.
 */
async function refuseUnresolvablePending(
  lease: AgentSessionLease,
  message: string,
): Promise<string> {
  return endWithoutAgentVerdict(lease, { turnStatus: "ERROR", lastError: message });
}

/**
 * The shared body of the two dead-end terminal paths: move a still-investigating report to
 * ANALYSIS_ONLY, and, when it has no verdict at all, mint the server-authored ANALYSIS_ONLY
 * verdict so a human can still approve and deliver it from the Analysis only lane. The
 * alternative is a report parked at ANALYSIS_ONLY with nothing to approve, which can never
 * reach delivery.
 *
 * The mint happens only when there is no verdict yet. A report that somehow already has one
 * (not reachable through the real driver, which mints only via publish_verdict) stays where it
 * is: an existing verdict is never overwritten, and a reproduced claim is never advanced
 * toward delivery from here.
 *
 * Every pending_* marker is cleared on the way out, and only the synthesized verdict pair is
 * written back. The session is over and its turn status is terminal, so nothing will claim the
 * row again: a thread and tool-call id left behind here would point at a TrueForge call that
 * nothing can ever answer. The relaxed pending_* check constraint allows the verdict pair set
 * with the thread pair null, which is what the synthesized verdict needs.
 *
 * Sandbox teardown stays after the transaction commits, same reasoning as everywhere in this
 * file: a Daytona network call is not something to hold report.state's row lock across.
 */
async function endWithoutAgentVerdict(
  lease: AgentSessionLease,
  updates: { turnStatus: "DONE_NO_ACTION" | "ERROR" | "CANCELLED"; lastError?: string },
): Promise<string> {
  await db.transaction(async (tx) => {
    const [reportRow] = await tx
      .select({ state: report.state })
      .from(report)
      .where(eq(report.id, lease.reportId))
      .for("update");

    if (!reportRow) {
      throw new Error(`agent session ${lease.id}: report ${lease.reportId} no longer exists`);
    }

    let pending: Pick<
      AgentSessionReleaseUpdate,
      | "pendingThreadId"
      | "pendingToolCallId"
      | "pendingVerdictId"
      | "pendingApprovedContentHash"
    > = {
      pendingThreadId: null,
      pendingToolCallId: null,
      pendingVerdictId: null,
      pendingApprovedContentHash: null,
    };
    if (reportRow.state === "TRIAGING" || reportRow.state === "REPRODUCING") {
      await transition(lease.reportId, reportRow.state, "ANALYSIS_ONLY", tx);
      const synthesized = await synthesizeAnalysisOnlyVerdict(lease.reportId, tx);
      if (synthesized) {
        pending = {
          ...pending,
          pendingVerdictId: synthesized.verdictId,
          pendingApprovedContentHash: synthesized.contentHash,
        };
      }
    }
    await release(lease, { ...updates, ...pending }, tx);
  });
  if (lease.sandboxId) await teardownSandbox(lease.sandboxId, true);
  return lease.id;
}

function parseJson(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
}

function extractCapability(argumentsJson: string): string | null {
  const parsed = parseJson(argumentsJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const capability = (parsed as Record<string, unknown>).capability;
  return typeof capability === "string" ? capability : null;
}

/**
 * A terminal path (AGENTS.md's teardown section): the turn ended without ever reaching a
 * publish_verdict call. Shares endWithoutAgentVerdict with refuseUnresolvablePending, which
 * moves the report to ANALYSIS_ONLY, mints the server-authored verdict when it has none, and
 * tears the sandbox down after the commit.
 */
async function finishWithoutApproval(
  lease: AgentSessionLease,
  updates: { turnStatus: "DONE_NO_ACTION" | "ERROR" | "CANCELLED"; lastError?: string },
): Promise<string> {
  return endWithoutAgentVerdict(lease, updates);
}

/**
 * Handle a verified, genuine pending publish_verdict call: this is the only place in the
 * codebase that records a pending publish_verdict call against the report lifecycle. A
 * reproduced or not-reproduced verdict moves into AWAITING_APPROVAL. An ANALYSIS_ONLY verdict
 * stays in the Analysis only lane with an approval button, because there was nothing to
 * reproduce and the reviewer still has to approve the exact outbound text.
 */
async function handleVerifiedPendingCall(
  lease: AgentSessionLease,
  call: PendingToolCall,
): Promise<string> {
  await db.transaction(async (tx) => {
    // Locks the report so a concurrent poll (a retried tick overlapping this one) cannot
    // also observe a pre-ANALYSIS_ONLY state and race this transition.
    const [reportRow] = await tx
      .select({ id: report.id, state: report.state })
      .from(report)
      .where(eq(report.id, lease.reportId))
      .for("update");

    if (!reportRow) {
      throw new Error(`agent session ${lease.id}: report ${lease.reportId} no longer exists`);
    }

    // The driver prepares revision 1 before it starts this turn. A later draft was not part
    // of the turn and cannot silently replace the exact payload the pending call refers to.
    const [verdictRow] = await tx
      .select({
        id: verdict.id,
        reportId: verdict.reportId,
        contentHash: verdict.contentHash,
        outcome: verdict.outcome,
      })
      .from(verdict)
      .where(and(eq(verdict.reportId, lease.reportId), eq(verdict.revision, 1)))
      .limit(1);

    if (!verdictRow) {
      throw new Error(
        `agent session ${lease.id}: report ${lease.reportId} has no verdict for publish_verdict to approve`,
      );
    }
    // The query above already filters on reportId; this is a sanity check on that
    // assumption, not a substitute for trusting it.
    if (verdictRow.reportId !== lease.reportId) {
      throw new Error(
        `agent session ${lease.id}: verdict ${verdictRow.id} does not belong to report ${lease.reportId}`,
      );
    }

    const analysisOnly = verdictRow.outcome === "ANALYSIS_ONLY";

    if (reportRow.state === "TRIAGING" || reportRow.state === "REPRODUCING") {
      await transition(lease.reportId, reportRow.state, "ANALYSIS_ONLY", tx);
      if (!analysisOnly) {
        await transition(lease.reportId, "ANALYSIS_ONLY", "AWAITING_APPROVAL", tx);
      }
    } else if (reportRow.state === "ANALYSIS_ONLY" && !analysisOnly) {
      await transition(lease.reportId, "ANALYSIS_ONLY", "AWAITING_APPROVAL", tx);
    } else if (reportRow.state === "AWAITING_APPROVAL") {
      if (
        lease.pendingThreadId !== call.threadId ||
        lease.pendingToolCallId !== call.toolCallId ||
        lease.pendingVerdictId !== verdictRow.id ||
        lease.pendingApprovedContentHash !== verdictRow.contentHash
      ) {
        await release(
          lease,
          {
            turnStatus: "ERROR",
            lastError:
              "pending publish_verdict does not match the pending call already recorded for review",
          },
          tx,
        );
        return;
      }
    } else {
      await release(
        lease,
        {
          turnStatus: "ERROR",
          lastError: `refusing pending publish_verdict because report is ${reportRow.state}`,
        },
        tx,
      );
      return;
    }
    // A report already at AWAITING_APPROVAL, or an ANALYSIS_ONLY verdict already parked in the
    // analysis lane, is the idempotent retry case. Later lifecycle states are refused above,
    // because a delayed harness result cannot reopen approval.

    await release(
      lease,
      {
        turnStatus: "AWAITING_APPROVAL_HARNESS",
        pendingThreadId: call.threadId,
        pendingToolCallId: call.toolCallId,
        pendingVerdictId: verdictRow.id,
        pendingApprovedContentHash: verdictRow.contentHash,
        nextPollAt: inFuture(AWAITING_APPROVAL_POLL_MS),
      },
      tx,
    );
  });

  return lease.id;
}

/**
 * A pending call whose arguments already carry the full agent-drafted shape (outcome, summary,
 * findings), not just a capability token. Mints or confirms the report's verdict from those
 * fields before falling through to the same handleVerifiedPendingCall approval-recording flow
 * a capability-only call uses -- the drafting step is the only part that's new.
 *
 * `agent/bountydesk.agent.json`'s instructions and `lib/analysis/trueforge-driver.ts`'s
 * `buildTurnMessage` both ask the agent for this shape today, so this branch is reachable in
 * production, not just exercised ahead of a later PR.
 */
async function handleAgentDraftedPendingCall(
  lease: AgentSessionLease,
  call: PendingToolCall,
  input: { capability: string; outcome: string; summary: string; findings: unknown[] },
): Promise<string> {
  const drafted = await draftVerdictFromPendingCall(lease.capabilityToken, {
    outcome: input.outcome,
    summary: input.summary,
    findings: input.findings,
  });
  if (!drafted.ok) {
    return refuseUnresolvablePending(lease, `publish_verdict draft refused: ${drafted.reason}`);
  }
  return handleVerifiedPendingCall(lease, call);
}

async function handleAwaitingApproval(
  lease: AgentSessionLease,
  pending: PendingToolCall[],
): Promise<string> {
  if (pending.length !== 1) {
    return refuseUnresolvablePending(
      lease,
      `${pending.length} pending calls, expected 1`,
    );
  }

  const call = pending[0];
  if (call.toolName !== "publish_verdict" || call.toolInfoType !== "mcp") {
    return refuseUnresolvablePending(
      lease,
      `unsupported pending tool call: ${call.toolName} (toolInfoType ${call.toolInfoType})`,
    );
  }

  // Today's tool schema and turn message only ever hand back {capability}; a full draft is
  // what a future, investigating agent will send instead once the driver rewrite starts asking
  // for one. A call is treated as a draft attempt the moment its arguments carry any
  // draft-specific key, whether or not the rest of the shape is valid: falling through to the
  // capability-only path for a malformed draft would silently approve whatever verdict already
  // exists instead of the (possibly different) content the caller actually tried to submit.
  const parsedArguments = parseJson(call.argumentsJson);
  const looksLikeDraftAttempt =
    typeof parsedArguments === "object" &&
    parsedArguments !== null &&
    !Array.isArray(parsedArguments) &&
    ["outcome", "summary", "findings"].some((key) => key in (parsedArguments as Record<string, unknown>));

  if (looksLikeDraftAttempt) {
    const fullDraft = publishVerdictInputSchema.safeParse(parsedArguments);
    if (!fullDraft.success) {
      return refuseUnresolvablePending(
        lease,
        `publish_verdict arguments look like a drafted verdict but failed validation: ${fullDraft.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    if (fullDraft.data.capability !== lease.capabilityToken) {
      return refuseUnresolvablePending(
        lease,
        "publish_verdict capability argument does not match this session's capability token",
      );
    }
    return handleAgentDraftedPendingCall(lease, call, fullDraft.data);
  }

  const capability = extractCapability(call.argumentsJson);
  if (capability === null) {
    return refuseUnresolvablePending(
      lease,
      "publish_verdict arguments are not valid JSON or carry no string capability field",
    );
  }
  if (capability !== lease.capabilityToken) {
    return refuseUnresolvablePending(
      lease,
      "publish_verdict capability argument does not match this session's capability token",
    );
  }

  return handleVerifiedPendingCall(lease, call);
}

/**
 * A ceiling on one TrueForge call, independent of the lease.
 *
 * The heartbeat below renews the lease for as long as the operation runs, so an HTTP call that
 * never answers is not something a sweeper can ever recover: the lease stays fresh, the loop
 * stays inside the claim, and the queue stops making progress with nothing expired to reclaim.
 * The deadline turns that into an ordinary failed claim, which the loop already knows how to
 * log and back off from.
 *
 * Per call, not per claim. A poll makes up to three sequential requests, and one budget shared
 * across them would charge a slow first request to the ones after it, aborting calls that never
 * had their own chance to answer.
 */
const REQUEST_DEADLINE_MS = 30_000;

/**
 * How many deadlines one claim may spend before the claim itself is abandoned.
 *
 * A per-call deadline alone is only as good as the client's respect for the signal: a request
 * that ignores an abort would hold the claim open forever, which is the wedge this file is here
 * to prevent. Three is what a poll actually makes (getTurn, listToolCalls, getFinalSummary), so
 * the ceiling never fires on work that is progressing.
 */
const CALLS_PER_CLAIM = 3;

/**
 * Renews the held lease every third of its duration while `operation` runs, so a slow
 * `getTurn` call (event pagination, a sluggish TrueForge) can't outlive its own lease and get
 * reclaimed by a sweeper running on a shorter, independent cadence than the tick route's
 * once-per-tick sweep this was originally sized for. Same shape as
 * lib/approval-submission/worker.ts's own runWithHeartbeat.
 */
async function runWithHeartbeat<T>(
  lease: AgentSessionLease,
  leaseSeconds: number,
  operation: (deadline: () => AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
  deadlineMs: number = REQUEST_DEADLINE_MS,
): Promise<T> {
  const controller = new AbortController();
  // Lease loss and the caller's own shutdown abort the whole operation. The request deadline
  // is minted per call on top of that, which is why the operation is handed a factory rather
  // than a signal: a shared timeout would run down across sequential requests.
  const base = AbortSignal.any([controller.signal, ...(outerSignal ? [outerSignal] : [])]);
  const deadline = () => AbortSignal.any([base, AbortSignal.timeout(deadlineMs)]);
  // The ceiling on the claim as a whole, which is what ends a request that ignores its own
  // deadline. Generous by construction: every call would have to spend its entire budget.
  const signal = AbortSignal.any([base, AbortSignal.timeout(deadlineMs * CALLS_PER_CLAIM)]);
  const intervalMs = Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    Math.floor((leaseSeconds * 1000) / 3),
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal = Promise.resolve();
  let rejectLeaseLoss!: (reason: unknown) => void;
  const leaseLoss = new Promise<never>((_, reject) => {
    rejectLeaseLoss = reject;
  });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const heartbeat = () => {
    renewal = renew(lease, leaseSeconds)
      .then(() => {
        if (!stopped) timer = setTimeout(heartbeat, intervalMs);
      })
      .catch((error: unknown) => {
        controller.abort(error);
        rejectLeaseLoss(error);
      });
  };

  timer = setTimeout(heartbeat, intervalMs);
  try {
    const result = await Promise.race([operation(deadline), leaseLoss, aborted]);
    if (signal.aborted) throw signal.reason;
    return result;
  } finally {
    stopped = true;
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    await renewal.catch(() => undefined);
  }
}

/**
 * Advance one claimable agent_session as far as one poll allows: ask TrueForge for the
 * turn's current state, and record whatever that state is.
 *
 * Returns the claimed row's id once something was done with it, or null when nothing was
 * claimable. Deliberately has no top-level try/catch: an unexpected error (a TrueForge
 * outage, a malformed response, or the heartbeat above losing the lease) propagates out and
 * the lease is simply never released. It expires on its own, and sweepExpiredLeases (called
 * from the tick route or a persistent worker, not from here) reclaims it for the next
 * attempt.
 */
export async function pollOnce(
  owner: string,
  opts: {
    leaseSeconds?: number;
    client?: TrueForgeClient;
    signal?: AbortSignal;
    /** Only set by tests, which cannot wait out the real deadline. */
    requestDeadlineMs?: number;
  } = {},
): Promise<string | null> {
  if (opts.signal?.aborted) return null;
  const leaseSeconds = opts.leaseSeconds ?? 60;
  if (
    !Number.isFinite(leaseSeconds) ||
    leaseSeconds * 1000 <= MIN_HEARTBEAT_INTERVAL_MS
  ) {
    throw new Error("leaseSeconds must exceed the 50 ms heartbeat floor");
  }
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  // A report that has finished has nothing left for its session to poll about. Nothing else
  // marks the session terminal when its report reaches DELIVERED or DENIED, so without this the
  // row stays claimable and keeps asking TrueForge about a turn no one is waiting on, holding a
  // sandbox open with it. CANCELLED is terminal for claim(), so this is the last time the row
  // is picked up, and finishWithoutApproval clears the pending markers and tears the sandbox
  // down on the way out.
  const [reportRow] = await db
    .select({ state: report.state })
    .from(report)
    .where(eq(report.id, lease.reportId))
    .limit(1);

  if (reportRow && isTerminal(reportRow.state)) {
    return finishWithoutApproval(lease, {
      turnStatus: "CANCELLED",
      lastError: `report is ${reportRow.state}; nothing left for this session to poll`,
    });
  }

  if (!lease.turnId) {
    // The driver created the session but has not started a turn yet; nothing to ask
    // TrueForge about.
    await release(lease, { nextPollAt: inFuture(POLL_BACKOFF_MS) });
    return lease.id;
  }
  const turnId = lease.turnId;

  const client = opts.client ?? createTrueForgeClient();
  let pollResult: {
    snapshot: TurnSnapshot;
    toolCalls: ObservedToolCall[];
    cursor: string | null;
    finalSummary: string | null;
  };
  try {
    pollResult = await runWithHeartbeat(
      lease,
      leaseSeconds,
      async (deadline) => {
        const snapshot = await client.getTurn(lease.sessionId, turnId, {
          signal: deadline(),
        });
        // since: only ask for what has happened past the last poll's cursor -- without it every
        // poll of a long-running turn re-reads and re-processes its entire event history, cost
        // growing with the turn's total call count rather than with how much is actually new.
        const result = await client.listToolCalls?.(lease.sessionId, turnId, {
          signal: deadline(),
          since: lease.lastMirroredEventId ?? undefined,
        });
        // The agent's closing summary exists only once the turn is done: on a pending
        // publish_verdict call (the agent-authored path) or a turn that finished without one.
        // Fetched once, inside the heartbeat like the calls above, and only while the turn is
        // still running would it be premature or absent.
        const captureSummary =
          lease.finalSummary === null &&
          (snapshot.status === "awaiting_approval" || snapshot.status === "done_no_action");
        const finalSummary = captureSummary
          ? ((await client.getFinalSummary?.(lease.sessionId, turnId, {
              signal: deadline(),
            })) ?? null)
          : null;
        return { snapshot, toolCalls: result?.calls ?? [], cursor: result?.cursor ?? null, finalSummary };
      },
      opts.signal,
      opts.requestDeadlineMs,
    );
  } catch (error) {
    if (isTrueForgeNotFoundError(error)) {
      return finishWithoutApproval(lease, {
        turnStatus: "ERROR",
        lastError: `TrueForge session or turn was not found: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    throw error;
  }
  const { snapshot, toolCalls, cursor, finalSummary } = pollResult;

  // Mirrored regardless of the turn's status: a call already made is a call already made,
  // whether the turn is still running, has errored, or is sitting on a pending approval.
  // Best-effort with respect to everything below: mirrorToolCalls never throws, and the cursor
  // only advances once its calls are actually recorded, so a failure here just means the next
  // poll re-walks the same (small, since-bounded) batch rather than losing it.
  await mirrorToolCalls(lease.reportId, toolCalls);
  if (cursor !== null && cursor !== lease.lastMirroredEventId) {
    await markMirrored(lease, cursor).catch((error: unknown) => {
      console.error(
        `agent session ${lease.id}: failed to persist tool-call mirroring cursor: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  // Best-effort, like the cursor above: the summary is a nice-to-have for the case file, and a
  // failure to store it must never keep the turn's real status from being handled below. A
  // LeaseLostError still propagates, matching markMirrored: losing the lease mid-poll is not
  // something to swallow.
  if (finalSummary !== null) {
    await recordFinalSummary(lease, finalSummary).catch((error: unknown) => {
      if (error instanceof LeaseLostError) throw error;
      console.error(
        `agent session ${lease.id}: failed to persist final summary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  switch (snapshot.status) {
    case "running":
      // This poll has directly observed the turn still going, which the initial RUNNING set
      // by the driver right after createTurn cannot claim: the agent is now genuinely mid
      // investigation, not just started.
      await release(lease, {
        turnStatus: "INVESTIGATING",
        nextPollAt: inFuture(POLL_BACKOFF_MS),
      });
      return lease.id;

    case "error":
      // Never inferred as an approval or a denial: the turn errored, full stop.
      return finishWithoutApproval(lease, {
        turnStatus: "ERROR",
        lastError: snapshot.message,
      });

    case "cancelled":
      return finishWithoutApproval(lease, { turnStatus: "CANCELLED" });

    case "done_no_action":
      // Expected, real terminal outcome for this narrow model turn: the model finished
      // without calling publish_verdict. Not an error, and there is no retry-prompting
      // logic in this PR's scope, so polling simply stops here.
      return finishWithoutApproval(lease, { turnStatus: "DONE_NO_ACTION" });

    case "awaiting_approval":
      return handleAwaitingApproval(lease, snapshot.pending);
  }
}
