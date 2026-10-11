import { listAppeals } from "@/lib/appeals/appeals";
import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";
import { mobileCaseView } from "@/lib/mobile/views";
import { isReportId, readCase } from "@/lib/reports/case";

export const runtime = "nodejs";

/** The case file: header, state, target, summary, the exact drafted verdict with its hash, the timeline, tool calls and appeals. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await mobileAuth();
  if (!gate.ok) return gate.response;

  const { id } = await context.params;
  if (!isReportId(id)) return jsonError("report not found", 404);

  const [file, appeals] = await Promise.all([readCase(id), listAppeals(id)]);
  if (!file) return jsonError("report not found", 404);

  return json(mobileCaseView(file, appeals));
}
