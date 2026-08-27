import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  inArray,
  isNotNull,
  isNull,
  sql,
  type Executor,
} from "@/lib/db";

/**
 * The App-lifecycle side of intake: who installed us, on which repositories, and whether
 * that access is still live.
 *
 * These handlers do not go through the jobs table: a suspension has to take effect the
 * moment the request arrives, not when a worker next picks up a queue row. They run inside
 * the caller's transaction, alongside the `lifecycle_delivery` row that makes a redelivery
 * a no-op, so a crash part-way through leaves neither the mutation nor the record of it.
 *
 * GitHub does not promise ordered delivery, and nothing in a webhook payload lets us
 * reconstruct the order, so none of this reasons about which event is newer. Every
 * transition is one-way in the safe direction instead:
 *
 *   - `deleted_at` is a tombstone and is never cleared. A real reinstall arrives under a new
 *     installation id, so nothing legitimate needs the old row back.
 *   - Only `unsuspend` clears `suspended_at`, and only while the installation is alive.
 *   - The installation grant (`active`) and the repository's archive state (`archived_at`)
 *     are separate columns, so restoring one cannot restore the other.
 *   - Every revocation clears `target_profile_id`, and no webhook ever sets it. Restoring
 *     intake therefore always takes an operator action, which is the one signal we can
 *     order, so a stale positive delivery cannot re-open intake by itself.
 */

/** The subset of GitHub's payloads we read. Anything not named here is ignored. */
type InstallationPayload = {
  id: number;
  account?: { login?: string; id?: number; type?: string } | null;
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
 * The upsert never touches `suspended_at` or `deleted_at`. A `created` that arrives after
 * the suspension or uninstall it precedes therefore lands on a row that stays revoked, which
 * is why those two columns move only in the handler that owns them.
 */
async function upsertInstallation(
  tx: Executor,
  installation: InstallationPayload,
): Promise<string> {
  const values = {
    installationId: installation.id,
    accountLogin: installation.account?.login ?? "",
    accountId: installation.account?.id ?? 0,
    // GitHub sends "User" or "Organization". Anything else, including absent, stays null:
    // the settings link falls back rather than guessing a path that 404s.
    accountType:
      installation.account?.type === "User" || installation.account?.type === "Organization"
        ? installation.account.type
        : null,
  };

  const [row] = await tx
    .insert(githubInstallation)
    .values(values)
    .onConflictDoUpdate({
      target: githubInstallation.installationId,
      set: {
        accountLogin: values.accountLogin,
        accountId: values.accountId,
        // Only overwrite with a value GitHub actually sent, so a payload without an account
        // type does not erase one we already learned.
        ...(values.accountType ? { accountType: values.accountType } : {}),
        updatedAt: new Date(),
      },
    })
    .returning({ id: githubInstallation.id });

  return row.id;
}

/**
 * Record the installation grant.
 *
 * A repository that comes back after being removed comes back unconfigured: `active` says
 * the account has selected it, `target_profile_id` stays null until an operator binds a
 * target, and intake needs both.
 */
async function grantRepositories(
  tx: Executor,
  installationRowId: string,
  repositories: RepositoryPayload[],
): Promise<void> {
  if (repositories.length === 0) return;

  await tx
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

/**
 * Withdraw the grant and the operator's configuration together.
 *
 * Clearing `target_profile_id` is what makes the revocation survive a stale positive
 * delivery: an `installation_repositories.added` arriving late restores the grant, but
 * intake still refuses the repository until an operator binds a target again.
 */
async function revokeRepositories(tx: Executor, repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;

  await tx
    .update(connectedRepository)
    .set({ active: false, targetProfileId: null, updatedAt: new Date() })
    .where(inArray(connectedRepository.repoId, repoIds));
}

/** Withdraw configuration from every repository of one installation. */
async function unconfigureInstallationRepositories(
  tx: Executor,
  installationRowId: string,
): Promise<void> {
  await tx
    .update(connectedRepository)
    .set({ targetProfileId: null, updatedAt: new Date() })
    .where(eq(connectedRepository.installationId, installationRowId));
}

async function handleInstallation(tx: Executor, payload: LifecyclePayload): Promise<void> {
  const installation = payload.installation;
  if (!installation) return;

  switch (payload.action) {
    case "created":
    case "new_permissions_accepted": {
      const rowId = await upsertInstallation(tx, installation);
      await grantRepositories(tx, rowId, payload.repositories ?? []);
      return;
    }

    case "suspend": {
      // Upsert rather than update: a suspension that overtakes the `created` it follows must
      // still leave a row saying the installation is suspended, or the late `created` would
      // land on an empty table and look like a fresh, live install.
      const rowId = await upsertInstallation(tx, installation);
      await tx
        .update(githubInstallation)
        .set({ suspendedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallation.id, rowId));
      await unconfigureInstallationRepositories(tx, rowId);
      return;
    }

    case "unsuspend": {
      const rowId = await upsertInstallation(tx, installation);
      // A tombstoned installation stays dead. Only the suspension mark lifts here, and the
      // repositories stay unconfigured until an operator binds their targets again.
      await tx
        .update(githubInstallation)
        .set({ suspendedAt: null, updatedAt: new Date() })
        .where(and(eq(githubInstallation.id, rowId), isNull(githubInstallation.deletedAt)));
      return;
    }

    case "deleted": {
      const rowId = await upsertInstallation(tx, installation);
      await tx
        .update(githubInstallation)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(githubInstallation.id, rowId), isNull(githubInstallation.deletedAt)));
      await unconfigureInstallationRepositories(tx, rowId);
      return;
    }
  }
}

