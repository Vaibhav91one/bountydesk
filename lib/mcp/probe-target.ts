import { z } from "zod";

import { agentSession, db, eq, report, targetProfile } from "@/lib/db";
import { getPortPreviewUrl, readLimitedText, ResponseBodyTooLarge } from "@/lib/sandbox/provision";
import { verify as verifyGrant } from "@/lib/scope-guard/grants";

/**
 * The tool that lets the agent reach the target this session actually got provisioned, without
 * ever handing it a raw URL, host or token. See docs/decisions.md's "target reachability"
 * section: scope-guard's http_probe is bound to a target profile's one static baseUrl and can't
 * reach a dynamic per-run Daytona preview URL, so this is a second, narrower tool instead --
 * `capability` resolves the caller's own session (the same lookup publishVerdict uses), and
 * everything else is a same-origin request this function assembles and dispatches itself.
 *
 * Wall-clock ceiling per request, matching reproduce.ts's own HTTP_TIMEOUT_MS for calls this
 * process makes to the sandbox.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export const probeTargetInputSchema = z.object({
  capability: z.string(),
  method: z.enum(["GET", "POST", "HEAD"]),
  // A same-origin path only -- see resolveTargetUrl. 2000 is generous for any real route/query
  // string and matches this file's general instinct to cap everything a model can send us.
  path: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string()).optional(),
  // Matches lib/mcp/publish-verdict.ts's own finding/summary caps in spirit: bound every
  // string a tool call can carry, rather than trust a model to stay reasonable on its own.
  body: z.string().max(200_000).optional(),
  // Required for POST, the one write/active action this tool can perform -- mirrors
  // scope-guard's http_probe (lib/scope-guard/egress.ts's authorizeConnect), which needs a
  // grant from request_intrusive_approval for exactly the same reason.
  grant_token: z.string().optional(),
});

export type ProbeTargetInput = z.infer<typeof probeTargetInputSchema>;

export type ProbeTargetResult = { ok: true; status: number; body: string } | { ok: false; reason: string };

/**
 * Resolve `path` against the sandbox's own preview origin and refuse anything that doesn't
 * land back on that same origin. Checking the parsed result's origin, rather than pattern-
 * matching the input string, is what closes the WHATWG URL parser's own quirks: a special
 * (http/https) URL treats a backslash as a path separator too, so a naive "reject a leading
 * `//`" check still lets `/\evil.example/x` resolve to `https://evil.example/x` once appended
 * to a base. Letting the real parser resolve it and then comparing origins catches that and
 * anything like it, rather than this file trying to enumerate every escape the spec allows.
 */
function resolveTargetUrl(previewUrl: string, path: string): URL | null {
  if (!path.startsWith("/")) return null;
  let base: URL;
  let target: URL;
  try {
    base = new URL(previewUrl);
    target = new URL(path, base);
  } catch {
    return null;
  }
  return target.origin === base.origin ? target : null;
}

/** Every header name this session's own request supplies, minus `Host`: forwarding a
 * caller-chosen Host would let a request pinned to the sandbox's real origin still be routed,
 * at the virtual-host layer, to whatever authority the caller names instead -- the same class
 * of gap the preview-token override below closes for authentication. */
function forwardableHeaders(callerHeaders: Record<string, string> | undefined): Headers {
  const headers = new Headers(
    Object.fromEntries(Object.entries(callerHeaders ?? {}).filter(([key]) => key.toLowerCase() !== "host")),
  );
  return headers;
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
  // A cheap, network-free rejection for the common case; the authoritative check is
  // resolveTargetUrl below, once the preview origin to resolve against is in hand.
  if (!input.path.startsWith("/")) {
    return { ok: false, reason: "path must be a same-origin path starting with a single '/'" };
  }

  const [session] = await db
    .select({ sandboxId: agentSession.sandboxId, appPort: agentSession.appPort, reportId: agentSession.reportId })
    .from(agentSession)
    .where(eq(agentSession.capabilityToken, input.capability))
    .limit(1);

  if (!session) return { ok: false, reason: "unknown capability" };
  if (!session.sandboxId || !session.appPort) {
    return { ok: false, reason: "no sandbox is provisioned for this session; there is nothing to probe" };
  }

  // POST is this tool's one write/active action; every other method stays passive-probe
  // territory and needs no grant, matching http_probe's own requiresGrant split.
  if (input.method === "POST") {
    const [target] = await db
      .select({ name: targetProfile.name })
      .from(report)
      .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
      .where(eq(report.id, session.reportId))
      .limit(1);
    if (!target) {
      return { ok: false, reason: "no bound target to check the grant against" };
    }
    if (!input.grant_token) {
      return {
        ok: false,
        reason: "grant denial: this is a write action and needs a grant from request_intrusive_approval first",
      };
    }
    const verified = await verifyGrant(input.grant_token, target.name);
    if (!verified.valid) {
      return { ok: false, reason: `grant denial: ${verified.reason}` };
    }
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

  const target = resolveTargetUrl(preview.url, input.path);
  if (!target) {
    return { ok: false, reason: "path must resolve to a same-origin request against the provisioned sandbox" };
  }

  // Caller headers first (Host stripped), preview token last: a header this session's own
  // request supplies wins for everything else, but neither Host nor this token can be
  // overridden by one it supplies too.
  const headers = forwardableHeaders(input.headers);
  const hasBody = input.method !== "GET" && input.method !== "HEAD" && input.body !== undefined;
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("x-daytona-preview-token", preview.token);

  let response: Response;
  try {
    response = await fetch(target, {
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
