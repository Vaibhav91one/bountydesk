import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GitHubApiError, type mintInstallationToken } from "./app-auth";
import {
  gitCloneCommand,
  hasContentsRead,
  PolicyRefusedError,
  privateRepoPolicyRefused,
  redactToken,
  repoReadToken,
  withRepoReadToken,
  type RepoAccess,
} from "./repo-access";

const TOKEN = "ghs_privateRepoCloneToken123";

function access(overrides: Partial<RepoAccess>): () => Promise<RepoAccess> {
  return async () => ({ repoId: 42, installationId: 7, isPrivate: true, contentsPermission: "read", ...overrides });
}

function recordingMint(result: () => Promise<{ token: string; expiresAt: string }>) {
  const calls: Array<{ installationId: number; repoId: number; permissions?: unknown }> = [];
  const mint = (async (installationId: number, repoId: number, opts?: { permissions?: unknown }) => {
    calls.push({ installationId, repoId, permissions: opts?.permissions });
    return result();
  }) as typeof mintInstallationToken;
  return { mint, calls };
}

const okMint = () => recordingMint(async () => ({ token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));

test("only a known-private repository without Contents: read is refused", () => {
  assert.equal(hasContentsRead("read"), true);
  assert.equal(hasContentsRead("write"), true);
  assert.equal(hasContentsRead("none"), false);
  assert.equal(hasContentsRead(null), false);

  assert.equal(privateRepoPolicyRefused({ isPrivate: true, contentsPermission: null }), true);
  assert.equal(privateRepoPolicyRefused({ isPrivate: true, contentsPermission: "none" }), true);
  assert.equal(privateRepoPolicyRefused({ isPrivate: true, contentsPermission: "read" }), false);
  assert.equal(privateRepoPolicyRefused({ isPrivate: false, contentsPermission: null }), false);
  assert.equal(privateRepoPolicyRefused({ isPrivate: null, contentsPermission: null }), false);
  assert.equal(privateRepoPolicyRefused({}), false);
});

test("a public repository gets no token and nothing is minted", async () => {
  const { mint, calls } = okMint();
  assert.equal(await repoReadToken("acme/app", { loadAccess: access({ isPrivate: false }), mint }), null);
  assert.equal(await repoReadToken("acme/app", { loadAccess: access({ isPrivate: null }), mint }), null);
  assert.equal(await repoReadToken("acme/app", { loadAccess: async () => null, mint }), null);
  assert.equal(calls.length, 0);
});

test("a private repository without Contents: read is refused before any token is minted", async () => {
  const { mint, calls } = okMint();
  await assert.rejects(
    repoReadToken("acme/secret", { loadAccess: access({ contentsPermission: "none" }), mint }),
    (error: unknown) => error instanceof PolicyRefusedError && /POLICY_REFUSED/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("a private repository with Contents: read mints a single-repository contents:read token", async () => {
  const { mint, calls } = okMint();
  assert.equal(await repoReadToken("acme/secret", { loadAccess: access({}), mint }), TOKEN);
  assert.deepEqual(calls, [{ installationId: 7, repoId: 42, permissions: { contents: "read" } }]);
});

test("GitHub refusing the contents permission (422) is the same POLICY_REFUSED", async () => {
  const { mint } = recordingMint(async () => {
    throw new GitHubApiError(422, "The permissions requested are not granted to this installation.");
  });
  await assert.rejects(repoReadToken("acme/secret", { loadAccess: access({}), mint }), PolicyRefusedError);
});

test("a server-side read revokes its token when the read settles, even when it fails", async () => {
  const revoked: string[] = [];
  const deps = { loadAccess: access({}), mint: okMint().mint, revoke: async (t: string) => void revoked.push(t) };
  assert.equal(await withRepoReadToken("acme/secret", async (token) => `read with ${token}`, deps), `read with ${TOKEN}`);
  await assert.rejects(
    withRepoReadToken("acme/secret", async () => {
      throw new Error("404");
    }, deps),
    /404/,
  );
  assert.deepEqual(revoked, [TOKEN, TOKEN]);

  // A public repository has nothing to revoke.
  await withRepoReadToken("acme/app", async (token) => assert.equal(token, null), { ...deps, loadAccess: access({ isPrivate: false }) });
  assert.equal(revoked.length, 2);
});

test("the anonymous clone command carries no credential", () => {
  const command = gitCloneCommand("https://github.com/acme/app.git", "/work/source", null);
  assert.equal(command, "git clone --no-checkout 'https://github.com/acme/app.git' '/work/source'");
});

test("the authenticated clone keeps the token out of the URL and scopes the helper to github.com", () => {
  const command = gitCloneCommand("https://github.com/acme/secret.git", "/work/source", TOKEN);
  assert.ok(command.includes("'https://github.com/acme/secret.git'"), "the clone URL is unchanged");
  assert.ok(!command.includes(`${TOKEN}@`) && !command.includes(`:${TOKEN}`), "no token in the URL");
  assert.equal(command.split(TOKEN).length, 2, "the token appears exactly once, in the env assignment");
  assert.ok(command.startsWith(`BD_GIT_TOKEN='${TOKEN}' GIT_TERMINAL_PROMPT=0 git -c credential.helper= `));
  assert.ok(command.includes("credential.https://github.com.helper="));
});

/**
 * Run the real clone command through sh with a stand-in `git` that prints the arguments and env it
 * received, so the test sees exactly what the shell hands git after quoting.
 */
function parsedCloneCommand(): { args: string[]; token: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "bd-git-"));
  writeFileSync(path.join(dir, "git"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done\nprintf "TOKEN=%s" "$BD_GIT_TOKEN"\n');
  chmodSync(path.join(dir, "git"), 0o755);
  const out = execFileSync("sh", ["-c", gitCloneCommand("https://github.com/acme/secret.git", "/work/source", TOKEN)], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  }).toString();
  const parts = out.split("\0");
  return { args: parts.slice(0, -1), token: parts.at(-1)!.replace(/^TOKEN=/, "") };
}

test("the shell hands git the helper, the unchanged URL, and the token only through the environment", () => {
  const { args, token } = parsedCloneCommand();
  assert.equal(token, TOKEN);
  assert.deepEqual(args.slice(0, 4), ["-c", "credential.helper=", "-c", args[3]]);
  assert.match(args[3], /^credential\.https:\/\/github\.com\.helper=!f\(\)/);
  assert.deepEqual(args.slice(4), ["clone", "--no-checkout", "https://github.com/acme/secret.git", "/work/source"]);
  assert.ok(!args.some((a) => a.includes(TOKEN)), "the token is in no argument git receives");
});

/** Ask real git what the helper answers for a host, the same lookup a clone makes. */
function credentialFill(host: string): string {
  const config = parsedCloneCommand().args[3];
  try {
    return execFileSync("git", ["-c", "credential.helper=", "-c", config, "credential", "fill"], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, BD_GIT_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
  } catch (error) {
    return `failed: ${(error as { stderr?: Buffer }).stderr?.toString() ?? ""}`;
  }
}

test("real git hands the token to github.com and to no other host", () => {
  const github = credentialFill("github.com");
  assert.match(github, /username=x-access-token/);
  assert.match(github, new RegExp(`password=${TOKEN}`));
  assert.ok(!credentialFill("evil.example").includes(TOKEN), "another host never receives the token");
});

test("redactToken strips every occurrence and leaves text alone without a token", () => {
  assert.equal(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN), "a [redacted] b [redacted]");
  assert.equal(redactToken("plain", null), "plain");
});
