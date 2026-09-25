import { connectedRepository, db, eq, report, targetProfile, verdict } from "@/lib/db";
import { recordEvent, transition } from "@/lib/reports/lifecycle";

/**
 * Why the profile is being removed, which decides where its bound reports land.
 *
 * "invalid-target" (the default) is a target that could not be trusted or provisioned: a stale
 * row written before fail-closed validation existed. Nothing is wrong with the report, only with
 * its target, so it drops to ANALYSIS_ONLY and a human decides.
 *
 * "out-of-scope" is a scope determination: the bound repository or target is outside the
 * bounty's authorised scope. That is a deterministic rejection made before any verdict exists, so
 * the report moves to the terminal OUT_OF_SCOPE. This branch only ever runs for a report that has
 * a bound target (quarantine selects reports by target profile id), so it never produces
 * OUT_OF_SCOPE from the mere absence of a target, and never weakens no-target -> ANALYSIS_ONLY.
 */
export type QuarantineDisposition = "invalid-target" | "out-of-scope";

export type QuarantineStaleTargetProfileInput = {
  /** The logical profile name, e.g. "juice-shop-v17.3.0". Looked up, not taken by row id. */
  profileName: string;
  /** The stale values this profile is expected to hold. A mismatch refuses rather than acts. */
  expectedImageDigest: string;
  expectedSnapshotId: string;
  reason: string;
  /** Defaults to "invalid-target". See QuarantineDisposition. */
  disposition?: QuarantineDisposition;
};

export type QuarantineStaleTargetProfileResult = {
  quarantinedProfileId: string;
  clearedReportIds: string[];
  clearedRepositoryIds: string[];
};

/**
 * Remove a target profile that was written before fail-closed validation existed, without
 * losing the audit trail of anything that referenced it.
 *
 * This is a repair for one specific mistake, not a general "unbind and delete" operation, so
 * it is deliberately narrow. It refuses unless every one of these holds:
 *
 *   - a profile with this name exists, and its digest and snapshot id are exactly the stale
 *     values the caller expects, not merely "some digest" or "some snapshot id"
 *   - every report bound to it is still TRIAGING
 *   - none of those reports has a verdict, which is transitively true for approval and
 *     delivery too, since both are recorded off a verdict that does not exist here
 *
 * A report that fails any of those checks is left exactly as it is, and the whole transaction
 * rolls back: a partially-quarantined profile is worse than one nobody has touched yet, since
 * it would look cleaned up while still being reachable through a report that was skipped.
 *
 * The report itself is kept. Deleting an authenticated intake record would erase the evidence
 * that it was ever received; the new state plus an audit event says what happened without
 * pretending the report never existed. Where it lands depends on `disposition`: ANALYSIS_ONLY
 * for an invalid target, terminal OUT_OF_SCOPE for a scope rejection. It is not expected to be
 * reused for reproduction afterwards — a verified target gets a fresh report once one exists.
 */
export async function quarantineStaleTargetProfile(
  input: QuarantineStaleTargetProfileInput,
): Promise<QuarantineStaleTargetProfileResult> {
  return db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(targetProfile)
      .where(eq(targetProfile.name, input.profileName))
      .limit(1)
      .for("update");

    if (!profile) {
      throw new Error(`no target profile named ${input.profileName}`);
    }
    if (
      profile.imageDigest !== input.expectedImageDigest ||
      profile.snapshotId !== input.expectedSnapshotId
    ) {
      throw new Error(
        `target profile ${input.profileName} does not match the expected stale values; refusing to quarantine a profile that might be real`,
      );
    }

    const repos = await tx
      .select({ id: connectedRepository.id })
      .from(connectedRepository)
      .where(eq(connectedRepository.targetProfileId, profile.id))
      .for("update");

    const reports = await tx
      .select({ id: report.id, state: report.state })
      .from(report)
      .where(eq(report.targetProfileId, profile.id))
      .for("update");

    for (const r of reports) {
      if (r.state !== "TRIAGING") {
        throw new Error(
          `report ${r.id} is ${r.state}, not TRIAGING; refusing to quarantine a target something has already acted on`,
        );
      }

      const [existingVerdict] = await tx
        .select({ id: verdict.id })
        .from(verdict)
        .where(eq(verdict.reportId, r.id))
        .limit(1);

      if (existingVerdict) {
        throw new Error(
          `report ${r.id} already has a verdict; refusing to quarantine its target`,
        );
      }
    }

    // A scope determination is terminal (OUT_OF_SCOPE); a bad or unprovisionable target is not
    // the report's fault, so it drops to ANALYSIS_ONLY for a human. Both cases have a bound
    // target here, so OUT_OF_SCOPE is never produced from the absence of one.
    const outOfScope = input.disposition === "out-of-scope";
    const to = outOfScope ? "OUT_OF_SCOPE" : "ANALYSIS_ONLY";
    const eventType = outOfScope ? "target.out_of_scope" : "target.invalidated";

    for (const r of reports) {
      await transition(r.id, "TRIAGING", to, tx);
      await recordEvent(
        r.id,
        eventType,
        { targetProfileId: profile.id, targetProfileName: profile.name, reason: input.reason },
        { tx },
      );
      await tx.update(report).set({ targetProfileId: null }).where(eq(report.id, r.id));
    }

    for (const repo of repos) {
      await tx
        .update(connectedRepository)
        .set({ targetProfileId: null })
        .where(eq(connectedRepository.id, repo.id));
    }

    await tx.delete(targetProfile).where(eq(targetProfile.id, profile.id));

    return {
      quarantinedProfileId: profile.id,
      clearedReportIds: reports.map((r) => r.id),
      clearedRepositoryIds: repos.map((repo) => repo.id),
    };
  });
}
