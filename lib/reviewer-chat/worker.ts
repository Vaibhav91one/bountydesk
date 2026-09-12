import { and, db, eq, reviewerChatMessage, reviewerChatThread, report, sql, verdict, verdictSupersession, targetProfile } from "@/lib/db";
import { buildReviewerChatContext, redactReviewerText, type ReviewerChatContext } from "./context";
import { chatReplySchema, MODEL_REPLY_MAX_LENGTH } from "./schema";
import {
  CHAT_AGENT_NAME,
  ChatInvariantError,
  attachSession,
  cancel,
  claim,
  complete,
  fail,
  LeaseLostError,
  releaseUnstarted,
  renew,
  reviewerChatEnabled,
  type ChatLease,
} from "./queue";
import { computeContentHash } from "@/lib/verdicts/hash";
import { createTrueForgeClient, type TrueForgeClient, type TurnInput, type TurnSnapshot } from "@/lib/trueforge/client";

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_TURN_DEADLINE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_PRIOR_MESSAGES = 24;
const MAX_PRIOR_MESSAGE_LENGTH = 4_000;

export type ReviewerChatWorkerOptions = {
  client?: TrueForgeClient;
  leaseSeconds?: number;
  turnDeadlineMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Keep lease ownership alive while a provider request or poll is in flight. */
async function runWithHeartbeat<T>(
  lease: ChatLease,
  leaseSeconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const combined = outerSignal
    ? AbortSignal.any([controller.signal, outerSignal])
    : controller.signal;
  const interval = Math.max(50, Math.floor((leaseSeconds * 1000) / 3));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let renewal = Promise.resolve();
  let rejectLoss!: (error: unknown) => void;
  const lost = new Promise<never>((_, reject) => {
    rejectLoss = reject;
  });

  const heartbeat = () => {
    renewal = renew(lease, leaseSeconds)
      .then(() => {
        if (!stopped) timer = setTimeout(heartbeat, interval);
      })
      .catch((error) => {
        controller.abort(error);
        rejectLoss(error);
      });
  };
  timer = setTimeout(heartbeat, interval);

  try {
    const result = await Promise.race([operation(combined), lost]);
    if (combined.aborted) throw combined.reason;
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await renewal.catch(() => undefined);
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function findingsFromEvidence(evidence: unknown): { title: string; evidence: string }[] {
  if (typeof evidence !== "object" || evidence === null) return [];
  const raw = (evidence as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const value = entry as Record<string, unknown>;
    return [{ title: stringField(value.title), evidence: stringField(value.evidence) }];
  });
}

async function loadWork(lease: ChatLease): Promise<{
  context: ReviewerChatContext;
  input: TurnInput[];
  threadVerdictHash: string | null;
}> {
  const [thread] = await db
    .select({
      id: reviewerChatThread.id,
      reportId: reviewerChatThread.reportId,
      verdictId: reviewerChatThread.verdictId,
      verdictRevision: reviewerChatThread.verdictRevision,
      verdictContentHash: reviewerChatThread.verdictContentHash,
    })
    .from(reviewerChatThread)
    .where(and(eq(reviewerChatThread.id, lease.threadId), eq(reviewerChatThread.reportId, lease.reportId)))
    .limit(1);
  if (!thread) throw new ChatInvariantError("chat thread is not bound to the claimed report");

  const [caseReport] = await db
    .select({ body: report.body, targetProfileId: report.targetProfileId })
    .from(report)
    .where(eq(report.id, lease.reportId));
  if (!caseReport) throw new ChatInvariantError("report does not exist");

  let verdictSnapshot: {
    summary: string;
    evidence: unknown;
    outcome: string;
    revision: number;
    payload: string;
    contentHash: string;
  } | null = null;
  if (thread.verdictId) {
    const [row] = await db
      .select({
        summary: verdict.summary,
        evidence: verdict.evidence,
        outcome: verdict.outcome,
        revision: verdict.revision,
        payload: verdict.payload,
        contentHash: verdict.contentHash,
      })
      .from(verdict)
      .where(and(eq(verdict.id, thread.verdictId), eq(verdict.reportId, lease.reportId)))
      .limit(1);
    if (!row) throw new ChatInvariantError("chat verdict is not owned by the report");
    if (
      row.revision !== thread.verdictRevision ||
      row.contentHash !== thread.verdictContentHash ||
      computeContentHash(row.payload) !== row.contentHash
    ) {
      throw new ChatInvariantError("chat verdict revision or content hash no longer matches");
    }
    const superseded = await db
      .select({ id: verdictSupersession.id })
      .from(verdictSupersession)
      .where(eq(verdictSupersession.oldVerdictId, thread.verdictId))
      .limit(1);
    if (superseded.length > 0) throw new ChatInvariantError("chat verdict has been superseded");
    verdictSnapshot = row;
  } else if (thread.verdictRevision !== null || thread.verdictContentHash !== null) {
    throw new ChatInvariantError("chat thread has an incomplete verdict snapshot");
  }

  let targetName: string | undefined;
  let targetIdentityHash: string | undefined;
  if (caseReport.targetProfileId) {
    const [target] = await db
      .select({ name: targetProfile.name, imageDigest: targetProfile.imageDigest })
      .from(targetProfile)
      .where(eq(targetProfile.id, caseReport.targetProfileId));
    if (target) {
      targetName = target.name;
      targetIdentityHash = target.imageDigest;
    }
  }

  const previous = await db
    .select({ id: reviewerChatMessage.id, sender: reviewerChatMessage.sender, body: reviewerChatMessage.body })
    .from(reviewerChatMessage)
    .where(eq(reviewerChatMessage.threadId, lease.threadId))
    .orderBy(sql`${reviewerChatMessage.createdAt} desc`)
    .limit(MAX_PRIOR_MESSAGES + 1);
  previous.reverse();

  const context = buildReviewerChatContext({
    reportBody: caseReport.body,
    summary: verdictSnapshot?.summary ?? "No verdict has been drafted yet.",
    findings: findingsFromEvidence(verdictSnapshot?.evidence),
    ...(targetName ? { targetName } : {}),
    ...(targetIdentityHash ? { targetIdentityHash } : {}),
    ...(verdictSnapshot ? {
      outcome: verdictSnapshot.outcome,
      verdictRevision: verdictSnapshot.revision,
      verdictContentHash: verdictSnapshot.contentHash,
    } : {}),
  });

  const conversation = previous
    .filter((message) => message.id !== lease.id)
    .map((message) => `${message.sender === "REVIEWER" ? "Reviewer" : "Assistant"}: ${redactReviewerText(message.body).slice(0, MAX_PRIOR_MESSAGE_LENGTH)}`)
    .join("\n");
  const prompt = `${context}\n\nPrior conversation:\n${conversation || "(none)"}\n\nReviewer message:\n${redactReviewerText(lease.body)}`;

  return {
    context: {
      reportBody: caseReport.body,
      summary: verdictSnapshot?.summary ?? "No verdict has been drafted yet.",
      findings: findingsFromEvidence(verdictSnapshot?.evidence),
      ...(targetName ? { targetName } : {}),
      ...(targetIdentityHash ? { targetIdentityHash } : {}),
      ...(verdictSnapshot ? {
        outcome: verdictSnapshot.outcome,
        verdictRevision: verdictSnapshot.revision,
        verdictContentHash: verdictSnapshot.contentHash,
      } : {}),
    },
    input: [{ type: "user.message", content: prompt }],
    threadVerdictHash: thread.verdictContentHash,
  };
}

async function pollTurn(
  client: TrueForgeClient,
  sessionId: string,
  turnId: string,
  opts: ReviewerChatWorkerOptions,
  signal: AbortSignal,
): Promise<TurnSnapshot> {
  const deadline = Date.now() + (opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
  let snapshot = await client.getTurn(sessionId, turnId, { signal });
  while (snapshot.status === "running") {
    if (Date.now() >= deadline) throw new Error("reviewer chat turn deadline exceeded");
    await (opts.sleep ?? defaultSleep)(opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, signal);
    snapshot = await client.getTurn(sessionId, turnId, { signal });
  }
  return snapshot;
}

/**
 * Process one durable chat turn. A provider failure only returns the thread to retryable ERROR;
 * it never changes report, verdict, approval, target, or delivery state.
 */
export async function runOnce(
  owner: string,
  opts: ReviewerChatWorkerOptions = {},
): Promise<string | null> {
  if (!reviewerChatEnabled() || opts.signal?.aborted) return null;
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  if (opts.signal?.aborted) {
    try {
      await releaseUnstarted(lease);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    }
    return lease.threadId;
  }

  try {
    const work = await loadWork(lease);
    const client = opts.client ?? createTrueForgeClient();
    let sessionId = lease.trueforgeSessionId;

    if (!sessionId) {
      const session = await runWithHeartbeat(
        lease,
        leaseSeconds,
        (signal) => client.createSession({ signal, agentName: CHAT_AGENT_NAME }),
        opts.signal,
      );
      sessionId = session.sessionId;
      try {
        await attachSession(lease, sessionId);
      } catch (error) {
        // A lost fence after session creation must not leave an unowned provider session behind.
        await client.deleteSession(sessionId).catch(() => undefined);
        throw error;
      }
    }

    const turn = await runWithHeartbeat(
      lease,
      leaseSeconds,
      async (signal) => {
        const requestSignal = withDeadline(signal, opts.turnDeadlineMs ?? DEFAULT_TURN_DEADLINE_MS);
        const existing = await client.findTurnByInput?.(sessionId!, work.input, { signal: requestSignal });
        return existing
          ? { turnId: existing.turnId, snapshot: { status: "running" } as TurnSnapshot }
          : client.createTurn(sessionId!, work.input, { signal: requestSignal });
      },
      opts.signal,
    );

    const snapshot = await runWithHeartbeat(
      lease,
      leaseSeconds,
      (signal) => pollTurn(client, sessionId!, turn.turnId, opts, signal),
      opts.signal,
    );
    if (snapshot.status === "error") throw new Error(snapshot.message);
    if (snapshot.status === "cancelled") throw new Error("TrueForge cancelled reviewer chat turn");
    if (snapshot.status !== "done_no_action") {
      throw new ChatInvariantError("reviewer chat turn exposed an action despite the no-tool manifest");
    }

    const body = await runWithHeartbeat(
      lease,
      leaseSeconds,
      (signal) => client.getFinalSummary?.(sessionId!, turn.turnId, { signal }) ?? Promise.resolve(null),
      opts.signal,
    );
    const parsed = chatReplySchema.safeParse({ body: redactReviewerText(body ?? "") });
    if (!parsed.success || parsed.data.body.length > MODEL_REPLY_MAX_LENGTH) {
      throw new ChatInvariantError("TrueForge returned an empty, oversize, or invalid chat response");
    }

    await complete(lease, { body: parsed.data.body, providerTurnId: turn.turnId });
    return lease.threadId;
  } catch (error) {
    if (error instanceof LeaseLostError) return lease.threadId;
    if (error instanceof ChatInvariantError) {
      try {
        await cancel(lease);
      } catch (recoveryError) {
        if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
      }
      return lease.threadId;
    }

    try {
      await fail(lease);
    } catch (recoveryError) {
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }
    if (opts.signal?.aborted) throw opts.signal.reason;
    // Preserve the error for a caller that wants to log it, while the durable row remains retryable.
    throw new Error(`reviewer chat worker failed: ${errorMessage(error)}`);
  }
}

export { loadWork as loadReviewerChatWork };
