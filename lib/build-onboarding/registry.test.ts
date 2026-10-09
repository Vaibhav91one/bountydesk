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
  assert.match(login, /docker login 'ghcr\.io' -u 'bountydesk'/);
  assert.ok(login.includes("secret-tok"), "the login carries the push token");
  assert.ok(commands.some((c) => c.startsWith("docker push ghcr.io/acme/widget")));
  assert.ok(commands.some((c) => c.includes("docker logout 'ghcr.io'")));
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

type Call = { url: string; method: string; headers: Record<string, string> };

async function withFetch(
  respond: (call: Call) => Response,
  body: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    assert.ok(init?.signal, "every registry fetch carries an abort signal");
    const call = { url: String(input), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
    console.warn = warn;
  }
}

const V2_TAG = "registry.example.com/team/widget:bountydesk-abc";
const V2_DIGEST = `sha256:${"b".repeat(64)}`;
const v2Registry = () =>
  createRegistry({ host: "registry.example.com", user: "bot", namespace: "registry.example.com/team", pushToken: "p", deleteToken: "del" });

test("v2 delete reads the manifest digest with HEAD, then deletes by digest", async () => {
  await withFetch(
    (call) =>
      call.method === "HEAD"
        ? new Response(null, { status: 200, headers: { "docker-content-digest": V2_DIGEST } })
        : new Response(null, { status: 202 }),
    async (calls) => {
      await v2Registry().deleteImage(V2_TAG);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, "HEAD");
      assert.equal(calls[0].url, "https://registry.example.com/v2/team/widget/manifests/bountydesk-abc");
      assert.match(calls[0].headers.accept, /application\/vnd\.oci\.image\.index\.v1\+json/);
      assert.equal(calls[1].method, "DELETE");
      assert.equal(calls[1].url, `https://registry.example.com/v2/team/widget/manifests/${V2_DIGEST}`);
      assert.equal(calls[1].headers.authorization, `Basic ${Buffer.from("bot:del").toString("base64")}`);
    },
  );
});

test("v2 delete treats a missing tag as already gone", async () => {
  await withFetch(() => new Response(null, { status: 404 }), async (calls) => {
    await v2Registry().deleteImage(V2_TAG);
    assert.equal(calls.length, 1);
  });
});

test("v2 delete logs and returns when the registry has deletes disabled", async () => {
  await withFetch(
    (call) =>
      call.method === "HEAD"
        ? new Response(null, { status: 200, headers: { "docker-content-digest": V2_DIGEST } })
        : new Response(null, { status: 405 }),
    async (calls) => {
      await v2Registry().deleteImage(V2_TAG);
      assert.equal(calls.length, 2);
    },
  );
});

test("v2 delete does not throw when the registry is unreachable", async () => {
  const original = globalThis.fetch;
  const warn = console.warn;
  console.warn = () => undefined;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  try {
    await v2Registry().deleteImage(V2_TAG);
  } finally {
    globalThis.fetch = original;
    console.warn = warn;
  }
});
