/**
 * Recognising the repository host behind a link a reporter pasted, so the case file can show a
 * GitLab or Bitbucket reference as a labelled, safe link instead of letting it vanish.
 *
 * This is display only. Only a connected github.com repository can become a reproduction target
 * (targets come from GitHub App installs), so nothing here binds, reproduces or feeds scope. A
 * recognised link off GitHub is something a reviewer can open and read, never a target the report
 * can run against. Kept free of any database or Next import so a client bundle and a plain unit
 * test can both use it.
 */

export type RepoHost = "github" | "gitlab" | "bitbucket";

export const REPO_HOST_LABEL: Record<RepoHost, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

// The exact hostnames we recognise, mapped to the host key. A bare match on "gitlab" anywhere in a
// domain would let evil-gitlab.com through, so this is a whole-hostname lookup, not a substring one.
const HOST_DOMAIN: Record<string, RepoHost> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

const DOMAIN_OF: Record<RepoHost, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

// An owner or repo path segment worth linking. The same shape the reporter-handle and github link
// checks elsewhere accept, kept deliberately narrow so a path like /orgs or /search cannot be
// dressed up as owner/repo.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type RepoLink = {
  host: RepoHost;
  /** The host as a person reads it: GitHub, GitLab, Bitbucket. */
  label: string;
  /** owner/repo as it appears in the URL, for a short in-line label. */
  name: string;
  /** A normalised https link to the repository root, safe to render as an external link. */
  url: string;
};

/**
 * The repository a single link points at, or null when the value is not a recognised repository
 * URL.
 *
 * Null is the safe fallback the caller renders as plain text: a value that is not a URL at all, a
 * non-http scheme (javascript:, data:), a host we do not recognise, or a URL that does not name at
 * least owner and repo. A bare `owner/repo` is not enough on its own because there is no host to
 * label it with. The returned url is always rebuilt from the host and the two path segments, so a
 * query string, fragment or credentials in the original cannot ride along.
 */
export function recognizeRepoLink(value: string): RepoLink | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Accept a link written without a scheme ("github.com/o/r"), which is how reporters often paste
  // one, by giving it https before parsing. A genuine non-URL ("see the login form") fails to
  // parse and returns null rather than becoming a bogus link.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const host = HOST_DOMAIN[hostname];
  if (!host) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  // A clone URL ends .git, and sentence punctuation can cling to a pasted link; neither is part of
  // the name.
  const repo = segments[1].replace(/\.git$/i, "").replace(/\.+$/, "");
  if (!SEGMENT.test(owner) || !repo || !SEGMENT.test(repo)) return null;

  const name = `${owner}/${repo}`;
  return { host, label: REPO_HOST_LABEL[host], name, url: `https://${DOMAIN_OF[host]}/${name}` };
}

const MAX_TEXT = 64 * 1024;
const MAX_REFERENCES = 10;

// A recognised host URL sitting in free text. The character before it may not be part of a domain,
// so evil-gitlab.com and gitlab.com.attacker.io do not match, the same boundary guard the github
// link scan in lib/targets/suggest.ts uses.
const HOST_LINK =
  /(?:^|[^A-Za-z0-9.@-])((?:https?:\/\/)?(?:www\.)?(?:gitlab\.com|bitbucket\.org)\/[A-Za-z0-9][A-Za-z0-9._/-]*)/gi;

/**
 * The distinct non-GitHub repositories a report body links to, in order of first mention.
 *
 * GitHub links are left to lib/targets/suggest.ts, which can actually turn them into a target. This
 * is only the display side: a reviewer reading a report that points at GitLab or Bitbucket sees the
 * reference labelled and clickable, and sees that BountyDesk cannot reproduce against it. Deduped
 * by normalised url and capped, since the body is reporter-controlled.
 */
export function otherHostReferences(text: string): RepoLink[] {
  const found = new Map<string, RepoLink>();
  for (const match of text.slice(0, MAX_TEXT).matchAll(HOST_LINK)) {
    const link = recognizeRepoLink(match[1]);
    if (!link || link.host === "github") continue;
    if (!found.has(link.url)) found.set(link.url, link);
    if (found.size >= MAX_REFERENCES) break;
  }
  return [...found.values()];
}
