import { safeErrorText } from "@/lib/errors/safe-error";
import { readBoundedBody } from "@/lib/github/webhook";
import { isReportId } from "@/lib/reports/case";
import { confirmContactCode, sendContactCode } from "@/lib/upload/intake";

export const runtime = "nodejs";

/**
 * Confirm an upload's contact address, or mail it another code. Both act only on an upload report and
 * only on the address given at upload, so a report id alone cannot redirect where its verdict goes.
 * The code has a short expiry and an attempt cap, and a report gets a fixed number of codes.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await readBoundedBody(request, 4 * 1024);
  if (!raw) return Response.json({ error: "request too large" }, { status: 413 });

  let input: { reportId?: unknown; code?: unknown; action?: unknown };
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch {
    return Response.json({ error: "send a JSON body" }, { status: 400 });
  }
  const reportId = typeof input.reportId === "string" ? input.reportId : "";
  if (!isReportId(reportId)) return Response.json({ error: "no such upload" }, { status: 404 });

  try {
    const result =
      input.action === "resend"
        ? await sendContactCode(reportId)
        : await confirmContactCode(reportId, typeof input.code === "string" ? input.code : "");
    if (!result.ok) return Response.json({ error: result.reason }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error(`upload contact check for ${reportId} failed: ${safeErrorText(error)}`);
    return Response.json({ error: "could not check the code; try again shortly" }, { status: 503 });
  }
}
