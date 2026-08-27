import assert from "node:assert/strict";
import test from "node:test";

import { listIssueComments, postIssueComment } from "./comment";

function commentsPage(count: number, startIndex: number): Response {
  const items = Array.from({ length: count }, (_, i) => ({
    body: `comment-${startIndex + i}`,
    user: { login: "bountydesk-triage[bot]", type: "Bot" },
    performed_via_github_app: { id: 123456 },
  }));
  return new Response(JSON.stringify(items), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("listIssueComments follows every page while it comes back full", async () => {
  const seen: URL[] = [];

  const stub = (async (input: unknown) => {
    const url = new URL(String(input));
    seen.push(url);
    const page = Number(url.searchParams.get("page"));
    if (page === 1) return commentsPage(100, 0);
    if (page === 2) return commentsPage(100, 100);
    if (page === 3) return commentsPage(30, 200);
    throw new Error(`unexpected page ${page}`);
  }) as typeof fetch;

  const comments = await listIssueComments({
    token: "t",
    fullName: "acme/widgets",
    issueNumber: 7,
    fetchImpl: stub,
  });

  assert.equal(seen.length, 3);
  assert.deepEqual(
    seen.map((u) => u.searchParams.get("page")),
    ["1", "2", "3"],
  );
  for (const url of seen) assert.equal(url.searchParams.get("per_page"), "100");

  assert.equal(comments.length, 230);
  assert.deepEqual(comments[0], {
    body: "comment-0",
    authorLogin: "bountydesk-triage[bot]",
    authorType: "Bot",
    githubAppId: 123456,
  });
  assert.equal(comments[229].body, "comment-229");
});

test("a first page under 100 items stops the loop after one call", async () => {
  let calls = 0;
  const stub = (async () => {
    calls++;
    return commentsPage(3, 0);
  }) as typeof fetch;

  const comments = await listIssueComments({
    token: "t",
    fullName: "acme/widgets",
    issueNumber: 7,
    fetchImpl: stub,
  });

  assert.equal(calls, 1);
  assert.equal(comments.length, 3);
});

test("listIssueComments rejects malformed comment entries", async () => {
  const stub = (async () =>
    new Response(JSON.stringify([{ body: 42 }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    listIssueComments({
      token: "t",
      fullName: "acme/widgets",
      issueNumber: 7,
      fetchImpl: stub,
    }),
    /malformed issue comments response/,
  );
});

test("postIssueComment posts the right URL, body, and headers", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;

  const stub = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(JSON.stringify({ id: 555 }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const result = await postIssueComment({
    token: "ghs_the_token",
    fullName: "acme/widgets",
    issueNumber: 12,
    body: "hello",
    fetchImpl: stub,
  });

  assert.equal(
    seenUrl,
    "https://api.github.com/repos/acme/widgets/issues/12/comments",
  );
  assert.deepEqual(JSON.parse(seenInit?.body as string), { body: "hello" });

  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer ghs_the_token");
  assert.equal(headers["x-github-api-version"], "2022-11-28");

  assert.deepEqual(result, { id: 555 });
});

test("postIssueComment rejects a malformed successful response", async () => {
  const stub = (async () =>
    new Response(JSON.stringify({ id: "not-a-number" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(
    postIssueComment({
      token: "t",
      fullName: "acme/widgets",
      issueNumber: 12,
      body: "hello",
      fetchImpl: stub,
    }),
    /malformed issue comment response/,
  );
});

test("a non-2xx response throws with the status and never echoes the token", async () => {
  const stub = (async () =>
    new Response("bad credentials", { status: 401 })) as typeof fetch;

  await assert.rejects(
    postIssueComment({
      token: "ghs_the_token",
      fullName: "acme/widgets",
      issueNumber: 12,
      body: "hi",
      fetchImpl: stub,
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /401/);
      assert.equal(err.message.includes("ghs_the_token"), false);
      return true;
    },
  );
});
