import { z } from "zod";

import { agentSession, db, eq } from "@/lib/db";
import { getPortPreviewUrl, readLimitedText, ResponseBodyTooLarge } from "@/lib/sandbox/provision";

/**
 * The tool that lets the agent reach the target this session actually got provisioned, without
 * ever handing it a raw URL, host or token. See docs/decisions.md's "target reachability"
 * section: scope-guard's http_probe is bound to a target profile's one static baseUrl and can't
 * reach a dynamic per-run Daytona preview URL, so this is a second, narrower tool instead --
 * `capability` resolves the caller's own session (the same lookup publish_verdict uses), and
 * everything else is a same-origin request this function assembles and dispatches itself.
 *
 * Wall-clock ceiling per request, matching reproduce.ts's own HTTP_TIMEOUT_MS for calls this
 * process makes to the sandbox.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export const probeTargetInputSchema = z.object({
  capability: z.string(),
  method: z.enum(["GET", "POST", "HEAD"]),
  // A same-origin path only -- see normalizedPath. 2000 is generous for any real route/query
  // string and matches this file's general instinct to cap everything a model can send us.
  path: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).optional(),
  // Matches lib/mcp/publish-verdict.ts's own finding/summary caps in spirit: bound every
  // string a tool call can carry, rather than trust a model to stay reasonable on its own.
  body: z.string().max(200_000).optional(),
});

export type ProbeTargetInput = z.infer<typeof probeTargetInputSchema>;

export type ProbeTargetResult = { ok: true; status: number; body: string } | { ok: false; reason: string };

/**
 * Refuse anything that isn't a plain same-origin path. `path` is appended directly to the
 * sandbox's preview origin below; a caller-supplied scheme-relative path ("//evil.example/x")
 * would otherwise resolve, once concatenated, to a second origin this tool was never meant to
 * reach -- the same class of gap `sandboxRequestHeaders` closes for headers, applied to the URL
 * instead.
 */
function normalizedPath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  return path;
}

/**
 * Resolve the calling session by capability (the exact lookup publishVerdict uses), forward the
 * request to that session's provisioned sandbox with the preview token injected, and hand back
 * the raw status and body. The model never sees the preview URL or token, and never chooses
 * which sandbox to reach -- both come from this session's own agent_session row, looked up
 * fresh, never cached across calls (getPortPreviewUrl is called new every time, per this file's
 * doc comment, since a stored token could go stale between calls).
 */
export async function probeTarget(input: ProbeTargetInput): Promise<ProbeTargetResult> {
  const path = normalizedPath(input.path);
  if (path === null) {
    return { ok: false, reason: "path must be a same-origin path starting with a single '/'" };
  }

  const [session] = await db
    .select({ sandboxId: agentSession.sandboxId, appPort: agentSession.appPort })
    .from(agentSession)
    .where(eq(agentSession.capabilityToken, input.capability))
    .limit(1);

  if (!session) return { ok: false, reason: "unknown capability" };
  if (!session.sandboxId || !session.appPort) {
    return { ok: false, reason: "no sandbox is provisioned for this session; there is nothing to probe" };
  }

  let preview: { url: string; token: string };
  try {
    preview = await getPortPreviewUrl(session.sandboxId, session.appPort);
  } catch (error) {
    return {
      ok: false,
      reason: `could not reach the sandbox: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Caller headers first, preview token last: a header this session's own request supplies
  // wins for everything else, but this token can never be overridden by one it supplies too.
  const headers = new Headers(input.headers);
  const hasBody = input.method !== "GET" && input.method !== "HEAD" && input.body !== undefined;
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-daytona-preview-token", preview.token);

  const url = `${preview.url.replace(/\/$/, "")}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.method,
      headers,
      body: hasBody ? input.body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `request to the sandbox failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const body = await readLimitedText(response);
    return { ok: true, status: response.status, body };
  } catch (error) {
    if (error instanceof ResponseBodyTooLarge) {
      return { ok: false, reason: error.message };
    }
    return {
      ok: false,
      reason: `could not read the sandbox's response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
