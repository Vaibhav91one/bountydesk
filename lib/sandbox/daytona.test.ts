import assert from "node:assert/strict";
import test from "node:test";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";

import { UnsafeSandboxSpec, assertSafeSpec, createSandbox, type SandboxSpec } from "./daytona";

/**
 * The validation in front of provisioning, tested for what it refuses.
 *
 * A reproduction sandbox that comes up with network looks exactly like one that came up
 * correctly, right until a proof-of-concept uses it. So these assert that the unsafe spec
 * throws before any network call, rather than being corrected and logged.
 */
const build: SandboxSpec = {
  snapshot: "juice-shop-v17.3.0",
  purpose: "build",
  cpu: 2,
  memoryGb: 2,
  diskGb: 10,
  ttlMinutes: 20,
  domainAllowList: ["github.com", "registry.npmjs.org"],
};

const reproduction: SandboxSpec = {
  snapshot: "juice-shop-v17.3.0",
  purpose: "reproduction",
  cpu: 2,
  memoryGb: 2,
  diskGb: 10,
  ttlMinutes: 20,
};

test("a well-formed spec of either purpose is accepted", () => {
  assert.doesNotThrow(() => assertSafeSpec(build));
  assert.doesNotThrow(() => assertSafeSpec(reproduction));
});

test("a reproduction sandbox may not carry a domain allow list", () => {
  // Asking for one means the caller thinks reproduction gets network. It does not.
  assert.throws(
    () => assertSafeSpec({ ...reproduction, domainAllowList: ["github.com"] }),
    UnsafeSandboxSpec,
  );
});

test("a build sandbox must name the hosts it may reach", () => {
  // An empty list is the dangerous case: it reads as "no restriction" rather than "no access".
  assert.throws(() => assertSafeSpec({ ...build, domainAllowList: [] }), UnsafeSandboxSpec);
  assert.throws(() => assertSafeSpec({ ...build, domainAllowList: undefined }), UnsafeSandboxSpec);
});

test("a snapshot identifier that did not come from a profile is refused", () => {
  for (const snapshot of ["", "  ", "a".repeat(201), "juice; rm -rf /", "$(whoami)", "a b"]) {
    assert.throws(() => assertSafeSpec({ ...build, snapshot }), UnsafeSandboxSpec, snapshot);
  }
});

test("limits and a time-to-live are mandatory and positive", () => {
  for (const patch of [
    { cpu: 0 }, { cpu: -1 }, { memoryGb: 0 }, { diskGb: 0 },
    { ttlMinutes: 0 }, { ttlMinutes: -5 }, { cpu: Number.NaN },
  ]) {
    assert.throws(() => assertSafeSpec({ ...build, ...patch }), UnsafeSandboxSpec, JSON.stringify(patch));
  }

  // Below the provider's documented floor the request is silently raised, which would make the
  // limit we recorded untrue.
  assert.throws(() => assertSafeSpec({ ...build, memoryGb: 0.5 }), UnsafeSandboxSpec);
});

test("an unsafe spec never reaches the network", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      createSandbox({ ...reproduction, domainAllowList: ["github.com"] }),
      UnsafeSandboxSpec,
    );
    assert.equal(called, false, "provisioning was attempted despite an unsafe spec");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the request body derives network policy from purpose and carries no secrets", async () => {
  const realFetch = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];

  // createSandbox reads the snapshot first, because the provider refuses resource fields
  // alongside a snapshot and the limits therefore have to be verified rather than requested.
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (url.includes("/snapshots/")) {
      return json({ id: "snap-1", name: "juice-shop-v17.3.0", imageName: "x", state: "active", cpu: 2, mem: 2, disk: 10 });
    }

    sent.push(JSON.parse(init?.body as string));
    return json({ id: "sb-1", state: "started" });
  }) as typeof fetch;

  try {
    await createSandbox(reproduction);
    await createSandbox(build);
  } finally {
    globalThis.fetch = realFetch;
  }

  const [repro, bld] = sent;

  // Purpose decides the network, so no caller can request a reproduction sandbox with one.
  assert.equal(repro.networkBlockAll, true);
  assert.equal(repro.domainAllowList, undefined);
  assert.equal(bld.networkBlockAll, false);
  assert.equal(bld.domainAllowList, "github.com,registry.npmjs.org");

  // The hostile runtime holds no platform credential, and the way to be sure is that no code
  // path puts one there.
  for (const body of sent) {
    assert.equal("env" in body, false, "env must never be sent");
    assert.equal("secrets" in body, false, "secrets must never be sent");
    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes("dtn_"), false, "the Daytona key must not appear in a body");
    assert.equal(/ghs_|ghp_|github_pat_|postgres:\/\//.test(serialised), false);
  }

  // A sandbox with no ceiling outlives the run that made it.
  assert.equal(repro.ttlMinutes, 20);
});

test("a snapshot whose limits differ from the run's is refused", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/snapshots/")) {
      // Same snapshot name, but it was rebuilt with more memory than this run asked for.
      return new Response(
        JSON.stringify({ id: "snap-1", name: "juice-shop-v17.3.0", imageName: "x", state: "active", cpu: 2, mem: 8, disk: 10 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("provisioning was attempted despite a limit mismatch");
  }) as typeof fetch;

  try {
    await assert.rejects(createSandbox(reproduction), UnsafeSandboxSpec);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an inactive snapshot is refused before provisioning", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/snapshots/")) {
      return new Response(
        JSON.stringify({ id: "snap-1", name: "x", imageName: "x", state: "building", cpu: 2, mem: 2, disk: 10 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("provisioning was attempted against a snapshot that is not active");
  }) as typeof fetch;

  try {
    await assert.rejects(createSandbox(reproduction), UnsafeSandboxSpec);
  } finally {
    globalThis.fetch = realFetch;
  }
});
