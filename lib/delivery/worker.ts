import {
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

import { claim, fail, failPermanently, markSent, type DeliveryLease } from "./queue";

/** Response bodies and error strings are stored for incident review; unbounded text from a
 * misbehaving upstream should not become an unbounded row. */
const MAX_STORED_TEXT = 4000;

function truncate(text: string): string {
  return text.length > MAX_STORED_TEXT ? text.slice(0, MAX_STORED_TEXT) : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The seam for the cross-branch modules this worker depends on but that do not exist in
 * this worktree yet (lib/verdicts/hash, lib/github/app-auth, lib/github/comment are being
 * built on sibling branches). A test supplies a fake set; production leaves `deps` unset and
 * `deliverOnce` loads the real modules itself, lazily, via `defaultDeps` below.
 *
 * The load is dynamic rather than a static top-level import specifically so this file, and
 * anything that merely imports it, does not fail to resolve modules that do not exist here
 * yet. A static `import { computeContentHash } from "@/lib/verdicts/hash"` would throw at
 * module-load time regardless of whether a test ever exercises that branch; a dynamic
 * `import()` inside `defaultDeps` is only ever evaluated when no fake was injected, which
 * every test in this worktree avoids by always passing `deps`.
 */
export type DeliveryDeps = {
  hashContent: (payload: string) => string;
  mintToken: (
    installationId: number,
    repoId: number,
  ) => Promise<{ token: string; expiresAt: string }>;
  postComment: (opts: {
    token: string;
    fullName: string;
    issueNumber: number;
    body: string;
  }) => Promise<{ id: number }>;
  listComments: (opts: {
    token: string;
    fullName: string;
    issueNumber: number;
  }) => Promise<string[]>;
};

async function defaultDeps(): Promise<DeliveryDeps> {
  const [hash, appAuth, comment] = await Promise.all([
    import("@/lib/verdicts/hash"),
    import("@/lib/github/app-auth"),
    import("@/lib/github/comment"),
  ]);

  return {
    hashContent: hash.computeContentHash,
    mintToken: appAuth.mintInstallationToken,
    postComment: comment.postIssueComment,
    listComments: comment.listIssueComments,
  };
}

async function recordAttempt(
  deliveryId: string,
  attempt: number,
  fields: { responseStatus?: number; responseBody?: string; error?: string },
  startedAt: Date,
  tx: Executor = db,
): Promise<void> {
  await tx.insert(deliveryAttempt).values({
    deliveryId,
    attempt,
    responseStatus: fields.responseStatus ?? null,
    responseBody: fields.responseBody ?? null,
    error: fields.error ?? null,
    startedAt,
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
  { leaseSeconds = 60, deps }: { leaseSeconds?: number; deps?: DeliveryDeps } = {},
): Promise<string | null> {
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  const d = deps ?? (await defaultDeps());

  // The verdict is read-only evidence; the hash check happens before anything else touches
  // the network, because a mismatch means the stored payload was tampered with or corrupted
  // after approval, and no amount of retrying against GitHub fixes that.
  const [verdictRow] = await db
    .select({ payload: verdict.payload })
    .from(verdict)
    .where(eq(verdict.id, lease.verdictId))
    .limit(1);

  if (!verdictRow) {
    await recordAttempt(
      lease.id,
      lease.attempts,
      { error: `verdict ${lease.verdictId} no longer exists` },
      new Date(),
    );
    await failPermanently(lease, `verdict ${lease.verdictId} no longer exists`);
    return lease.id;
  }

  const computedHash = d.hashContent(verdictRow.payload);
  if (computedHash !== lease.approvedContentHash) {
    const message =
      `content hash mismatch for verdict ${lease.verdictId}: stored payload hashes to ` +
      `${computedHash}, approval was for ${lease.approvedContentHash}`;
    await recordAttempt(lease.id, lease.attempts, { error: message }, new Date());
    await failPermanently(lease, message);
    return lease.id;
  }

  const [target] = await db
    .select({
      sourceRef: report.sourceRef,
      installationId: githubInstallation.installationId,
      repoId: connectedRepository.repoId,
      fullName: connectedRepository.fullName,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .where(eq(report.id, lease.reportId))
    .limit(1);

  const sourceMatch = target?.sourceRef.match(GITHUB_SOURCE_REF);

  if (!target || !target.installationId || !target.repoId || !target.fullName || !sourceMatch) {
    const message = `report ${lease.reportId} has no bound GitHub repository or an unparseable source ref`;
    await recordAttempt(lease.id, lease.attempts, { error: message }, new Date());
    await failPermanently(lease, message);
    return lease.id;
  }

  const issueNumber = Number(sourceMatch[2]);

  // Refusal is checked before minting a token: an installation can be suspended, or a
  // repository removed or archived, between approval and this attempt, and that check must
  // never be skipped in favour of "we already have a token so let's just try".
  const repository = await activeRepository(target.installationId, target.repoId);
  if (!repository) {
    const message = `repository ${target.fullName} is no longer connected (suspended, deleted, removed, or missing a target profile); a human has to reconnect it`;
    await recordAttempt(lease.id, lease.attempts, { error: message }, new Date());
    await failPermanently(lease, message);
    return lease.id;
  }

  const marker = `<!-- bountydesk-delivery:${lease.verdictId} -->`;
  const startedAt = new Date();

  try {
    const { token } = await d.mintToken(target.installationId, target.repoId);
    const comments = await d.listComments({
      token,
      fullName: target.fullName,
      issueNumber,
    });

    if (comments.some((c) => c.includes(marker))) {
      // Crash recovery: the comment already went out on a prior attempt that died before
      // this worker could commit SENT/DELIVERED. Posting again would duplicate the comment,
      // so this path never reaches postComment.
      await recordAttempt(
        lease.id,
        lease.attempts,
        { error: "marker already present on the issue; treating as already delivered, no comment posted" },
        startedAt,
      );
    } else {
      const posted = await d.postComment({
        token,
        fullName: target.fullName,
        issueNumber,
        body: verdictRow.payload,
      });
      await recordAttempt(
        lease.id,
        lease.attempts,
        { responseStatus: 201, responseBody: truncate(JSON.stringify(posted)) },
        startedAt,
      );
    }

    await db.transaction(async (tx) => {
      await markSent(lease, tx);
      await transition(lease.reportId, "DELIVERING", "DELIVERED", tx);
    });
    return lease.id;
  } catch (err) {
    // A network failure or a non-2xx from GitHub is transient: retry on backoff rather than
    // burying the delivery. The report deliberately stays in DELIVERING here (see
    // lib/reports/states.ts): a failing send is not a report-lifecycle event.
    const message = truncate(errorMessage(err));
    await recordAttempt(lease.id, lease.attempts, { error: message }, startedAt);
    await fail(lease, message);
    return lease.id;
  }
}

export type { DeliveryLease };
