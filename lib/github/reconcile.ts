import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  inArray,
  isNull,
  report,
  verdict,
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
 * itself even if it races a real reinstall. It does copy facts from GitHub onto live rows, the
 * installation's Contents and repository advisories permissions and each repository's visibility
 * (syncAccessFacts), but those restore nothing: they feed the private-repository policy and the
 * email-to-advisory routing choice.
 *
 * Fail safe on every read. A reconcile failure must never revoke: if the truth from GitHub did
 * not fully arrive (a failed page, a rate limit, a 5xx), we leave state as it is and record the
 * error. Revoking on a read we could not complete would strand a live grant on a transient blip.
 */

const GITHUB_API = "https://api.github.com";

// Minimum elapsed between polls of the same repository. The unauthenticated GitHub API
// rate limit is 60 requests/hour per IP; at the reconcile cadence this keeps us well under
// it even with many public repos.
const PUSH_POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Tracks per-repo last-poll time in the worker process. Reset between reconcile
 * ticks is not needed: the worker process restarts fresh, and the 15-minute window
 * naturally ages out stale entries. Exported for test visibility.
 */
const lastPolledAt = new Map<number, number>();
const PER_PAGE = 100;
// GitHub caps App installations far below this; the guard only stops a malformed Link-less
// response (a server always returning a full page) from looping forever.
const MAX_PAGES = 100;

/** The slice of GitHub's installation object reconcile reads. `contents` is the granted Contents
 *  permission ("none" when absent from a permissions object), undefined when GitHub sent none. */
type LiveInstallation = {
  id: number;
  suspended: boolean;
  contents?: string;
  /** The granted repository_advisories permission, read the same way as `contents`. */
  advisories?: string;
};

/** One repository of an installation. `private` is undefined when GitHub did not say. */
type LiveRepo = { id: number; private?: boolean };

