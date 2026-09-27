import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFindings,
  createDraftAdvisory,
  findAdvisoryByMarker,
  getAdvisory,
  updateAdvisoryDescription,
} from "./advisory";

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

  const found = await findAdvisoryByMarker({ token: "t", fullName: "o/r", markers: ["<!-- other -->", "<!-- m -->"], fetchImpl });
  assert.equal(found?.ghsaId, "GHSA-b");
  assert.equal(found?.marker, "<!-- m -->");
  assert.equal(urls[1], "https://api.github.com/repos/o/r/security-advisories?after=c1");

  const offHost = (async () =>
    reply([], { link: '<https://evil.example/next>; rel="next"' })) as typeof fetch;
  assert.equal(await findAdvisoryByMarker({ token: "t", fullName: "o/r", markers: ["m"], fetchImpl: offHost }), null);
});

test("getAdvisory reads the summary and description, and keeps a refusal's status", async () => {
  let seen: { url: string; method?: string } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, method: init.method };
    return reply({
      ghsa_id: "GHSA-read-aaaa-bbbb",
      html_url: "https://github.com/o/r/security/advisories/GHSA-read-aaaa-bbbb",
      summary: "XSS in search",
      description: "the reporter's writeup",
    });
  }) as typeof fetch;

  const advisory = await getAdvisory({ token: "t", fullName: "o/r", ghsaId: "GHSA-read-aaaa-bbbb", fetchImpl });
  assert.equal(advisory.summary, "XSS in search");
  assert.equal(advisory.description, "the reporter's writeup");
  assert.equal(advisory.ghsaId, "GHSA-read-aaaa-bbbb");
  assert.equal(seen?.method, "GET");
  assert.equal(seen?.url, "https://api.github.com/repos/o/r/security-advisories/GHSA-read-aaaa-bbbb");

  // A 404 (the installation cannot see the advisory) surfaces as a status-carrying error, not a stub.
  await assert.rejects(
    getAdvisory({
      token: "t",
      fullName: "o/r",
      ghsaId: "GHSA-x",
      fetchImpl: (async () => reply({ message: "not found" }, { status: 404 })) as typeof fetch,
    }),
    (error: { status?: number }) => error.status === 404,
  );
});

test("a refusal keeps GitHub's status, and a response pointing off github.com is rejected", async () => {
  await assert.rejects(
    createDraftAdvisory({
      token: "t",
      fullName: "o/r",
      summary: "s",
      description: "d",
      severity: null,
      cweIds: [],
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
      severity: null,
      cweIds: [],
      fetchImpl: (async () => reply({ ghsa_id: "G", html_url: "javascript:alert(1)" }, { status: 201 })) as typeof fetch,
    }),
    /malformed/,
  );
});

test("a draft opens with the classified severity and CWEs, and an update sends only the description", async () => {
  const sent: { url: string; method?: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
    return reply({ ghsa_id: "GHSA-x", html_url: "https://github.com/o/r/security/advisories/GHSA-x" }, { status: 201 });
  }) as typeof fetch;

  await createDraftAdvisory({
    token: "t",
    fullName: "o/r",
    summary: "s",
    description: "d",
    severity: "high",
    cweIds: ["CWE-79"],
    fetchImpl,
  });
  assert.equal(sent[0].body.severity, "high");
  assert.deepEqual(sent[0].body.cwe_ids, ["CWE-79"]);
  // GitHub takes severity or a CVSS vector, never both.
  assert.equal("cvss_vector_string" in sent[0].body, false);
  assert.equal("credits" in sent[0].body, false);

  const updated = await updateAdvisoryDescription({
    token: "t",
    fullName: "o/r",
    ghsaId: "GHSA-x",
    description: "d2",
    fetchImpl,
  });
  assert.equal(updated.ghsaId, "GHSA-x");
  assert.equal(sent[1].method, "PATCH");
  assert.equal(sent[1].url, "https://api.github.com/repos/o/r/security-advisories/GHSA-x");
  assert.deepEqual(sent[1].body, { description: "d2" });
});

test("severity is the highest finding's, and a CWE comes only from the closed table", () => {
  const f = (title: string, severity: string, description = "d") => ({ title, severity, description });

  assert.deepEqual(classifyFindings([]), { severity: null, cweIds: [] });
  assert.deepEqual(classifyFindings([f("Banner", "info")]), { severity: null, cweIds: [] });
  assert.equal(classifyFindings([f("a", "low"), f("b", "critical"), f("c", "medium")]).severity, "critical");
  assert.equal(classifyFindings([f("a", "medium"), f("b", "info")]).severity, "medium");

  // The class named in a title, or the id named anywhere in a finding.
  assert.deepEqual(classifyFindings([f("Reflected XSS in search", "high")]).cweIds, ["CWE-79"]);
  assert.deepEqual(
    classifyFindings([
      f("Login bypass", "high", "Classic SQL injection, see CWE-89."),
      f("Upload", "low", "cwe-22 via ../"),
    ]).cweIds,
    ["CWE-89", "CWE-22"],
  );
  // A description saying what it is not, an id outside the table, and a longer id sharing a
  // prefix all yield nothing.
  assert.deepEqual(classifyFindings([f("Header missing", "low", "This is not XSS.")]).cweIds, []);
  assert.deepEqual(classifyFindings([f("Regex DoS", "medium", "CWE-1333")]).cweIds, []);
  assert.deepEqual(classifyFindings([f("Thing", "medium", "CWE-790")]).cweIds, []);
});
