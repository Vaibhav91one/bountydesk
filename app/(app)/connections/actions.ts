"use server";

import { revalidatePath } from "next/cache";

import { currentSession } from "@/lib/auth/dal";
import {
  approveOnboardingRequest,
  type ApproveResult,
} from "@/lib/build-onboarding/approve-request";

export type { ApproveResult };

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
