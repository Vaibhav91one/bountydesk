import { randomBytes, randomUUID } from "node:crypto";

import {
  agentSession,
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  report,
  targetProfile,
  verdict,
  type Executor,
} from "@/lib/db";
import type { AnalysisContext, AnalysisDriver } from "@/lib/jobs/worker";
import type {
  GetRecipesForTargetFn,
  ReproduceFn,
  ReproductionOutcome,
  ReproductionRecipe,
} from "@/lib/reproduction/types";
import { reproduce } from "@/lib/sandbox/reproduce";
import { getRecipesForTarget } from "@/lib/targets/recipes";
import { createTrueForgeClient, type TrueForgeClient } from "@/lib/trueforge/client";
import { ensureInitialVerdict } from "@/lib/verdicts/lifecycle";

// Byte-identical to stub-driver.ts's disclaimer: both drivers are the same honest
// "reproduction was not performed" message, and a reviewer comparing verdicts across the
// two paths should never see the wording drift.
const ANALYSIS_MESSAGE = `Automated reproduction was not run for this report. What follows is an analysis-only read of the report as submitted, not a check of whether the issue actually reproduces. A person still needs to review this before any next step.`;

function buildPayload(verdictId: string): string {
  return `${ANALYSIS_MESSAGE}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

/**
 * Deterministic, server-authored prose for a completed reproduction run. Never model output
 * (AGENTS.md: "the model never narrates the verdict") and never the raw canary value, only
 * what ReproductionEvidence already carries (a hash of it).
 */
function buildReproducedPayload(
  verdictId: string,
  recipe: ReproductionRecipe,
  result: Extract<ReproductionOutcome, { outcome: "REPRODUCED" | "NOT_REPRODUCED" }>,
): string {
  const finding =
    result.outcome === "REPRODUCED"
      ? "The exploit request tripped the canary. The report reproduces."
      : "The exploit request did not trip the canary. The report does not reproduce as described.";

  const body = `Automated reproduction ran the "${recipe.title}" scenario against an isolated, pinned copy of the target. An unpredictable canary was seeded fresh for this run through a trusted fixture call, a negative control request ran first and left the canary untouched, and then the exploit request ran.

${finding}

A person still needs to review this before any next step.`;

  return `${body}\n\n<!-- bountydesk-delivery:${verdictId} -->`;
}

function buildTurnMessage(
  title: string,
  body: string,
  capabilityToken: string,
  verdictOutcome: (typeof verdict.outcome.enumValues)[number],
  verdictSummary: string,
): string {
  if (verdictOutcome === "REPRODUCED" || verdictOutcome === "NOT_REPRODUCED") {
    return `A bug bounty report has come in for triage.

Title: ${title}

Body:
${body}

Automated reproduction already ran against a sandboxed target and reached a result:
${verdictSummary}

Draft the human-facing writeup for a reviewer based on that result, then call publish_verdict
with capability set to exactly this string: ${capabilityToken}

That call submits the writeup for human review. Do not invent a capability value; use only the
one given here.`;
  }

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

/** Whether a report names the same vulnerability class and scenario the recipe exercises.
 * A recipe author writes both broad class words and endpoint-specific words; matching only one
 * side is unsafe because it can run a search SQLi recipe for a login SQLi report, or for search
 * XSS. A false negative falls through to ANALYSIS_ONLY, while a false positive can persist a
 * definitive verdict for the wrong scenario.
 */
function matchesReport(
  recipe: ReproductionRecipe,
  reportContent: { title: string; body: string },
): boolean {
  const haystack = `${reportContent.title}\n${reportContent.body}`;
  let matchedVulnerability = false;
  let matchedScenario = false;

  for (const keyword of recipe.keywords) {
    if (!containsKeyword(haystack, keyword)) continue;
    if (isVulnerabilityKeyword(keyword)) {
      matchedVulnerability = true;
    } else {
      matchedScenario = true;
    }
  }

  return matchedVulnerability && matchedScenario;
}

function containsKeyword(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(haystack);
}

function isVulnerabilityKeyword(keyword: string): boolean {
  return [
    "sql injection",
    "sqli",
    "union select",
    "xss",
    "cross-site scripting",
    "csrf",
    "ssrf",
    "rce",
    "command injection",
    "auth bypass",
    "authentication bypass",
    "login bypass",
  ].includes(keyword.toLowerCase());
}

type ReproductionTargetSnapshot = {
  targetProfileId: string;
  imageName: string;
  imageDigest: string;
  snapshotId: string | null;
};

type DecidedVerdict = {
  outcome: (typeof verdict.outcome.enumValues)[number];
  summary: string;
  evidence: Record<string, unknown>;
  payload: string;
  reproductionTarget?: ReproductionTargetSnapshot;
};

function analysisNotRunDecision(verdictId: string): DecidedVerdict {
  return {
    outcome: "ANALYSIS_ONLY",
    summary: "Analysis-only result: automated reproduction was not run.",
    evidence: { reason: "AUTOMATED_REPRODUCTION_NOT_RUN" },
    payload: buildPayload(verdictId),
  };
}

/** What to decide the verdict's outcome/summary/evidence/payload are, for a genuinely fresh
 * report. The caller runs this outside any database transaction because it can include a
 * sandbox reproduction call. A short final transaction persists this decision, or adopts one
 * another worker committed first. */
async function decideFreshVerdict(
  reportId: string,
  verdictId: string,
  reproduceFn: ReproduceFn,
  getRecipes: GetRecipesForTargetFn,
  signal: AbortSignal,
  tx: Executor,
): Promise<DecidedVerdict> {
  const [target] = await tx
    .select({
      targetProfileId: targetProfile.id,
      imageName: targetProfile.imageName,
      imageDigest: targetProfile.imageDigest,
      snapshotId: targetProfile.snapshotId,
      name: targetProfile.name,
      config: targetProfile.config,
      title: report.title,
      body: report.body,
      connectedRepositoryId: report.connectedRepositoryId,
      repoActive: connectedRepository.active,
      repoArchivedAt: connectedRepository.archivedAt,
      repoTargetProfileId: connectedRepository.targetProfileId,
      installationSuspendedAt: githubInstallation.suspendedAt,
      installationDeletedAt: githubInstallation.deletedAt,
    })
    .from(report)
    .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .where(eq(report.id, reportId))
    .limit(1);

  // Missing target bindings, inactive repository grants and missing matching recipes all stop
  // at ANALYSIS_ONLY. A definitive reproduction verdict is only for the exact authorized
  // target and scenario this report still owns.
  const recipes = target ? getRecipes({ name: target.name, config: target.config }) : [];
  const recipe = target ? recipes.find((candidate) => matchesReport(candidate, target)) : undefined;
  if (!target || !target.imageName || !recipe || !hasActiveRepositoryGrant(target)) {
    return analysisNotRunDecision(verdictId);
  }

  const result = await reproduceFn(
    {
      targetProfileId: target.targetProfileId,
      imageName: target.imageName,
      imageDigest: target.imageDigest,
      snapshotId: target.snapshotId,
      recipe,
    },
    { signal },
  );
  if (signal.aborted) throw signal.reason;

  if (result.outcome !== "REPRODUCED" && result.outcome !== "NOT_REPRODUCED") {
    return {
      outcome: "ANALYSIS_ONLY",
      summary: `Analysis-only result: automated reproduction did not complete (${result.reason}).`,
      // The reason plus whatever partial evidence exists, for operator visibility. Partial
      // evidence never carries the raw canary, only its hash, per the Phase-0 contract.
      evidence: { reason: result.reason, ...(result.evidence ?? {}) },
      payload: buildPayload(verdictId),
      reproductionTarget: {
        targetProfileId: target.targetProfileId,
        imageName: target.imageName,
        imageDigest: target.imageDigest,
        snapshotId: target.snapshotId,
      },
    };
  }

  return {
    outcome: result.outcome,
    summary:
      result.outcome === "REPRODUCED"
        ? `Automated reproduction reproduced "${recipe.title}" against the sandboxed target.`
        : `Automated reproduction ran "${recipe.title}" against the sandboxed target and did not reproduce it.`,
    evidence: { ...result.evidence },
    payload: buildReproducedPayload(verdictId, recipe, result),
    reproductionTarget: {
      targetProfileId: target.targetProfileId,
      imageName: target.imageName,
      imageDigest: target.imageDigest,
      snapshotId: target.snapshotId,
    },
  };
}

function hasActiveRepositoryGrant(target: {
  targetProfileId: string;
  connectedRepositoryId: string | null;
  repoActive: boolean | null;
  repoArchivedAt: Date | null;
  repoTargetProfileId: string | null;
  installationSuspendedAt: Date | null;
  installationDeletedAt: Date | null;
}): boolean {
  if (!target.connectedRepositoryId) return true;
  return (
    target.repoActive === true &&
    target.repoArchivedAt === null &&
    target.repoTargetProfileId === target.targetProfileId &&
    target.installationSuspendedAt === null &&
    target.installationDeletedAt === null
  );
}

function adoptVerdict(row: {
  outcome: (typeof verdict.outcome.enumValues)[number];
  summary: string;
  evidence: unknown;
  payload: string;
}): DecidedVerdict {
  return {
    outcome: row.outcome,
    summary: row.summary,
    evidence: row.evidence as Record<string, unknown>,
    payload: row.payload,
  };
}

async function targetStillAuthorized(
  tx: Executor,
  reportId: string,
  target: ReproductionTargetSnapshot,
): Promise<boolean> {
  const [current] = await tx
    .select({
      targetProfileId: report.targetProfileId,
      state: report.state,
      connectedRepositoryId: report.connectedRepositoryId,
      repoActive: connectedRepository.active,
      repoArchivedAt: connectedRepository.archivedAt,
      repoTargetProfileId: connectedRepository.targetProfileId,
      installationSuspendedAt: githubInstallation.suspendedAt,
      installationDeletedAt: githubInstallation.deletedAt,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .where(eq(report.id, reportId))
    .limit(1);

  if (!current || current.targetProfileId !== target.targetProfileId) return false;
  if (current.state !== "TRIAGING" && current.state !== "REPRODUCING") return false;
  if (!hasActiveRepositoryGrant({ ...current, targetProfileId: target.targetProfileId })) return false;

  const [currentProfile] = await tx
    .select({
      imageName: targetProfile.imageName,
      imageDigest: targetProfile.imageDigest,
      snapshotId: targetProfile.snapshotId,
    })
    .from(targetProfile)
    .where(eq(targetProfile.id, target.targetProfileId))
    .for("share")
    .limit(1);

  return (
    currentProfile?.imageName === target.imageName &&
    currentProfile.imageDigest === target.imageDigest &&
    currentProfile.snapshotId === target.snapshotId
  );
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
  reproduceFn: ReproduceFn = reproduce,
  getRecipes: GetRecipesForTargetFn = getRecipesForTarget,
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

      const [existingVerdictBeforeDecision] = await db
        .select({
          id: verdict.id,
          outcome: verdict.outcome,
          summary: verdict.summary,
          evidence: verdict.evidence,
          payload: verdict.payload,
        })
        .from(verdict)
        .where(and(eq(verdict.reportId, reportId), eq(verdict.revision, 1)))
        .limit(1);

      const proposedVerdictId = existingVerdictBeforeDecision?.id ?? randomUUID();
      const proposed = existingVerdictBeforeDecision
        ? adoptVerdict(existingVerdictBeforeDecision)
        : await decideFreshVerdict(reportId, proposedVerdictId, reproduceFn, getRecipes, signal, db);

      if (signal.aborted) throw signal.reason;

      // Keep the transaction short. Reproduction may take minutes, so it happens above with no
      // open transaction and no held pool connection. If another worker wins the race while we
      // are reproducing, this transaction adopts that committed verdict instead of trying to
      // compare two independently minted canary hashes.
      await db.transaction(async (tx) => {
        await tx.select({ id: report.id }).from(report).where(eq(report.id, reportId)).for("update");

        const [existingAfterLock] = await tx
          .select({ id: agentSession.id })
          .from(agentSession)
          .where(eq(agentSession.reportId, reportId))
          .limit(1);
        if (existingAfterLock) return;

        // A retry after this same function failed partway (session creation or the insert
        // below threw, after the verdict already committed) must reuse every field of that
        // verdict exactly, not recompute any of them: ensureInitialVerdict treats a
        // (reportId, revision) match that disagrees on outcome, summary, evidence or payload as
        // a hard integrity error, since it has no way to tell "this is just a retry" from "two
        // different callers disagree about what this report's verdict says." Recomputing would
        // also call reproduceFn a second time, mint a fresh random canary, and hash to
        // different evidence than the row already committed, so this select has to read the
        // committed outcome/summary/evidence too, not just the id and payload, or a retry of a
        // reproduced report would try to overwrite them with the hardcoded analysis-only shape.
        const [existingVerdict] = await tx
          .select({
            id: verdict.id,
            outcome: verdict.outcome,
            summary: verdict.summary,
            evidence: verdict.evidence,
            payload: verdict.payload,
          })
          .from(verdict)
          .where(and(eq(verdict.reportId, reportId), eq(verdict.revision, 1)))
          .limit(1);

        const verdictId = existingVerdict?.id ?? proposedVerdictId;
        const proposedStillAuthorized =
          !proposed.reproductionTarget || (await targetStillAuthorized(tx, reportId, proposed.reproductionTarget));
        const decided = existingVerdict
          ? adoptVerdict(existingVerdict)
          : proposedStillAuthorized
            ? proposed
            : analysisNotRunDecision(verdictId);

        await ensureInitialVerdict(
          {
            id: verdictId,
            reportId,
            outcome: decided.outcome,
            summary: decided.summary,
            evidence: decided.evidence,
            payload: decided.payload,
          },
          tx,
        );

        // Opaque handle the model echoes back as publish_verdict's sole argument; the only
        // report identifier it ever sees.
        const capabilityToken = randomBytes(32).toString("base64url");
        const { sessionId } = await client.createSession({ signal });

        // onConflictDoNothing is now belt-and-suspenders rather than the primary defense: the
        // report row lock above already keeps two concurrent first-time callers from racing
        // this far together. It still matters for the retry case above, where a differently
        // timed crash could leave two attempts both reaching this insert.
        await tx
          .insert(agentSession)
          .values({ reportId, capabilityToken, sessionId })
          .onConflictDoNothing({ target: agentSession.reportId });

        if (signal.aborted) throw signal.reason;
      });
    },

    async run({ reportId, signal }: AnalysisContext): Promise<void> {
      if (signal.aborted) throw signal.reason;

      const [reportRow] = await db
        .select({ title: report.title, body: report.body })
        .from(report)
        .where(eq(report.id, reportId))
        .limit(1);
      if (!reportRow) {
        throw new Error(`trueforgeAnalysisDriver.run: report ${reportId} does not exist`);
      }

      const [verdictRow] = await db
        .select({ outcome: verdict.outcome, summary: verdict.summary })
        .from(verdict)
        .where(and(eq(verdict.reportId, reportId), eq(verdict.revision, 1)))
        .limit(1);
      if (!verdictRow) {
        throw new Error(
          `trueforgeAnalysisDriver.run: no verdict for report ${reportId}; ensureSession must run first`,
        );
      }

      // The row lock spans the createTurn call on purpose, unlike the delivery worker's GitHub
      // calls: TrueForge is a loopback service this deployment always controls, not a slow or
      // rate-limited external API, so holding one Postgres row lock for the length of one local
      // call is a bounded, acceptable cost for what it buys. Without it, two concurrent run()
      // attempts (or a stale worker still executing after its lease expired, racing a fresh
      // retry) could both pass the "no turnId yet" check, both call createTurn, and both try to
      // write: TrueForge chains a new turn onto the session's last turn by default, so a second
      // concurrent createTurn call does not just waste an API call, it cancels the first turn
      // outright. Serializing on this row means the second attempt always sees the first
      // attempt's committed turnId and returns without ever calling createTurn.
      //
      // Residual, accepted gap: if a transaction crashes after TrueForge accepts a turn but
      // before the write below commits, that turn is orphaned. The next retry creates a new
      // one, which supersedes it via the same session-chaining behavior, at the cost of one
      // wasted call. Same category as ensureSession's accepted orphaned-session cost above.
      await db.transaction(async (tx) => {
        const [session] = await tx
          .select({
            id: agentSession.id,
            sessionId: agentSession.sessionId,
            turnId: agentSession.turnId,
            capabilityToken: agentSession.capabilityToken,
          })
          .from(agentSession)
          .where(eq(agentSession.reportId, reportId))
          .for("update");

        if (!session) {
          throw new Error(
            `trueforgeAnalysisDriver.run: no agent session for report ${reportId}; ensureSession must run first`,
          );
        }

        // A turn was already started for this report, either by an earlier pass or by
        // whichever concurrent caller won the lock first. The poller takes it from here
        // regardless of how that turn is doing.
        if (session.turnId) return;

        if (signal.aborted) throw signal.reason;

        const content = buildTurnMessage(
          reportRow.title,
          reportRow.body,
          session.capabilityToken,
          verdictRow.outcome,
          verdictRow.summary,
        );
        const { turnId } = await client.createTurn(
          session.sessionId,
          [{ type: "user.message", content }],
          { signal },
        );

        await tx
          .update(agentSession)
          .set({ turnId, turnStatus: "RUNNING", updatedAt: new Date() })
          .where(eq(agentSession.id, session.id));
      });

      if (signal.aborted) throw signal.reason;
    },
  };
}
