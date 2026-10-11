import { z } from "zod";

import { canManageReviewers, verifyCode } from "@/lib/auth/reviewers";
import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";

export const runtime = "nodejs";

/**
 * Confirm a pending reviewer with the code that was mailed to them. Owner-only.
 *
 * Reuses verifyCode, the same primitive the web action uses, so the constant-time compare, expiry
 * check, and attempt cap are identical.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await mobileAuth({ write: true });
  if (!gate.ok) return gate.response;

  if (!canManageReviewers(gate.session.email)) {
    return jsonError("only an owner can verify reviewers", 403);
  }

  const schema = z.object({
    email: z.string().email(),
    code: z.string().length(6),
  });

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return jsonError("invalid body: email and 6-digit code are required", 400);

  const result = await verifyCode(parsed.data.email.trim().toLowerCase(), parsed.data.code);
  if (!result.ok) return jsonError(result.error, 400);

  return json({ ok: true });
}
