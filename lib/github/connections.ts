import {
  connectedRepository,
  db,
  eq,
  githubInstallation,
  isNull,
  targetProfile,
} from "@/lib/db";

/**
 * The read model behind the Channels screen.
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
};

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
 * An unknown account type falls back to the personal path: rows written before the type was
 * recorded have no answer, and a wrong guess for organizations is the more common mistake.
 */
export function manageRepositoriesUrl(
  installationId: number,
  account: { login: string; type: string | null },
): string {
  if (account.type === "Organization") {
    return `https://github.com/organizations/${account.login}/settings/installations/${installationId}`;
  }

  return `https://github.com/settings/installations/${installationId}`;
}
