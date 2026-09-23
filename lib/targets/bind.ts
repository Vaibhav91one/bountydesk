import {
  connectedRepository,
  db,
  desc,
  eq,
  githubInstallation,
  isNull,
  report,
  targetProfile,
  type Executor,
} from "@/lib/db";
import { recordEvent } from "@/lib/reports/lifecycle";
import { isTerminal, type ReportState } from "@/lib/reports/states";

/**
 * Bind a reproduction target to a report that arrived without one.
 *
 * A GitHub report inherits its target from the connected repository the issue was filed on. An
 * email or uploaded report has no repository to inherit from, so it lands with
 * `target_profile_id` null, and `assertVerdictInsertAllowed` then correctly refuses any verdict
 * except `ANALYSIS_ONLY`. That refusal is the invariant and it does not move: this is how a
 * report satisfies it, by a human choosing a target from the profiles the server already holds.
 *
 * Nothing the reporter wrote reaches this. The caller passes a profile id, it is looked up
 * server-side, and the report is bound to the row that exists.
 */

export type BindTargetResult =
  | { ok: true; targetName: string }
  | { ok: false; reason: string };

/**
 * The repository that owns a profile, when one does.
 *
 * Copied onto the report along with the target so a revoked grant stops an email report exactly
 * as it stops a GitHub one: `hasActiveRepositoryGrant` reads `connected_repository_id` off the
 * report, and a report bound to a target but to no repository is treated as always active. That
 * is right for a target nobody can revoke, and wrong for one that came from an installation, so
 * the link is made here rather than left null.
 */
type OwningRepository = {
  id: string;
  fullName: string;
  active: boolean;
  archivedAt: Date | null;
  installationSuspendedAt: Date | null;
  installationDeletedAt: Date | null;
};

async function owningRepository(
  profileId: string,
  tx: Executor,
): Promise<OwningRepository | null> {
  const [row] = await tx
    .select({
      id: connectedRepository.id,
      fullName: connectedRepository.fullName,
      active: connectedRepository.active,
      archivedAt: connectedRepository.archivedAt,
      installationSuspendedAt: githubInstallation.suspendedAt,
      installationDeletedAt: githubInstallation.deletedAt,
    })
    .from(connectedRepository)
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .where(eq(connectedRepository.targetProfileId, profileId))
    // An active grant first, so a stale row for the same profile cannot mask a live one.
    .orderBy(desc(connectedRepository.active), connectedRepository.archivedAt)
    .limit(1);
  return row ?? null;
}

/** The same conditions hasActiveRepositoryGrant applies, asked before binding instead of after. */
function grantIsLive(repo: OwningRepository): boolean {
  return (
    repo.active &&
    repo.archivedAt === null &&
    repo.installationSuspendedAt === null &&
    repo.installationDeletedAt === null
  );
}

export async function bindTarget(
  reportId: string,
  profileId: string,
  reviewer: string,
): Promise<BindTargetResult> {
  return db.transaction(async (tx): Promise<BindTargetResult> => {
    const [reportRow] = await tx
      .select({ state: report.state, targetProfileId: report.targetProfileId })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");
    if (!reportRow) return { ok: false, reason: "report not found" };

    const state = reportRow.state as ReportState;
    if (isTerminal(state)) {
      return { ok: false, reason: `report is ${state}; a closed report cannot change target` };
    }
    // Mid-delivery the approved verdict is already on its way out, and its outcome was gated on
    // whatever target the report had when it was drafted.
    if (state === "DELIVERING") {
      return { ok: false, reason: "report is delivering; its verdict is already on its way" };
    }
    if (reportRow.targetProfileId) {
      // Rebinding would change what a drafted verdict was judged against. Nothing needs it yet,
      // and refusing is cheaper to reason about than deciding what happens to that verdict.
      return { ok: false, reason: "report already has a bound target" };
    }

    const [profile] = await tx
      .select({ id: targetProfile.id, name: targetProfile.name, retiredAt: targetProfile.retiredAt })
      .from(targetProfile)
      .where(eq(targetProfile.id, profileId))
      .limit(1);
    if (!profile) return { ok: false, reason: "target profile not found" };
    // The picker hides retired profiles, but a stale page can still post one.
    if (profile.retiredAt) return { ok: false, reason: `${profile.name} is retired` };

    // A profile owned by a repository whose grant is already revoked would bind fine and then
    // refuse every definitive verdict, which reads as the feature being broken. Say so now.
    const repo = await owningRepository(profile.id, tx);
    if (repo && !grantIsLive(repo)) {
      return {
        ok: false,
        reason: `${repo.fullName} no longer grants access to this target, so it could not be reproduced against`,
      };
    }

    await tx
      .update(report)
      .set({
        targetProfileId: profile.id,
        connectedRepositoryId: repo?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(report.id, reportId));

    // Every other target change on a report records one, and this is the only place a human
    // picks what gets executed against.
    await recordEvent(
      reportId,
      "target.bound",
      { targetProfileId: profile.id, targetName: profile.name, reviewer, repositoryId: repo?.id ?? null },
      { tx },
    );

    return { ok: true, targetName: profile.name };
  });
}

export type TargetProfileOption = {
  id: string;
  name: string;
  imageDigest: string | null;
};

/**
 * The profiles a reviewer may bind, for the picker.
 *
 * Reads the database rather than `listTargetDefinitions()` in the registry: that lists what the
 * code knows how to build, and this needs what has actually been built and verified, which is
 * the row that carries an id and an image digest.
 */
export async function listTargetProfiles(): Promise<TargetProfileOption[]> {
  return db
    .select({
      id: targetProfile.id,
      name: targetProfile.name,
      imageDigest: targetProfile.imageDigest,
    })
    .from(targetProfile)
    .where(isNull(targetProfile.retiredAt))
    .orderBy(targetProfile.name);
}
