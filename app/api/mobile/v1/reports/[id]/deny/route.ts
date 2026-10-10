import { handleDecision } from "@/lib/mobile/decision";

export const runtime = "nodejs";

/** Deny `{ verdictId, contentHash, reason }`. The reason is stored as the decision note. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleDecision(request, context, "DENIED");
}
