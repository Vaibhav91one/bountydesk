import { isIP } from "node:net";

import { isCommitSha } from "@/lib/build-onboarding/source-identity";

/**
 * A public git clone URL and commit from an outside submitter, validated for the build sandbox.
 *
 * The URL is untrusted, and its host becomes the one extra entry in the build sandbox's egress
 * allow-list, so everything is refused that is not a plain https URL to a public DNS name: no
 * credentials, no query, no port, no IP literal, no single-label or internal-looking host. The
 * commit must be a full 40-character SHA; a branch, tag or HEAD is mutable and is refused here so
 * the server needs no network call to resolve it. The build re-reads HEAD and checks it equals the
 * SHA. A public name that resolves to a private address is not detectable without a lookup, and is
 * contained by the sandbox having no route to anything but the allow-listed domain.
 */

export const MAX_GIT_URL_CHARS = 300;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTERNAL_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa"];

export type GitSource = { cloneUrl: string; host: string; commitSha: string };

export function parseGitSource(
  rawUrl: string,
  rawCommit: string,
): { ok: true; source: GitSource } | { ok: false; reason: string } {
  const text = rawUrl.trim();
  if (!text || text.length > MAX_GIT_URL_CHARS) {
    return { ok: false, reason: `the git URL must be 1 to ${MAX_GIT_URL_CHARS} characters` };
  }
  const commit = rawCommit.trim();
  if (!isCommitSha(commit)) {
    return { ok: false, reason: "the git commit must be a full 40-character SHA, not a branch, tag or HEAD" };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "the git URL is not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "the git URL must use https" };
  if (url.username || url.password) return { ok: false, reason: "the git URL must not contain credentials" };
  if (url.port) return { ok: false, reason: "the git URL must use the default https port" };
  if (url.search || url.hash) return { ok: false, reason: "the git URL must not have a query or fragment" };

  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  const tld = labels.at(-1) ?? "";
  if (
    isIP(host) ||
    host.includes(":") ||
    labels.length < 2 ||
    !labels.every((label) => LABEL.test(label)) ||
    !/^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(tld) ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return { ok: false, reason: "the git host must be a public domain name" };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || segments.length > 10 || !segments.every((s) => PATH_SEGMENT.test(s) && !s.includes(".."))) {
    return { ok: false, reason: "the git URL must name a repository path such as /group/project" };
  }

  return { ok: true, source: { cloneUrl: `https://${host}/${segments.join("/")}`, host, commitSha: commit.toLowerCase() } };
}
