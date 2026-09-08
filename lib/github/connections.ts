import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  inArray,
  isNull,
  isNotNull,
  report,
  sql,
  targetOnboarding,
  targetProfile,
} from "@/lib/db";
import { awaitingReviewSql } from "@/lib/reports/queue";
import type { TargetManifest } from "@/lib/targets/manifest";

/**
 * The read model behind the Integrations screen.
 *
 * Kept apart from lifecycle.ts, which owns applying webhooks and the activeRepository gate.
 * This is display only. `admissible` here is a label for an operator, never an authorization
 * decision: intake and delivery ask activeRepository(), which re-reads the row under a lock
 * at the moment it matters. Two things that look the same on screen can differ by the time
 * a job runs, and only one of them is allowed to decide.
 */
export type RepoStatus =
  | "admissible"
  | "not-configured"
  | "archived"
  | "disconnected"
  | "suspended";

export type ConnectionRepo = {
  connectedRepositoryId: string;
  repoId: number;
  fullName: string;
  targetProfileName: string | null;
  status: RepoStatus;
  /** What this repository has actually sent, which is the question an operator opens a
   *  repository to ask. Hidden reports are left out, the same as everywhere else. */
  reports: RepoReports;
  /** A built target waiting for a reviewer to approve its proposed manifest, or null. This is
   *  the only human gate between a build and a written TargetProfile, so the panel surfaces it. */
  onboarding: OnboardingProposal | null;
  /** Where onboarding is for this repo when it is not yet approvable: classifying, building,
   *  failed, or an honest UNSUPPORTED with a reason. Null when there is nothing in flight (no row,
   *  already awaiting approval, or already configured). Lets the panel say "building" rather than
   *  look idle, and show why a repo cannot be onboarded. */
  onboardingProgress: OnboardingProgress | null;
  /** The full onboarding record for the panel: what was built, the recipe, the sandboxability verdict,
   *  the approver, and which artifacts can be downloaded. Present whenever an onboarding row exists (any
   *  state, including CONFIGURED, so "was this properly onboarded?" has a positive answer). Null when the
   *  repo has never been onboarded. */
  onboardingDetail: OnboardingDetail | null;
};

export type OnboardingDetail = {
  state: string;
  /** A live note on what onboarding is doing now ("building the target image"), for in-flight states. */
  progressNote: string | null;
  /** The UNSUPPORTED not-flattenable reason or the FAILED last error; null otherwise. */
  reason: string | null;
  strategy: string | null;
  ecosystem: string | null;
  imageName: string | null;
  imageDigest: string | null;
  /** The source commit baked into the image and re-verified from inside the sandbox. */
  buildMarker: string | null;
  approvedBy: string | null;
  /** ISO string, so it crosses from the server component into the client one. */
  approvedAt: string | null;
  /** The sandboxability review's verdict and reason, when a review ran and its result is still on the
   *  row (it is cleared once consumed, so this is usually only set mid-review). */
  review: { verdict: string; reason: string } | null;
  /** Whether the Dockerfile / build log are stored, so the panel offers a download without shipping the
   *  full text in the connections list (the download fetches it on demand). */
  hasDockerfile: boolean;
  hasBuildLog: boolean;
  hasManifest: boolean;
  hasBuildPlan: boolean;
};

export type OnboardingProgress = {
  state: "PENDING_PLAN" | "PENDING_BUILD" | "PENDING_MANIFEST" | "FAILED" | "UNSUPPORTED";
  /** The not-flattenable reason for UNSUPPORTED, or the last error for FAILED; null otherwise. */
  reason: string | null;
};

export type OnboardingProposal = {
  manifest: TargetManifest;
  /** The pushed image and its digest, shown so a reviewer approves a specific build, not a name. */
  imageName: string | null;
  imageDigest: string | null;
};

export type RepoReports = {
  total: number;
  /** Reports with a verdict a reviewer can still answer, by the same rule the board uses. */
  awaitingReview: number;
  /** Reports whose verdict reached the issue as a comment. */
  delivered: number;
  lastReportAt: Date | null;
};

