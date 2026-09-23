import assert from "node:assert/strict";
import test from "node:test";

import { createDraftAdvisory, findAdvisoryByMarker } from "./advisory";

function reply(body: unknown, init: { status?: number; link?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.link ? { link: init.link } : {},
  });
}

test("the marker search follows GitHub's cursor links and ignores a next link off api.github.com", async () => {
  const urls: string[] = [];
  const pages = [
    reply([{ description: "other", ghsa_id: "GHSA-a", html_url: "https://github.com/o/r/security/advisories/GHSA-a" }], {
      link: '<https://api.github.com/repos/o/r/security-advisories?after=c1>; rel="next"',
    }),
    reply([{ description: "x <!-- m --> y", ghsa_id: "GHSA-b", html_url: "https://github.com/o/r/security/advisories/GHSA-b" }]),
  ];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return pages.shift()!;
  }) as typeof fetch;

  const found = await findAdvisoryByMarker({ token: "t", fullName: "o/r", marker: "<!-- m -->", fetchImpl });
  assert.equal(found?.ghsaId, "GHSA-b");
  assert.equal(urls[1], "https://api.github.com/repos/o/r/security-advisories?after=c1");

  const offHost = (async () =>
    reply([], { link: '<https://evil.example/next>; rel="next"' })) as typeof fetch;
  assert.equal(await findAdvisoryByMarker({ token: "t", fullName: "o/r", marker: "m", fetchImpl: offHost }), null);
});

test("a refusal keeps GitHub's status, and a response pointing off github.com is rejected", async () => {
  await assert.rejects(
    createDraftAdvisory({
      token: "t",
      fullName: "o/r",
      summary: "s",
      description: "d",
      fetchImpl: (async () => reply({ message: "no" }, { status: 403 })) as typeof fetch,
    }),
    (error: { status?: number }) => error.status === 403,
  );
  await assert.rejects(
    createDraftAdvisory({
      token: "t",
      fullName: "o/r",
      summary: "s",
      description: "d",
      fetchImpl: (async () => reply({ ghsa_id: "G", html_url: "javascript:alert(1)" }, { status: 201 })) as typeof fetch,
    }),
    /malformed/,
  );
});
