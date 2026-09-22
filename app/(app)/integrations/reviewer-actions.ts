"use server";

import { revalidatePath } from "next/cache";

import { requireReviewer } from "@/lib/auth/dal";
import { canManageReviewers, removeReviewer, startVerification, verifyCode } from "@/lib/auth/reviewers";
import { sendVerificationEmail } from "@/lib/email/resend";

export type ReviewerActionResult = { ok: true; message?: string } | { ok: false; error: string };

/**
 * Every reviewer mutation is owner-only. requireReviewer proves a reviewer session, and the
 * canManage check is the second gate that keeps an added member from managing the list. A server
 * action arrives as its own request, so the checks live here, not only in the layout guard.
 */
async function requireOwnerEmail(): Promise<string | null> {
  const session = await requireReviewer();
  return canManageReviewers(session.email) ? session.email : null;
}

/**
 * Connect an email, or resend the code to a pending one. Both are the same step: create or refresh
 * the pending row and mail a fresh code. The row is not authorized until the code is entered.
 */
export async function connectEmail(email: string): Promise<ReviewerActionResult> {
  const owner = await requireOwnerEmail();
  if (!owner) return { ok: false, error: "Only an owner can add reviewers." };
  if (email.trim().length === 0) return { ok: false, error: "Enter an email address." };

  let result;
  try {
    result = await startVerification(email, owner);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not add that address." };
  }

  if (result.status === "already_verified") {
    revalidatePath("/integrations/email");
    return { ok: true, message: "That address is already verified." };
  }

  try {
    await sendVerificationEmail(email.trim().toLowerCase(), result.code);
  } catch {
    revalidatePath("/integrations/email");
    return { ok: false, error: "The address was added, but the code email failed to send. Try again." };
  }

  revalidatePath("/integrations/email");
  return { ok: true };
}

/** Confirm a pending reviewer with the code that was mailed to them. */
export async function verifyEmail(email: string, code: string): Promise<ReviewerActionResult> {
  const owner = await requireOwnerEmail();
  if (!owner) return { ok: false, error: "Only an owner can verify reviewers." };

  const result = await verifyCode(email, code);
  if (!result.ok) return result;

  revalidatePath("/integrations/email");
  return { ok: true };
}

/** Remove a reviewer, pending or verified. An env owner cannot be removed here. */
export async function disconnectEmail(email: string): Promise<ReviewerActionResult> {
  const owner = await requireOwnerEmail();
  if (!owner) return { ok: false, error: "Only an owner can remove reviewers." };

  try {
    await removeReviewer(email);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not remove that address." };
  }

  revalidatePath("/integrations/email");
  return { ok: true };
}
