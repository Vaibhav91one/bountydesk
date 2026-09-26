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
import { GitHubApiError } from "@/lib/github/app-auth";
import { activeRepository } from "@/lib/github/lifecycle";
import { transition } from "@/lib/reports/lifecycle";

import { advisoryArm } from "./advisory-arm";
import { emailArm } from "./email";
import {
  claim,
  claimById,
  fail,
  failPermanently,
  LeaseLostError,
  markSent,
  releaseUnstarted,
  runWithHeartbeat,
  type DeliveryLease,
} from "./queue";
import type { ArmOutcome, DeliveryArm, DeliveryDeps } from "./arm";

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

async function defaultDeps(): Promise<DeliveryDeps> {
  const [hash, appAuth, comment, resend, advisory] = await Promise.all([
    import("@/lib/verdicts/hash"),
    import("@/lib/github/app-auth"),
    import("@/lib/github/comment"),
    import("@/lib/email/resend"),
    import("@/lib/github/advisory"),
  ]);

  return {
    githubAppId: Number((await import("@/lib/env")).githubAppId()),
    hashContent: hash.computeContentHash,
    mintToken: appAuth.mintInstallationToken,
    postComment: comment.postIssueComment,
    listComments: comment.listIssueComments,
    sendEmail: resend.sendVerdictEmail,
    getAdvisory: advisory.getAdvisory,
    updateAdvisoryDescription: advisory.updateAdvisoryDescription,
  };
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
  hold = false,
): Promise<void> {
  await db.transaction(async (tx) => {
    await recordAttempt(
      lease.id,
      lease.attempts,
      { error: message },
      startedAt,
      tx,
    );
    // A hold is for a refusal a human has to look at rather than one the evidence explains on
    // its own: an address that lost authorization, or a send we cannot prove did not already go
    // out. requires_human_review also takes the row out of claim()'s reach for good.
    await failPermanently(lease, message, tx, hold);
  });
}

/** `report.source_ref` for a GitHub-channel report, e.g. "github:123456:issue:482". */
const GITHUB_SOURCE_REF = /^github:(\d+):issue:(\d+)$/;

/**
 * Post the verdict as an issue comment.
 *
 * Unchanged from before there was a channel seam: the destination is resolved from the report's
 * installation and repository, the grant is re-checked live before a token is minted, and the
 * issue's own comments are read back so a crashed attempt cannot post twice. That read-back is
 * exactly what email cannot do, which is why the email arm has to buy the same safety another way.
 */
const githubArm: DeliveryArm = async (ctx, d) => {
  const { lease } = ctx;

  const [row] = await db
    .select({
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
    .where(eq(report.id, ctx.report.id))
    .limit(1);

  const sourceMatch = ctx.report.sourceRef.match(GITHUB_SOURCE_REF);

  if (!row || !row.installationId || !row.repoId || !row.fullName || !sourceMatch) {
    return {
      kind: "refused",
      message: `report ${ctx.report.id} has no bound GitHub repository or an unparseable source ref`,
    };
  }

  const installationId = row.installationId;
  const repoId = row.repoId;
  const issueNumber = Number(sourceMatch[2]);
  const sourceRepoId = Number(sourceMatch[1]);

  if (
    lease.target !== ctx.report.sourceRef ||
    !Number.isSafeInteger(sourceRepoId) ||
    sourceRepoId !== repoId ||
    !Number.isSafeInteger(issueNumber) ||
    issueNumber <= 0
  ) {
    return {
      kind: "refused",
      message: `delivery ${lease.id} target does not match report ${ctx.report.id}`,
    };
  }

  // Refusal is checked before minting a token: an installation can be suspended, or a
  // repository removed or archived, between approval and this attempt, and that check must
  // never be skipped in favour of "we already have a token so let's just try".
  const repository = await activeRepository(installationId, repoId);
  if (!repository) {
    return {
      kind: "refused",
      message: `repository ${row.fullName} is no longer connected (suspended, deleted, removed, or missing a target profile); a human has to reconnect it`,
    };
  }

  let result: { kind: "replayed" } | { kind: "posted"; posted: { id: number } };
  try {
    result = await runWithHeartbeat(
      lease,
      ctx.leaseSeconds,
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
              comment.body === ctx.payload &&
              comment.authorType === "Bot" &&
              comment.githubAppId === d.githubAppId,
          )
        )
          return { kind: "replayed" } as const;

        const posted = await d.postComment({
          token,
          fullName: repository.fullName,
          issueNumber,
          body: ctx.payload,
          signal,
        });
        return { kind: "posted", posted } as const;
      },
      ctx.signal,
    );
  } catch (err) {
    // A 403 or 404 minting the installation token is authoritative, not transient: the App is no
    // longer authorized for this repository, or the installation is gone. activeRepository passed
    // just above, so the webhook that should have caught this was dropped or arrived out of order.
    // Only mintToken throws GitHubApiError in this block (comment.ts throws plain Errors), so this
    // catches exactly the token-mint case. Refuse it like the pre-mint activeRepository failure
    // instead of retrying against an install that will keep refusing, and hold it: reconnecting is
    // a human's action, and the reconcile backstop will withdraw the stale grant on its next tick.
    // A rate-limited 403 is not a refusal and falls through to the retry path.
    if (err instanceof GitHubApiError && !err.rateLimited && (err.status === 403 || err.status === 404)) {
      return {
        kind: "refused",
        hold: true,
        message: `repository ${repository.fullName} is no longer connected (minting an installation token returned ${err.status}); a human has to reconnect it`,
      };
    }
    throw err;
  }

  // Crash recovery: the comment already went out on a prior attempt that died before the
  // worker could commit SENT/DELIVERED. Posting again would duplicate it.
  if (result.kind === "replayed") {
    return {
      kind: "replayed",
      note: "marker already present on the issue; treating as already delivered, no comment posted",
      completesReport: true,
    };
  }

  // A 201 from GitHub means the comment exists on the issue: acceptance is the receipt.
  return {
    kind: "sent",
    responseStatus: 201,
    responseBody: JSON.stringify(result.posted),
    completesReport: true,
  };
};

