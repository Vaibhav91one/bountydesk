import { and, eq } from "drizzle-orm";

import { isReviewer } from "@/lib/auth/reviewers";
import type { Session } from "@/lib/auth/session";
import { db, targetOnboarding } from "@/lib/db";

/**
 * The human gate on onboarding: a reviewer approves the proposed manifest before it becomes a
 * TargetProfile.
 *
 * The worker cannot cross AWAITING_APPROVAL on its own (claim() excludes that state), so this is
 * the only path from a proposal to APPROVED, and therefore the only path to a written profile.
 * The reviewer allow-list is re-checked here, not just at login, so a reviewer removed from the
 * list cannot approve with a still-valid cookie, mirroring lib/targets/configure-request.ts.
 */
export type ApproveResult = { ok: true } | { ok: false; error: string };

export async function approveOnboardingRequest(
  session: Session | null,
  rawRepoId: unknown,
): Promise<ApproveResult> {
  if (!session || !isReviewer(session.userId)) {
    return { ok: false, error: "You are not signed in as a reviewer." };
  }

  const repoId = Number(rawRepoId);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    return { ok: false, error: "That repository id is not valid." };
  }

  // Guard the state in the WHERE, not after a read: two reviewers clicking at once cannot both
  // move the row, and a row already past AWAITING_APPROVAL is left untouched.
  const updated = await db
    .update(targetOnboarding)
    .set({
      state: "APPROVED",
      approvedBy: session.login,
      approvedAt: new Date(),
      // Clear any prior failure and let the worker pick it up promptly.
      nextAttemptAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(targetOnboarding.repoId, repoId),
        eq(targetOnboarding.state, "AWAITING_APPROVAL"),
      ),
    )
    .returning({ id: targetOnboarding.id });

  if (updated.length === 0) {
    return { ok: false, error: "No onboarding is awaiting approval for that repository." };
  }
  return { ok: true };
}
