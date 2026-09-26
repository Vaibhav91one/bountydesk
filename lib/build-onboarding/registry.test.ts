import assert from "node:assert/strict";
import test from "node:test";

import type { Sandbox } from "@/lib/sandbox/daytona";

import { createRegistry, parseGhcrRef, pickVersionIdByTag, resolveRegistry, type SandboxRun } from "./registry";

const SANDBOX = { id: "sbx" } as unknown as Sandbox;

function recordingRun(): { run: SandboxRun; commands: string[] } {
  const commands: string[] = [];
  const run: SandboxRun = async (_sandbox, command) => {
    commands.push(command);
    if (command.includes(".RepoDigests")) return { exitCode: 0, result: `sha256:${"a".repeat(64)}` };
    return { exitCode: 0, result: "ok" };
  };
  return { run, commands };
}

test("push returns the pullable tag and digest and keeps the credential in the login window", async () => {
  const registry = createRegistry({ host: "ghcr.io", user: "bountydesk", namespace: "ghcr.io/acme", pushToken: "secret-tok" });
  const { run, commands } = recordingRun();

  const pushed = await registry.push(SANDBOX, "ghcr.io/acme/widget:bountydesk-onboarding", run);

  assert.equal(pushed.pullableTag, "ghcr.io/acme/widget:bountydesk-onboarding");
  assert.equal(pushed.digest, `sha256:${"a".repeat(64)}`);

  const login = commands.find((c) => c.includes("docker login")) ?? "";
  assert.match(login, /docker login ghcr\.io -u bountydesk/);
  assert.ok(login.includes("secret-tok"), "the login carries the push token");
  assert.ok(commands.some((c) => c.startsWith("docker push ghcr.io/acme/widget")));
  assert.ok(commands.some((c) => c.includes("docker logout ghcr.io")));
  // The digest read runs after the credential is gone.
  const logoutAt = commands.findIndex((c) => c.includes("docker logout"));
  const inspectAt = commands.findIndex((c) => c.includes(".RepoDigests"));
  assert.ok(logoutAt < inspectAt);
});

test("the default registry is GHCR from the historical env, with REGISTRY_* overriding", () => {
  const saved = { ...process.env };
  try {
    for (const key of ["REGISTRY_HOST", "REGISTRY_USER", "REGISTRY_NAMESPACE", "REGISTRY_PUSH_TOKEN", "REGISTRY_DELETE_TOKEN"]) {
      delete process.env[key];
    }
    process.env.GHCR_NAMESPACE = "ghcr.io/acme";
    process.env.GHCR_PUSH_TOKEN = "ghcr-tok";
    assert.equal(resolveRegistry().namespace, "ghcr.io/acme");

    process.env.REGISTRY_NAMESPACE = "registry.example.com:5000/team";
    assert.equal(resolveRegistry().namespace, "registry.example.com:5000/team");
  } finally {
    process.env = saved;
  }
});

test("createRegistry refuses a shell-hostile host or user before any push", () => {
  assert.throws(() => createRegistry({ host: "ghcr.io; rm -rf /", user: "u", namespace: "ghcr.io/a", pushToken: "t" }), /host/);
  assert.throws(() => createRegistry({ host: "ghcr.io", user: "u; evil", namespace: "ghcr.io/a", pushToken: "t" }), /user/);
});

test("deleteImage is a no-op without a delete token and never throws", async () => {
  const registry = createRegistry({ host: "ghcr.io", user: "bountydesk", namespace: "ghcr.io/acme", pushToken: "t" });
  await registry.deleteImage("ghcr.io/acme/widget:bountydesk-onboarding");
});

test("parseGhcrRef splits owner, package and tag; pickVersionIdByTag finds the tagged version", () => {
  assert.deepEqual(parseGhcrRef("ghcr.io/acme/widget:bountydesk-onboarding"), {
    owner: "acme",
    packageName: "widget",
    tag: "bountydesk-onboarding",
  });
  assert.deepEqual(parseGhcrRef("ghcr.io/acme/team/svc:tag"), { owner: "acme", packageName: "team/svc", tag: "tag" });
  assert.throws(() => parseGhcrRef("ghcr.io/acme/widget"), /tagged reference/);

  const versions = [
    { id: 1, metadata: { container: { tags: ["other"] } } },
    { id: 2, metadata: { container: { tags: ["bountydesk-onboarding"] } } },
  ];
  assert.equal(pickVersionIdByTag(versions, "bountydesk-onboarding"), 2);
  assert.equal(pickVersionIdByTag(versions, "missing"), null);
});
