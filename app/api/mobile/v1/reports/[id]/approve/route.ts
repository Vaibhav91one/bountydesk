import { handleDecision } from "@/lib/mobile/decision";

export const runtime = "nodejs";

/** Approve `{ verdictId, contentHash }`. Refused with 409 unless the hash is that of the verdict text. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleDecision(request, context, "APPROVED");
}
