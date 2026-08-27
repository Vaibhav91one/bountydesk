import assert from "node:assert/strict";
import test from "node:test";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";

import {
  UnsafeSandboxSpec,
  assertSafeSpec,
  assertSnapshotLimits,
  createSandbox,
  type SandboxSpec,
  type SnapshotInfo,
} from "./daytona";

/**
 * The validation in front of provisioning, tested for what it refuses.
 *
 * A reproduction sandbox that comes up with network looks exactly like one that came up
 * correctly, right until a proof-of-concept uses it. So these assert that the unsafe spec
 * throws before any network call, rather than being corrected and logged.
 */
const spec: SandboxSpec = {
  snapshot: "juice-shop-v17.3.0",
  cpu: 2,
  memoryGb: 2,
  diskGb: 10,
  ttlMinutes: 20,
};

const snapshot: SnapshotInfo = {
  id: "snap-1",
  name: "juice-shop-v17.3.0",
  imageName: "ghcr.io/example/juice-shop@sha256:abc",
  state: "active",
  cpu: 2,
  mem: 2,
  disk: 10,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Swap fetch for the duration of one test, and always put the real one back. */
async function withFetch(stub: typeof fetch, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a well-formed spec is accepted", () => {
  assert.doesNotThrow(() => assertSafeSpec(spec));
});

test("a snapshot identifier that did not come from a profile is refused", () => {
  for (const snapshot of ["", "  ", "a".repeat(201), "juice; rm -rf /", "$(whoami)", "a b"]) {
    assert.throws(() => assertSafeSpec({ ...spec, snapshot }), UnsafeSandboxSpec, snapshot);
  }
});

test("limits and a time-to-live are mandatory and positive", () => {
  for (const patch of [
    { cpu: 0 }, { cpu: -1 }, { memoryGb: 0 }, { diskGb: 0 },
    { ttlMinutes: 0 }, { ttlMinutes: -5 }, { cpu: Number.NaN },
  ]) {
    assert.throws(() => assertSafeSpec({ ...spec, ...patch }), UnsafeSandboxSpec, JSON.stringify(patch));
  }

  // Below the provider's documented floor the request is silently raised, which would make the
  // limit we recorded untrue.
  assert.throws(() => assertSafeSpec({ ...spec, memoryGb: 0.5 }), UnsafeSandboxSpec);
});

test("a snapshot that does not declare a limit has not proved it", () => {
  // Limits cannot be requested, so the snapshot record is the only evidence there is. Silence
  // is not agreement.
  assert.doesNotThrow(() => assertSnapshotLimits(spec, snapshot));
  for (const missing of [{ cpu: null }, { mem: null }, { disk: null }] as Partial<SnapshotInfo>[]) {
    assert.throws(
      () => assertSnapshotLimits(spec, { ...snapshot, ...missing }),
      UnsafeSandboxSpec,
      JSON.stringify(missing),
    );
  }
});

test("an unsafe spec never reaches the network", async () => {
  let called = false;
  const stub = (async () => {
    called = true;
    return json({});
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox({ ...spec, snapshot: "$(whoami)" }), UnsafeSandboxSpec);
    assert.equal(called, false, "provisioning was attempted despite an unsafe spec");
  });
});

test("the request blocks all network, names the resolved id, and carries no secrets", async () => {
  const sent: Record<string, unknown>[] = [];

  // createSandbox reads the snapshot first, because the provider refuses resource fields
  // alongside a snapshot and the limits therefore have to be verified rather than requested.
  const stub = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/snapshots/")) return json(snapshot);
    sent.push(JSON.parse(init?.body as string));
    return json({ id: "sb-1", state: "started" });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await createSandbox(spec);
  });

  const [body] = sent;

  // No argument grants network, so there is nothing a caller can pass to get one.
  assert.equal(body.networkBlockAll, true);
  assert.equal("domainAllowList" in body, false);

  // The caller passed a display name; the create names the immutable id the lookup returned,
  // so a name repointed in between cannot swap the artifact underneath us.
  assert.equal(body.snapshot, "snap-1");

  // The hostile runtime holds no platform credential, and the way to be sure is that no code
  // path puts one there.
  assert.equal("env" in body, false, "env must never be sent");
  assert.equal("secrets" in body, false, "secrets must never be sent");
  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes("dtn_"), false, "the Daytona key must not appear in a body");
  assert.equal(/ghs_|ghp_|github_pat_|postgres:\/\//.test(serialised), false);

  // A sandbox with no ceiling outlives the run that made it.
  assert.equal(body.ttlMinutes, 20);
});

test("a snapshot whose limits differ from the run's is refused", async () => {
  const stub = (async (input: unknown) => {
    // Same snapshot name, but it was rebuilt with more memory than this run asked for.
    if (String(input).includes("/snapshots/")) return json({ ...snapshot, mem: 8 });
    throw new Error("provisioning was attempted despite a limit mismatch");
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), UnsafeSandboxSpec);
  });
});

test("an inactive snapshot is refused before provisioning", async () => {
  const stub = (async (input: unknown) => {
    if (String(input).includes("/snapshots/")) return json({ ...snapshot, state: "building" });
    throw new Error("provisioning was attempted against a snapshot that is not active");
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), UnsafeSandboxSpec);
  });
});
