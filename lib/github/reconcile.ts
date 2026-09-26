import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  inArray,
  isNull,
} from "@/lib/db";

import {
  mintInstallationAccessToken,
  signAppJwt,
  type InstallationToken,
} from "./app-auth";

/**
 * The reconcile backstop for GitHub access revocation.
 *
 * The lifecycle webhooks in `lifecycle.ts` are the fast path: a suspend, uninstall, or removed
 * repository takes effect the moment the delivery arrives. But GitHub does not promise delivery,
 * and a dropped or out-of-order event leaves a grant marked active in our tables that GitHub no
 * longer honours. No verdict escapes on a stale grant (delivery re-checks and the token mint now
 * refuses a 403/404), but a stale-active repository still burns sandbox budget on intake. This
 * closes that window by asking GitHub for the current truth and revoking anything the DB still
 * shows as live that GitHub does not.
 *
 * One-way-safe, exactly like the webhooks: reconcile can only revoke. It never clears a tombstone,
 * never lifts a suspension, and never restores a target profile. Restoring access is always an
 * operator action, the one signal we can order, so a reconcile pass cannot re-open intake by
 * itself even if it races a real reinstall. It does copy two facts from GitHub onto live rows, the
 * installation's Contents permission and each repository's visibility (syncAccessFacts), but those
 * restore nothing: they only feed the private-repository policy.
 *
 * Fail safe on every read. A reconcile failure must never revoke: if the truth from GitHub did
 * not fully arrive (a failed page, a rate limit, a 5xx), we leave state as it is and record the
 * error. Revoking on a read we could not complete would strand a live grant on a transient blip.
 */

const GITHUB_API = "https://api.github.com";
const PER_PAGE = 100;
// GitHub caps App installations far below this; the guard only stops a malformed Link-less
// response (a server always returning a full page) from looping forever.
const MAX_PAGES = 100;

/** The slice of GitHub's installation object reconcile reads. `contents` is the granted Contents
 *  permission ("none" when absent from a permissions object), undefined when GitHub sent none. */
type LiveInstallation = { id: number; suspended: boolean; contents?: string };

/** One repository of an installation. `private` is undefined when GitHub did not say. */
type LiveRepo = { id: number; private?: boolean };

export type ReconcileSummary = {
  installationsChecked: number;
  installationsRevoked: number;
  repositoriesRevoked: number;
  /** Non-fatal read failures. A non-empty list means some grants were left unchecked on purpose. */
  errors: string[];
};

export type ReconcileDeps = {
  fetchImpl?: typeof fetch;
  /** Mints a whole-installation token for listing its repositories. Injected for tests. */
  mintToken?: (
    installationId: number,
    opts?: { signal?: AbortSignal },
  ) => Promise<InstallationToken>;
  signal?: AbortSignal;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${signAppJwt()}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal });
  if (!response.ok) {
    // The body is GitHub's own complaint; it never echoes the Authorization header we sent.
    const text = await response.text();
    throw new Error(`GitHub ${url} failed with ${response.status}: ${text}`);
  }
  return response.json();
}

/**
 * Every installation GitHub currently reports for this App, across all pages. Throws on any page
 * that does not answer, so a partial list can never be mistaken for "these installations are gone".
 */
async function fetchLiveInstallations(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<LiveInstallation[]> {
  const out: LiveInstallation[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await getJson(
      fetchImpl,
      `${GITHUB_API}/app/installations?per_page=${PER_PAGE}&page=${page}`,
      appHeaders(),
      signal,
    );
    if (!Array.isArray(json)) {
      throw new Error("GitHub returned a malformed installations list");
    }
    for (const item of json) {
      if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "number") {
        const suspendedAt = (item as { suspended_at?: unknown }).suspended_at;
        const permissions = (item as { permissions?: unknown }).permissions;
        const contents =
          permissions && typeof permissions === "object"
            ? (permissions as { contents?: unknown }).contents
            : undefined;
        out.push({
          id: (item as { id: number }).id,
          suspended: typeof suspendedAt === "string",
          ...(permissions && typeof permissions === "object"
            ? { contents: typeof contents === "string" ? contents : "none" }
            : {}),
        });
      }
    }
    if (json.length < PER_PAGE) break;
  }
  return out;
}

/**
 * Every repository currently in one installation, across all pages, read with a whole-installation
 * token. Throws on any page that does not answer, for the same reason as above: a short read must
 * not look like repositories were removed.
 */
