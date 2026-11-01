import { z } from "zod";

import { agentSession, db, eq } from "@/lib/db";
import { runWorkbench, type WorkbenchTool } from "@/lib/sandbox/workbench-probe";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";

/**
 * The agent-facing counterpart of probe_target for the pentest workbench (Phase 0, issue #327).
 * Runs one allowlisted recon tool (httpx, nuclei, newman) from a BountyDesk-owned, offline sandbox
 * link-joined to the session's target, and hands back the tool's raw, capped output.
 *
 * This is evidence only. A hit here is a lead the agent can turn into a reproduction through
 * probe_target / probe_target_write; it is never itself a REPRODUCED verdict, and nothing in this
 * file or workbench-probe.ts touches the canary oracle.
 *
 * Same session and grant resolution as probe_browser: the capability resolves the session's own
 * sandbox and port, and the target's address is always that server-held pair, never a host or URL
 * the agent supplies. The agent only ever gives a tool name, a same-origin path, and (for nuclei)
 * a tag filter.
 */
export const probeWorkbenchInputSchema = z.object({
  capability: z.string(),
  tool: z.enum(["httpx", "nuclei", "newman"]),
  path: z.string().min(1).max(2000),
  tags: z.array(z.string().max(64)).max(20).optional(),
});

export type ProbeWorkbenchInput = z.infer<typeof probeWorkbenchInputSchema>;

export type ProbeWorkbenchResult =
  | { ok: true; tool: WorkbenchTool; exitCode: number; stdout: string; stderr: string; truncated: boolean }
  | { ok: false; reason: string };

export async function probeWorkbench(input: ProbeWorkbenchInput): Promise<ProbeWorkbenchResult> {
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
    return { ok: false, reason: "no sandbox is provisioned for this session; there is nothing to scan" };
  }

  // The same live revocation check probe_target and probe_browser make on every call.
  const grant = await loadRepositoryGrantSnapshot(session.reportId, db);
  if (!grant || !hasActiveRepositoryGrant(grant)) {
    return { ok: false, reason: "this report's target authorization has been revoked; there is nothing to scan" };
  }

  return runWorkbench(
    { targetSandboxId: session.sandboxId, targetPort: session.appPort },
    { tool: input.tool, path: input.path, tags: input.tags },
  );
}
