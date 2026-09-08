import {
  approvalDecision,
  connectedRepository,
  db,
  deliveryAttempt,
  eq,
  githubInstallation,
  report,
  verdict,
  type Executor,
} from "@/lib/db";
import { activeRepository } from "@/lib/github/lifecycle";
import { transition } from "@/lib/reports/lifecycle";
import type { IssueComment } from "@/lib/github/comment";

import {
  claim,
  claimById,
  fail,
  failPermanently,
  LeaseLostError,
  markSent,
  releaseUnstarted,
  renew,
  type DeliveryLease,
} from "./queue";

/**
 * Response bodies and error strings are stored for incident review. Unbounded text from a
 * misbehaving upstream should not become an unbounded row.
 */
const MAX_STORED_TEXT = 4000;

function truncate(text: string): string {
  return text.length > MAX_STORED_TEXT ? text.slice(0, MAX_STORED_TEXT) : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The injectable boundary keeps GitHub calls deterministic in worker tests. */
export type DeliveryDeps = {
  githubAppId: number;
  hashContent: (payload: string) => string;
  mintToken: (
    installationId: number,
    repoId: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ token: string; expiresAt: string }>;
  postComment: (opts: {
    token: string;
    fullName: string;
    issueNumber: number;
    body: string;
    signal?: AbortSignal;
  }) => Promise<{ id: number }>;
  listComments: (opts: {
    token: string;
    fullName: string;
    issueNumber: number;
    signal?: AbortSignal;
  }) => Promise<IssueComment[]>;
};

async function defaultDeps(): Promise<DeliveryDeps> {
  const [hash, appAuth, comment] = await Promise.all([
    import("@/lib/verdicts/hash"),
    import("@/lib/github/app-auth"),
    import("@/lib/github/comment"),
  ]);

  return {
    githubAppId: Number((await import("@/lib/env")).githubAppId()),
    hashContent: hash.computeContentHash,
    mintToken: appAuth.mintInstallationToken,
    postComment: comment.postIssueComment,
    listComments: comment.listIssueComments,
  };
}

async function runWithHeartbeat<T>(
  lease: DeliveryLease,
  leaseSeconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([controller.signal, outerSignal])
    : controller.signal;
  const intervalMs = Math.max(50, Math.floor((leaseSeconds * 1000) / 3));
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
    const result = await Promise.race([
      operation(signal),
      leaseLoss,
      aborted,
    ]);
    if (signal.aborted) throw signal.reason;
    return result;
  } finally {
    stopped = true;
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    await renewal.catch(() => undefined);
  }
}

async function recordAttempt(
  deliveryId: string,
  attempt: number,
  fields: { responseStatus?: number; responseBody?: string; error?: string },
  startedAt: Date,
  tx: Executor = db,
): Promise<void> {
  await tx
    .insert(deliveryAttempt)
    .values({
      deliveryId,
      attempt,
      responseStatus: fields.responseStatus ?? null,
      responseBody: fields.responseBody ?? null,
      error: fields.error ?? null,
      startedAt,
    })
    .onConflictDoNothing({
      target: [deliveryAttempt.deliveryId, deliveryAttempt.attempt],
    });
}

async function refuseDelivery(
  lease: DeliveryLease,
  message: string,
  startedAt: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await recordAttempt(
      lease.id,
      lease.attempts,
      { error: message },
      startedAt,
      tx,
    );
    await failPermanently(lease, message, tx);
  });
}

/** `report.source_ref` for a GitHub-channel report, e.g. "github:123456:issue:482". */
const GITHUB_SOURCE_REF = /^github:(\d+):issue:(\d+)$/;

/**
 * Drive one outbox row as far as its lease allows.
 *
 * Returns the delivery id once something was done with it (sent, recognised as already sent,
 * or permanently refused), or null when the outbox had nothing claimable.
 */
