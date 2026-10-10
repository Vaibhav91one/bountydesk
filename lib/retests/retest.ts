import { randomUUID } from "node:crypto";

import { isCommitSha } from "@/lib/build-onboarding/source-identity";
import {
  and,
  connectedRepository,
  db,
  desc,
  eq,
  report,
  retest,
  targetOnboarding,
  targetProfile,
  uploadIntake,
  verdict,
} from "@/lib/db";
import { ensureReport, recordEvent } from "@/lib/reports/lifecycle";
import { approveUploadTarget, reviewedUploadTarget, type UploadTargetInput } from "@/lib/upload/gate";
import { parseGitSource } from "@/lib/upload/git-source";
import { profileAppPort } from "@/lib/targets/authorize-reproduction";
import { ECOSYSTEMS, type Ecosystem } from "@/lib/build-onboarding/build-plan";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";

/**
 * Fix-verification (docs/decisions.md Q34): after a REPRODUCED report ships, a reviewer names the
 * fixed commit and the platform asks the agent whether the bug still reproduces there.
 *
 * The retest is a child report built through the upload path (git material, the onboarding agent,
 * the normal investigation), so nothing here touches the original report, its verdict, its
 * TargetProfile or the repository binding. The child has no reporter contact, which makes delivery
 * impossible by construction: enqueueApprovedVerdictDelivery refuses an upload report with no
 * verified contact. The child's verdict is evidence for a human and is never sent to anyone.
 */

export type RetestResult = "FIXED" | "NOT_FIXED" | "PARTIALLY_FIXED" | "INCONCLUSIVE";

type VerdictOutcome = (typeof verdict.outcome.enumValues)[number];

/** Report states from which a REPRODUCED verdict has been approved and is on its way out or out. */
const RETESTABLE_STATES = ["DELIVERING", "DELIVERED"];

/** A child that ended without a verdict will never produce one. */
const DEAD_STATES = ["DENIED", "OUT_OF_SCOPE", "CANCELLED", "EXPIRED"];

/**
 * The retest result from what the child run produced, or null while it is still running.
 * PARTIALLY_FIXED is deliberately never returned: one agent run cannot tell a partial fix from an
 * incomplete retest, so the value stays reserved for a human to record (not built).
 */
export function deriveRetestResult(input: {
  outcome: VerdictOutcome | null;
  buildState: string | null;
  childState: string;
}): RetestResult | null {
  switch (input.outcome) {
    case "REPRODUCED":
      return "NOT_FIXED";
    case "NOT_REPRODUCED":
      return "FIXED";
    case "ANALYSIS_ONLY":
    case "INCONCLUSIVE":
      return "INCONCLUSIVE";
    default:
      if (input.buildState === "FAILED" || DEAD_STATES.includes(input.childState)) return "INCONCLUSIVE";
      return null;
  }
}

export type StartRetestResult = { ok: true; childReportId: string } | { ok: false; reason: string };

