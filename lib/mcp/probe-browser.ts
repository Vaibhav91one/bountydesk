import { z } from "zod";

import { agentSession, db, eq } from "@/lib/db";
import { runBrowserProbe } from "@/lib/sandbox/browser-probe";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";

/**
 * The agent-facing counterpart of probe_target for client-side bugs. probe_target forwards one
 * HTTP request and hands back the raw body, which is blind to anything that only happens once a
 * browser runs the page's JavaScript (DOM/SPA XSS, a hash-to-sink flow, a client-side redirect).
 * This renders one navigation in a real headless browser and hands back what it observed: the
 * post-load DOM, the page's console output, and whether a JavaScript dialog fired.
 *
 * It resolves the session and re-checks the target grant exactly as probe_target does, then drives
 * lib/sandbox/browser-probe.ts, which runs the browser in its own offline, isolated sandbox (see
 * that file for the SSRF containment and no-egress argument). The browser cannot reach anything
 * but the one target app, so, like probe_target_write, this needs no separate human approval: the
 * network boundary is the offline sandbox and the human gate is publish_verdict. The agent's draft
 * is still what a human approves, never these observations directly.
 *
 * Same origin discipline as probe_target: `path` is the server-visible path (before any `#`) and
 * is origin-checked against the provisioned sandbox. `hashPayload` is the URL fragment (after `#`),
 * the client-only channel where an XSS payload belongs, and is never sent to the server.
 */
export const probeBrowserInputSchema = z.object({
  capability: z.string(),
  // A same-origin path only, capped like every other model-supplied string in this codebase.
  path: z.string().min(1).max(2000),
  // The fragment payload, optional. Larger cap than a path: a real DOM-XSS payload can be sizable,
  // but it is still bounded rather than trusted to stay small.
  hashPayload: z.string().max(20_000).optional(),
});

export type ProbeBrowserInput = z.infer<typeof probeBrowserInputSchema>;

export type ProbeBrowserResult =
  | {
      ok: true;
      navigated: boolean;
      title: string;
      dom: string;
      consoleText: string;
      dialogFired: boolean;
      dialogMessages: string[];
    }
  | { ok: false; reason: string };

export async function probeBrowser(input: ProbeBrowserInput): Promise<ProbeBrowserResult> {
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

  // The same live revocation check probe_target makes on every call: a sandboxId on the row proves
  // a target was authorized when it was provisioned, not that it still is, and a disconnected,
  // archived or repointed repository never touches this row.
  const grant = await loadRepositoryGrantSnapshot(session.reportId, db);
  if (!grant || !hasActiveRepositoryGrant(grant)) {
    return { ok: false, reason: "this report's target authorization has been revoked; there is nothing to probe" };
  }

  const result = await runBrowserProbe(
    { targetSandboxId: session.sandboxId, targetPort: session.appPort },
    [{ label: "probe", path: input.path, hashPayload: input.hashPayload ?? "" }],
  );
  if (!result.ok) return result;

  const [observation] = result.steps;
  return {
    ok: true,
    navigated: observation.navigated,
    title: observation.title,
    dom: observation.dom,
    consoleText: observation.consoleText,
    dialogFired: observation.dialogFired,
    dialogMessages: observation.dialogMessages,
  };
}