const NO_REPORTS: RepoReports = {
  total: 0,
  awaitingReview: 0,
  delivered: 0,
  lastReportAt: null,
};

/**
 * How many reports each connected repository has sent, and when the last one arrived.
 *
 * One grouped pass rather than a count per row: the connections screen draws every repository
 * an installation granted, and a query each would scale with the grant. Reports carry the
 * repository they came from, so this needs no join back to the installation.
 */
async function reportsByRepository(): Promise<Map<string, RepoReports>> {
  const rows = await db
    .select({
      connectedRepositoryId: report.connectedRepositoryId,
      total: sql<number>`count(*)::int`,
      // The same predicate the board and the home summary rank on, so a repository cannot
      // report nothing waiting while the queue shows a card with an Approve button.
      awaitingReview: sql<number>`count(*) filter (where ${awaitingReviewSql})::int`,
      delivered: sql<number>`count(*) filter (where ${report.state} = 'DELIVERED')::int`,
      lastReportAt: sql<Date>`max(${report.createdAt})`,
    })
    .from(report)
    .where(and(isNull(report.hiddenAt), isNotNull(report.connectedRepositoryId)))
    .groupBy(report.connectedRepositoryId);

  return new Map(
    rows.flatMap((row) =>
      row.connectedRepositoryId
        ? [
            [
              row.connectedRepositoryId,
              {
                total: row.total,
                awaitingReview: row.awaitingReview,
                delivered: row.delivered,
                lastReportAt: row.lastReportAt ? new Date(row.lastReportAt) : null,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

/**
 * The onboarding rows a reviewer can act on, keyed by repository id.
 *
 * Only AWAITING_APPROVAL: every other state is either the worker's to advance or already
 * terminal, and none of them offers the reviewer a decision. A row with no proposed manifest
 * yet cannot be shown, so it is skipped rather than surfaced as an empty card.
 */
async function awaitingApprovalOnboardings(): Promise<Map<number, OnboardingProposal>> {
  const rows = await db
    .select({
      repoId: targetOnboarding.repoId,
      proposedManifest: targetOnboarding.proposedManifest,
      imageName: targetOnboarding.imageName,
      imageDigest: targetOnboarding.imageDigest,
    })
    .from(targetOnboarding)
    .where(eq(targetOnboarding.state, "AWAITING_APPROVAL"));

  return new Map(
    rows.flatMap((row) =>
      row.proposedManifest
        ? [
            [
              Number(row.repoId),
              {
                manifest: row.proposedManifest as TargetManifest,
                imageName: row.imageName,
                imageDigest: row.imageDigest,
              },
            ] as const,
          ]
        : [],
    ),
  );
}

/**
 * Onboarding that is in flight or refused, keyed by repository id. Everything except the two states
 * the reviewer sees elsewhere (AWAITING_APPROVAL has its own proposal card, CONFIGURED is just the
 * bound target). UNSUPPORTED carries its reason from the build plan; FAILED carries the last error.
 */
async function onboardingProgressByRepo(): Promise<Map<number, OnboardingProgress>> {
  const rows = await db
    .select({
      repoId: targetOnboarding.repoId,
      state: targetOnboarding.state,
      buildPlan: targetOnboarding.buildPlan,
      lastError: targetOnboarding.lastError,
    })
    .from(targetOnboarding)
    .where(
      inArray(targetOnboarding.state, ["PENDING_PLAN", "PENDING_BUILD", "PENDING_MANIFEST", "FAILED", "UNSUPPORTED"]),
    );

  return new Map(
    rows.map((row) => {
      const state = row.state as OnboardingProgress["state"];
      const reason =
        state === "UNSUPPORTED"
          ? ((row.buildPlan as { reason?: string } | null)?.reason ?? null)
          : state === "FAILED"
            ? row.lastError
            : null;
      return [Number(row.repoId), { state, reason }] as const;
    }),
  );
}

/**
 * The full onboarding record for every repo that has one, keyed by repository id, for the panel's
 * detail view and downloads. Presence flags stand in for the large text columns (Dockerfile, build
 * log): the download fetches the text on demand rather than shipping it in the connections list.
 */
async function onboardingDetailByRepo(): Promise<Map<number, OnboardingDetail>> {
  const rows = await db
    .select({
      repoId: targetOnboarding.repoId,
      state: targetOnboarding.state,
      progressNote: targetOnboarding.progressNote,
      buildPlan: targetOnboarding.buildPlan,
      lastError: targetOnboarding.lastError,
      imageName: targetOnboarding.imageName,
      imageDigest: targetOnboarding.imageDigest,
      buildMarker: targetOnboarding.buildMarker,
      approvedBy: targetOnboarding.approvedBy,
      approvedAt: targetOnboarding.approvedAt,
      reviewResult: targetOnboarding.reviewResult,
      hasDockerfile: sql<boolean>`${targetOnboarding.dockerfileText} is not null`,
      hasBuildLog: sql<boolean>`${targetOnboarding.buildLog} is not null`,
      hasManifest: sql<boolean>`${targetOnboarding.proposedManifest} is not null`,
      hasBuildPlan: sql<boolean>`${targetOnboarding.buildPlan} is not null`,
    })
    .from(targetOnboarding);

  return new Map(
    rows.map((row) => {
      const plan = row.buildPlan as { strategy?: string; ecosystem?: string; reason?: string } | null;
      const review = row.reviewResult as { verdict?: string; reason?: string } | null;
      const reason =
        row.state === "UNSUPPORTED" ? (plan?.reason ?? null) : row.state === "FAILED" ? row.lastError : null;
      // The progress note only means something while a step is running; a resting row shows its state.
      const inFlight = ["PENDING_PLAN", "PENDING_BUILD", "PENDING_MANIFEST"].includes(row.state);
      const detail: OnboardingDetail = {
        state: row.state,
        progressNote: inFlight ? row.progressNote : null,
        reason,
        strategy: plan?.strategy ?? null,
        ecosystem: plan?.ecosystem ?? null,
        imageName: row.imageName,
        imageDigest: row.imageDigest,
        buildMarker: row.buildMarker,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
        review: review?.verdict ? { verdict: review.verdict, reason: review.reason ?? "" } : null,
        hasDockerfile: Boolean(row.hasDockerfile),
        hasBuildLog: Boolean(row.hasBuildLog),
        hasManifest: Boolean(row.hasManifest),
        hasBuildPlan: Boolean(row.hasBuildPlan),
      };
      return [Number(row.repoId), detail] as const;
    }),
  );
}

export type Connection = {
  installationRowId: string;
  installationId: number;
  accountLogin: string;
  accountType: string | null;
  suspendedAt: Date | null;
  /**
   * The most recent write across the installation row and its repositories. A rename,
   * transfer, archive or removal touches only connected_repository, so reading the
   * installation alone would report a stale time and call it synchronisation.
   *
   * Still not "last event": lifecycle_delivery has no installation key, so the time of the
   * last webhook for this account is genuinely not in the schema.
   */
  lastSyncedAt: Date;
  /** Repositories the installation currently grants. Excludes ones it has withdrawn. */
  grantedRepositoryCount: number;
  repositories: ConnectionRepo[];
};

type StatusInput = {
  installationSuspended: boolean;
  active: boolean;
  archivedAt: Date | null;
  targetProfileId: string | null;
};

/**
 * Why a repository is or is not admissible, most severe reason first.
 *
 * A row can fail several of these at once (a suspended installation whose repository was
 * also archived), and an operator needs the one that explains what to do next. The order
 * mirrors the predicate in activeRepository: installation liveness, then the grant, then
 * the repository's own state, then our configuration.
 */
export function repoStatus(row: StatusInput): RepoStatus {
  if (row.installationSuspended) return "suspended";
  if (!row.active) return "disconnected";
  if (row.archivedAt) return "archived";
  if (!row.targetProfileId) return "not-configured";

  return "admissible";
}

/** Every live installation and the repositories it granted. Tombstoned installs are hidden. */
export async function listConnections(): Promise<Connection[]> {
  const reports = await reportsByRepository();
  const onboardings = await awaitingApprovalOnboardings();
  const onboardingProgress = await onboardingProgressByRepo();
  const onboardingDetail = await onboardingDetailByRepo();
  const rows = await db
    .select({
      installationRowId: githubInstallation.id,
      installationId: githubInstallation.installationId,
      accountLogin: githubInstallation.accountLogin,
      accountType: githubInstallation.accountType,
      suspendedAt: githubInstallation.suspendedAt,
      updatedAt: githubInstallation.updatedAt,
      repositoryUpdatedAt: connectedRepository.updatedAt,
      connectedRepositoryId: connectedRepository.id,
      repoId: connectedRepository.repoId,
      fullName: connectedRepository.fullName,
      active: connectedRepository.active,
      archivedAt: connectedRepository.archivedAt,
      targetProfileId: connectedRepository.targetProfileId,
      targetProfileName: targetProfile.name,
    })
    .from(githubInstallation)
    .leftJoin(
      connectedRepository,
      eq(connectedRepository.installationId, githubInstallation.id),
    )
    .leftJoin(targetProfile, eq(connectedRepository.targetProfileId, targetProfile.id))
    .where(isNull(githubInstallation.deletedAt))
    .orderBy(githubInstallation.accountLogin, connectedRepository.fullName);

  const byInstallation = new Map<string, Connection>();

  for (const row of rows) {
    let connection = byInstallation.get(row.installationRowId);
    if (!connection) {
      connection = {
        installationRowId: row.installationRowId,
        installationId: row.installationId,
        accountLogin: row.accountLogin,
        accountType: row.accountType,
        suspendedAt: row.suspendedAt,
        lastSyncedAt: row.updatedAt,
        grantedRepositoryCount: 0,
        repositories: [],
      };
      byInstallation.set(row.installationRowId, connection);
    }

    // The left join yields one null-filled row for an installation that granted nothing.
    if (!row.connectedRepositoryId || row.repoId === null || row.fullName === null) continue;

    if (row.repositoryUpdatedAt && row.repositoryUpdatedAt > connection.lastSyncedAt) {
      connection.lastSyncedAt = row.repositoryUpdatedAt;
    }

    // Counted from the grant itself, not from the display status: a suspended installation
    // reports every repository as "suspended", which would hide whether the grant is intact.
    if (row.active) connection.grantedRepositoryCount += 1;

    connection.repositories.push({
      connectedRepositoryId: row.connectedRepositoryId,
      repoId: row.repoId,
      fullName: row.fullName,
      targetProfileName: row.targetProfileName,
      reports: reports.get(row.connectedRepositoryId) ?? NO_REPORTS,
      onboarding: onboardings.get(row.repoId) ?? null,
      onboardingProgress: onboardingProgress.get(row.repoId) ?? null,
      onboardingDetail: onboardingDetail.get(row.repoId) ?? null,
      status: repoStatus({
        installationSuspended: row.suspendedAt !== null,
        active: row.active ?? false,
        archivedAt: row.archivedAt,
        targetProfileId: row.targetProfileId,
      }),
    });
  }

  return [...byInstallation.values()];
}

/**
 * Where an operator changes which repositories the App can see.
 *
 * A GitHub App cannot change its own repository selection through the API: GitHub owns that
 * screen, and we find out afterwards from installation_repositories. So this is a deep link
 * out, not a form. Vercel's "configure repositories" works the same way.
 *
 * An organization keeps its installation settings under /organizations/<login>/settings,
 * not the personal /settings path, so sending an org operator to the personal one is a 404.
 * Rows written before the type was recorded have no safe deep link. Returning null makes the
 * caller offer the installation flow instead, which lets GitHub send the missing account type.
 */
export function manageRepositoriesUrl(
  installationId: number,
  account: { login: string; type: string | null },
): string | null {
  if (account.type === "Organization") {
    return `https://github.com/organizations/${account.login}/settings/installations/${installationId}`;
  }

  if (account.type === "User") {
    return `https://github.com/settings/installations/${installationId}`;
  }

  return null;
}
