/**
 * Issue-comment primitives used by delivery (posting a verdict) and reproduction (reading the
 * reporter's own follow-ups). Both take an already-minted installation token; neither one
 * mints or refreshes it, which keeps token lifetime the caller's problem.
 */

const GITHUB_TIMEOUT_MS = 10_000;

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function requestHeaders(
  token: string,
  withContentType: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (withContentType) headers["content-type"] = "application/json";
  return headers;
}

async function throwForStatus(
  response: Response,
  action: string,
): Promise<never> {
  // The response body is GitHub's own error message, not one of ours, so it is safe to
  // include; the token used for the request never appears in it.
  const body = await response.text();
  throw new Error(
    `GitHub ${action} request failed with ${response.status}: ${body}`,
  );
}

function repositoryPath(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`repository full name must be owner/repo, got ${fullName}`);
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

export async function postIssueComment(opts: {
  token: string;
  fullName: string;
  issueNumber: number;
  body: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ id: number }> {
  const { token, fullName, issueNumber, body, fetchImpl, signal } = opts;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `issueNumber must be a positive integer, got ${issueNumber}`,
    );
  }

  const path = repositoryPath(fullName);
  const doFetch = fetchImpl ?? fetch;

  const response = await doFetch(
    `https://api.github.com/repos/${path}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: requestHeaders(token, true),
      body: JSON.stringify({ body }),
      signal: requestSignal(signal),
    },
  );

  if (!response.ok) await throwForStatus(response, "issue comment");

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("GitHub returned a malformed issue comment response");
  }
  if (
    typeof json !== "object" ||
    json === null ||
    !("id" in json) ||
    typeof json.id !== "number" ||
    !Number.isSafeInteger(json.id) ||
    json.id <= 0
  ) {
    throw new Error("GitHub returned a malformed issue comment response");
  }
  return { id: json.id };
}

export async function listIssueComments(opts: {
  token: string;
  fullName: string;
  issueNumber: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<IssueComment[]> {
  const { token, fullName, issueNumber, fetchImpl, signal } = opts;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `issueNumber must be a positive integer, got ${issueNumber}`,
    );
  }

  const path = repositoryPath(fullName);
  const doFetch = fetchImpl ?? fetch;
  const PER_PAGE = 100;
  const comments: IssueComment[] = [];

  for (let page = 1; ; page++) {
    const response = await doFetch(
      `https://api.github.com/repos/${path}/issues/${issueNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      { headers: requestHeaders(token, false), signal: requestSignal(signal) },
    );

    if (!response.ok) await throwForStatus(response, "issue comments");

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("GitHub returned a malformed issue comments response");
    }
    if (
      !Array.isArray(json) ||
      json.some(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          typeof item.body !== "string" ||
          typeof item.user !== "object" ||
          item.user === null ||
          typeof item.user.login !== "string" ||
          typeof item.user.type !== "string" ||
          (item.performed_via_github_app !== null &&
            (typeof item.performed_via_github_app !== "object" ||
              typeof item.performed_via_github_app.id !== "number" ||
              !Number.isSafeInteger(item.performed_via_github_app.id))),
      )
    ) {
      throw new Error("GitHub returned a malformed issue comments response");
    }
    const items = json as Array<{
      body: string;
      user: { login: string; type: string };
      performed_via_github_app: { id: number } | null;
    }>;
    for (const item of items) {
      comments.push({
        body: item.body,
        authorLogin: item.user.login,
        authorType: item.user.type,
        githubAppId: item.performed_via_github_app?.id ?? null,
      });
    }

    // A page under the requested size is the only signal GitHub gives that there is no next
    // one; a full page might still have more behind it, so only a short page stops the loop.
    if (items.length < PER_PAGE) break;
  }

  return comments;
}

export type IssueComment = {
  body: string;
  authorLogin: string;
  authorType: string;
  githubAppId: number | null;
};
