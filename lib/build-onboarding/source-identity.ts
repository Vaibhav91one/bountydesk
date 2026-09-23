import { createHash } from "node:crypto";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_RE.test(value);
}

/** Resolve the server-owned repository to one immutable commit before customer code runs. */
export async function resolveRepositoryCommit(repoFullName: string, sourceRef: string): Promise<string> {
  if (isCommitSha(sourceRef)) return sourceRef.toLowerCase();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoFullName)) {
    throw new Error("cannot resolve a commit for an invalid repository name");
  }

  const url = new URL(`https://api.github.com/repos/${repoFullName}/commits`);
  if (sourceRef && !/^https?:\/\//.test(sourceRef)) url.searchParams.set("sha", sourceRef);
  url.searchParams.set("per_page", "1");
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "bountydesk-onboarding" },
  });
  if (!response.ok) throw new Error(`could not resolve ${repoFullName} source commit: GitHub returned ${response.status}`);
  const rows = (await response.json()) as Array<{ sha?: unknown }>;
  const sha = rows[0]?.sha;
  if (!isCommitSha(sha)) throw new Error(`GitHub returned no immutable commit for ${repoFullName}`);
  return sha.toLowerCase();
}

export type RepositoryLineage = { parent: string | null; source: string | null };

const FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Which repository this one was forked from, and the root of that chain, read anonymously like
 * the commit above (onboarding only reads public repositories). A report usually names the
 * upstream project, not the fork that was connected, and these names are how its link finds the
 * fork. Only well-formed names are kept, since the result is stored and later matched on.
 */
export async function resolveRepositoryLineage(
  repoFullName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepositoryLineage> {
  if (!FULL_NAME.test(repoFullName)) throw new Error("cannot read lineage for an invalid repository name");
  const response = await fetchImpl(`https://api.github.com/repos/${repoFullName}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "bountydesk-onboarding" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`could not read ${repoFullName}: GitHub returned ${response.status}`);
  const repo = (await response.json()) as {
    fork?: unknown;
    parent?: { full_name?: unknown };
    source?: { full_name?: unknown };
  };
  const name = (value: unknown) => (typeof value === "string" && FULL_NAME.test(value) ? value : null);
  if (repo.fork !== true) return { parent: null, source: null };
  return { parent: name(repo.parent?.full_name), source: name(repo.source?.full_name) };
}

export type SourceIdentityInput = {
  repoFullName: string;
  resolvedCommitSha: string;
  sourceArchiveDigest?: string;
  plan: unknown;
  /** The build base snapshot or image identity, when the strategy builds on one. */
  buildBaseSnapshot?: string;
  /** Every service artifact. Sorted before hashing, so service order is never a source of drift. */
  services?: Array<{ service: string; imageDigest: string; snapshotId: string }>;
  /** A single-image build's app digest, kept in identity so two builds of one source that produced
   *  different artifacts cannot share a digest. */
  imageDigest?: string;
  /** The commit baked into the image, re-proven from inside the booted sandbox. */
  buildMarker?: string;
};

/**
 * The canonical build identity. One function for the whole codebase, so the same source, plan and
 * artifacts always hash to the same digest and no two call sites can drift apart. Collections that
 * have no meaningful order are sorted before hashing.
 */
export function sourceIdentityDigest(input: SourceIdentityInput): string {
  if (!isCommitSha(input.resolvedCommitSha)) throw new Error("source identity requires a full commit SHA");
  const services = [...(input.services ?? [])].sort((a, b) => a.service.localeCompare(b.service));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ ...input, services }))
    .digest("hex")}`;
}