export type ReconcileSummary = {
  installationsChecked: number;
  installationsRevoked: number;
  repositoriesRevoked: number;
  /** Non-fatal read failures. A non-empty list means some grants were left unchecked on purpose. */
  errors: string[];
  /** How many default-branch SHAs were checked against GitHub. */
  pushSuggestionsChecked: number;
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
        const granted =
          permissions && typeof permissions === "object"
            ? (permissions as { contents?: unknown; repository_advisories?: unknown })
            : undefined;
        out.push({
          id: (item as { id: number }).id,
          suspended: typeof suspendedAt === "string",
          ...(granted
            ? {
                contents: typeof granted.contents === "string" ? granted.contents : "none",
                advisories:
                  typeof granted.repository_advisories === "string"
                    ? granted.repository_advisories
                    : "none",
              }
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
 * Copy GitHub's current Contents and repository advisories permissions and repository visibility
 * onto our rows. This is the backfill for rows written before these were stored, and the catch-up
 * for a permission change that sent no webhook. It is not a grant: none of these columns restores
 * access, a target binding or intake. They feed the private-repository policy and the choice of
 * advisory over email reply, both of which then read what GitHub says right now.
 */
async function syncAccessFacts(
  installationRowId: string,
  { contents, advisories }: Pick<LiveInstallation, "contents" | "advisories">,
  liveRepos: LiveRepo[],
): Promise<void> {
  if (contents !== undefined || advisories !== undefined) {
    await db
      .update(githubInstallation)
      .set({
        ...(contents !== undefined ? { contentsPermission: contents } : {}),
        ...(advisories !== undefined ? { repositoryAdvisoriesPermission: advisories } : {}),
        updatedAt: new Date(),
      })
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
    pushSuggestionsChecked: 0,
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
    await syncAccessFacts(row.id, gh, liveRepos);
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

/**
 * Fetch the SHA at the head of a repository's default branch from the public GitHub REST
 * API, unauthenticated.
 *
 * Uses a single call: GET /repos/{owner}/{repo}/commits/HEAD with the "application/vnd.github.sha"
 * accept header, which returns the default-branch head SHA for any public repository without
 * Contents read. The branch name is taken from the stored `latestPushedBranch` column when
 * present; otherwise we also fetch it from GET /repos/{owner}/{repo}.
 *
 * Returns null on any error, including 404 (private repo) or network failure. The caller
 * preserves the old value on null. `rateLimited` is set to true when the response indicates
 * the GitHub rate limit is exhausted, so the caller can stop polling for the rest of this tick.
 */
async function fetchDefaultBranchHead(
  fetchImpl: typeof fetch,
  owner: string,
  repo: string,
  knownBranch: string | null | undefined,
  signal?: AbortSignal,
): Promise<{ branch: string; sha: string; rateLimited: boolean } | null> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  let rateLimited = false;

  // If we don't know the default branch yet, fetch it from the repo endpoint.
  let branch = knownBranch;
  if (!branch) {
    const repoUrl = `${GITHUB_API}/repos/${encodedOwner}/${encodedRepo}`;
    try {
      const repoResponse = await fetchImpl(repoUrl, {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        signal,
      });
      rateLimited = checkRateLimit(repoResponse);
      if (!repoResponse.ok) {
        // If rate-limited, report it so the caller stops polling for this tick.
        if (rateLimited) return { branch: "", sha: "", rateLimited };
        return null;
      }
      const repo = await repoResponse.json() as { default_branch?: string };
      branch = repo.default_branch;
      if (!branch) return null;
    } catch {
      return null;
    }
  }

  const shaUrl = `${GITHUB_API}/repos/${encodedOwner}/${encodedRepo}/commits/${encodeURIComponent(branch)}`;
  try {
    const shaResponse = await fetchImpl(shaUrl, {
      headers: { accept: "application/vnd.github.sha", "x-github-api-version": "2022-11-28" },
      signal,
    });
    rateLimited = checkRateLimit(shaResponse);
    if (!shaResponse.ok) return rateLimited ? { branch, sha: "", rateLimited } : null;
    const sha = (await shaResponse.text()).trim();
    return sha ? { branch, sha, rateLimited } : null;
  } catch {
    return null;
  }
}

/** Returns true when the response indicates the unauthenticated GitHub rate limit is exhausted. */
function checkRateLimit(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

/**
 * Poll the default branch head for every public connected repository that has at least one
 * REPRODUCED report, and store the latest commit SHA and branch name on connected_repository.
 *
 * SUGGEST ONLY: this never starts a retest. It just keeps `latest_pushed_commit_sha` fresh so
 * `readPushSuggestion` can surface a one-click suggestion when a pushed commit is ahead of the
 * pinned commit. Private repositories are skipped: an unauthenticated public SHA fetch is all
 * this needs, and private repos have no grant-free path. Rate-limit friendly: each repo is
 * fetched at most once per tick, and only if its last poll is older than PUSH_POLL_INTERVAL_MS.
 * On any fetch error the old value is kept. If GitHub returns 403/429 with rate-limit
 * remaining: 0, polling stops for the rest of this tick.
 */
export async function reconcilePushSuggestions(
  deps: ReconcileDeps = {},
): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = Date.now();

  // Only public repositories with a live grant and at least one REPRODUCED verdict.
  // DISTINCT so a repo with multiple REPRODUCED verdicts is polled once.
  const candidates = await db
    .selectDistinct({
      repoId: connectedRepository.repoId,
      fullName: connectedRepository.fullName,
      knownBranch: connectedRepository.latestPushedBranch,
    })
    .from(connectedRepository)
    .innerJoin(githubInstallation, eq(githubInstallation.id, connectedRepository.installationId))
    .innerJoin(report, eq(report.connectedRepositoryId, connectedRepository.id))
    .innerJoin(verdict, eq(verdict.reportId, report.id))
    .where(
      and(
        eq(connectedRepository.isPrivate, false),
        eq(connectedRepository.active, true),
        isNull(githubInstallation.deletedAt),
        eq(verdict.outcome, "REPRODUCED"),
      ),
    );

  let checked = 0;
  for (const repo of candidates) {
    if (deps.signal?.aborted) break;
    if (!repo.fullName) continue;

    // Skip if this repo was polled recently. The in-memory map is process-scoped;
    // it resets on worker restart, which is safe (worst case: one extra poll).
    const lastPoll = lastPolledAt.get(repo.repoId);
    if (lastPoll !== undefined && now - lastPoll < PUSH_POLL_INTERVAL_MS) continue;
    lastPolledAt.set(repo.repoId, now);

    const [owner, ...rest] = repo.fullName.split("/");
    const repoName = rest.join("/");
    const result = await fetchDefaultBranchHead(fetchImpl, owner, repoName, repo.knownBranch, deps.signal);
    if (result?.rateLimited) {
      console.warn(`github reconcile: rate limit exhausted, stopping push suggestion polling`);
      break;
    }
    if (!result) continue;

    await db
      .update(connectedRepository)
      .set({
        latestPushedCommitSha: result.sha.toLowerCase(),
        latestPushedBranch: result.branch,
        updatedAt: new Date(),
      })
      .where(eq(connectedRepository.repoId, repo.repoId));
    checked += 1;
  }
  return checked;
}

/** Exposed for tests to reset the in-process poll cache between tests. */
export function __clearPollCache(): void {
  lastPolledAt.clear();
}

