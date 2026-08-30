import { and, db, eq, report, verdict } from "@/lib/db";
import { draftVerdictFromPendingCall, publishVerdictInputSchema } from "@/lib/mcp/publish-verdict";
import { recordEvent, transition } from "@/lib/reports/lifecycle";
import {
  createTrueForgeClient,
  type ObservedToolCall,
  type PendingToolCall,
  type TrueForgeClient,
} from "@/lib/trueforge/client";

import { claim, markMirrored, release, renew, type AgentSessionLease } from "./queue";

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
 */
async function refuseUnresolvablePending(
  lease: AgentSessionLease,
  message: string,
): Promise<string> {
  await release(lease, { turnStatus: "ERROR", lastError: message });
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

async function finishWithoutApproval(
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
    if (reportRow.state === "TRIAGING" || reportRow.state === "REPRODUCING") {
      await transition(lease.reportId, reportRow.state, "ANALYSIS_ONLY", tx);
    }
    await release(lease, updates, tx);
  });
  return lease.id;
}

/**
 * Handle a verified, genuine pending publish_verdict call: this is the only place in the
 * codebase that moves a report through ANALYSIS_ONLY into AWAITING_APPROVAL (see
 * lib/reports/states.ts). It happens here, and nowhere else, because this is the first
 * moment bounty-desk can prove the model actually asked to publish something, rather than a
 * driver or a route inferring that from a turn merely finishing.
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
      .select({ id: verdict.id, reportId: verdict.reportId, contentHash: verdict.contentHash })
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

    if (reportRow.state === "TRIAGING" || reportRow.state === "REPRODUCING") {
      await transition(lease.reportId, reportRow.state, "ANALYSIS_ONLY", tx);
      await transition(lease.reportId, "ANALYSIS_ONLY", "AWAITING_APPROVAL", tx);
    } else if (reportRow.state === "ANALYSIS_ONLY") {
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
    // A report already at AWAITING_APPROVAL is the idempotent retry case. Later lifecycle
    // states are refused above, because a delayed harness result cannot reopen approval.

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
 * Nothing in the live agent manifest or turn message asks for this shape yet (that lands with
 * the driver rewrite), so this branch is unreachable in production today; it exists so the
 * poller-side half of the new schema is exercised and provable ahead of that later PR.
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
 * Renews the held lease every third of its duration while `operation` runs, so a slow
 * `getTurn` call (event pagination, a sluggish TrueForge) can't outlive its own lease and get
 * reclaimed by a sweeper running on a shorter, independent cadence than the tick route's
 * once-per-tick sweep this was originally sized for. Same shape as
 * lib/approval-submission/worker.ts's own runWithHeartbeat.
 */
async function runWithHeartbeat<T>(
  lease: AgentSessionLease,
  leaseSeconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([controller.signal, outerSignal])
    : controller.signal;
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
    const result = await Promise.race([operation(signal), leaseLoss, aborted]);
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
  opts: { leaseSeconds?: number; client?: TrueForgeClient; signal?: AbortSignal } = {},
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

  if (!lease.turnId) {
    // The driver created the session but has not started a turn yet; nothing to ask
    // TrueForge about.
    await release(lease, { nextPollAt: inFuture(POLL_BACKOFF_MS) });
    return lease.id;
  }
  const turnId = lease.turnId;

  const client = opts.client ?? createTrueForgeClient();
  const { snapshot, toolCalls, cursor } = await runWithHeartbeat(
    lease,
    leaseSeconds,
    async (signal) => {
      const snapshot = await client.getTurn(lease.sessionId, turnId, { signal });
      // since: only ask for what has happened past the last poll's cursor -- without it every
      // poll of a long-running turn re-reads and re-processes its entire event history, cost
      // growing with the turn's total call count rather than with how much is actually new.
      const result = await client.listToolCalls?.(lease.sessionId, turnId, {
        signal,
        since: lease.lastMirroredEventId ?? undefined,
      });
      return { snapshot, toolCalls: result?.calls ?? [], cursor: result?.cursor ?? null };
    },
    opts.signal,
  );

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
