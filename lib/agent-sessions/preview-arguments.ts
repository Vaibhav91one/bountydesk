import { redactReviewerText } from "@/lib/reviewer-chat/context";

/** Long enough to show what a safe field's value was, short enough that a chatty one never
 * makes session_event a second copy of the payload it was called with. */
const TOOL_ARGUMENTS_PREVIEW_LIMIT = 500;

/**
 * Argument field names safe to copy into the durable, reviewer-visible audit trail. An
 * allowlist, not a denylist: session_event has no UPDATE or DELETE (see AGENTS.md), so a field
 * let through here is there forever. Every scope-guard/bountydesk tool call carries a
 * `capability` token to identify the caller, and several also carry a `grant_token`/`token`
 * from `request_intrusive_approval`/`verify_grant` embedded in `headers` or `body` -- none of
 * that, and nothing this list doesn't name, ever gets copied. A new tool's arguments preview as
 * empty until someone deliberately adds its safe fields here, which is the direction this needs
 * to fail in.
 */
const ARGUMENT_PREVIEW_ALLOWLIST = new Set([
  "url",
  "method",
  "host",
  "port",
  "target",
  "entry",
  "action",
  "name",
  "ecosystem",
  "version",
  "id",
  "limit",
  "ttl_minutes",
  "timeout_seconds",
]);

const SENSITIVE_ARGUMENT_KEY = /(?:token|secret|password|passwd|credential|authorization|cookie|api[-_ ]?key)/i;

function safePreviewValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && SENSITIVE_ARGUMENT_KEY.test(key)) return "[REDACTED]";
    const redacted = redactReviewerText(value).replace(
      /^((?:[a-z][a-z\d+.-]*:\/\/|\/\/))[^/?#@]*@/i,
      "$1",
    );
    try {
      const url = new URL(redacted);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return redacted.replace(/[?#].*$/, "");
    }
  }
  if (Array.isArray(value)) return value.map((item) => safePreviewValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        safePreviewValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

/**
 * The safe subset of a tool call's arguments, or undefined when there is nothing safe to show
 * (including when the arguments aren't a plain JSON object at all, e.g. publish_verdict's
 * {capability, outcome, summary, findings}: none of those keys are on the allowlist, so its
 * arguments preview as nothing, which is deliberate -- the verdict itself is already visible in
 * the verdict panel, and its capability token must never repeat anywhere else).
 */
export function previewArguments(argumentsJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

    const safe = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([key]) => ARGUMENT_PREVIEW_ALLOWLIST.has(key))
        .map(([key, value]) => [key, safePreviewValue(value, key)]),
    );
    if (Object.keys(safe).length === 0) return undefined;

    const json = JSON.stringify(safe);
    return json.length > TOOL_ARGUMENTS_PREVIEW_LIMIT ? `${json.slice(0, TOOL_ARGUMENTS_PREVIEW_LIMIT)}…` : json;
  } catch {
    return undefined;
  }
}
