import { createHash, randomUUID } from "node:crypto";

import { isCommitSha } from "@/lib/build-onboarding/source-identity";
import { parseUploadForm, type UploadMaterial, type UploadSubmission } from "@/lib/upload/intake";
import { OUTSIDE_LIMITS } from "@/lib/email/outside-intake";
import {
  and,
  connectedRepository,
  db,
  desc,
  eq,
  report,
  retest,
  sql,
  targetOnboarding,
  targetProfile,
  uploadIntake,
  verdict,
} from "@/lib/db";
import { ensureReport, recordEvent, transition } from "@/lib/reports/lifecycle";
import { approveUploadTarget, reviewedUploadTarget, type UploadTargetInput } from "@/lib/upload/gate";
import { parseGitSource } from "@/lib/upload/git-source";
import { ECOSYSTEMS, type Ecosystem } from "@/lib/build-onboarding/build-plan";
import { hasActiveRepositoryGrant, loadRepositoryGrantSnapshot } from "@/lib/targets/repository-grant";
import { PolicyRefusedError, privateRepoPolicyRefused } from "@/lib/github/repo-access";
import { profileAppPort } from "@/lib/targets/authorize-reproduction";

/**
 * Fix-verification (docs/decisions.md Q34): after a REPRODUCED report ships, a reviewer names the fix
 * material and the platform asks the agent whether the bug still reproduces there.
 *
 * Two material shapes are accepted:
 *
 * - A git commit SHA on the report's connected repository. A public repository clones anonymously; a
 *   private one reuses the private-clone path in lib/github/repo-access.ts. If the installation has
 *   not granted Contents read, the retest is refused with the same POLICY_REFUSED reasoning shown to a
 *   reviewer.
 *
 * - Upload material (a tarball, a Dockerfile, a git URL at a commit, or a prebuilt image pinned by
 *   digest) for a report with a connectionless target (no bound repository). The reviewer supplies the
 *   fixed material instead of a commit SHA, reusing the existing upload intake validation.
 *
 * The child runs through the upload path so nothing here touches the original report, its verdict,
 * its TargetProfile or the repository binding. The child has no contact so nothing is delivered, and
 * the original verdict is untouched. The result is derived from the child verdict when read.
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

/** A git commit SHA on the report's connected repository. */
export type GitRetestMaterial = { kind: "git"; commitSha: string };

/** Upload material supplied by the reviewer for a connectionless target. */
export type UploadRetestMaterial = {
  kind: "upload";
  /** At most one of these is set; the upload intake validator enforces exactly one. */
  archive?: File;
  dockerfile?: File;
  imageRef?: string;
  imageDigest?: string;
  gitUrl?: string;
  gitCommitSha?: string;
};

export type RetestMaterial = GitRetestMaterial | UploadRetestMaterial;

export type StartRetestResult = { ok: true; childReportId: string } | { ok: false; reason: string };

/**
 * Start a fix-verification retest. The material must match the report's binding:
 *
 * - A commit SHA is only valid for a report bound through a connected GitHub repository. A private
 *   repository is accepted when its installation has Contents read, and refused with POLICY_REFUSED
 *   when it does not.
 *
 * - Upload material is only valid for a connectionless target (no bound repository), and reuses the
 *   exact upload intake validation so an invalid archive, Dockerfile, image ref, or git URL is refused
 *   before any row is written.
 *
 * The child is created on the upload channel and approved by the triggering reviewer, so it skips
 * the gate and goes straight into the build and investigation. The child has no reporter contact,
 * so enqueueApprovedVerdictDelivery refuses any verdict it might produce; the child's verdict is
 * evidence for a human and is never sent.
 */
