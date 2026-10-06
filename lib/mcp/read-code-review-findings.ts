import { z } from "zod";

import { agentSession, codeReviewFinding, db, eq } from "@/lib/db";

export const readCodeReviewFindingsInputSchema = z.object({ capability: z.string() });

export type ReadCodeReviewFindingsResult =
  | {
      ok: true;
      findings: Array<{
        file: string;
        line: number | null;
        category: string;
        summary: string;
        severity: string;
        confidence: string;
      }>;
    }
  | { ok: false; reason: string };

/**
 * Read-only lead material for the reproduction agent. The report comes from the capability's own
 * session row, never from an argument, so a session can only see its own report's findings. The
 * findings are model-written evidence: nothing here touches report state, the verdict or the oracle.
 */
export async function readCodeReviewFindings(input: { capability: string }): Promise<ReadCodeReviewFindingsResult> {
  const [session] = await db
    .select({ reportId: agentSession.reportId })
    .from(agentSession)
    .where(eq(agentSession.capabilityToken, input.capability))
    .limit(1);
  if (!session) return { ok: false, reason: "unknown capability" };

  const findings = await db
    .select({
      file: codeReviewFinding.file,
      line: codeReviewFinding.line,
      category: codeReviewFinding.category,
      summary: codeReviewFinding.summary,
      severity: codeReviewFinding.severity,
      confidence: codeReviewFinding.confidence,
    })
    .from(codeReviewFinding)
    .where(eq(codeReviewFinding.reportId, session.reportId))
    .orderBy(codeReviewFinding.createdAt);
  return { ok: true, findings };
}
