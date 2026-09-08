"use server";

import { revalidatePath } from "next/cache";

import { currentSession, requireReviewer } from "@/lib/auth/dal";
import { db, eq } from "@/lib/db";
import { targetOnboarding } from "@/lib/db/schema";
import {
  approveOnboardingRequest,
  type ApproveResult,
} from "@/lib/build-onboarding/approve-request";

export type { ApproveResult };

export type OnboardingArtifactKind = "dockerfile" | "manifest" | "buildplan" | "buildlog";
export type ArtifactResult = { ok: true; filename: string; text: string } | { ok: false; error: string };

/**
 * Return an onboarding artifact for download: the Dockerfile the agent authored, the proposed target
 * manifest, the build plan, or the build log. Reviewer-gated, and the text is fetched on demand here
 * rather than shipped in the connections list. The repository id is validated to a positive integer;
 * the row is looked up by it server-side, so nothing a caller passes selects a different repo's data.
 */
export async function getOnboardingArtifact(
  repoId: number,
  kind: OnboardingArtifactKind,
): Promise<ArtifactResult> {
  await requireReviewer();
  if (!Number.isSafeInteger(repoId) || repoId <= 0) return { ok: false, error: "invalid repository" };

  const [row] = await db
    .select({
      repoFullName: targetOnboarding.repoFullName,
      dockerfileText: targetOnboarding.dockerfileText,
      proposedManifest: targetOnboarding.proposedManifest,
      buildPlan: targetOnboarding.buildPlan,
      buildLog: targetOnboarding.buildLog,
    })
    .from(targetOnboarding)
    .where(eq(targetOnboarding.repoId, repoId))
    .limit(1);
  if (!row) return { ok: false, error: "no onboarding record for that repository" };

  const base = row.repoFullName.split("/").pop() ?? "target";
  switch (kind) {
    case "dockerfile":
      return row.dockerfileText
        ? { ok: true, filename: "Dockerfile", text: row.dockerfileText }
        : { ok: false, error: "no Dockerfile was recorded" };
    case "manifest":
      return row.proposedManifest
        ? { ok: true, filename: `${base}.manifest.json`, text: JSON.stringify(row.proposedManifest, null, 2) }
        : { ok: false, error: "no manifest was proposed" };
    case "buildplan":
      return row.buildPlan
        ? { ok: true, filename: `${base}.build-plan.json`, text: JSON.stringify(row.buildPlan, null, 2) }
        : { ok: false, error: "no build plan was recorded" };
    case "buildlog":
      return row.buildLog
        ? { ok: true, filename: `${base}.build.log`, text: row.buildLog }
        : { ok: false, error: "no build log was recorded" };
    default:
      return { ok: false, error: "unknown artifact" };
  }
}

/**
 * Approve a built target's proposed manifest, the one human gate before it becomes a
 * TargetProfile.
 *
 * Deliberately thin, the same as the integrations actions: a server action is a POST that
 * reaches the server on its own, so the layout guard does not run for it. The reviewer check
 * and the AWAITING_APPROVAL guard both live in approveOnboardingRequest, where they are tested.
 */
export async function approveOnboarding(
  _previous: ApproveResult | null,
  formData: FormData,
): Promise<ApproveResult> {
  const result = await approveOnboardingRequest(
    await currentSession(),
    formData.get("repoId"),
  );

  if (result.ok) revalidatePath("/connections");

  return result;
}
