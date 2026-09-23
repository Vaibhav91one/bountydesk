/**
 * Repository security advisory primitives. Like comment.ts, these take an already-minted
 * installation token and never mint one. The App needs "Repository security advisories: write".
 */

const GITHUB_TIMEOUT_MS = 10_000;

/** A non-2xx from GitHub, with the status kept so the caller can tell refusal from outage. */
export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Advisory = { ghsaId: string; htmlUrl: string };

function requestInit(token: string, signal?: AbortSignal): RequestInit {
  const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  return {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
}

function advisoriesUrl(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`repository full name must be owner/repo, got ${fullName}`);
  }
  return `https://api.github.com/repos/${parts.map(encodeURIComponent).join("/")}/security-advisories`;
}

async function readJson(response: Response, action: string): Promise<unknown> {
  if (!response.ok) {
    // GitHub's own error text; the token never appears in it.
    throw new GitHubRequestError(
      response.status,
      `GitHub ${action} request failed with ${response.status}: ${await response.text()}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`GitHub returned a malformed ${action} response`);
  }
}

function toAdvisory(item: unknown, action: string): Advisory {
  if (
    typeof item !== "object" ||
    item === null ||
    !("ghsa_id" in item) ||
    typeof item.ghsa_id !== "string" ||
    !("html_url" in item) ||
    typeof item.html_url !== "string" ||
    !item.html_url.startsWith("https://github.com/")
  ) {
    throw new Error(`GitHub returned a malformed ${action} response`);
  }
  return { ghsaId: item.ghsa_id, htmlUrl: item.html_url };
}

/**
 * Open a draft advisory. A draft is visible only to the repository's admins and security
 * managers, so nothing is disclosed until the owner publishes it.
 */
export async function createDraftAdvisory(opts: {
  token: string;
  fullName: string;
  summary: string;
  description: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Advisory> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(advisoriesUrl(opts.fullName), {
    ...requestInit(opts.token, opts.signal),
    method: "POST",
    body: JSON.stringify({
      summary: opts.summary,
      description: opts.description,
      // Required by the API. The affected product is the repository itself, not a package.
      vulnerabilities: [{ package: { ecosystem: "other", name: null } }],
      // No severity and no credits: the owner rates it, and the reporter's identity stays here.
      severity: null,
    }),
  });
  return toAdvisory(await readJson(response, "create advisory"), "create advisory");
}

/** The draft advisory whose description carries `marker`, if an earlier attempt opened one. */
export async function findAdvisoryByMarker(opts: {
  token: string;
  fullName: string;
  marker: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Advisory | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  // This endpoint pages by cursor, not by page number, so the next page is only ever the one
  // GitHub names in its Link header.
  let url: string | null = `${advisoriesUrl(opts.fullName)}?state=draft&per_page=100`;
  while (url) {
    const response: Response = await doFetch(url, { ...requestInit(opts.token, opts.signal), method: "GET" });
    const json = await readJson(response, "list advisories");
    if (!Array.isArray(json)) throw new Error("GitHub returned a malformed list advisories response");
    for (const item of json) {
      if (typeof item?.description === "string" && item.description.includes(opts.marker)) {
        return toAdvisory(item, "list advisories");
      }
    }
    const next: string | null = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    url = next?.startsWith("https://api.github.com/") ? next : null;
  }
  return null;
}
