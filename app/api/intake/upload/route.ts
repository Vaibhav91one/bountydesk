import { readOutsideConfig } from "@/lib/email/outside-config";
import { safeErrorText } from "@/lib/errors/safe-error";
import { readBoundedBody } from "@/lib/github/webhook";
import { admitUpload, clientAddress, parseUploadForm, UPLOAD_LIMITS } from "@/lib/upload/intake";

export const runtime = "nodejs";

/**
 * Public upload intake. Anyone can post here, so the order matters: the size cap and the content type
 * are checked on the raw request before any parsing, the fields and the attached material are bounded
 * and typed next, and only then do the daily limits run against the database. An accepted upload is a
 * report held at NEEDS_DECISION; nothing runs on it until a reviewer decides.
 */
export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return Response.json({ error: "send the report as multipart/form-data" }, { status: 415 });
  }

  const raw = await readBoundedBody(request, UPLOAD_LIMITS.maxRequestBytes);
  if (!raw) return Response.json({ error: "the upload is too large" }, { status: 413 });

  let form: FormData;
  try {
    // Re-wrapped so the parser only ever sees the bytes that passed the size cap.
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
  } catch {
    return Response.json({ error: "the form could not be read" }, { status: 400 });
  }

  try {
    const config = await readOutsideConfig();
    const parsed = await parseUploadForm(form, config);
    if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });

    const admission = await admitUpload(parsed.submission, clientAddress(request.headers), { config });
    if (!admission.accepted) return Response.json({ error: admission.reason }, { status: admission.status });
    return Response.json({ reportId: admission.reportId, codeSent: admission.codeSent }, { status: 202 });
  } catch (error) {
    console.error(`upload intake failed: ${safeErrorText(error)}`);
    return Response.json({ error: "the upload could not be accepted; try again shortly" }, { status: 503 });
  }
}
