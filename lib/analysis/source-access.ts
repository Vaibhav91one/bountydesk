import type { SourceReader } from "@/lib/build-onboarding/classify";
import type { withRepoReadToken } from "@/lib/github/repo-access";

/**
 * The read-only source access the analysis module shares: a bounded raw-file reader, the
 * repository tree listing, and the manifest list every review reads first. Every call is a GitHub
 * raw or API read; nothing is cloned or run. A private repository needs a contents:read token from
 * withRepoReadToken, whose lifetime the caller owns. An HTTP failure resolves to null or an empty
 * list; a network error rejects, and the callers catch it so a review degrades to less source.
 */

/** Tree entries over this size are never listed, so an oversize file is never fetched even if a
 *  server ignores the reader's Range header. */
export const MAX_BLOB_BYTES = 200_000;

/** The files whose presence and contents most reveal how a repo boots: what it is (README), whether it
 *  declares multiple services (compose), its ecosystem and scripts (the language manifests), how it is
 *  launched (Dockerfile, Procfile), and whether it needs credentials to start (.env.example, app.json). */
export const REVIEW_FILES = [
  "README.md",
  "readme.md",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "Dockerfile",
  "Procfile",
  "app.json",
  ".env.example",
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "composer.json",
  "Gemfile",
  "go.mod",
  "pom.xml",
];

/** The injectable token plumbing for a private repository's reads. Production passes nothing and gets
 *  the real lookup, mint and revoke from lib/github/repo-access. */
export type RepoReadDeps = Parameters<typeof withRepoReadToken>[2];

/** Read a file capped at maxBytes with a Range request, so a large README or lockfile does not download
 *  in full for a cheap pre-check. raw.githubusercontent.com honours Range and answers 206 with only the
 *  first bytes; a host that ignores it returns 200, which the slice still bounds. A private repository
 *  needs `token`, a contents:read token from withRepoReadToken whose lifetime the caller owns. */
export function boundedSourceReader(
  repoFullName: string,
  maxBytes: number,
  ref = "HEAD",
  signal?: AbortSignal,
  token?: string | null,
): SourceReader {
  return {
    async readFile(path: string) {
      const res = await fetch(`https://raw.githubusercontent.com/${repoFullName}/${ref}/${path}`, {
        headers: { Range: `bytes=0-${maxBytes - 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal,
      });
      if (res.status === 404) return null;
      if (!res.ok && res.status !== 206) return null;
      return (await res.text()).slice(0, maxBytes);
    },
  };
}

type TreeEntry = { path?: unknown; type?: unknown; size?: unknown };

export async function listBlobPaths(
  repoFullName: string,
  ref: string,
  signal: AbortSignal,
  token: string | null,
): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    {
      headers: { Accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal,
    },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { tree?: TreeEntry[] };
  return (body.tree ?? [])
    .filter(
      (e): e is { path: string; type: "blob"; size?: number } =>
        e.type === "blob" && typeof e.path === "string" && (typeof e.size !== "number" || e.size <= MAX_BLOB_BYTES),
    )
    .map((e) => e.path);
}
