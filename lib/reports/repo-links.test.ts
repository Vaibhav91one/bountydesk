import assert from "node:assert/strict";
import test from "node:test";

import { otherHostReferences, recognizeRepoLink } from "./repo-links";

test("the three known hosts are recognised and labelled", () => {
  assert.deepEqual(recognizeRepoLink("https://github.com/acme/api"), {
    host: "github",
    label: "GitHub",
    name: "acme/api",
    url: "https://github.com/acme/api",
  });
  assert.deepEqual(recognizeRepoLink("https://gitlab.com/acme/api"), {
    host: "gitlab",
    label: "GitLab",
    name: "acme/api",
    url: "https://gitlab.com/acme/api",
  });
  assert.deepEqual(recognizeRepoLink("https://bitbucket.org/acme/api"), {
    host: "bitbucket",
    label: "Bitbucket",
    name: "acme/api",
    url: "https://bitbucket.org/acme/api",
  });
});

test("a bare link, a www. prefix and a .git suffix all normalise", () => {
  assert.equal(recognizeRepoLink("gitlab.com/acme/api")?.url, "https://gitlab.com/acme/api");
  assert.equal(recognizeRepoLink("www.gitlab.com/acme/api")?.url, "https://gitlab.com/acme/api");
  assert.equal(recognizeRepoLink("https://bitbucket.org/acme/api.git")?.url, "https://bitbucket.org/acme/api");
  // Userinfo in a pasted link is dropped when the url is rebuilt, so no credentials ride along.
  assert.equal(recognizeRepoLink("https://user@gitlab.com/acme/api")?.url, "https://gitlab.com/acme/api");
});

test("a query, fragment or extra path is dropped from the link", () => {
  assert.equal(
    recognizeRepoLink("https://gitlab.com/acme/api/-/issues/3?tab=x#note")?.url,
    "https://gitlab.com/acme/api",
  );
});

test("an unknown host falls back safely to null", () => {
  assert.equal(recognizeRepoLink("https://example.com/acme/api"), null);
  // A lookalike host must not match on a substring.
  assert.equal(recognizeRepoLink("https://evil-gitlab.com/acme/api"), null);
  assert.equal(recognizeRepoLink("https://gitlab.com.attacker.io/acme/api"), null);
});

test("a non-URL, a non-repo path and a non-http scheme return null", () => {
  assert.equal(recognizeRepoLink("see the login form for details"), null);
  assert.equal(recognizeRepoLink(""), null);
  assert.equal(recognizeRepoLink("https://gitlab.com/acme"), null); // owner only, no repo
  assert.equal(recognizeRepoLink("javascript:alert(1)//gitlab.com/a/b"), null);
});

test("otherHostReferences pulls non-GitHub repos out of a body, deduped and in order", () => {
  const body =
    "Repro on https://gitlab.com/acme/api and bitbucket.org/acme/web. " +
    "Same one again gitlab.com/acme/api. GitHub github.com/acme/api is handled elsewhere.";
  assert.deepEqual(
    otherHostReferences(body).map((r) => `${r.label} ${r.name}`),
    ["GitLab acme/api", "Bitbucket acme/web"],
  );
});

test("otherHostReferences leaves a body with no such links alone", () => {
  assert.deepEqual(otherHostReferences("no links here, only github.com/acme/api"), []);
});