export async function startRetest(
  reportId: string,
  commitSha: string,
  reviewer: { login: string },
): Promise<StartRetestResult> {
  if (!isCommitSha(commitSha)) {
    return { ok: false, reason: "the fixed commit must be a full 40-character SHA" };
  }

  const [original] = await db
    .select({
      title: report.title,
      body: report.body,
      state: report.state,
      targetProfileId: report.targetProfileId,
      repoId: connectedRepository.repoId,
      repoFullName: connectedRepository.fullName,
      repoIsPrivate: connectedRepository.isPrivate,
      targetConfig: targetProfile.config,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .leftJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
    .where(eq(report.id, reportId))
    .limit(1);
  if (!original) return { ok: false, reason: "report not found" };

  const [latest] = await db
    .select({ id: verdict.id, outcome: verdict.outcome })
    .from(verdict)
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  if (!latest || latest.outcome !== "REPRODUCED" || !RETESTABLE_STATES.includes(original.state)) {
    return { ok: false, reason: "only a report with an approved REPRODUCED verdict can be retested" };
  }

  // Only a repository connected through the GitHub App is rebuilt here. A connectionless or demo
  // target has no repository to read the fixed commit from.
  if (!original.repoId || !original.repoFullName || !original.targetProfileId) {
    return { ok: false, reason: "retest needs a target bound through a connected GitHub repository" };
  }
  // A private clone needs an installation token inside the build sandbox, which the upload path
  // does not have. Refused until that is designed rather than building it half way.
  if (original.repoIsPrivate !== false) {
    return { ok: false, reason: "retest supports public repositories only" };
  }
  const grant = await loadRepositoryGrantSnapshot(reportId, db);
  if (!grant || !hasActiveRepositoryGrant(grant)) {
    return { ok: false, reason: "the repository grant is no longer active" };
  }

  const git = parseGitSource(`https://github.com/${original.repoFullName}`, commitSha);
  if (!git.ok) return { ok: false, reason: git.reason };

  const target = await originalTargetSettings(original.repoId, original.targetConfig);
  if (!target.ok) return target;
  // Validate before writing, so a bad setting leaves no orphan child.
  try {
    reviewedUploadTarget(randomUUID(), target.input);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "the target settings are not valid" };
  }

  const duplicate = await db
    .select({ id: retest.id })
    .from(retest)
    .where(and(eq(retest.originalVerdictId, latest.id), eq(retest.commitSha, git.source.commitSha)))
    .limit(1);
  if (duplicate.length > 0) return { ok: false, reason: "this commit was already retested for this verdict" };

  const childReportId = await db.transaction(async (tx) => {
    const id = await ensureReport(
      {
        channel: "upload",
        sourceRef: `upload:retest-${randomUUID()}`,
        title: `Retest: ${original.title}`.slice(0, 200),
        body: `${original.body}\n\nThis is a fix-verification retest at commit ${git.source.commitSha}. Check whether the issue reported above still reproduces on this build.`,
        reporterHandle: reviewer.login,
        // No contact and no verified sender: delivery refuses, so the child verdict goes nowhere.
        reporterContact: null,
        state: "NEEDS_DECISION",
        connectedRepositoryId: null,
        targetProfileId: null,
      },
      tx,
    );
    await tx.insert(uploadIntake).values({
      reportId: id,
      senderKey: `retest:${reportId}`,
      senderDomain: "retest.internal",
      clientIp: null,
      materialKind: "git",
      gitUrl: git.source.cloneUrl,
      gitCommitSha: git.source.commitSha,
    });
    await tx.insert(retest).values({
      originalReportId: reportId,
      originalVerdictId: latest.id,
      childReportId: id,
      commitSha: git.source.commitSha,
      actor: reviewer.login,
    });
    await recordEvent(id, "retest.created", { originalReportId: reportId, commitSha: git.source.commitSha, reviewer: reviewer.login }, { tx });
    return id;
  });

  // The reviewer triggering the retest is the approver, so the child skips the gate and goes to
  // the build; the same call the reviewer upload path makes.
  const approved = await approveUploadTarget(childReportId, reviewer.login, target.input);
  if (!approved.ok) return { ok: false, reason: approved.reason };
  return { ok: true, childReportId };
}

/** The original target's runtime settings; the ecosystem comes from the plan its onboarding built with. */
async function originalTargetSettings(
  repoId: number,
  config: unknown,
): Promise<{ ok: true; input: UploadTargetInput } | { ok: false; reason: string }> {
  const port = profileAppPort(config);
  const provisioning =
    typeof config === "object" && config !== null
      ? ((config as { provisioning?: { readinessPath?: unknown; startCommand?: unknown } }).provisioning ?? {})
      : {};
  if (port === null || typeof provisioning.readinessPath !== "string") {
    return { ok: false, reason: "the original target has no recorded port or readiness path" };
  }
  const [onboarding] = await db
    .select({ buildPlan: targetOnboarding.buildPlan })
    .from(targetOnboarding)
    .where(eq(targetOnboarding.repoId, repoId))
    .limit(1);
  const planned = (onboarding?.buildPlan as { ecosystem?: unknown } | null)?.ecosystem;
  const ecosystem: Ecosystem = ECOSYSTEMS.includes(planned as Ecosystem) ? (planned as Ecosystem) : "none";
  return {
    ok: true,
    input: {
      port,
      readinessPath: provisioning.readinessPath,
      ...(typeof provisioning.startCommand === "string" && provisioning.startCommand
        ? { startCommand: provisioning.startCommand }
        : {}),
      ecosystem,
    },
  };
}

export type RetestRow = {
  id: string;
  childReportId: string;
  childTitle: string;
  commitSha: string;
  actor: string;
  createdAt: Date;
  result: RetestResult | null;
};

/** The retests of one report, newest first, each with its result derived from the child's latest verdict. */
export async function listRetests(originalReportId: string): Promise<RetestRow[]> {
  const rows = await db
    .select({
      id: retest.id,
      childReportId: retest.childReportId,
      childTitle: report.title,
      childState: report.state,
      commitSha: retest.commitSha,
      actor: retest.actor,
      createdAt: retest.createdAt,
      buildState: uploadIntake.buildState,
    })
    .from(retest)
    .innerJoin(report, eq(report.id, retest.childReportId))
    .leftJoin(uploadIntake, eq(uploadIntake.reportId, retest.childReportId))
    .where(eq(retest.originalReportId, originalReportId))
    .orderBy(desc(retest.createdAt));

  return Promise.all(
    rows.map(async ({ childState, buildState, ...row }) => {
      const [latest] = await db
        .select({ outcome: verdict.outcome })
        .from(verdict)
        .where(eq(verdict.reportId, row.childReportId))
        .orderBy(desc(verdict.revision))
        .limit(1);
      return { ...row, result: deriveRetestResult({ outcome: latest?.outcome ?? null, buildState, childState }) };
    }),
  );
}

/** The original report a child retest belongs to, for the "Retest of" link; null for any other report. */
export async function readRetestOf(
  childReportId: string,
): Promise<{ originalReportId: string; originalTitle: string; commitSha: string } | null> {
  const [row] = await db
    .select({ originalReportId: retest.originalReportId, originalTitle: report.title, commitSha: retest.commitSha })
    .from(retest)
    .innerJoin(report, eq(report.id, retest.originalReportId))
    .where(eq(retest.childReportId, childReportId))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the case file should offer the control: the same checks startRetest makes on the report
 * itself, minus the ones that need the commit. Display only; startRetest re-checks everything.
 */
export async function canOfferRetest(reportId: string): Promise<boolean> {
  const [row] = await db
    .select({ state: report.state, isPrivate: connectedRepository.isPrivate, repoId: connectedRepository.repoId })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .where(eq(report.id, reportId))
    .limit(1);
  if (!row || !row.repoId || row.isPrivate !== false || !RETESTABLE_STATES.includes(row.state)) return false;
  const [latest] = await db
    .select({ outcome: verdict.outcome })
    .from(verdict)
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  return latest?.outcome === "REPRODUCED";
}
