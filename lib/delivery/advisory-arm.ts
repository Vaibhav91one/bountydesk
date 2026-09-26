import {
  connectedRepository,
  db,
  eq,
  githubInstallation,
  report,
  verdict,
} from "@/lib/db";
import { GitHubApiError } from "@/lib/github/app-auth";
import { classifyFindings, GitHubRequestError, type Advisory } from "@/lib/github/advisory";
import { activeRepository } from "@/lib/github/lifecycle";
import { verdictFindings } from "@/lib/reports/case-facts";

import type { DeliveryArm } from "./arm";
import { runWithHeartbeat } from "./queue";

// `report.source_ref` for an advisory-channel report, e.g. "github:123456:advisory:GHSA-xxxx-...".
// The GHSA id is not re-validated here beyond being present: it is the worker that read it from
// GitHub, and the shape matches what parseAdvisory writes and publish-verdict accepts.
const ADVISORY_SOURCE_REF = /^github:(\d+):advisory:(.+)$/;

const MAX_SUMMARY = 1024;

function deliveryMarker(verdictId: string): string {
  return `<!-- bountydesk-delivery:${verdictId} -->`;
}

/**
 * Write the verdict back onto the repository's security advisory.
 *
 * GitHub security advisories have no comments API, so "reply to the report" here means editing the
 * advisory itself: open the draft on the first delivery, and replace its description on a later
 * revision. This is the advisory analogue of `githubArm`, and it earns the same completesReport:
 * the create or PATCH returning a ghsa_id is itself the receipt, so the report is DELIVERED in the
 * same transaction.
 *
 * Idempotency rests entirely on the delivery marker in the payload, because unlike the owner
 * advisory path there is no stored ghsa_id column to fall back on. Every verdict revision's payload
 * carries its own marker, and any of a report's revisions naming an advisory identifies this
 * report's advisory. If the advisory already carries this verdict's marker, an earlier attempt
 * already wrote it, so this is a replay; if it carries an earlier revision's marker, this PATCHes
 * that same advisory up to the new approved text; otherwise it opens the draft.
 */
export const advisoryArm: DeliveryArm = async (ctx, deps) => {
  const { lease } = ctx;

  const [row] = await db
    .select({
      installationId: githubInstallation.installationId,
      repoId: connectedRepository.repoId,
      fullName: connectedRepository.fullName,
      evidence: verdict.evidence,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .innerJoin(verdict, eq(verdict.id, lease.verdictId))
    .where(eq(report.id, ctx.report.id))
    .limit(1);

  const sourceMatch = ctx.report.sourceRef.match(ADVISORY_SOURCE_REF);

  if (!row || !row.installationId || !row.repoId || !row.fullName || !sourceMatch) {
    return {
      kind: "refused",
      message: `report ${ctx.report.id} has no bound GitHub repository or an unparseable advisory source ref`,
    };
  }

  const installationId = row.installationId;
  const repoId = row.repoId;
  const sourceRepoId = Number(sourceMatch[1]);

  // The destination is frozen on the outbox row at approval. A source_ref that no longer names the
  // bound repository is not the delivery a human approved.
  if (lease.target !== ctx.report.sourceRef || !Number.isSafeInteger(sourceRepoId) || sourceRepoId !== repoId) {
    return {
      kind: "refused",
      message: `delivery ${lease.id} target does not match report ${ctx.report.id}`,
    };
  }

  // Re-checked live, before a token exists: an uninstall, suspension, or target unbind between
  // approval and now stops the write and holds the row for a human, exactly like githubArm.
  const repository = await activeRepository(installationId, repoId);
  if (!repository) {
    return {
      kind: "refused",
      hold: true,
      message: `repository ${row.fullName} is no longer connected (suspended, deleted, removed, or missing a target profile); a human has to reconnect it`,
    };
  }

  const marker = deliveryMarker(lease.verdictId);

  let result:
    | { kind: "replayed"; advisory: Advisory }
    | { kind: "created" | "patched"; advisory: Advisory };
  try {
    result = await runWithHeartbeat(
      lease,
      ctx.leaseSeconds,
      async (signal) => {
        const { token } = await deps.mintToken(installationId, repoId, { signal });

        // Any revision's marker names this report's advisory, so a crashed attempt that opened one
        // is found rather than twinned.
        const revisions = await db
          .select({ id: verdict.id })
          .from(verdict)
          .where(eq(verdict.reportId, ctx.report.id));
        const existing = await deps.findAdvisoryByMarker({
          token,
          fullName: repository.fullName,
          markers: revisions.map((v) => deliveryMarker(v.id)),
          signal,
        });

        if (existing?.marker === marker) {
          return { kind: "replayed", advisory: existing } as const;
        }
        if (existing) {
          const advisory = await deps.updateAdvisoryDescription({
            token,
            fullName: repository.fullName,
            ghsaId: existing.ghsaId,
            description: ctx.payload,
            signal,
          });
          return { kind: "patched", advisory } as const;
        }

        const { severity, cweIds } = classifyFindings(verdictFindings(row.evidence));
        const advisory = await deps.createDraftAdvisory({
          token,
          fullName: repository.fullName,
          summary: ctx.report.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_SUMMARY) || "Security report",
          description: ctx.payload,
          severity,
          cweIds,
          signal,
        });
        return { kind: "created", advisory } as const;
      },
      ctx.signal,
    );
  } catch (err) {
    // GitHub saying no, not GitHub being down. A 403 is an installation that has not accepted
    // "Repository security advisories: write"; a 404 is that plus a repository it cannot see; a
    // 422 is GitHub rejecting the advisory's shape. None is fixed by retrying, and reconnecting or
    // accepting the permission is a human's action, so hold the row. A rate-limited 403 is
    // transient and falls through to the retry path.
    const mintRefusal =
      err instanceof GitHubApiError && !err.rateLimited && (err.status === 403 || err.status === 404);
    const apiRefusal =
      err instanceof GitHubRequestError && (err.status === 403 || err.status === 404 || err.status === 422);
    if (mintRefusal || apiRefusal) {
      return {
        kind: "refused",
        hold: true,
        message: `GitHub refused the advisory for ${repository.fullName} (${(err as { status?: number }).status}); accept "Repository security advisories: write" on the installation, then a human can retry`,
      };
    }
    throw err;
  }

  if (result.kind === "replayed") {
    return {
      kind: "replayed",
      note: `advisory ${result.advisory.ghsaId} already carries this verdict's marker; no second write`,
      completesReport: true,
    };
  }

  // The create or PATCH returned a ghsa_id: the advisory exists and carries the approved text.
  return {
    kind: "sent",
    responseStatus: 200,
    responseBody: JSON.stringify(result.advisory),
    completesReport: true,
  };
};
