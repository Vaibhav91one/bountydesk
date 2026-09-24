import {
  and,
  asc,
  connectedRepository,
  db,
  desc,
  eq,
  githubInstallation,
  isNotNull,
  lte,
  or,
  outboundDelivery,
  ownerAdvisory,
  report,
  sql,
  verdict,
} from "@/lib/db";
import { ne } from "drizzle-orm";
import { activeRepository } from "@/lib/github/lifecycle";
import { classifyFindings, type Advisory, type AdvisorySeverity } from "@/lib/github/advisory";
import { verdictFindings } from "@/lib/reports/case-facts";
import { recordEvent } from "@/lib/reports/lifecycle";
import {
  hasActiveRepositoryGrant,
  loadRepositoryGrantSnapshot,
} from "@/lib/targets/repository-grant";

/**
 * Tell a connected repository's owner about a reproduced report, as a private draft advisory.
 *
 * An email report's verdict goes to the reporter, so the owner has a vulnerability they have not
 * heard about. A GitHub report's verdict is a comment on an issue the owner can see, but an issue
 * is no place to track a fix, and a draft advisory is where GitHub's own private fix and CVE flow
 * starts. Either way this opens a draft, which only the repository's admins and security managers
 * can see, and which the owner publishes when it is fixed.
 *
 * It runs after delivery, never in place of it. The text is the verdict a human already approved
 * for the reporter, byte for byte, re-checked against that approval's hash when it is sent; a
 * reviewer's click on "Notify owner" chooses the destination, not the words. When a later revision
 * is delivered, the same click replaces the advisory's description with that revision's approved
 * text, under the same checks.
 */

export type RequestResult = { ok: true } | { ok: false; reason: string };

export async function requestOwnerAdvisory(
  reportId: string,
  reviewer: string,
): Promise<RequestResult> {
  return db.transaction(async (tx): Promise<RequestResult> => {
    const [row] = await tx
      .select({
        channel: report.channel,
        state: report.state,
        connectedRepositoryId: report.connectedRepositoryId,
      })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");
    if (!row) return { ok: false, reason: "report not found" };
    // Only these two deliver to a reporter. Naming them, rather than excluding the rest, keeps a
    // new channel from being offered this before anyone has thought about it.
    if (row.channel !== "email" && row.channel !== "github") {
      return { ok: false, reason: "only an email or GitHub report can notify the owner" };
    }
    if (row.state !== "DELIVERED") {
      return { ok: false, reason: "the verdict has to reach the reporter first" };
    }
    if (!row.connectedRepositoryId) {
      return { ok: false, reason: "the bound target belongs to no connected repository" };
    }

    const grant = await loadRepositoryGrantSnapshot(reportId, tx);
    if (!grant || !hasActiveRepositoryGrant(grant)) {
      return { ok: false, reason: "the repository no longer grants access" };
    }

    // The verdict the reporter actually received, and the hash that was approved for it.
    const [delivered] = await tx
      .select({
        verdictId: outboundDelivery.verdictId,
        approvedContentHash: outboundDelivery.approvedContentHash,
        outcome: verdict.outcome,
      })
      .from(outboundDelivery)
      .innerJoin(verdict, eq(outboundDelivery.verdictId, verdict.id))
      .where(
        and(
          eq(outboundDelivery.reportId, reportId),
          eq(outboundDelivery.state, "SENT"),
          isNotNull(outboundDelivery.deliveredAt),
        ),
      )
      .orderBy(desc(outboundDelivery.deliveredAt))
      .limit(1);
    if (!delivered) return { ok: false, reason: "no delivered verdict on record" };
    // Anything short of a reproduction gives the owner nothing to fix.
    if (delivered.outcome !== "REPRODUCED") {
      return { ok: false, reason: "only a reproduced verdict is sent to the owner" };
    }

    const fields = {
      verdictId: delivered.verdictId,
      connectedRepositoryId: row.connectedRepositoryId,
      approvedContentHash: delivered.approvedContentHash,
      requestedBy: reviewer,
    };
    // One advisory per report, pointed at whichever verdict it should carry. A FAILED row can be
    // asked for again, which is the normal path when the first send hit an installation that had
    // not yet accepted the advisories permission. A SENT row can be asked for again once a later
    // revision has been delivered, and keeps its ghsa_id so the sender updates that advisory
    // rather than opening a second. A pending row, or one already carrying this verdict, cannot,
    // so a double click never queues anything.
    const inserted = await tx
      .insert(ownerAdvisory)
      .values({ reportId, ...fields })
      .onConflictDoUpdate({
        target: ownerAdvisory.reportId,
        set: { ...fields, state: "PENDING", attempts: 0, lastError: null, nextAttemptAt: new Date(), updatedAt: new Date() },
        setWhere: or(
          eq(ownerAdvisory.state, "FAILED"),
          and(eq(ownerAdvisory.state, "SENT"), ne(ownerAdvisory.verdictId, delivered.verdictId)),
        ),
      })
      .returning({ id: ownerAdvisory.id, ghsaId: ownerAdvisory.ghsaId });
    if (inserted.length === 0) return { ok: false, reason: "the owner has already been notified" };

    await recordEvent(
      reportId,
      "owner_advisory.requested",
      {
        reviewer,
        verdictId: delivered.verdictId,
        contentHash: delivered.approvedContentHash,
        update: inserted[0].ghsaId !== null,
      },
      { tx },
    );
    return { ok: true };
  });
}

