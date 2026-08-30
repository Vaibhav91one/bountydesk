import { agentSession, db, eq } from "@/lib/db";
import { createTrueForgeClient, type ToolCallDetail } from "@/lib/trueforge/client";

/**
 * How long the case file waits for TrueForge before rendering without live tool-call detail.
 * This is a page-render path, so a TrueForge that is up but slow (or a socket that never
 * answers) must not hold the reviewer's page open. On timeout the fetch aborts and the panel
 * falls back to the mirrored session_event steps.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Full tool-call detail for a report's investigation, read live from TrueForge at render time.
 *
 * Never persisted: the raw arguments and results here carry the secrets session_event is
 * deliberately kept clear of (capability tokens, grant tokens, canary values), so they are read
 * from the harness that already holds the transcript and shown to the reviewer, not written to a
 * durable table. See lib/trueforge/client.ts's listToolCallDetails and
 * lib/agent-sessions/poller.ts's ARGUMENT_PREVIEW_ALLOWLIST for the split.
 *
 * Resilient by construction: a report with no session or no started turn, and any TrueForge
 * failure (unreachable, the session deleted, a timeout), all return an empty array. The case
 * file then falls back to the mirrored steps rather than showing a broken panel or crashing.
 */
export async function readToolCalls(reportId: string): Promise<ToolCallDetail[]> {
  const [session] = await db
    .select({ sessionId: agentSession.sessionId, turnId: agentSession.turnId })
    .from(agentSession)
    .where(eq(agentSession.reportId, reportId))
    .limit(1);

  if (!session?.turnId) return [];

  try {
    const client = createTrueForgeClient();
    const calls = await client.listToolCallDetails?.(session.sessionId, session.turnId, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return calls ?? [];
  } catch (error) {
    console.error(
      `report ${reportId}: live tool-call detail unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}
