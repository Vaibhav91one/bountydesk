import { connectedRepository, db, eq, githubInstallation, report, verdict } from "@/lib/db";
import { GitHubApiError } from "@/lib/github/app-auth";
import { GitHubRequestError, classifyFindings, type Advisory } from "@/lib/github/advisory";
import { activeRepository } from "@/lib/github/lifecycle";
import { verdictFindings } from "@/lib/reports/case-facts";

import type { DeliveryArm } from "./arm";
import { runWithHeartbeat } from "./queue";

// `report.source_ref` for an advisory-channel report, e.g. "github:123456:advisory:GHSA-xxxx-...".
// The GHSA id is the reporter's advisory, the one this report came from; group 2 is that id.
const ADVISORY_SOURCE_REF = /^github:(\d+):advisory:(.+)$/;

// The frozen outbox target for an email report bound to an advisory-capable repo. It names the repo,
// not a GHSA, because no advisory exists yet: the arm opens one. "create" is not a valid GHSA id, so
// it never collides with the source-ref shape above.
const ADVISORY_CREATE_TARGET = /^github:(\d+):advisory:create$/;

const MAX_SUMMARY = 1024;

function deliveryMarker(verdictId: string): string {
  return `<!-- bountydesk-delivery:${verdictId} -->`;
}

/**
 * Write the verdict back onto a repository's security advisory.
 *
 * Two reports reach here. An advisory-channel report came in as a private vulnerability report, a
 * repository security advisory GitHub already created and whose GHSA id its source_ref carries;
 * advisories have no comments API, so replying means editing that advisory's description. An email
 * report bound to an advisory-capable repo has no advisory of its own, so a draft is opened the first
 * time, which for a connected repo is where a fix and CVE flow start. Either way this is the advisory
 * analogue of `githubArm` and earns the same completesReport: the create's 201 or the PATCH's 200
 * carrying a ghsa_id is the receipt, so the report is DELIVERED in the same transaction.
 *
 * Idempotency needs no stored ghsa_id. For the reply path the source_ref names the advisory, so a
 * read that already finds this verdict's marker is a replay and any earlier revision's text is
 * PATCHed up. For the create path a draft an earlier attempt opened carries one of this report's
 * verdict markers, so findAdvisoryByMarker turns a retry into a PATCH of that draft instead of a
 * twin. The PATCH is idempotent either way: repeating it writes the same approved bytes.
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

  if (!row || !row.installationId || !row.repoId || !row.fullName) {
    return {
      kind: "refused",
      message: `report ${ctx.report.id} has no bound GitHub repository`,
    };
  }

  const installationId = row.installationId;
  const repoId = row.repoId;

  // The destination is frozen on the outbox row at approval. A create target that no longer names the
  // bound repository, or a source_ref that moved, is not the delivery a human approved.
  const createMatch = lease.target.match(ADVISORY_CREATE_TARGET);
  const sourceMatch = ctx.report.sourceRef.match(ADVISORY_SOURCE_REF);
  let ghsaId: string | null;
  if (createMatch) {
    const targetRepoId = Number(createMatch[1]);
    if (!Number.isSafeInteger(targetRepoId) || targetRepoId !== repoId) {
      return {
        kind: "refused",
        message: `delivery ${lease.id} target does not match report ${ctx.report.id}`,
      };
    }
    ghsaId = null;
  } else if (sourceMatch) {
    const sourceRepoId = Number(sourceMatch[1]);
    if (lease.target !== ctx.report.sourceRef || !Number.isSafeInteger(sourceRepoId) || sourceRepoId !== repoId) {
      return {
        kind: "refused",
        message: `delivery ${lease.id} target does not match report ${ctx.report.id}`,
      };
    }
    ghsaId = sourceMatch[2];
  } else {
    return {
      kind: "refused",
      message: `report ${ctx.report.id} has an unparseable advisory source ref`,
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

  const fullName = repository.fullName;
  const marker = deliveryMarker(lease.verdictId);

  let result: { kind: "replayed" | "updated" | "created"; advisory: Advisory };
  try {
    result = await runWithHeartbeat(
      lease,
      ctx.leaseSeconds,
      async (signal) => {
        const { token } = await deps.mintToken(installationId, repoId, { signal });

        if (ghsaId) {
          const current = await deps.getAdvisory({ token, fullName, ghsaId, signal });
          if (current.description.includes(marker)) {
            return { kind: "replayed", advisory: current } as const;
          }
          const advisory = await deps.updateAdvisoryDescription({
            token,
            fullName,
            ghsaId,
            description: ctx.payload,
            signal,
          });
          return { kind: "updated", advisory } as const;
        }

        // Create path. Any of this report's verdict markers on a draft means an earlier attempt or an
        // earlier revision already opened it: find it to PATCH rather than open a second advisory.
        const revisions = await db
          .select({ id: verdict.id })
          .from(verdict)
          .where(eq(verdict.reportId, ctx.report.id));
        const existing = await deps.findAdvisoryByMarker({
          token,
          fullName,
          markers: revisions.map((v) => deliveryMarker(v.id)),
          signal,
        });
        if (existing?.marker === marker) {
          return { kind: "replayed", advisory: existing } as const;
        }
        if (existing) {
          const advisory = await deps.updateAdvisoryDescription({
            token,
            fullName,
            ghsaId: existing.ghsaId,
            description: ctx.payload,
            signal,
          });
          return { kind: "updated", advisory } as const;
        }

        // Severity and CWEs are read off the approved verdict's own findings, the same as the
        // owner-advisory path, never asked of a model. The owner can edit both on the draft.
        const [source] = await db
          .select({ evidence: verdict.evidence })
          .from(verdict)
          .where(eq(verdict.id, lease.verdictId))
          .limit(1);
        const { severity, cweIds } = classifyFindings(verdictFindings(source?.evidence));
        const advisory = await deps.createDraftAdvisory({
          token,
          fullName,
          // The report title is reporter-controlled, so it is flattened and capped before it becomes
          // the advisory summary.
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
    // "Repository security advisories: write"; a 404 is that plus an advisory it cannot see; a 422
    // is GitHub rejecting the edit or the draft. None is fixed by retrying, and accepting the
    // permission is a human's action, so hold the row. A rate-limited 403 is transient and falls
    // through to retry.
    const mintRefusal =
      err instanceof GitHubApiError && !err.rateLimited && (err.status === 403 || err.status === 404);
    const apiRefusal =
      err instanceof GitHubRequestError && (err.status === 403 || err.status === 404 || err.status === 422);
    if (mintRefusal || apiRefusal) {
      return {
        kind: "refused",
        hold: true,
        message: `GitHub refused the advisory write for ${fullName} (${(err as { status?: number }).status}); accept "Repository security advisories: write" on the installation, then a human can retry`,
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

  // The create returned a ghsa_id (201) or the PATCH did (200): the advisory now carries the
  // approved verdict text.
  return {
    kind: "sent",
    responseStatus: result.kind === "created" ? 201 : 200,
    responseBody: JSON.stringify(result.advisory),
    completesReport: true,
  };
};