export type AdvisoryDeps = {
  hashContent: (payload: string) => string;
  mintToken: (
    installationId: number,
    repoId: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<{ token: string }>;
  findByMarker: (opts: {
    token: string;
    fullName: string;
    markers: string[];
    signal?: AbortSignal;
  }) => Promise<(Advisory & { marker: string }) | null>;
  create: (opts: {
    token: string;
    fullName: string;
    summary: string;
    description: string;
    severity: AdvisorySeverity | null;
    cweIds: string[];
    signal?: AbortSignal;
  }) => Promise<Advisory>;
  update: (opts: {
    token: string;
    fullName: string;
    ghsaId: string;
    description: string;
    signal?: AbortSignal;
  }) => Promise<Advisory>;
};

async function defaultDeps(): Promise<AdvisoryDeps> {
  const [hash, appAuth, advisory] = await Promise.all([
    import("@/lib/verdicts/hash"),
    import("@/lib/github/app-auth"),
    import("@/lib/github/advisory"),
  ]);
  return {
    hashContent: hash.computeContentHash,
    mintToken: appAuth.mintInstallationToken,
    findByMarker: advisory.findAdvisoryByMarker,
    create: advisory.createDraftAdvisory,
    update: advisory.updateAdvisoryDescription,
  };
}

const MAX_ATTEMPTS = 5;
// Long enough that a send in flight finishes before the row is claimable again.
const CLAIM_HOLD_MINUTES = 5;
const MAX_DESCRIPTION = 65_535;
const MAX_SUMMARY = 1024;

type Settle =
  | { state: "SENT"; advisory: Advisory; updated: boolean }
  | { state: "FAILED"; error: string }
  | { state: "RETRY"; error: string };

/**
 * Send one pending advisory. Returns its id once something was done with it, or null when
 * nothing was due.
 */
export async function adviseOnce(opts: { signal?: AbortSignal; deps?: AdvisoryDeps } = {}) {
  // Claim and release: the row lock is held only long enough to push next_attempt_at forward,
  // never across the network calls below.
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: ownerAdvisory.id })
      .from(ownerAdvisory)
      .where(and(eq(ownerAdvisory.state, "PENDING"), lte(ownerAdvisory.nextAttemptAt, sql`now()`)))
      .orderBy(asc(ownerAdvisory.nextAttemptAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const [updated] = await tx
      .update(ownerAdvisory)
      .set({
        attempts: sql`${ownerAdvisory.attempts} + 1`,
        nextAttemptAt: sql`now() + make_interval(mins => ${CLAIM_HOLD_MINUTES})`,
        updatedAt: new Date(),
      })
      .where(eq(ownerAdvisory.id, row.id))
      .returning();
    return updated;
  });
  if (!claimed) return null;

  const d = opts.deps ?? (await defaultDeps());
  let outcome: Settle;
  try {
    outcome = await send(claimed, d, opts.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: unknown }).status;
    // 403 and 404 are GitHub saying no: the installation has not accepted the advisories
    // permission, or private vulnerability reporting is off for the repository. Retrying
    // does not change either, a person does.
    // 403 is what an installation that has not accepted the permission gets, and it is the
    // one a reviewer can act on, so it says what to do; GitHub's own text follows for detail.
    outcome =
      status === 403
        ? {
            state: "FAILED",
            error: `The GitHub App installation has not granted "Repository security advisories: write". Accept it on the installation, then try again. (${message})`,
          }
        : status === 404 || status === 422
          ? { state: "FAILED", error: `GitHub refused the advisory (${status}): ${message}` }
          : { state: "RETRY", error: message };
  }

  const failedForGood = outcome.state === "RETRY" && claimed.attempts >= MAX_ATTEMPTS;
  await db
    .update(ownerAdvisory)
    .set(
      outcome.state === "SENT"
        ? { state: "SENT", ghsaId: outcome.advisory.ghsaId, htmlUrl: outcome.advisory.htmlUrl, lastError: null }
        : {
            state: outcome.state === "FAILED" || failedForGood ? "FAILED" : "PENDING",
            lastError: outcome.error.slice(0, 4000),
            // A retry waits a minute per attempt so far; the claim already pushed it out further
            // than that, so this only ever brings it forward.
            nextAttemptAt: sql`now() + make_interval(mins => ${claimed.attempts})`,
          },
    )
    .where(and(eq(ownerAdvisory.id, claimed.id), eq(ownerAdvisory.state, "PENDING")));

  if (outcome.state === "SENT") {
    await recordEvent(claimed.reportId, outcome.updated ? "owner_advisory.updated" : "owner_advisory.sent", {
      ghsaId: outcome.advisory.ghsaId,
      htmlUrl: outcome.advisory.htmlUrl,
      verdictId: claimed.verdictId,
    });
  }
  return claimed.id;
}

