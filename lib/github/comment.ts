/**
 * Issue-comment primitives used by delivery (posting a verdict) and reproduction (reading the
 * reporter's own follow-ups). Both take an already-minted installation token; neither one
 * mints or refreshes it, which keeps token lifetime the caller's problem.
 */

const GITHUB_TIMEOUT_MS = 10_000;

function requestHeaders(token: string, withContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (withContentType) headers["content-type"] = "application/json";
  return headers;
}

async function throwForStatus(response: Response, action: string): Promise<never> {
  // The response body is GitHub's own error message, not one of ours, so it is safe to
  // include; the token used for the request never appears in it.
  const body = await response.text();
  throw new Error(`GitHub ${action} request failed with ${response.status}: ${body}`);
}

export async function postIssueComment(opts: {
  token: string;
  fullName: string;
  issueNumber: number;
  body: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: number }> {
  const { token, fullName, issueNumber, body, fetchImpl } = opts;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`issueNumber must be a positive integer, got ${issueNumber}`);
  }

  const [owner, repo] = fullName.split("/");
  const doFetch = fetchImpl ?? fetch;

  const response = await doFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: requestHeaders(token, true),
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    },
  );

  if (!response.ok) await throwForStatus(response, "issue comment");

  const json = (await response.json()) as { id: number };
  return { id: json.id };
}

export async function listIssueComments(opts: {
  token: string;
  fullName: string;
  issueNumber: number;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const { token, fullName, issueNumber, fetchImpl } = opts;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`issueNumber must be a positive integer, got ${issueNumber}`);
  }

  const [owner, repo] = fullName.split("/");
  const doFetch = fetchImpl ?? fetch;
  const PER_PAGE = 100;
  const bodies: string[] = [];

  for (let page = 1; ; page++) {
    const response = await doFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
      { headers: requestHeaders(token, false), signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) },
    );

    if (!response.ok) await throwForStatus(response, "issue comments");

    const items = (await response.json()) as { body?: string }[];
    for (const item of items) bodies.push(item.body ?? "");

    // A page under the requested size is the only signal GitHub gives that there is no next
    // one; a full page might still have more behind it, so only a short page stops the loop.
    if (items.length < PER_PAGE) break;
  }

  return bodies;
}
