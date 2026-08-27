import assert from "node:assert/strict";
import test from "node:test";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";

import {
  DaytonaError,
  MAX_EXEC_SECONDS,
  MAX_TTL_MINUTES,
  UnsafeSandboxSpec,
  assertSafeSpec,
  assertSandboxGone,
  assertSnapshotImage,
  assertSnapshotLimits,
  createSandbox,
  deleteSandbox,
  execute,
  listSandboxes,
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
const IMAGE_REF = `ghcr.io/example/juice-shop@sha256:${"a".repeat(64)}`;

const spec: SandboxSpec = {
  snapshot: "juice-shop-v17.3.0",
  imageRef: IMAGE_REF,
  cpu: 2,
  memoryGb: 2,
  diskGb: 10,
  ttlMinutes: 20,
};

const snapshot: SnapshotInfo = {
  id: "snap-1",
  name: "juice-shop-v17.3.0",
  imageName: IMAGE_REF,
  state: "active",
  cpu: 2,
  mem: 2,
  disk: 10,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Restoring in a finally matters: a leaked stub makes the *next* test fail, somewhere else.
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

test("imageRef must be a digest-pinned reference, not a mutable tag", () => {
  for (const imageRef of [
    "",
    "ghcr.io/example/juice-shop:v17.3.0",
    "ghcr.io/example/juice-shop@sha256:" + "a".repeat(63),
    "ghcr.io/example/juice-shop@sha256:" + "g".repeat(64),
    "ghcr.io/example/juice-shop",
  ]) {
    assert.throws(() => assertSafeSpec({ ...spec, imageRef }), UnsafeSandboxSpec, imageRef);
  }
});

test("a snapshot built from a different image is refused", () => {
  assert.doesNotThrow(() => assertSnapshotImage(spec, snapshot));

  assert.throws(
    () => assertSnapshotImage(spec, { ...snapshot, imageName: `ghcr.io/example/juice-shop@sha256:${"b".repeat(64)}` }),
    UnsafeSandboxSpec,
  );
  assert.throws(
    () => assertSnapshotImage(spec, { ...snapshot, imageName: null }),
    UnsafeSandboxSpec,
    "a snapshot silent about its image has not shown us anything",
  );
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
    return json({ id: "sb-1", state: "started", public: false });
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

test("provisioning refuses a snapshot built from a different image", async () => {
  const stub = (async (input: unknown) => {
    // Right name, right limits, wrong build. This is exactly the case a name-only check
    // would miss.
    if (String(input).includes("/snapshots/")) {
      return json({ ...snapshot, imageName: `ghcr.io/example/juice-shop@sha256:${"c".repeat(64)}` });
    }
    throw new Error("provisioning was attempted against the wrong image");
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

test("a sandbox is never asked for publicly, and one that comes up public is destroyed", async () => {
  const sent: Record<string, unknown>[] = [];
  let deleted: string | null = null;

  const stub = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/snapshots/")) return json(snapshot);
    if (init?.method === "DELETE") {
      deleted = url.split("/sandbox/")[1];
      return new Response(null, { status: 204 });
    }
    sent.push(JSON.parse(init?.body as string));
    // The provider disagreeing with what we asked for is the case worth handling.
    return json({ id: "sb-public", state: "started", public: true });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), UnsafeSandboxSpec);
  });

  assert.equal(sent[0].public, false, "provisioning must ask for a private sandbox");
  assert.equal(deleted, "sb-public", "a sandbox that came up public must not be left running");
});

test("a time-to-live must be whole minutes and within our own ceiling", () => {
  assert.throws(() => assertSafeSpec({ ...spec, ttlMinutes: 10.5 }), UnsafeSandboxSpec);
  assert.throws(() => assertSafeSpec({ ...spec, ttlMinutes: MAX_TTL_MINUTES + 1 }), UnsafeSandboxSpec);
  assert.doesNotThrow(() => assertSafeSpec({ ...spec, ttlMinutes: MAX_TTL_MINUTES }));
});

/**
 * Teardown is the part that only misbehaves under conditions a live run rarely reproduces:
 * a sandbox still settling, a sandbox already gone, a provider having a bad minute. Stubbing
 * is the only way to see all three in the same second.
 */
test("teardown retries a 409 and stops as soon as one takes", async () => {
  let calls = 0;
  const stub = (async () => {
    calls++;
    return calls < 3
      ? new Response("Sandbox state change in progress", { status: 409 })
      : new Response(null, { status: 204 });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await deleteSandbox("sb-1", 6, 1);
  });
  assert.equal(calls, 3);
});

test("teardown treats an already-gone sandbox as success", async () => {
  const stub = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  await withFetch(stub, async () => {
    await deleteSandbox("sb-1", 6, 1);
  });
});

test("teardown gives up loudly rather than pretending", async () => {
  let calls = 0;
  const stub = (async () => {
    calls++;
    return new Response("Sandbox state change in progress", { status: 409 });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(deleteSandbox("sb-1", 3, 1), DaytonaError);
  });
  assert.equal(calls, 3, "every attempt should be used before giving up");
});

test("teardown does not retry an error that is not a 409", async () => {
  let calls = 0;
  const stub = (async () => {
    calls++;
    return new Response("nope", { status: 401 });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(deleteSandbox("sb-1", 6, 1), DaytonaError);
  });
  assert.equal(calls, 1, "a 401 will not fix itself");
});

test("only a 404 proves a sandbox is gone", async () => {
  // The whole point: "we could not reach the provider" must never be recorded as "destroyed".
  await withFetch((async () => new Response("gone", { status: 404 })) as typeof fetch, async () => {
    await assertSandboxGone("sb-1");
  });

  await withFetch((async () => json({ id: "sb-1", state: "started" })) as typeof fetch, async () => {
    await assert.rejects(assertSandboxGone("sb-1"), /still exists/);
  });

  await withFetch((async () => new Response("boom", { status: 500 })) as typeof fetch, async () => {
    await assert.rejects(assertSandboxGone("sb-1"), DaytonaError);
  });

  await withFetch((async () => { throw new TypeError("network down"); }) as typeof fetch, async () => {
    await assert.rejects(assertSandboxGone("sb-1"), TypeError);
  });
});

test("a labelled listing follows every page", async () => {
  // A sweep that stops at page one leaves the rest running, which is the failure this exists
  // to prevent rather than a tidiness concern.
  const pages: Record<string, unknown> = {
    "": { items: [{ id: "a" }], nextCursor: "p2" },
    p2: { items: [{ id: "b" }], nextCursor: "p3" },
    p3: { items: [{ id: "c" }], nextCursor: null },
  };

  const stub = (async (input: unknown) => {
    const cursor = new URL(String(input)).searchParams.get("cursor") ?? "";
    return json(pages[cursor]);
  }) as typeof fetch;

  await withFetch(stub, async () => {
    const found = await listSandboxes({ "bountydesk.purpose": "reproduction" });
    assert.deepEqual(found.map((s) => s.id), ["a", "b", "c"]);
  });
});

test("executing a command addresses the toolbox proxy by sandbox id", async () => {
  let seen = "";
  const stub = (async (input: unknown) => {
    seen = String(input);
    return json({ exitCode: 0, result: "ok\n" });
  }) as typeof fetch;

  const sandbox = { id: "sb-1", toolboxProxyUrl: "https://proxy.example/" } as Parameters<typeof execute>[0];

  await withFetch(stub, async () => {
    const result = await execute(sandbox, "echo ok");
    assert.equal(result.exitCode, 0);
    assert.equal(result.result, "ok\n");
  });

  assert.equal(seen, "https://proxy.example/sb-1/process/execute");
});

test("a sandbox with no toolbox proxy cannot be asked to run anything", async () => {
  const sandbox = { id: "sb-1", toolboxProxyUrl: null } as Parameters<typeof execute>[0];
  await assert.rejects(execute(sandbox, "echo ok"), DaytonaError);
});

test("a toolbox response with no exit status is a failure, not a success", async () => {
  // Defaulting a missing status to zero would report a changed or truncated response as a
  // command that worked, which is the wrong direction to guess in.
  const sandbox = { id: "sb-1", toolboxProxyUrl: "https://proxy.example" } as Parameters<typeof execute>[0];

  await withFetch((async () => json({ result: "output but no status" })) as typeof fetch, async () => {
    await assert.rejects(execute(sandbox, "echo ok"), DaytonaError);
  });

  // The mirror image: a status with no result. Defaulting it to "" would show a truncated
  // response to a probe that reads output as a command that ran and printed nothing.
  await withFetch((async () => json({ exitCode: 0 })) as typeof fetch, async () => {
    await assert.rejects(execute(sandbox, "echo ok"), DaytonaError);
  });

  await withFetch((async () => json({ exitCode: 1.5, result: "" })) as typeof fetch, async () => {
    await assert.rejects(execute(sandbox, "echo ok"), DaytonaError);
  });

  // A cast is a promise to the compiler, not a check.
  await withFetch((async () => json({ exitCode: 0, result: {} })) as typeof fetch, async () => {
    await assert.rejects(execute(sandbox, "echo ok"), DaytonaError);
  });

  await withFetch((async () => json({ code: 3, result: "" })) as typeof fetch, async () => {
    assert.equal((await execute(sandbox, "false")).exitCode, 3);
  });
});

test("a public sandbox that cannot be destroyed is reported as still running", async () => {
  // Saying "destroyed" after a failed delete would hide a reachable hostile sandbox behind a
  // reassuring message.
  const stub = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/snapshots/")) return json(snapshot);
    if (init?.method === "DELETE") return new Response("nope", { status: 500 });
    return json({ id: "sb-public", state: "started", public: true });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), /could not be confirmed destroyed[\s\S]*may be reachable/);
  });
});