async function send(
  row: typeof ownerAdvisory.$inferSelect,
  d: AdvisoryDeps,
  signal?: AbortSignal,
): Promise<Settle> {
  const [source] = await db
    .select({
      payload: verdict.payload,
      contentHash: verdict.contentHash,
      evidence: verdict.evidence,
      verdictReportId: verdict.reportId,
      title: report.title,
      installationId: githubInstallation.installationId,
      repoId: connectedRepository.repoId,
      fullName: connectedRepository.fullName,
    })
    .from(verdict)
    .innerJoin(report, eq(report.id, row.reportId))
    .innerJoin(connectedRepository, eq(connectedRepository.id, row.connectedRepositoryId))
    .innerJoin(githubInstallation, eq(githubInstallation.id, connectedRepository.installationId))
    .where(eq(verdict.id, row.verdictId))
    .limit(1);
  if (!source) return { state: "FAILED", error: "verdict or repository is gone" };

  // The same checks delivery makes before anything leaves: the stored bytes still hash to what
  // was approved, and they belong to this report.
  const computed = d.hashContent(source.payload);
  if (computed !== row.approvedContentHash || source.contentHash !== row.approvedContentHash) {
    return { state: "FAILED", error: `content hash mismatch for verdict ${row.verdictId}` };
  }
  if (source.verdictReportId !== row.reportId) {
    return { state: "FAILED", error: `verdict ${row.verdictId} does not belong to report ${row.reportId}` };
  }
  const marker = deliveryMarker(row.verdictId);
  if (source.payload.split(marker).length !== 2) {
    return { state: "FAILED", error: "payload must contain its delivery marker exactly once" };
  }
  if (source.payload.length > MAX_DESCRIPTION) {
    return { state: "FAILED", error: "payload is longer than GitHub allows for an advisory" };
  }

  // Re-checked live, before a token exists: an uninstall between the click and now stops it.
  const repository = await activeRepository(Number(source.installationId), Number(source.repoId));
  if (!repository) {
    return { state: "FAILED", error: `${source.fullName} is no longer connected` };
  }

  const { token } = await d.mintToken(Number(source.installationId), Number(source.repoId), { signal });
  const fullName = repository.fullName;

  let ghsaId = row.ghsaId;
  if (!ghsaId) {
    // An attempt that died after GitHub created the advisory but before the row said SENT left
    // it there with its verdict's marker in it, and a later revision may since have been asked
    // for. Any revision's marker names this report's advisory; finding it is the difference
    // between a retry and a twin.
    const revisions = await db
      .select({ id: verdict.id })
      .from(verdict)
      .where(eq(verdict.reportId, row.reportId));
    const existing = await d.findByMarker({
      token,
      fullName,
      markers: revisions.map((v) => deliveryMarker(v.id)),
      signal,
    });
    if (existing?.marker === marker) return { state: "SENT", advisory: existing, updated: false };
    ghsaId = existing?.ghsaId ?? null;
  }

  if (ghsaId) {
    // Idempotent: a retry that repeats this PATCH writes the same approved bytes again.
    const advisory = await d.update({ token, fullName, ghsaId, description: source.payload, signal });
    return { state: "SENT", advisory, updated: true };
  }

  const { severity, cweIds } = classifyFindings(verdictFindings(source.evidence));
  const advisory = await d.create({
    token,
    fullName,
    summary: source.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUMMARY) || "Security report",
    description: source.payload,
    severity,
    cweIds,
    signal,
  });
  return { state: "SENT", advisory, updated: false };
}

function deliveryMarker(verdictId: string): string {
  return `<!-- bountydesk-delivery:${verdictId} -->`;
}