export async function startRetest(
  reportId: string,
  material: RetestMaterial,
  reviewer: { login: string },
): Promise<StartRetestResult> {
  const [original] = await db
    .select({
      title: report.title,
      body: report.body,
      state: report.state,
      targetProfileId: report.targetProfileId,
      repoId: connectedRepository.repoId,
      connectedRepositoryId: report.connectedRepositoryId,
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

  if (material.kind === "git") {
    return startGitRetest(reportId, original, latest, material, reviewer);
  }
  return startUploadRetest(reportId, original, latest, material, reviewer);
}

/**
 * The original target's runtime settings; the ecosystem comes from the plan its onboarding built with.
 * For a connectionless target (no connected repository) the ecosystem defaults to none, since there
 * is no onboarding row keyed on a repo_id.
 */
async function originalTargetSettings(
  config: unknown,
  repoId: number | null,
): Promise<{ ok: true; input: UploadTargetInput } | { ok: false; reason: string }> {
  const port = profileAppPort(config);
  const provisioning =
    typeof config === "object" && config !== null
      ? ((config as { provisioning?: { readinessPath?: unknown; startCommand?: unknown } }).provisioning ?? {})
      : {};
  if (port === null || typeof provisioning.readinessPath !== "string") {
    return { ok: false, reason: "the original target has no recorded port or readiness path" };
  }
  const planned =
    repoId !== null
      ? (await db
          .select({ buildPlan: targetOnboarding.buildPlan })
          .from(targetOnboarding)
          .where(eq(targetOnboarding.repoId, repoId))
          .limit(1)
          .then((rows) => rows[0]?.buildPlan as { ecosystem?: unknown } | null))
      : null;
  const ecosystem: Ecosystem = ECOSYSTEMS.includes((planned?.ecosystem as Ecosystem) ?? "none")
    ? ((planned?.ecosystem as Ecosystem) ?? "none")
    : "none";
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

/** A retest pinned on a commit of the report's connected repository. */
async function startGitRetest(
  reportId: string,
  original: {
    title: string;
    body: string;
    repoId: number | null;
    connectedRepositoryId: string | null;
    repoFullName: string | null;
    repoIsPrivate: boolean | null;
    targetConfig: unknown;
  },
  latest: { id: string; outcome: string },
  material: GitRetestMaterial,
  reviewer: { login: string },
): Promise<StartRetestResult> {
  if (!isCommitSha(material.commitSha)) {
    return { ok: false, reason: "the fixed commit must be a full 40-character SHA" };
  }

  // Only a repository connected through the GitHub App can supply source to clone from.
  if (!original.repoId || !original.repoFullName || !original.targetConfig) {
    return { ok: false, reason: "a commit retest needs a target bound through a connected GitHub repository" };
  }

  // The private-repository policy: a private clone needs Contents read. Without it, refuse with the
  // same server-side reasoning a reviewer sees elsewhere, rather than building half a path.
  const grant = await loadRepositoryGrantSnapshot(reportId, db);
  if (!grant) {
    return { ok: false, reason: "the repository grant could not be loaded" };
  }
  if (privateRepoPolicyRefused({ isPrivate: original.repoIsPrivate, contentsPermission: grant.installationContentsPermission })) {
    return { ok: false, reason: new PolicyRefusedError(original.repoFullName ?? "the repository").message };
  }
  if (!hasActiveRepositoryGrant(grant)) {
    return { ok: false, reason: "the repository grant is no longer active" };
  }

  const git = parseGitSource(`https://github.com/${original.repoFullName}`, material.commitSha);
  if (!git.ok) return { ok: false, reason: git.reason };

  const target = await originalTargetSettings(original.targetConfig, original.repoId);
  if (!target.ok) return target;
  // Validate before writing, so a bad setting leaves no orphan child.
  try {
    reviewedUploadTarget(randomUUID(), target.input);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "the target settings are not valid" };
  }

  let childReportId: string;
  try {
    childReportId = await db.transaction(async (tx) => {
      // Advisory lock on the original verdict id serializes concurrent retests for the same verdict,
      // so the read-then-write dedupe check is race-safe without a DB-level unique index on nullable commit_sha.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${latest.id}, 0))`);

      const duplicate = await tx
        .select({ id: retest.id })
        .from(retest)
        .where(and(eq(retest.originalVerdictId, latest.id), eq(retest.commitSha, git.source.commitSha)))
        .limit(1);
      if (duplicate.length > 0) {
        // Release the lock and signal the caller to treat this as a dedupe refusal.
        throw new Error("DUPLICATE_RETEST");
      }

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
      connectedRepositoryId: original.connectedRepositoryId,
      isRetest: true,
    });
    await tx.insert(retest).values({
      originalReportId: reportId,
      originalVerdictId: latest.id,
      childReportId: id,
      materialKind: "git",
      commitSha: git.source.commitSha,
      actor: reviewer.login,
    });
    await recordEvent(
      id,
      "retest.created",
      { originalReportId: reportId, commitSha: git.source.commitSha, reviewer: reviewer.login },
      { tx },
    );
    return id;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_RETEST") {
      return { ok: false, reason: "this commit was already retested for this verdict" };
    }
    throw error;
  }

  // The reviewer triggering the retest is the approver, so the child skips the gate and goes to
  // the build; the same call the reviewer upload path makes.
  const approved = await approveUploadTarget(childReportId, reviewer.login, target.input);
  if (!approved.ok) {
    // Close the child so it is not left at the gate; the retest row stays and reads INCONCLUSIVE.
    await transition(childReportId, "NEEDS_DECISION", "DENIED").catch(() => undefined);
    return { ok: false, reason: approved.reason };
  }
  return { ok: true, childReportId };
}

/**
 * A retest whose target material does not come from a connected repository: a tarball, a Dockerfile,
 * a git URL at a commit, or a prebuilt image pinned by digest. The reviewer supplies the material
 * through the same intake validation the public /submit path uses, so the bounds, tarball check,
 * image-registry allowlist and git URL rules are identical.
 */
async function startUploadRetest(
  reportId: string,
  original: {
    title: string;
    body: string;
    repoId: number | null;
    connectedRepositoryId: string | null;
    targetConfig: unknown;
  },
  latest: { id: string; outcome: string },
  material: UploadRetestMaterial,
  reviewer: { login: string },
): Promise<StartRetestResult> {
  // Upload material is for a connectionless target. A report bound to a connected repository
  // must use the git path so the clone goes through the private-repo policy and Contents token.
  if (original.repoId || original.connectedRepositoryId) {
    return { ok: false, reason: "a connectionless upload retest must target a report with no connected repository" };
  }
  if (!original.targetConfig) {
    return { ok: false, reason: "this report has no bound target to copy run settings from" };
  }
  const target = await originalTargetSettings(original.targetConfig, null);
  if (!target.ok) return target;

  // Validate the material and the target settings together, reusing the upload intake validator so
  // the exact same bounds and registry checks run. Validate before writing, so bad input leaves no orphan.
  const parsed = await parseUploadRetestMaterial(material);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const material_ = parsed.submission.material;
  try {
    reviewedUploadTarget(randomUUID(), target.input);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "the target settings are not valid" };
  }

  // Deduplicate: compare the material's identity anchor against prior retests for this verdict.
  const anchor = uploadMaterialAnchor(material_);

  let childReportId: string;
  try {
    childReportId = await db.transaction(async (tx) => {
      // Advisory lock on the original verdict id serializes concurrent retests for the same verdict,
      // so the read-then-write dedupe check is race-safe.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${latest.id}, 0))`);

      // Filter directly in the WHERE on the material identity, so dedupe works past any row cap.
      if (anchor) {
        const dupe = await tx
          .select({ id: retest.id })
          .from(retest)
          .innerJoin(report, eq(report.id, retest.childReportId))
          .innerJoin(uploadIntake, eq(uploadIntake.reportId, report.id))
          .where(
            and(
              eq(retest.originalVerdictId, latest.id),
              sql`
                ${uploadIntake.sourceArchiveDigest} = ${anchor}
                OR ${uploadIntake.imageDigest} = ${anchor}
                OR ${uploadIntake.gitCommitSha} = ${anchor}
              `,
            ),
          )
          .limit(1);
        if (dupe.length > 0) {
          throw new Error("DUPLICATE_RETEST");
        }
      }

      const id = await ensureReport(
        {
          channel: "upload",
          sourceRef: `upload:retest-${randomUUID()}`,
          title: `Retest: ${original.title}`.slice(0, 200),
          body: `${original.body}\n\nThis is a fix-verification retest with reviewer-supplied material. Check whether the issue reported above still reproduces on this build.`,
          reporterHandle: reviewer.login,
          // No contact and no verified sender: delivery refuses, so the child verdict goes nowhere.
          reporterContact: null,
          state: "NEEDS_DECISION",
          connectedRepositoryId: null,
          targetProfileId: null,
        },
        tx,
      );
      const m = material_;
      const isArchive = m.kind === "archive" || m.kind === "dockerfile";
      const materialDigest = isArchive ? `sha256:${createHash("sha256").update(m.archive).digest("hex")}` : null;
      await tx.insert(uploadIntake).values({
        reportId: id,
        senderKey: `retest:${reportId}`,
        senderDomain: "retest.internal",
        clientIp: null,
        materialKind: m.kind,
        archive: isArchive ? m.archive : null,
        sourceArchiveDigest: materialDigest,
        imageRef: m.kind === "image" ? m.imageRef : null,
        imageDigest: m.kind === "image" ? m.imageDigest : null,
        gitUrl: m.kind === "git" ? m.gitUrl : null,
        gitCommitSha: m.kind === "git" ? m.gitCommitSha : null,
        materialBytes: isArchive ? m.archive.length : null,
        isRetest: true,
      });
      await tx.insert(retest).values({
        originalReportId: reportId,
        originalVerdictId: latest.id,
        childReportId: id,
        materialKind: "upload",
        commitSha: null,
        actor: reviewer.login,
      });
      await recordEvent(
        id,
        "retest.created",
        { originalReportId: reportId, materialKind: "upload", reviewer: reviewer.login },
        { tx },
      );
      return id;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_RETEST") {
      return { ok: false, reason: "this material was already retested for this verdict" };
    }
    throw error;
  }

  // The reviewer is the approver, so the child skips the gate.
  const approved = await approveUploadTarget(childReportId, reviewer.login, target.input);
  if (!approved.ok) {
    await transition(childReportId, "NEEDS_DECISION", "DENIED").catch(() => undefined);
    return { ok: false, reason: approved.reason };
  }
  return { ok: true, childReportId };
}

/**
 * Re-serialize a reviewer-supplied upload material into a FormData the upload intake validator
 * accepts, so the exact same bounds and checks run as on the public /submit path.
 */
async function parseUploadRetestMaterial(material: UploadRetestMaterial): Promise<{
  ok: true;
  submission: Omit<UploadSubmission, "material"> & { material: UploadMaterial };
} | { ok: false; reason: string }> {
  const form = new FormData();
  form.set("title", "placeholder");
  form.set("body", "placeholder");
  form.set("contact", "retest@internal.test");

  if (material.archive) form.set("archive", material.archive);
  if (material.dockerfile) form.set("dockerfile", material.dockerfile);
  if (material.imageRef) form.set("imageRef", material.imageRef);
  if (material.imageDigest) form.set("imageDigest", material.imageDigest);
  if (material.gitUrl) form.set("gitUrl", material.gitUrl);
  if (material.gitCommitSha) form.set("gitCommit", material.gitCommitSha);

  const config = { perSenderPerDay: OUTSIDE_LIMITS.perSenderPerDay, perDomainPerDay: OUTSIDE_LIMITS.perDomainPerDay, maxBytes: OUTSIDE_LIMITS.maxBytes, exemptDomains: [] };
  const parsed = await parseUploadForm(form, config);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const { submission } = parsed;
  if (!submission.material) return { ok: false, reason: "no target material was provided" };
  return { ok: true, submission: { ...submission, material: submission.material } };
}

/** The immutable identity anchor of an upload material, for dedupe. */
function uploadMaterialAnchor(material: UploadMaterial): string | null {
  if (material.kind === "archive" || material.kind === "dockerfile") {
    return `sha256:${createHash("sha256").update(material.archive).digest("hex")}`;
  }
  if (material.kind === "image") return material.imageDigest ?? null;
  if (material.kind === "git") return material.gitCommitSha ?? null;
  return null;
}


export type RetestRow = {
  id: string;
  childReportId: string;
  childTitle: string;
  commitSha: string | null;
  materialKind: string;
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
      materialKind: retest.materialKind,
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
): Promise<{ originalReportId: string; originalTitle: string; commitSha: string | null } | null> {
  const [row] = await db
    .select({ originalReportId: retest.originalReportId, originalTitle: report.title, commitSha: retest.commitSha })
    .from(retest)
    .innerJoin(report, eq(report.id, retest.originalReportId))
    .where(eq(retest.childReportId, childReportId))
    .limit(1);
  return row ?? null;
}

/**
 * Whether the case file should offer the retest control. Display only; startRetest re-checks everything.
 * Offers the control for any report with an approved REPRODUCED verdict that has a live target grant:
 * a public or private connected repository (private requires Contents read), or a connectionless target
 * (no bound repository), which uses the reviewer-supplied material path instead.
 */
export async function canOfferRetest(reportId: string): Promise<boolean> {
  const [row] = await db
    .select({
      state: report.state,
      isPrivate: connectedRepository.isPrivate,
      repoId: connectedRepository.repoId,
      targetProfileId: report.targetProfileId,
    })
    .from(report)
    .leftJoin(connectedRepository, eq(report.connectedRepositoryId, connectedRepository.id))
    .where(eq(report.id, reportId))
    .limit(1);
  if (!row || !RETESTABLE_STATES.includes(row.state)) return false;

  const [latest] = await db
    .select({ outcome: verdict.outcome })
    .from(verdict)
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);
  if (latest?.outcome !== "REPRODUCED") return false;

  // A connectionless target (no connected repository) can be retested with reviewer-supplied material.
  if (!row.repoId) {
    return row.targetProfileId !== null;
  }

  // A connected repository is offerable only while its grant is live: active, not suspended,
  // and (for a private repo) with Contents read. A revoked or suspended installation hides the
  // control even for a public repository, which otherwise clones anonymously.
  const grant = await loadRepositoryGrantSnapshot(reportId, db);
  if (!grant || !hasActiveRepositoryGrant(grant)) return false;
  return true;
}
