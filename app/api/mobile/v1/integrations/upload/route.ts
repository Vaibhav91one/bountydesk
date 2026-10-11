import type { Ecosystem } from "@/lib/build-onboarding/build-plan";
import { readOutsideConfig } from "@/lib/email/outside-config";
import { safeErrorText } from "@/lib/errors/safe-error";
import { readBoundedBody } from "@/lib/github/webhook";
import { json, jsonError, mobileAuth } from "@/lib/mobile/auth";
import { parseUploadForm, UPLOAD_LIMITS } from "@/lib/upload/intake";

export const runtime = "nodejs";

/**
 * A reviewer uploads target material from the dashboard (M28), the trusted twin of the public
 * upload intake.
 *
 * Reuse is total: parseUploadForm validates the multipart body (size caps, tarball sniff, image
 * registry allowlist), and admitReviewerUpload writes the report and queues the build. The only
 * things this handler adds over the public /api/intake/upload route are the mobileAuth write gate
 * (which the public route does not need, since anyone can upload) and the reviewer's email as the
 * contact instead of the OTP flow. The build settings come from the same form fields the web action
 * reads, so a mobile client and the dashboard cannot disagree on how the target runs.
 *
 * The contact is always the authenticated reviewer's session email, never form input: that is what
 * lets the trusted path skip the public OTP.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await mobileAuth({ write: true });
  if (!gate.ok) return gate.response;

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return jsonError("send the upload as multipart/form-data", 415);
  }

  const raw = await readBoundedBody(request, UPLOAD_LIMITS.maxRequestBytes);
  if (!raw) return jsonError("the upload is too large", 413);

  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
  } catch {
    return jsonError("the form could not be read", 400);
  }

  try {
    // The reviewer's email is the contact; it is proven by the session, not the OTP the public
    // route requires from an anonymous uploader.
    form.set("contact", gate.session.email);

    const config = await readOutsideConfig();
    const parsed = await parseUploadForm(form, config);
    if (!parsed.ok) return jsonError(parsed.reason, 400);

    const startCommand = String(form.get("startCommand") ?? "").trim();
    const ecosystem = String(form.get("ecosystem") ?? "").trim();
    const target = {
      port: Number(form.get("port")),
      readinessPath: String(form.get("readinessPath") ?? ""),
      ...(startCommand ? { startCommand } : {}),
      ...(ecosystem ? { ecosystem: ecosystem as Ecosystem } : {}),
    };

    const { admitReviewerUpload } = await import("@/lib/upload/intake");
    const result = await admitReviewerUpload(
      parsed.submission,
      { login: gate.session.login, email: gate.session.email },
      target,
    );
    if (!result.ok) return jsonError(result.reason, 400);

    return json({ reportId: result.reportId }, 202);
  } catch (error) {
    console.error(`reviewer upload failed: ${safeErrorText(error)}`);
    return jsonError("the upload could not be accepted; try again shortly", 503);
  }
}
