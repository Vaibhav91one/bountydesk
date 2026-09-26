import { connectedRepository, db, eq, githubInstallation, report } from "@/lib/db";
import { GitHubApiError } from "@/lib/github/app-auth";
import { GitHubRequestError, type Advisory } from "@/lib/github/advisory";
import { activeRepository } from "@/lib/github/lifecycle";

import type { DeliveryArm } from "./arm";
import { runWithHeartbeat } from "./queue";

// `report.source_ref` for an advisory-channel report, e.g. "github:123456:advisory:GHSA-xxxx-...".
// The GHSA id is the reporter's advisory, the one this report came from; group 2 is that id.
const ADVISORY_SOURCE_REF = /^github:(\d+):advisory:(.+)$/;

function deliveryMarker(verdictId: string): string {
  return `<!-- bountydesk-delivery:${verdictId} -->`;
}

/**
 * Write the verdict back onto the repository's security advisory.
 *
 * The report came in as a private vulnerability report, which is a repository security advisory
 * GitHub already created and whose GHSA id the report's source_ref carries. Advisories have no
 * comments API, so "reply to the report" means editing that advisory's description, not opening a
 * new one: the reporter's advisory is the conversation surface. This is the advisory analogue of
 * `githubArm`, and it earns the same completesReport, the PATCH returning a ghsa_id is the receipt,
 * so the report is DELIVERED in the same transaction.
 *
 * Idempotency needs no stored ghsa_id, because the source_ref already names the advisory. The
 * verdict payload carries its own delivery marker, so a read that finds this verdict's marker
 * already in the description is a replay (an earlier attempt PATCHed and died before committing
 * SENT), and a description carrying an earlier revision's text is PATCHed up to the new approved
 * payload. The PATCH is idempotent either way: repeating it writes the same approved bytes.
 */
export const advisoryArm: DeliveryArm = async (ctx, deps) => {
  const { lease } = ctx;

  const [row] = await db
    .select({
      installationId: githubInstallation.installationId,
      repoId: connectedRepository.repoId,
      fullName: connectedRepository.fullName,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
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
  const ghsaId = sourceMatch[2];

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

  let result: { kind: "replayed" | "updated"; advisory: Advisory };
  try {
    result = await runWithHeartbeat(
      lease,
      ctx.leaseSeconds,
      async (signal) => {
        const { token } = await deps.mintToken(installationId, repoId, { signal });
        const current = await deps.getAdvisory({ token, fullName: repository.fullName, ghsaId, signal });
        if (current.description.includes(marker)) {
          return { kind: "replayed", advisory: current } as const;
        }
        const advisory = await deps.updateAdvisoryDescription({
          token,
          fullName: repository.fullName,
          ghsaId,
          description: ctx.payload,
          signal,
        });
        return { kind: "updated", advisory } as const;
      },
      ctx.signal,
    );
  } catch (err) {
    // GitHub saying no, not GitHub being down. A 403 is an installation that has not accepted
    // "Repository security advisories: write"; a 404 is that plus an advisory it cannot see; a 422
    // is GitHub rejecting the edit. None is fixed by retrying, and accepting the permission is a
    // human's action, so hold the row. A rate-limited 403 is transient and falls through to retry.
    const mintRefusal =
      err instanceof GitHubApiError && !err.rateLimited && (err.status === 403 || err.status === 404);
    const apiRefusal =
      err instanceof GitHubRequestError && (err.status === 403 || err.status === 404 || err.status === 422);
    if (mintRefusal || apiRefusal) {
      return {
        kind: "refused",
        hold: true,
        message: `GitHub refused the advisory edit for ${repository.fullName} (${(err as { status?: number }).status}); accept "Repository security advisories: write" on the installation, then a human can retry`,
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

  // The PATCH returned a ghsa_id: the advisory now carries the approved verdict text.
  return {
    kind: "sent",
    responseStatus: 200,
    responseBody: JSON.stringify(result.advisory),
    completesReport: true,
  };
};
