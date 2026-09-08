"use server";

import { revalidatePath } from "next/cache";

import { currentSession, requireReviewer } from "@/lib/auth/dal";
import { db, eq } from "@/lib/db";
import { targetOnboarding } from "@/lib/db/schema";
import {
  approveOnboardingRequest,
  type ApproveResult,
} from "@/lib/build-onboarding/approve-request";

import { selectOnboardingArtifact } from "./artifact-select";

export type { ApproveResult };
export type { OnboardingArtifactKind, ArtifactResult } from "./artifact-select";
type OnboardingArtifactKind = "dockerfile" | "manifest" | "buildplan" | "buildlog";
type ArtifactResult = { ok: true; filename: string; text: string } | { ok: false; error: string };

/**
 * Return an onboarding artifact for download: the Dockerfile the agent authored, the proposed target
 * manifest, the build plan, or the build log. The text is fetched on demand here rather than shipped
 * in the connections list.
 *
 * Reviewer authorization is the access boundary: a reviewer sees the whole connections screen, so any
 * reviewer may fetch any repository's onboarding artifacts, which is intended. `repoId` selects the
 * onboarding row (validated to a positive integer and used in a parameterized lookup); it is not a
 * per-repo authorization check, and nothing here should later be made to rely on it as one.
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

  return selectOnboardingArtifact(row, kind);
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
