import { randomBytes, randomUUID } from "node:crypto";

import { agentSession, db, eq, report } from "@/lib/db";
import type { AnalysisContext, AnalysisDriver } from "@/lib/jobs/worker";
import { createTrueForgeClient, type TrueForgeClient } from "@/lib/trueforge/client";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";

// Byte-identical to stub-driver.ts's disclaimer: both drivers are the same honest
// "reproduction was not performed" message, and a reviewer comparing verdicts across the
// two paths should never see the wording drift.
const ANALYSIS_MESSAGE = `Automated reproduction was not run for this report. What follows is an analysis-only read of the report as submitted, not a check of whether the issue actually reproduces. A person still needs to review this before any next step.`;

function buildPayload(verdictId: string): string {
  return `${ANALYSIS_MESSAGE}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

function buildTurnMessage(title: string, body: string, capabilityToken: string): string {
  return `A bug bounty report has come in for triage.

Title: ${title}

Body:
${body}

An analysis-only verdict has already been prepared for this report; there is no sandbox and no
reproduction available in this turn. Review the report above, then call publish_verdict with
capability set to exactly this string: ${capabilityToken}

That call submits the prepared analysis for human review. Do not invent a capability value; use
only the one given here.`;
}

/**
 * The real driver: opens a TrueForge session per report and starts a turn that asks the model
 * to call publish_verdict. Unlike stubAnalysisDriver, this never transitions the report's
 * lifecycle state. That transition happens only once a separate poller has independently
 * confirmed, by asking TrueForge itself, that a genuine pending publish_verdict call exists.
 * Two code paths racing to decide "this report is now awaiting approval" is exactly the kind
 * of disagreement that leaves the review queue and the approval handler looking at different
 * states, so this driver's job stops at: verdict exists, session exists, a turn has started.
 */
export function createTrueforgeAnalysisDriver(
  client: TrueForgeClient = createTrueForgeClient(),
): AnalysisDriver {
  return {
    async ensureSession({ reportId, signal }: AnalysisContext): Promise<void> {
      if (signal.aborted) throw signal.reason;

      const [existing] = await db
        .select({ id: agentSession.id })
        .from(agentSession)
        .where(eq(agentSession.reportId, reportId))
        .limit(1);
      if (existing) return;

      const verdictId = randomUUID();
      const payload = buildPayload(verdictId);
      await ensureInitialVerdict({
        id: verdictId,
        reportId,
        outcome: "ANALYSIS_ONLY",
        summary: "Analysis-only result: automated reproduction was not run.",
        evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
        payload,
      });

      // Opaque handle the model echoes back as publish_verdict's sole argument; the only
      // report identifier it ever sees.
      const capabilityToken = randomBytes(32).toString("base64url");
      const { sessionId } = await client.createSession();

      // onConflictDoNothing: if a concurrent call already inserted this report's session
      // first, the session just opened above is simply unused. Same accepted at-least-once
      // cost as the other queues in this codebase (see lib/delivery/worker.ts) rather than
      // adding locking beyond what ensureInitialVerdict and the unique index already give us.
      await db
        .insert(agentSession)
        .values({ reportId, capabilityToken, sessionId })
        .onConflictDoNothing({ target: agentSession.reportId });

      if (signal.aborted) throw signal.reason;
    },

    async run({ reportId, signal }: AnalysisContext): Promise<void> {
      if (signal.aborted) throw signal.reason;

      const [session] = await db
        .select({
          id: agentSession.id,
          sessionId: agentSession.sessionId,
          turnId: agentSession.turnId,
          capabilityToken: agentSession.capabilityToken,
        })
        .from(agentSession)
        .where(eq(agentSession.reportId, reportId))
        .limit(1);
      if (!session) {
        throw new Error(
          `trueforgeAnalysisDriver.run: no agent session for report ${reportId}; ensureSession must run first`,
        );
      }

      // A turn was already started for this report by an earlier pass; the poller takes it
      // from here regardless of how that turn is doing.
      if (session.turnId) return;

      const [reportRow] = await db
        .select({ title: report.title, body: report.body })
        .from(report)
        .where(eq(report.id, reportId))
        .limit(1);
      if (!reportRow) {
        throw new Error(`trueforgeAnalysisDriver.run: report ${reportId} does not exist`);
      }

      const content = buildTurnMessage(reportRow.title, reportRow.body, session.capabilityToken);
      const { turnId } = await client.createTurn(session.sessionId, [
        { type: "user.message", content },
      ]);

      await db
        .update(agentSession)
        .set({ turnId, turnStatus: "RUNNING", updatedAt: new Date() })
        .where(eq(agentSession.id, session.id));

      if (signal.aborted) throw signal.reason;
    },
  };
}
