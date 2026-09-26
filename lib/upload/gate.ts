import { ECOSYSTEMS, type BuildPlan, type Ecosystem } from "@/lib/build-onboarding/build-plan";
import { and, db, eq, isNull, report, sql, uploadIntake } from "@/lib/db";
import { recordEvent, transition } from "@/lib/reports/lifecycle";
import { targetDefinitionFromManifest } from "@/lib/targets/manifest";
import type { TargetDefinition } from "@/lib/targets/registry";
import type { GateResult } from "@/lib/triage/gate";

/**
 * The reviewer's half of an upload that brought target material.
 *
 * Releasing the report with its material is the only way an upload gets built. The reviewer states
 * how the target runs (its port, readiness path, optional start command and build ecosystem), and the
 * server turns that into a target definition through the same validator a reviewed manifest goes
 * through. The uploader's text never reaches it: the name and repository label are derived from the
 * report id, and the scope is the manifest default, loopback only.
 */

/** What a reviewer approves. Everything else in the definition is server-authored. */
export type UploadTargetInput = {
  port: number;
  readinessPath: string;
  startCommand?: string;
  ecosystem?: Ecosystem;
};

/** Stored on the upload row at approval and read back by the build loop. */
export type ReviewedUploadTarget = { definition: TargetDefinition; ecosystem: Ecosystem };

/** The untagged image name the build overrides; it only has to satisfy the manifest validator. */
const PENDING_IMAGE_NAME = "ghcr.io/bountydesk/upload-pending";

export function uploadTargetName(reportId: string): string {
  return `upload-${reportId.toLowerCase()}`;
}

/** Validate the reviewer's input into the definition and plan the build loop will use. Throws on bad input. */
export function reviewedUploadTarget(reportId: string, input: UploadTargetInput): ReviewedUploadTarget {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("the port must be a whole number from 1 to 65535");
  }
  const definition = targetDefinitionFromManifest({
    name: uploadTargetName(reportId),
    repoFullName: `upload/${reportId.toLowerCase()}`,
    imageName: PENDING_IMAGE_NAME,
    baseUrl: `http://localhost:${input.port}`,
    readinessPath: input.readinessPath.trim(),
    ...(input.startCommand?.trim() ? { startCommand: input.startCommand.trim() } : {}),
  });

  const ecosystem = input.ecosystem ?? "none";
  if (!ECOSYSTEMS.includes(ecosystem)) throw new Error(`the ecosystem must be one of ${ECOSYSTEMS.join(", ")}`);
  return { definition, ecosystem };
}

/**
 * The build plan for a piece of upload material. A tarball or an uploaded Dockerfile builds the
 * Dockerfile at the archive root; a prebuilt image is rebuilt FROM its digest with the build marker
 * baked in, and fetches nothing beyond its own (allowlisted) registry.
 */
export function uploadBuildPlan(
  material: { kind: string; imageRef: string | null },
  ecosystem: Ecosystem,
): BuildPlan {
  if (material.kind === "image") {
    if (!material.imageRef) throw new Error("image material has no reference");
    return { strategy: "image", ecosystem: "none", baseImage: material.imageRef };
  }
  return { strategy: "dockerfile", ecosystem, dockerfilePath: "Dockerfile", buildContext: "." };
}

/**
 * Release an upload report from the gate and queue its target material for a build.
 *
 * The report moves NEEDS_DECISION to TRIAGING and the upload row to build_state PENDING in one
 * transaction under the report's row lock, the same lock every other gate action takes, so a report
 * can be released once. The analysis run is queued by the build loop after the build, bound or not.
 */
export async function approveUploadTarget(
  reportId: string,
  reviewer: string,
  input: UploadTargetInput,
): Promise<GateResult> {
  return db.transaction(async (tx): Promise<GateResult> => {
    const [row] = await tx
      .select({ state: report.state, channel: report.channel })
      .from(report)
      .where(eq(report.id, reportId))
      .for("update");
    if (!row || row.channel !== "upload") return { ok: false, reason: "report not found" };
    if (row.state !== "NEEDS_DECISION") {
      return { ok: false, reason: `report is ${row.state}; it is no longer waiting for a decision` };
    }

    const [upload] = await tx
      .select({ materialKind: uploadIntake.materialKind })
      .from(uploadIntake)
      .where(eq(uploadIntake.reportId, reportId))
      .limit(1);
    if (!upload?.materialKind) return { ok: false, reason: "this upload carried no target material to build" };

    let reviewed: ReviewedUploadTarget;
    try {
      reviewed = reviewedUploadTarget(reportId, input);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "the target settings are not valid" };
    }

    const updated = await tx
      .update(uploadIntake)
      .set({
        reviewedTarget: reviewed,
        approvedBy: reviewer,
        buildState: "PENDING",
        buildAttempts: 0,
        buildError: null,
        buildLeaseExpiresAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(uploadIntake.reportId, reportId), isNull(uploadIntake.buildState)))
      .returning({ id: uploadIntake.id });
    if (updated.length === 0) return { ok: false, reason: "this upload's target was already approved" };

    await transition(reportId, "NEEDS_DECISION", "TRIAGING", tx);
    await recordEvent(
      reportId,
      "upload.target_approved",
      { reviewer, targetName: reviewed.definition.name, config: reviewed.definition.config, ecosystem: reviewed.ecosystem },
      { tx },
    );
    return { ok: true };
  });
}

export type UploadView = {
  materialKind: string | null;
  sourceArchiveDigest: string | null;
  imageRef: string | null;
  imageDigest: string | null;
  materialBytes: number | null;
  buildState: string | null;
  buildError: string | null;
  contact: string | null;
  contactVerified: boolean;
};

/** What the case file shows for an upload: the material, its build, and whether the contact is proven. */
export async function readUpload(reportId: string): Promise<UploadView | null> {
  const [row] = await db
    .select({
      materialKind: uploadIntake.materialKind,
      sourceArchiveDigest: uploadIntake.sourceArchiveDigest,
      imageRef: uploadIntake.imageRef,
      imageDigest: uploadIntake.imageDigest,
      materialBytes: uploadIntake.materialBytes,
      buildState: uploadIntake.buildState,
      buildError: uploadIntake.buildError,
      contact: report.reporterContact,
      verifiedSender: report.verifiedSender,
    })
    .from(uploadIntake)
    .innerJoin(report, eq(report.id, uploadIntake.reportId))
    .where(eq(uploadIntake.reportId, reportId))
    .limit(1);
  if (!row) return null;
  const { verifiedSender, ...view } = row;
  return { ...view, contactVerified: Boolean(row.contact && verifiedSender === row.contact) };
}