async function handleInstallationRepositories(
  tx: Executor,
  payload: LifecyclePayload,
): Promise<void> {
  const installation = payload.installation;
  if (!installation) return;

  const rowId = await upsertInstallation(tx, installation);

  await grantRepositories(tx, rowId, payload.repositories_added ?? []);
  await revokeRepositories(tx, (payload.repositories_removed ?? []).map((r) => r.id));
}

async function handleRepository(tx: Executor, payload: LifecyclePayload): Promise<void> {
  const repository = payload.repository;
  if (!repository) return;

  switch (payload.action) {
    case "renamed":
      await tx
        .update(connectedRepository)
        .set({ fullName: repository.full_name, updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, repository.id));
      return;

    case "transferred":
      // The repository now belongs to an owner our installation was never granted against.
      // Record the new name and withdraw everything else.
      await tx
        .update(connectedRepository)
        .set({ fullName: repository.full_name, updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, repository.id));
      await revokeRepositories(tx, [repository.id]);
      return;

    case "deleted":
      await revokeRepositories(tx, [repository.id]);
      return;

    case "archived":
      await tx
        .update(connectedRepository)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, repository.id));
      return;

    case "unarchived":
      // Clears the archive mark and nothing else. A repository removed from the installation,
      // or one whose target binding was withdrawn, stays out of intake.
      await tx
        .update(connectedRepository)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(connectedRepository.repoId, repository.id));
      return;
  }

  // Visibility changes (privatized, publicized) are deliberately not handled. A GitHub App
  // installation stays granted across them, and treating "went private" as a revocation
  // would strand exactly the repositories most likely to be filing security reports.
}

export async function applyLifecycle(
  tx: Executor,
  event: string,
  payload: LifecyclePayload,
): Promise<void> {
  switch (event) {
    case "installation":
      return handleInstallation(tx, payload);
    case "installation_repositories":
      return handleInstallationRepositories(tx, payload);
    case "repository":
      return handleRepository(tx, payload);
  }
}

export type ActiveRepository = {
  connectedRepositoryId: string;
  repoId: number;
  fullName: string;
  /** Never null: a repository with no bound target is not admissible. */
  targetProfileId: string;
};

/**
 * The one place that answers "may we still act on this repository?".
 *
 * Both directions of traffic ask it: intake before accepting a report, delivery before
 * posting a comment. Four things have to hold, and they come from different places on
 * purpose. The installation must be live and unsuspended, and the account must still have
 * the repository selected: that is GitHub's side. The repository must not be archived. And
 * an operator must have bound a target profile to it, which is the server-held scope every
 * capability is taken from. An agent never supplies a target, and neither does a webhook.
 *
 * `lock` takes FOR SHARE on the rows the answer rests on. A caller that acts on the result
 * inside the same transaction needs it: without the lock a revocation can commit between the
 * check and the write, and the work is admitted after access was withdrawn. The lifecycle
 * handlers update those same rows, so they queue behind the lock instead of racing it.
 */
export async function activeRepository(
  installationId: number | undefined,
  repoId: number | undefined,
  { tx = db, lock = false }: { tx?: Executor; lock?: boolean } = {},
): Promise<ActiveRepository | null> {
  if (!installationId || !repoId) return null;

  const query = tx
    .select({
      connectedRepositoryId: connectedRepository.id,
      repoId: connectedRepository.repoId,
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
        isNull(connectedRepository.archivedAt),
        isNotNull(connectedRepository.targetProfileId),
        eq(githubInstallation.installationId, installationId),
        isNull(githubInstallation.suspendedAt),
        isNull(githubInstallation.deletedAt),
      ),
    )
    .limit(1);

  const [row] = await (lock ? query.for("share") : query);
  if (!row?.targetProfileId) return null;

  return { ...row, targetProfileId: row.targetProfileId };
}
