import { z } from "zod";

import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";
import { isReportId } from "@/lib/reports/case";
import { DECISION_FAILED, HASH_MISMATCH, decide } from "@/lib/review/decide";

const target = {
  verdictId: z.uuid(),
  // sha256 hex, as computeContentHash produces. Shape-checked here; equality is the gate's job.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
};
const approveSchema = z.object(target);
const denySchema = z.object({ ...target, reason: z.string().trim().min(1).max(2000) });

/**
 * Approve or deny from the phone, through the same `decide` the web actions call, so the row
 * locks, supersession check, pending-hash check, delivery enqueue and replay rules are the web's.
 * The only addition is `contentHash`: the hash of the text the reviewer was shown, which decide
 * compares against the verdict it would deliver and refuses on any difference.
 */
export async function handleDecision(
  request: Request,
  context: { params: Promise<{ id: string }> },
  outcome: "APPROVED" | "DENIED",
): Promise<Response> {
  const gate = await mobileAuth({ write: true });
  if (!gate.ok) return gate.response;

  const { id } = await context.params;
  if (!isReportId(id)) return jsonError("report not found", 404);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }
  const parsed = (outcome === "APPROVED" ? approveSchema : denySchema).safeParse(input);
  if (!parsed.success) return jsonError("invalid body", 400);
  const body = parsed.data as { verdictId: string; contentHash: string; reason?: string };

  const result = await decide(
    id,
    body.verdictId,
    outcome,
    gate.session.login,
    body.reason,
    body.contentHash,
  );
  if (result.ok) return json({ ok: true });

  const error = result.error ?? "decision refused";
  if (error === HASH_MISMATCH) return json({ error, code: "content_hash_mismatch" }, 409);
  if (error === DECISION_FAILED) return jsonError(error, 503);
  return jsonError(error, error.includes("not found") ? 404 : 409);
}