test("a delete the provider accepted is not proof the sandbox is gone", async () => {
  // The DELETE succeeds and the sandbox is still there. Only assertSandboxGone catches that,
  // which is why rejecting a sandbox does both.
  const stub = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/snapshots/")) return json(snapshot);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (String(input).includes("/sandbox/")) return json({ id: "sb-public", state: "started" });
    return json({ id: "sb-public", state: "started", public: true });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), /could not be confirmed destroyed/);
  });
});

test("a sandbox that does not say whether it is public is not assumed private", async () => {
  // An omitted field is not a false. A provider that stops sending it would otherwise turn
  // every sandbox into a private one by default.
  let deleted = false;
  const stub = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("/snapshots/")) return json(snapshot);
    if (init?.method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (String(input).includes("/sandbox/")) return new Response("gone", { status: 404 });
    return json({ id: "sb-unknown", state: "started" });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), /did not report whether it is public/);
  });
  assert.equal(deleted, true, "an ambiguous sandbox must not be left running");
});

test("provisioning without a sandbox id is unusable, not merely odd", async () => {
  const stub = (async (input: unknown) => {
    if (String(input).includes("/snapshots/")) return json(snapshot);
    return json({ state: "started", public: false });
  }) as typeof fetch;

  await withFetch(stub, async () => {
    await assert.rejects(createSandbox(spec), /no sandbox id/);
  });
});

test("a command timeout must be whole seconds within our own ceiling", async () => {
  const sandbox = { id: "sb-1", toolboxProxyUrl: "https://proxy.example" } as Parameters<typeof execute>[0];

  // Zero is the dangerous one: it can leave the sandbox with no deadline of its own while the
  // HTTP request still aborts, so the command keeps running with nothing watching it.
  for (const seconds of [0, -1, 1.5, MAX_EXEC_SECONDS + 1, Number.NaN]) {
    await assert.rejects(execute(sandbox, "echo ok", seconds), UnsafeSandboxSpec, String(seconds));
  }
});
