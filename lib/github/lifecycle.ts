import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  inArray,
  isNull,
  sql,
} from "@/lib/db";

/**
 * The App-lifecycle side of intake: who installed us, on which repositories, and whether
 * that access is still live.
 *
 * These handlers do not go through the jobs table. Every one of them is an upsert keyed on
 * an immutable GitHub id, so replaying a delivery lands on the same row with the same
 * values and a `(channel, delivery_id)` guard would buy nothing. They also have to take
 * effect the moment the request arrives: a suspended installation must stop intake and
 * delivery at once, not when a worker next picks up a queue row.
 */

/** The subset of GitHub's payloads we read. Anything not named here is ignored. */
type InstallationPayload = {
  id: number;
  account?: { login?: string; id?: number } | null;
  suspended_at?: string | null;
};

type RepositoryPayload = {
  id: number;
  full_name: string;
};

type LifecyclePayload = {
  action?: string;
  installation?: InstallationPayload | null;
  repository?: RepositoryPayload | null;
  repositories?: RepositoryPayload[] | null;
  repositories_added?: RepositoryPayload[] | null;
  repositories_removed?: RepositoryPayload[] | null;
};

export const LIFECYCLE_EVENTS = new Set([
  "installation",
  "installation_repositories",
  "repository",
]);

/**
 * Record the installation and return its row id.
 *
 * `reinstate` clears the suspension and deletion marks, and only the two actions that
 * genuinely restore access pass it. Clearing them on every upsert would let an unrelated
 * event, a repository rename say, silently bring a deleted installation back to life.
 */
async function upsertInstallation(
  installation: InstallationPayload,
  { reinstate }: { reinstate: boolean },
): Promise<string> {
  const values = {
    installationId: installation.id,
    accountLogin: installation.account?.login ?? "",
    accountId: installation.account?.id ?? 0,
    suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
  };

  const [row] = await db
    .insert(githubInstallation)
    .values(values)
    .onConflictDoUpdate({
      target: githubInstallation.installationId,
      set: {
        accountLogin: values.accountLogin,
        accountId: values.accountId,
        updatedAt: new Date(),
        ...(reinstate ? { suspendedAt: values.suspendedAt, deletedAt: null } : {}),
      },
    })
    .returning({ id: githubInstallation.id });

  return row.id;
}

/** Mark repositories as granted. A repo re-added after removal comes back active. */
async function activateRepositories(
  installationRowId: string,
  repositories: RepositoryPayload[],
): Promise<void> {
  if (repositories.length === 0) return;

  await db
    .insert(connectedRepository)
    .values(
      repositories.map((repo) => ({
        installationId: installationRowId,
        repoId: repo.id,
        fullName: repo.full_name,
      })),
    )
    .onConflictDoUpdate({
      target: connectedRepository.repoId,
      set: {
        installationId: installationRowId,
        fullName: sql`excluded.full_name`,
        active: true,
        updatedAt: new Date(),
      },
    });
}

/** Withdraw access to repositories, keeping the rows so their history survives. */
async function deactivateRepositories(repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;

  await db
    .update(connectedRepository)
    .set({ active: false, updatedAt: new Date() })
    .where(inArray(connectedRepository.repoId, repoIds));
}

async function handleInstallation(payload: LifecyclePayload): Promise<void> {
  const installation = payload.installation;
  if (!installation) return;

  switch (payload.action) {
    case "created":
    case "unsuspend": {
      const rowId = await upsertInstallation(installation, { reinstate: true });
      await activateRepositories(rowId, payload.repositories ?? []);
      return;
    }

    case "new_permissions_accepted":
      await upsertInstallation(installation, { reinstate: false });
      return;

    case "suspend": {
      // GitHub sends suspended_at on this payload, but a clock we do not control decides a
      // security-relevant timestamp. Stamp it ourselves.
      await db
        .update(githubInstallation)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallation.installationId, installation.id));
      return;
    }

    case "deleted": {
      await db
        .update(githubInstallation)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallation.installationId, installation.id));
      return;
    }
  }
}

async function handleInstallationRepositories(payload: LifecyclePayload): Promise<void> {
  const installation = payload.installation;
  if (!installation) return;

  const rowId = await upsertInstallation(installation, { reinstate: false });

  await activateRepositories(rowId, payload.repositories_added ?? []);
  await deactivateRepositories((payload.repositories_removed ?? []).map((r) => r.id));
}

async function handleRepository(payload: LifecyclePayload): Promise<void> {
  const repository = payload.repository;
  if (!repository) return;

  switch (payload.action) {
    case "renamed":
    case "transferred":
      await db
        .update(connectedRepository)
        .set({ fullName: repository.full_name, updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, repository.id));
      return;

    case "archived":
    case "deleted":
    case "privatized":
      await deactivateRepositories([repository.id]);
      return;

    case "unarchived":
      await db
        .update(connectedRepository)
        .set({ active: true, updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, repository.id));
      return;
  }
}

export async function applyLifecycle(
  event: string,
  payload: LifecyclePayload,
): Promise<void> {
  switch (event) {
    case "installation":
      return handleInstallation(payload);
    case "installation_repositories":
      return handleInstallationRepositories(payload);
    case "repository":
      return handleRepository(payload);
  }
}

export type ActiveRepository = {
  connectedRepositoryId: string;
  fullName: string;
  targetProfileId: string | null;
};

/**
 * The one place that answers "may we still act on this repository?".
 *
 * Both directions of traffic ask it: intake before accepting a report, delivery before
 * posting a comment. Access ends the instant an installation is suspended or deleted or the
 * repository is dropped, and routing every caller through here is what makes that one
 * change rather than several.
 */
export async function activeRepository(
  installationId: number | undefined,
  repoId: number | undefined,
): Promise<ActiveRepository | null> {
  if (!installationId || !repoId) return null;

  const [row] = await db
    .select({
      connectedRepositoryId: connectedRepository.id,
      fullName: connectedRepository.fullName,
      targetProfileId: connectedRepository.targetProfileId,
    })
    .from(connectedRepository)
    .innerJoin(
      githubInstallation,
      eq(connectedRepository.installationId, githubInstallation.id),
    )
    .where(
      and(
        eq(connectedRepository.repoId, repoId),
        eq(connectedRepository.active, true),
        eq(githubInstallation.installationId, installationId),
        isNull(githubInstallation.suspendedAt),
        isNull(githubInstallation.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}
