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

export type AdvisorySeverity = "critical" | "high" | "medium" | "low";

// Most severe first. "info" is not a GitHub severity, so a verdict of only info findings gets none.
const SEVERITIES: AdvisorySeverity[] = ["critical", "high", "medium", "low"];

// A closed table, so every id sent is one GitHub knows and an advisory is never refused over a
// typo in agent-drafted text. The class patterns match finding titles only: a title is a short
// label, while a description can say "this is not XSS".
// ponytail: ten common web classes. A CWE the verdict names outside this table is left for the
// owner to add; grow the table when reports need more.
const CWES: [id: string, title: RegExp][] = [
  ["CWE-79", /cross[- ]site scripting|\bxss\b/i],
  ["CWE-89", /sql injection|\bsqli\b/i],
  ["CWE-78", /command injection/i],
  ["CWE-22", /path traversal|directory traversal/i],
  ["CWE-352", /cross[- ]site request forgery|\bcsrf\b/i],
  ["CWE-918", /server[- ]side request forgery|\bssrf\b/i],
  ["CWE-601", /open redirect/i],
  ["CWE-611", /xml external entit|\bxxe\b/i],
  ["CWE-639", /insecure direct object reference|\bidor\b/i],
  ["CWE-502", /deseriali[sz]ation/i],
];

/**
 * The severity and CWE ids an advisory opens with, read off the approved verdict's own findings
 * rather than asked of a model: the highest finding severity, and each CWE in the table above
 * that a finding names outright ("CWE-79") or whose class its title names.
 */
export function classifyFindings(
  findings: readonly { title: string; severity: string; description: string }[],
): { severity: AdvisorySeverity | null; cweIds: string[] } {
  const severity = SEVERITIES.find((level) => findings.some((f) => f.severity === level)) ?? null;
  const cweIds = CWES.filter(([id, title]) => {
    const named = new RegExp(`\\b${id}(?!\\d)`, "i");
    return findings.some((f) => title.test(f.title) || named.test(`${f.title}\n${f.description}`));
  }).map(([id]) => id);
  return { severity, cweIds };
}

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
  severity: AdvisorySeverity | null;
  cweIds: string[];
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
      // Severity, not cvss_vector_string: GitHub takes one or the other, and a verdict has a
      // finding severity rather than a vector. The owner can change both on the draft.
      severity: opts.severity,
      cwe_ids: opts.cweIds,
      // No credits: the reporter's identity stays here.
    }),
  });
  return toAdvisory(await readJson(response, "create advisory"), "create advisory");
}

/**
 * Replace an advisory's description, and nothing else: a revised verdict brings new approved
 * text, while the summary, severity and CWEs are the owner's to have edited on the draft since.
 * Sending the same bytes twice leaves the same advisory, so a retry needs no read-back.
 */
export async function updateAdvisoryDescription(opts: {
  token: string;
  fullName: string;
  ghsaId: string;
  description: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Advisory> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(`${advisoriesUrl(opts.fullName)}/${encodeURIComponent(opts.ghsaId)}`, {
    ...requestInit(opts.token, opts.signal),
    method: "PATCH",
    body: JSON.stringify({ description: opts.description }),
  });
  return toAdvisory(await readJson(response, "update advisory"), "update advisory");
}

/**
 * The draft advisory whose description carries one of `markers`, if an earlier attempt opened
 * one, with the marker it carries.
 */
export async function findAdvisoryByMarker(opts: {
  token: string;
  fullName: string;
  markers: string[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<(Advisory & { marker: string }) | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  // This endpoint pages by cursor, not by page number, so the next page is only ever the one
  // GitHub names in its Link header.
  let url: string | null = `${advisoriesUrl(opts.fullName)}?state=draft&per_page=100`;
  while (url) {
    const response: Response = await doFetch(url, { ...requestInit(opts.token, opts.signal), method: "GET" });
    const json = await readJson(response, "list advisories");
    if (!Array.isArray(json)) throw new Error("GitHub returned a malformed list advisories response");
    for (const item of json) {
      const description: unknown = item?.description;
      const marker =
        typeof description === "string" ? opts.markers.find((m) => description.includes(m)) : undefined;
      if (marker) return { ...toAdvisory(item, "list advisories"), marker };
    }
    const next: string | null = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    url = next?.startsWith("https://api.github.com/") ? next : null;
  }
  return null;
}
