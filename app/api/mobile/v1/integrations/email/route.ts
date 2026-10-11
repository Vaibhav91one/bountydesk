import { z } from "zod";

import { canManageReviewers, listReviewers, startVerification } from "@/lib/auth/reviewers";
import { sendVerificationEmail } from "@/lib/email/resend";
import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";

export const runtime = "nodejs";

/**
 * The reviewer allowlist for the email channel, the same list the web page renders.
 * Any reviewer may read it; only an owner may add or verify addresses.
 */
export async function GET(): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const rows = await listReviewers();
  return json(rows);
}

const addSchema = z.object({ email: z.string().email() });

/**
 * Add a pending reviewer: create/refresh the row and mail the code. Owner-only.
 *
 * Reuses startVerification and sendVerificationEmail, the exact primitives the web action
 * (reviewer-actions.ts) uses, so the hashing, expiry, and attempt cap cannot drift.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await mobileAuth({ write: true });
  if (!gate.ok) return gate.response;

  if (!canManageReviewers(gate.session.email)) {
    return jsonError("only an owner can add reviewers", 403);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return jsonError("invalid body: email is required", 400);

  const email = parsed.data.email.trim().toLowerCase();
  let result: { status: "code_sent"; code: string } | { status: "already_verified" };
  try {
    result = await startVerification(email, gate.session.email);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "could not add that address", 400);
  }

  if (result.status === "already_verified") {
    return json({ ok: true, message: "that address is already verified." });
  }

  try {
    await sendVerificationEmail(email, result.code, "reviewer");
  } catch {
    return json({ ok: false, error: "the address was added, but the code email failed to send. try again." }, 503);
  }

  return json({ ok: true, codeSent: true });
}
