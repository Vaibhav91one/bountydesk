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
  suspendedAt: Date | null;
  /**
   * githubInstallation.updatedAt. Deliberately not called "last event": lifecycle_delivery
   * has no installation key, so the time of the last webhook for this account is not in the
   * schema. This is the last time we wrote the row, which is close but not the same thing.
   */
  lastSyncedAt: Date;
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
      suspendedAt: githubInstallation.suspendedAt,
      updatedAt: githubInstallation.updatedAt,
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
        suspendedAt: row.suspendedAt,
        lastSyncedAt: row.updatedAt,
        repositories: [],
      };
      byInstallation.set(row.installationRowId, connection);
    }

    // The left join yields one null-filled row for an installation that granted nothing.
    if (!row.connectedRepositoryId || row.repoId === null || row.fullName === null) continue;

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
 */
export function manageRepositoriesUrl(installationId: number): string {
  return `https://github.com/settings/installations/${installationId}`;
}