export async function deliverOnce(
  owner: string,
  {
    leaseSeconds = 60,
    deps,
    signal,
  }: { leaseSeconds?: number; deps?: DeliveryDeps; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (signal?.aborted) return null;
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  return deliverClaimed(lease, { leaseSeconds, deps, signal });
}

/**
 * Drive one known outbox row. Review actions use this for synthesized analysis-only verdicts,
 * where the approval request just enqueued a specific delivery and should not wait for an
 * external scheduler to drain it later.
 */
export async function deliverById(
  deliveryId: string,
  owner: string,
  {
    leaseSeconds = 60,
    deps,
    signal,
  }: { leaseSeconds?: number; deps?: DeliveryDeps; signal?: AbortSignal } = {},
): Promise<string | null> {
  if (signal?.aborted) return null;
  const lease = await claimById(owner, deliveryId, leaseSeconds);
  if (!lease) return null;

  return deliverClaimed(lease, { leaseSeconds, deps, signal });
}

async function deliverClaimed(
  lease: DeliveryLease,
  {
    leaseSeconds,
    deps,
    signal,
  }: { leaseSeconds: number; deps?: DeliveryDeps; signal?: AbortSignal },
): Promise<string | null> {
  if (signal?.aborted) {
    try {
      await releaseUnstarted(lease);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    }
    return null;
  }

  const startedAt = new Date();

  try {
    const d = deps ?? (await defaultDeps());

    // The verdict is read-only evidence; the hash check happens before anything else touches
    // the network, because a mismatch means the stored payload was tampered with or corrupted
    // after approval, and no amount of retrying against GitHub fixes that.
    const [verdictRow] = await db
      .select({
        reportId: verdict.reportId,
        payload: verdict.payload,
        contentHash: verdict.contentHash,
      })
      .from(verdict)
      .where(eq(verdict.id, lease.verdictId))
      .limit(1);

    if (!verdictRow) {
      await refuseDelivery(
        lease,
        `verdict ${lease.verdictId} no longer exists`,
      );
      return lease.id;
    }

    const computedHash = d.hashContent(verdictRow.payload);
    if (computedHash !== lease.approvedContentHash) {
      const message =
        `content hash mismatch for verdict ${lease.verdictId}: stored payload hashes to ` +
        `${computedHash}, approval was for ${lease.approvedContentHash}`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    const [approval] = await db
      .select({
        decision: approvalDecision.decision,
        payloadHash: approvalDecision.payloadHash,
      })
      .from(approvalDecision)
      .where(eq(approvalDecision.verdictId, lease.verdictId))
      .limit(1);

    if (
      !approval ||
      approval.decision !== "APPROVED" ||
      approval.payloadHash !== lease.approvedContentHash ||
      verdictRow.contentHash !== lease.approvedContentHash
    ) {
      const message = `delivery ${lease.id} has no matching approved decision`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    if (verdictRow.reportId !== lease.reportId) {
      const message = `verdict ${lease.verdictId} does not belong to delivery report ${lease.reportId}`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    const marker = `<!-- bountydesk-delivery:${lease.verdictId} -->`;
    if (verdictRow.payload.split(marker).length !== 2) {
      const message = `verdict ${lease.verdictId} payload must contain its delivery marker exactly once`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    const [target] = await db
      .select({
        sourceRef: report.sourceRef,
        state: report.state,
        installationId: githubInstallation.installationId,
        repoId: connectedRepository.repoId,
        fullName: connectedRepository.fullName,
      })
      .from(report)
      .leftJoin(
        connectedRepository,
        eq(report.connectedRepositoryId, connectedRepository.id),
      )
      .leftJoin(
        githubInstallation,
        eq(connectedRepository.installationId, githubInstallation.id),
      )
      .where(eq(report.id, lease.reportId))
      .limit(1);

    const sourceMatch = target?.sourceRef.match(GITHUB_SOURCE_REF);

    if (
      !target ||
      !target.installationId ||
      !target.repoId ||
      !target.fullName ||
      !sourceMatch
    ) {
      const message = `report ${lease.reportId} has no bound GitHub repository or an unparseable source ref`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    const installationId = target.installationId;
    const repoId = target.repoId;

    if (target.state !== "DELIVERING") {
      const message = `report ${lease.reportId} is ${target.state}, not DELIVERING`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    const issueNumber = Number(sourceMatch[2]);
    const sourceRepoId = Number(sourceMatch[1]);

    if (
      lease.target !== target.sourceRef ||
      !Number.isSafeInteger(sourceRepoId) ||
      sourceRepoId !== repoId ||
      !Number.isSafeInteger(issueNumber) ||
      issueNumber <= 0
    ) {
      const message = `delivery ${lease.id} target does not match report ${lease.reportId}`;
      await refuseDelivery(lease, message);
      return lease.id;
    }

    // Refusal is checked before minting a token: an installation can be suspended, or a
    // repository removed or archived, between approval and this attempt, and that check must
    // never be skipped in favour of "we already have a token so let's just try".
    const repository = await activeRepository(installationId, repoId);
    if (!repository) {
      const message = `repository ${target.fullName} is no longer connected (suspended, deleted, removed, or missing a target profile); a human has to reconnect it`;
      await refuseDelivery(lease, message, startedAt);
      return lease.id;
    }

    const result = await runWithHeartbeat(
      lease,
      leaseSeconds,
      async (signal) => {
        const { token } = await d.mintToken(installationId, repoId, { signal });
        const comments = await d.listComments({
          token,
          fullName: repository.fullName,
          issueNumber,
          signal,
        });

        if (
          comments.some(
            (comment) =>
              comment.body === verdictRow.payload &&
              comment.authorType === "Bot" &&
              comment.githubAppId === d.githubAppId,
          )
        )
          return { kind: "replayed" } as const;

        const posted = await d.postComment({
          token,
          fullName: repository.fullName,
          issueNumber,
          body: verdictRow.payload,
          signal,
        });
        return { kind: "posted", posted } as const;
      },
      signal,
    );

    if (result.kind === "replayed") {
      // Crash recovery: the comment already went out on a prior attempt that died before
      // this worker could commit SENT/DELIVERED. Posting again would duplicate the comment,
      // so this path never reaches postComment.
      await db.transaction(async (tx) => {
        await recordAttempt(
          lease.id,
          lease.attempts,
          {
            error:
              "marker already present on the issue; treating as already delivered, no comment posted",
          },
          startedAt,
          tx,
        );
        await markSent(lease, tx);
        await transition(lease.reportId, "DELIVERING", "DELIVERED", tx);
      });
    } else {
      await db.transaction(async (tx) => {
        await recordAttempt(
          lease.id,
          lease.attempts,
          {
            responseStatus: 201,
            responseBody: truncate(JSON.stringify(result.posted)),
          },
          startedAt,
          tx,
        );
        await markSent(lease, tx);
        await transition(lease.reportId, "DELIVERING", "DELIVERED", tx);
      });
    }
    return lease.id;
  } catch (err) {
    if (err instanceof LeaseLostError) return lease.id;

    // A network failure or a non-2xx from GitHub is transient: retry on backoff rather than
    // burying the delivery. The report deliberately stays in DELIVERING here (see
    // lib/reports/states.ts): a failing send is not a report-lifecycle event.
    const message = truncate(errorMessage(err));
    try {
      await db.transaction(async (tx) => {
        await recordAttempt(
          lease.id,
          lease.attempts,
          { error: message },
          startedAt,
          tx,
        );
        await fail(lease, message, tx);
      });
    } catch (recoveryError) {
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }
    return lease.id;
  }
}

export type { DeliveryLease };
