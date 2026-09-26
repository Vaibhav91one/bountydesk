import type { BuildDriver, BuildSource } from "@/lib/build-onboarding/build-driver";
import { bindConnectionlessTargetFromBuild } from "@/lib/build-onboarding/connectionless-bind";
import { and, db, eq, lte, or, report, sql, targetProfile, uploadIntake, type Executor } from "@/lib/db";
import { safeErrorText } from "@/lib/errors/safe-error";
import { enqueue } from "@/lib/jobs/queue";
import { recordEvent } from "@/lib/reports/lifecycle";
import { bindTarget } from "@/lib/targets/bind";
import type { GateAnalysisPayload } from "@/lib/triage/gate";

import { uploadBuildPlan, type ReviewedUploadTarget } from "./gate";

/**
 * The loop that turns reviewer-approved upload material into a bound target.
 *
 * A row reaches this only after a reviewer released its report with a target definition (build_state
 * PENDING). The build runs through the non-GitHub build path (a BuildSource of kind archive or image),
 * the result is pinned with bindConnectionlessTargetFromBuild, and the report is bound to that profile.
 * Whatever happens, the report then gets the same analysis run the gate's "Run analysis" queues: with a
 * bound target it can reproduce, and without one (the build failed) it stops at ANALYSIS_ONLY, which is
 * the "no bound target, no REPRODUCED" rule rather than a dead end.
 *
 * It runs in its own daemon loop, not the jobs loop, because a build takes as long as the build
 * sandbox allows and the jobs loop's health budget is a few minutes.
 */

/** Longer than the build sandbox's 30 minute ttl, so a live build never loses its lease. */
const LEASE_MINUTES = 45;
/** A failed build is retried once, for a transient provider failure; after that it stays failed. */
const MAX_BUILD_ATTEMPTS = 2;

type ClaimedUpload = {
  id: string;
  reportId: string;
  materialKind: string;
  archive: Buffer | null;
  sourceArchiveDigest: string | null;
  imageRef: string | null;
  imageDigest: string | null;
  reviewedTarget: ReviewedUploadTarget;
  approvedBy: string;
  buildAttempts: number;
};

async function claim(): Promise<ClaimedUpload | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: uploadIntake.id })
      .from(uploadIntake)
      .where(
        or(
          eq(uploadIntake.buildState, "PENDING"),
          and(eq(uploadIntake.buildState, "BUILDING"), lte(uploadIntake.buildLeaseExpiresAt, sql`now()`)),
        ),
      )
      .orderBy(uploadIntake.updatedAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;

    const [claimed] = await tx
      .update(uploadIntake)
      .set({
        buildState: "BUILDING",
        buildLeaseExpiresAt: sql`now() + make_interval(mins => ${LEASE_MINUTES})`,
        buildAttempts: sql`${uploadIntake.buildAttempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(uploadIntake.id, row.id))
      .returning();
    return claimed as unknown as ClaimedUpload;
  });
}

/** The material as a build source. The archive digest was computed from these bytes at intake. */
export function uploadBuildSource(upload: Pick<ClaimedUpload, "materialKind" | "archive" | "sourceArchiveDigest" | "imageRef" | "imageDigest">): BuildSource {
  if (upload.materialKind === "image") {
    if (!upload.imageRef || !upload.imageDigest) throw new Error("image material is incomplete");
    return { kind: "image", imageRef: upload.imageRef, imageDigest: upload.imageDigest };
  }
  if (!upload.archive || !upload.sourceArchiveDigest) throw new Error("archive material is incomplete");
  return { kind: "archive", archive: Buffer.from(upload.archive), sourceArchiveDigest: upload.sourceArchiveDigest };
}

/**
 * Write the row's outcome and queue the analysis run, in one transaction. The attempt count is the
 * fence: a worker whose lease expired and was re-claimed has a stale count and writes nothing.
 */
async function finish(
  upload: ClaimedUpload,
  outcome: { state: "BUILT" | "FAILED" | "PENDING"; error?: string },
): Promise<void> {
  await db.transaction(async (tx: Executor) => {
    const updated = await tx
      .update(uploadIntake)
      .set({
        buildState: outcome.state,
        buildError: outcome.error ?? null,
        buildLeaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(uploadIntake.id, upload.id),
          eq(uploadIntake.buildState, "BUILDING"),
          eq(uploadIntake.buildAttempts, upload.buildAttempts),
        ),
      )
      .returning({ id: uploadIntake.id });
    if (updated.length === 0 || outcome.state === "PENDING") return;

    await recordEvent(
      upload.reportId,
      outcome.state === "BUILT" ? "upload.target_bound" : "upload.build_failed",
      outcome.error ? { reason: outcome.error } : {},
      { tx },
    );
    const payload: GateAnalysisPayload = { intake: "gate-analysis", reportId: upload.reportId };
    await enqueue({ channel: "email", deliveryId: `gate-analysis:${upload.reportId}`, payload }, tx);
  });
}

/**
 * Build and bind, or find the bind an earlier attempt already made. Returns the target name.
 *
 * A crash can land after the profile was written or after the report was bound, so each step checks
 * for its own result first: rebuilding would produce a new digest that the existing profile refuses.
 */
async function buildAndBind(upload: ClaimedUpload, driver: BuildDriver, signal?: AbortSignal): Promise<string> {
  const { definition, ecosystem } = upload.reviewedTarget;

  const [bound] = await db
    .select({ targetProfileId: report.targetProfileId })
    .from(report)
    .where(eq(report.id, upload.reportId))
    .limit(1);
  if (bound?.targetProfileId) return definition.name;

  const [existing] = await db
    .select({ id: targetProfile.id })
    .from(targetProfile)
    .where(eq(targetProfile.name, definition.name))
    .limit(1);

  let profileId = existing?.id;
  if (!profileId) {
    const result = await driver.build(
      {
        repoFullName: definition.repoFullName,
        sourceRef: `upload:${upload.reportId}`,
        source: uploadBuildSource(upload),
        plan: uploadBuildPlan({ kind: upload.materialKind, imageRef: upload.imageRef }, ecosystem),
      },
      { signal },
    );
    profileId = (await bindConnectionlessTargetFromBuild(definition, result)).targetProfileId;
  }

  const binding = await bindTarget(upload.reportId, profileId, upload.approvedBy);
  if (!binding.ok) throw new Error(`the target was built but not bound: ${binding.reason}`);
  return binding.targetName;
}

/** Claim one approved upload and build it. Returns the upload row id, or null when nothing was waiting. */
export async function buildUploadOnce({
  driver,
  signal,
}: {
  driver: BuildDriver;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (signal?.aborted) return null;
  const upload = await claim();
  if (!upload) return null;

  if (upload.buildAttempts > MAX_BUILD_ATTEMPTS) {
    await finish(upload, { state: "FAILED", error: `gave up after ${MAX_BUILD_ATTEMPTS} attempts` });
    return upload.id;
  }

  try {
    await buildAndBind(upload, driver, signal);
    await finish(upload, { state: "BUILT" });
  } catch (error) {
    // A shutdown mid-build leaves the row BUILDING; its lease expires and another claim resumes it.
    if (signal?.aborted) throw error;
    const reason = safeErrorText(error, 500);
    console.error(`upload build ${upload.id} failed: ${reason}`);
    await finish(upload, {
      state: upload.buildAttempts < MAX_BUILD_ATTEMPTS ? "PENDING" : "FAILED",
      error: reason,
    });
  }
  return upload.id;
}
