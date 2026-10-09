import { APPEAL_LIMITS, requestAppealCode, submitAppeal } from "@/lib/appeals/appeals";
import { safeErrorText } from "@/lib/errors/safe-error";
import { readBoundedBody } from "@/lib/github/webhook";
import { isReportId } from "@/lib/reports/case";
import { clientAddress } from "@/lib/upload/intake";

export const runtime = "nodejs";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Public appeal endpoint. `request_code` mails a one-time code to the report's delivery contact and
 * answers the same way whether or not the report, the address or a delivered verdict exists.
 * `submit` files the appeal and needs that code. Nothing here is a reviewer action.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await readBoundedBody(request, APPEAL_LIMITS.maxRequestBytes);
  if (!raw) return Response.json({ error: "request too large" }, { status: 413 });

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    input = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "send a JSON body" }, { status: 400 });
  }

  const reportId = str(input.reportId);
  const wellFormed = isReportId(reportId);

  try {
    if (input.action === "request_code") {
      // A malformed id gets the same answer as an unknown one.
      if (!wellFormed) return Response.json({ ok: true });
      const result = await requestAppealCode(reportId, str(input.contact), clientAddress(request.headers));
      return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: result.status });
    }
    if (input.action === "submit") {
      const result = wellFormed
        ? await submitAppeal({ reportId, contact: str(input.contact), code: str(input.code), body: str(input.body) })
        : { ok: false as const, status: 400, error: "That code is not valid. Request a new one." };
      return result.ok ? Response.json({ ok: true }, { status: 201 }) : Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    console.error(`appeal request failed: ${safeErrorText(error)}`);
    return Response.json({ error: "could not process the appeal; try again shortly" }, { status: 503 });
  }
}