async function fetchLiveRepos(
  installationId: number,
  mintToken: NonNullable<ReconcileDeps["mintToken"]>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<LiveRepo[]> {
  const { token } = await mintToken(installationId, { signal });
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  const repos: LiveRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await getJson(
      fetchImpl,
      `${GITHUB_API}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      headers,
      signal,
    );
    const pageRepos = (json as { repositories?: unknown })?.repositories;
    if (!Array.isArray(pageRepos)) {
      throw new Error("GitHub returned a malformed installation repositories list");
    }
    for (const repo of pageRepos) {
      if (repo && typeof repo === "object" && typeof (repo as { id?: unknown }).id === "number") {
        const isPrivate = (repo as { private?: unknown }).private;
        repos.push({
          id: (repo as { id: number }).id,
          ...(typeof isPrivate === "boolean" ? { private: isPrivate } : {}),
        });
      }
    }
    if (pageRepos.length < PER_PAGE) break;
  }
  return repos;
}

/**
 * Copy GitHub's current Contents permission and repository visibility onto our rows. This is the
 * backfill for rows written before either was stored, and the catch-up for a permission change that
 * sent no webhook. It is not a grant: neither column restores access, a target binding or intake.
 * They only feed the private-repository policy, which then reads what GitHub says right now.
 */
async function syncAccessFacts(
  installationRowId: string,
  contents: string | undefined,
  liveRepos: LiveRepo[],
): Promise<void> {
  if (contents !== undefined) {
    await db
      .update(githubInstallation)
      .set({ contentsPermission: contents, updatedAt: new Date() })
      .where(eq(githubInstallation.id, installationRowId));
  }
  for (const isPrivate of [true, false]) {
    const ids = liveRepos.filter((r) => r.private === isPrivate).map((r) => r.id);
    if (ids.length === 0) continue;
    await db
      .update(connectedRepository)
      .set({ isPrivate, updatedAt: new Date() })
      .where(
        and(
          eq(connectedRepository.installationId, installationRowId),
          inArray(connectedRepository.repoId, ids),
        ),
      );
  }
}

/**
 * Tombstone an installation GitHub no longer lists, matching the webhook `deleted` path: set
 * `deleted_at` (only if unset, so a real timestamp is never overwritten) and clear every
 * repository's target binding. The `activeRepository` gate joins on `deleted_at IS NULL`, so this
 * alone stops intake and delivery for every repository of the installation.
 */
async function tombstoneInstallation(installationRowId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(githubInstallation)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(githubInstallation.id, installationRowId), isNull(githubInstallation.deletedAt)));
    await tx
      .update(connectedRepository)
      .set({ targetProfileId: null, updatedAt: new Date() })
      .where(eq(connectedRepository.installationId, installationRowId));
  });
}

/**
 * Mark an installation suspended at GitHub, matching the webhook `suspend` path: set
 * `suspended_at` (only if unset) and clear every repository's target binding.
 */
async function suspendInstallation(installationRowId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(githubInstallation)
      .set({ suspendedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(githubInstallation.id, installationRowId), isNull(githubInstallation.suspendedAt)));
    await tx
      .update(connectedRepository)
      .set({ targetProfileId: null, updatedAt: new Date() })
      .where(eq(connectedRepository.installationId, installationRowId));
  });
}

/** Withdraw grant and configuration for specific repositories, matching `revokeRepositories`. */
async function revokeRepos(repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await db
    .update(connectedRepository)
    .set({ active: false, targetProfileId: null, updatedAt: new Date() })
    .where(inArray(connectedRepository.repoId, repoIds));
}

export async function reconcileGitHubAccess(
  deps: ReconcileDeps = {},
): Promise<ReconcileSummary> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const mintToken = deps.mintToken ?? mintInstallationAccessToken;
  const summary: ReconcileSummary = {
    installationsChecked: 0,
    installationsRevoked: 0,
    repositoriesRevoked: 0,
    errors: [],
  };

  // The authoritative truth. If this read fails, do nothing: an absent installation here would
  // otherwise be read as uninstalled and wrongly tombstoned.
  let live: LiveInstallation[];
  try {
    live = await fetchLiveInstallations(fetchImpl, deps.signal);
  } catch (err) {
    summary.errors.push(`list installations: ${errorMessage(err)}`);
    return summary;
  }
  const liveById = new Map(live.map((i) => [i.id, i]));

  // Only installations the DB still considers alive need checking; a tombstoned one is already
  // terminal and one-way-safe forbids reviving it.
  const rows = await db
    .select({
      id: githubInstallation.id,
      installationId: githubInstallation.installationId,
      suspendedAt: githubInstallation.suspendedAt,
    })
    .from(githubInstallation)
    .where(isNull(githubInstallation.deletedAt));

  for (const row of rows) {
    if (deps.signal?.aborted) break;
    summary.installationsChecked += 1;

    const gh = liveById.get(row.installationId);
    if (!gh) {
      await tombstoneInstallation(row.id);
      summary.installationsRevoked += 1;
      continue;
    }

    if (gh.suspended) {
      // Suspended at GitHub. Record it if the DB has not caught up; either way a suspended
      // installation gets no repository reconcile (its targets are cleared and no token is minted).
      if (!row.suspendedAt) {
        await suspendInstallation(row.id);
        summary.installationsRevoked += 1;
      }
      continue;
    }

    // GitHub shows the installation live and unsuspended. If the DB still marks it suspended, leave
    // that alone: one-way-safe means only an operator lifts a suspension, never reconcile.
    if (row.suspendedAt) continue;

    // Both sides live: reconcile the repository set. A failure here withdraws nothing.
    let liveRepos: LiveRepo[];
    try {
      liveRepos = await fetchLiveRepos(row.installationId, mintToken, fetchImpl, deps.signal);
    } catch (err) {
      summary.errors.push(`list repositories for installation ${row.installationId}: ${errorMessage(err)}`);
      continue;
    }
    await syncAccessFacts(row.id, gh.contents, liveRepos);
    const liveSet = new Set(liveRepos.map((r) => r.id));

    const activeRepos = await db
      .select({ repoId: connectedRepository.repoId })
      .from(connectedRepository)
      .where(
        and(
          eq(connectedRepository.installationId, row.id),
          eq(connectedRepository.active, true),
        ),
      );
    const gone = activeRepos.map((r) => r.repoId).filter((id) => !liveSet.has(id));
    if (gone.length > 0) {
      await revokeRepos(gone);
      summary.repositoriesRevoked += gone.length;
    }
  }

  return summary;
}