const ARMS: Partial<Record<"github" | "email" | "manual" | "upload" | "advisory", DeliveryArm>> = {
  github: githubArm,
  email: emailArm,
  // An upload has an OTP-verified email contact and no thread to reply into, which is exactly what
  // emailArm handles: threadingHeaders returns nothing for a non-email: source_ref, and the
  // recipient re-check reads verified_sender the same way.
  upload: emailArm,
  advisory: advisoryArm,
};

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

    // Channel-agnostic from here: which transport carries the bytes is the arm's business, but
    // every channel shares the requirement that the report is still mid-delivery. A report that
    // moved on (cancelled, or already delivered by an earlier attempt) must not receive a late
    // send.
    const [reportRow] = await db
      .select({
        channel: report.channel,
        sourceRef: report.sourceRef,
        title: report.title,
        state: report.state,
        reporterContact: report.reporterContact,
      })
      .from(report)
      .where(eq(report.id, lease.reportId))
      .limit(1);

    if (!reportRow) {
      await refuseDelivery(lease, `report ${lease.reportId} no longer exists`, startedAt);
      return lease.id;
    }

    if (reportRow.state !== "DELIVERING") {
      const message = `report ${lease.reportId} is ${reportRow.state}, not DELIVERING`;
      await refuseDelivery(lease, message, startedAt);
      return lease.id;
    }

    const arm = ARMS[reportRow.channel];
    const outcome: ArmOutcome = arm
      ? await arm(
          {
            lease,
            payload: verdictRow.payload,
            report: {
              id: lease.reportId,
              channel: reportRow.channel,
              sourceRef: reportRow.sourceRef,
              title: reportRow.title,
              reporterContact: reportRow.reporterContact,
            },
            leaseSeconds,
            startedAt,
            signal,
          },
          d,
        )
      : { kind: "refused", message: `unsupported delivery channel: ${reportRow.channel}` };

    if (outcome.kind === "refused") {
      await refuseDelivery(lease, outcome.message, startedAt, outcome.hold ?? false);
      return lease.id;
    }

    await db.transaction(async (tx) => {
      await recordAttempt(
        lease.id,
        lease.attempts,
        outcome.kind === "replayed"
          ? { error: outcome.note }
          : {
              responseStatus: outcome.responseStatus,
              responseBody: truncate(outcome.responseBody),
            },
        startedAt,
        tx,
      );
      // Only a transport whose acceptance is itself the receipt completes the report, and the
      // same flag decides whether delivered_at may be stamped now. Email earns SENT with a null
      // delivered_at and waits for its delivered webhook; see ArmOutcome.
      await markSent(lease, tx, outcome.completesReport);
      if (outcome.completesReport) {
        await transition(lease.reportId, "DELIVERING", "DELIVERED", tx);
      }
    });
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
export type { ArmOutcome, DeliveryArm, DeliveryContext, DeliveryDeps } from "./arm";
