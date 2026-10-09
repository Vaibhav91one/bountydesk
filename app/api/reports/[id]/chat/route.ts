import { currentSession } from "@/lib/auth/dal";
import { isReviewerWriter } from "@/lib/auth/reviewers";
import { isReportId } from "@/lib/reports/case";
import {
  ChatInvariantError,
  enqueueMessage,
  readChatStatus,
  reviewerChatEnabled,
} from "@/lib/reviewer-chat/queue";
import { reviewerMessageSchema } from "@/lib/reviewer-chat/schema";

export const runtime = "nodejs";

function unavailable(): Response {
  return Response.json({ error: "reviewer chat is not enabled" }, { status: 404 });
}

/** Return durable reviewer-chat messages. Browser input never selects a thread or verdict. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!reviewerChatEnabled()) return unavailable();

  const { id } = await context.params;
  if (!isReportId(id)) return Response.json({ error: "report not found" }, { status: 404 });

  const status = await readChatStatus(id);
  if (!status) return Response.json({ error: "report not found" }, { status: 404 });

  return Response.json(status, { headers: { "cache-control": "no-store" } });
}

/** Enqueue one bounded reviewer message and return immediately. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // A chat message steers a REVIEWER_GUIDANCE run, so it is a write, not a read: gated the same
  // as every other mutation, re-checked fresh rather than trusted from the session.
  if (!(await isReviewerWriter(session.email))) {
    return Response.json({ error: "read-only access" }, { status: 403 });
  }
  if (!reviewerChatEnabled()) return unavailable();

  const { id } = await context.params;
  if (!isReportId(id)) return Response.json({ error: "report not found" }, { status: 404 });

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const parsed = reviewerMessageSchema.safeParse(input);
  if (!parsed.success) {
    return Response.json({ error: "invalid reviewer message" }, { status: 400 });
  }

  const status = await readChatStatus(id);
  if (!status) return Response.json({ error: "report not found" }, { status: 404 });

  let result;
  try {
    result = await enqueueMessage({
      reportId: id,
      reviewerId: session.email,
      ...parsed.data,
    });
  } catch (error) {
    if (error instanceof ChatInvariantError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  return Response.json(result, {
    status: result.disposition === "DUPLICATE" ? 200 : 202,
    headers: { "cache-control": "no-store" },
  });
}
