import type { Executor } from "@/lib/db";

import { GitHubApiError, mintInstallationToken } from "./app-auth";

/**
 * The private-repository policy. A public repository is read and cloned anonymously and needs no
 * permission beyond Metadata. A private one can only be read with an installation token, and only
 * if the account granted the App Contents: read. Without it the repository is still accepted and
 * triaged, but nothing clones, builds or reproduces it: reproduction resolves ANALYSIS_ONLY with
 * POLICY_REFUSED, and onboarding refuses with the same reason.
 */

export function hasContentsRead(permission: string | null | undefined): boolean {
  return permission === "read" || permission === "write";
}

/** True when the repository is known to be private and the installation lacks Contents: read.
 *  An unknown visibility (null) is not refused: it is never given a token either, so a repository
 *  that is really private just fails its anonymous read. */
export function privateRepoPolicyRefused(access: {
  isPrivate?: boolean | null;
  contentsPermission?: string | null;
}): boolean {
  return access.isPrivate === true && !hasContentsRead(access.contentsPermission);
}

export class PolicyRefusedError extends Error {
  constructor(repoFullName: string) {
    super(
      `POLICY_REFUSED: ${repoFullName} is private and the GitHub App installation has not been granted ` +
        "Contents: read, so it cannot be cloned or reproduced. Add Contents: read to the App and accept it " +
        "on the installation, then retry.",
    );
    this.name = "PolicyRefusedError";
  }
}

export type RepoAccess = {
  repoId: number;
  installationId: number;
  isPrivate: boolean | null;
  contentsPermission: string | null;
};

/**
 * The live grant for a connected repository by name, or null when it is not connected right now.
 * The database is imported lazily so the pure helpers below load in the build driver and its tests
 * without opening a connection pool.
 */
export async function loadRepoAccess(repoFullName: string, tx?: Executor): Promise<RepoAccess | null> {
  const { and, connectedRepository, db, eq, githubInstallation, isNull } = await import("@/lib/db");
  const [row] = await (tx ?? db)
    .select({
      repoId: connectedRepository.repoId,
      installationId: githubInstallation.installationId,
      isPrivate: connectedRepository.isPrivate,
      contentsPermission: githubInstallation.contentsPermission,
    })
    .from(connectedRepository)
    .innerJoin(githubInstallation, eq(connectedRepository.installationId, githubInstallation.id))
    .where(
      and(
        eq(connectedRepository.fullName, repoFullName),
        eq(connectedRepository.active, true),
        isNull(githubInstallation.suspendedAt),
        isNull(githubInstallation.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type RepoReadTokenDeps = {
  loadAccess?: (repoFullName: string) => Promise<RepoAccess | null>;
  mint?: typeof mintInstallationToken;
};

/**
 * A short-lived token that can read one private repository, or null for a repository that is read
 * anonymously. Throws PolicyRefusedError for a private repository without Contents: read.
 *
 * The token is scoped to the single repository and narrowed to contents:read, so it cannot write
 * anything or reach a sibling repository of the same installation. Asking for contents:read also
 * makes GitHub the final word on the grant: a stored permission that has gone stale is refused with
 * a 422, which maps to the same POLICY_REFUSED.
 */
export async function repoReadToken(repoFullName: string, deps: RepoReadTokenDeps = {}): Promise<string | null> {
  const access = await (deps.loadAccess ?? loadRepoAccess)(repoFullName);
  if (!access || access.isPrivate !== true) return null;
  if (privateRepoPolicyRefused(access)) throw new PolicyRefusedError(repoFullName);
  try {
    const { token } = await (deps.mint ?? mintInstallationToken)(access.installationId, access.repoId, {
      permissions: { contents: "read" },
    });
    return token;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 422) throw new PolicyRefusedError(repoFullName);
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The shell command that clones `cloneUrl` into `dest` without checking out, authenticated when a
 * token is given.
 *
 * The token never goes into the URL, so it is not written to the clone's .git/config where the
 * repository's own build steps could read it. It reaches git through an environment variable read
 * by a credential helper that is scoped to github.com and only answers `get`, so git neither stores
 * it nor offers it to another host. It still appears in this command's text; callers keep that text
 * out of logs and errors (see redactToken) and revoke the token right after the clone.
 */
export function gitCloneCommand(cloneUrl: string, dest: string, token: string | null): string {
  const clone = `clone --no-checkout ${shellQuote(cloneUrl)} ${shellQuote(dest)}`;
  if (!token) return `git ${clone}`;
  const helper =
    'credential.https://github.com.helper=!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$BD_GIT_TOKEN"; }; f';
  return `BD_GIT_TOKEN=${shellQuote(token)} GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c ${shellQuote(helper)} ${clone}`;
}

/** Strip a token from text that may be surfaced (an error message, a stored failure reason). */
export function redactToken(text: string, token: string | null): string {
  return token ? text.split(token).join("[redacted]") : text;
}
