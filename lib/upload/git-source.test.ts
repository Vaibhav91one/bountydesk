import assert from "node:assert/strict";
import test from "node:test";

import { parseGitSource } from "./git-source";

const SHA = "a".repeat(40);

test("a public GitLab or Bitbucket URL with a full SHA is accepted and normalised", () => {
  const gitlab = parseGitSource("https://GitLab.com/group/sub/project.git/", SHA.toUpperCase());
  assert.deepEqual(gitlab, {
    ok: true,
    source: { cloneUrl: "https://gitlab.com/group/sub/project.git", host: "gitlab.com", commitSha: SHA },
  });
  const bitbucket = parseGitSource("https://bitbucket.org/team/repo", SHA);
  assert.ok(bitbucket.ok && bitbucket.source.host === "bitbucket.org");
  assert.ok(parseGitSource("https://git.example.org/team/repo", SHA).ok);
});

test("anything but a plain https URL to a public DNS name is refused", () => {
  const refused = [
    "http://gitlab.com/g/p",
    "git://gitlab.com/g/p",
    "ssh://git@gitlab.com/g/p",
    "https://user@gitlab.com/g/p",
    "https://user:pw@gitlab.com/g/p",
    "https://gitlab.com:8443/g/p",
    "https://gitlab.com/g/p?x=1",
    "https://gitlab.com/g/p#frag",
    "https://127.0.0.1/g/p",
    "https://10.0.0.5/g/p",
    "https://169.254.169.254/g/p",
    "https://2130706433/g/p",
    "https://[::1]/g/p",
    "https://[fd00::1]/g/p",
    "https://localhost/g/p",
    "https://gitserver/g/p",
    "https://git.corp.internal/g/p",
    "https://nas.local/g/p",
    "https://gitlab.com/onlyone",
    "https://gitlab.com/g/../p",
    "https://gitlab.com/g/p%20x",
    "https://gitlab.com/g/-p",
    "not a url",
    "",
    `https://gitlab.com/g/${"p".repeat(300)}`,
  ];
  for (const url of refused) assert.equal(parseGitSource(url, SHA).ok, false, url);
});

test("a short SHA, a branch, a tag, HEAD and a 64-char hash are refused", () => {
  for (const commit of ["", "abc1234", "main", "v1.2.3", "HEAD", "g".repeat(40), "a".repeat(64)]) {
    assert.equal(parseGitSource("https://gitlab.com/g/p", commit).ok, false, commit);
  }
});
