import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before, mock } from "node:test";

import type { ReproduceFn, ReproductionRecipe } from "@/lib/reproduction/types";
import { EXPECTED_BUILD_MARKER } from "@/lib/targets/configure";

import type { ExecResult, Sandbox, SandboxSpec, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
// Keeps the "never becomes ready" test fast: production's real 90s ceiling would otherwise
// make every run of this file sit through a real timeout for no reason.
process.env.BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS = "30";
process.env.BOUNTYDESK_REPRODUCE_READINESS_POLL_MS = "5";

const TARGET_PROFILE_ID = "profile-under-test";

type TestReproductionAuthorization =
  | {
      ok: true;
      imageName: string;
      imageDigest: string;
      snapshotId: string | null;
      appPort: number;
      recipe: ReproductionRecipe;
    }
  | { ok: false; reason: "NO_BOUND_TARGET" | "NO_APPROVED_ORACLE" };

/**
 * The seam this whole file rests on: reproduce.ts imports its sandbox lifecycle from
 * "./daytona", so replacing that module (before reproduce.ts is ever imported) lets these
 * tests exercise the real decision wiring, evidence hashing and teardown behaviour with no
 * live sandbox and no real Daytona credentials -- the same tool this codebase already uses in
 * lib/e2e/trueforge-approval-flow.test.ts to fake TrueForge at its client seam.
 */
const FAKE_SANDBOX: Sandbox = {
  id: "sandbox-under-test",
  state: "started",
  snapshot: "snap",
  networkBlockAll: true,
  networkAllowList: null,
  domainAllowList: null,
  toolboxProxyUrl: "https://toolbox.example",
  runnerId: "runner-1",
  sandboxClass: "container",
  public: false,
};

const FAKE_SNAPSHOT: SnapshotInfo = {
  id: "snap",
  name: "snap",
  imageName: "ghcr.io/vaibhav91one/juice-shop@sha256:" + "a".repeat(64),
  state: "active",
  cpu: 1,
  mem: 1,
  disk: 3,
};

let createSandboxCalls: SandboxSpec[] = [];
let deleteSandboxCalls: string[] = [];
let executeCalls: string[] = [];
let authorizeCalls: { targetProfileId: string; recipeId: string }[] = [];

/** Every test in this file passes `imageDigest: "sha256:" + "a".repeat(64)` (or the equivalent
 * derived from FAKE_SNAPSHOT), so the default execute() stub answers the build-marker read
 * with the marker reproduce.ts actually expects -- otherwise every existing test in this file
 * would start failing at the buildMarkerCheck gate instead of testing what it already tests. */
const BUILD_MARKER_COMMAND_FRAGMENT = "bountydesk-build-marker";

function defaultExecuteResult(command: string): ExecResult {
  if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
    return { exitCode: 0, result: `${EXPECTED_BUILD_MARKER}\n` };
  }
  if (command.includes("command -v curl")) {
    return { exitCode: 0, result: "CURL_PRESENT\n" };
  }
  if (command.includes("bountydesk-egress")) {
    return { exitCode: 0, result: "PROBE curl_exit=0 status=403\nBODY Internet is restricted\n" };
  }
  return { exitCode: 0, result: "200" };
}

/** Overridable per test: lets a test make provisioning, readiness or teardown fail without
 * touching the shared default. */
let createSandboxImpl: (spec: SandboxSpec) => Promise<Sandbox> = async (spec) => {
  createSandboxCalls.push(spec);
  return FAKE_SANDBOX;
};
let getSandboxImpl: (id: string) => Promise<Sandbox> = async () => FAKE_SANDBOX;
let executeImpl: (sandbox: Sandbox, command: string) => Promise<ExecResult> = async (_sandbox, command) => {
  executeCalls.push(command);
  // Any status starting with 2 satisfies waitForAppReady's readiness regex; the start-app
  // call's result is never inspected, so the same canned answer covers both execute() calls.
  return defaultExecuteResult(command);
};
let deleteSandboxImpl: (id: string) => Promise<void> = async (id) => {
  deleteSandboxCalls.push(id);
};
let authorizeImpl: (input: {
  targetProfileId: string;
  recipeId: string;
}) => Promise<TestReproductionAuthorization> = async (input) => {
  authorizeCalls.push(input);
  return {
    ok: true,
    imageName: "ghcr.io/vaibhav91one/juice-shop",
    imageDigest: "sha256:" + "a".repeat(64),
    snapshotId: "snap",
    appPort: 3000,
    recipe,
  };
};

mock.module("./daytona", {
  namedExports: {
    createSandbox: (spec: SandboxSpec) => createSandboxImpl(spec),
    getSandbox: (id: string) => getSandboxImpl(id),
    execute: (sandbox: Sandbox, command: string) => executeImpl(sandbox, command),
    deleteSandbox: (id: string) => deleteSandboxImpl(id),
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

let reproduce: ReproduceFn;
let positiveIntegerEnv: (name: string, fallback: number) => number;

before(async () => {
  const reproduceModule = await import("./reproduce");
  const { createReproducer } = reproduceModule;
  positiveIntegerEnv = reproduceModule.positiveIntegerEnv;
  reproduce = createReproducer((input) => authorizeImpl(input));
});

test("positiveIntegerEnv falls back for invalid timing values", () => {
  const key = "BOUNTYDESK_TEST_TIMING_VALUE";
  const old = process.env[key];
  try {
    for (const value of ["0", "-1", "Infinity", "nope"]) {
      process.env[key] = value;
      assert.equal(positiveIntegerEnv(key, 123), 123);
    }
    process.env[key] = "456";
    assert.equal(positiveIntegerEnv(key, 123), 456);
  } finally {
    if (old === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = old;
    }
  }
});

function resetSpies(): void {
  createSandboxCalls = [];
  deleteSandboxCalls = [];
  executeCalls = [];
  authorizeCalls = [];
  createSandboxImpl = async (spec) => {
    createSandboxCalls.push(spec);
    return FAKE_SANDBOX;
  };
  getSandboxImpl = async () => FAKE_SANDBOX;
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    return defaultExecuteResult(command);
  };
  deleteSandboxImpl = async (id) => {
    deleteSandboxCalls.push(id);
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: "sha256:" + "a".repeat(64),
      snapshotId: "snap",
      appPort: 3000,
      recipe,
    };
  };
}

const CANARY_HEADER = "x-daytona-preview-token";
const PREVIEW_URL = "https://preview.example";
const PREVIEW_TOKEN = "preview-token-123";

type FetchCall = { url: string; init?: RequestInit; canary: string | null };

/**
 * A fetch stub that plays the two roles reproduce.ts asks of it: Daytona's control-plane
 * preview-url lookup, and the direct sandbox-facing calls for the fixture, negative control
 * and exploit. Routed on path, not call order, so tests can't accidentally pass by coincidence
 * of ordering. The canary is read back out of whatever body was actually sent -- the same
 * value the fixture just registered -- so a test never has to guess reproduce.ts's random
 * output ahead of time.
 */
function fetchStub(
  calls: FetchCall[],
  responses: {
    fixtureStatus?: number;
    fixtureHeaders?: HeadersInit;
    negativeControlStatus?: number;
    negativeControlHeaders?: HeadersInit;
    exploitStatus?: number;
    exploitHeaders?: HeadersInit;
    negativeControlBody: (canary: string) => string;
    exploitBody: (canary: string) => string;
  },
): typeof fetch {
  let lastCanary: string | null = null;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/ports/") && url.endsWith("/preview-url")) {
      calls.push({ url, init, canary: null });
      return new Response(
        JSON.stringify({ sandboxId: FAKE_SANDBOX.id, url: PREVIEW_URL, token: PREVIEW_TOKEN }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const headers = new Headers(init?.headers);
    assert.equal(headers.get(CANARY_HEADER), PREVIEW_TOKEN, "every sandbox-facing call must carry the preview token");

    const path = new URL(url).pathname;
    if (path === "/fixture") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      lastCanary = body.email ?? null;
      calls.push({ url, init, canary: lastCanary });
      return new Response(JSON.stringify({ status: "success" }), {
        status: responses.fixtureStatus ?? 201,
        headers: responses.fixtureHeaders,
      });
    }
    if (path === "/negative") {
      calls.push({ url, init, canary: lastCanary });
      return new Response(responses.negativeControlBody(lastCanary ?? ""), {
        status: responses.negativeControlStatus ?? 200,
        headers: responses.negativeControlHeaders,
      });
    }
    if (path === "/exploit") {
      calls.push({ url, init, canary: lastCanary });
      return new Response(responses.exploitBody(lastCanary ?? ""), {
        status: responses.exploitStatus ?? 200,
        headers: responses.exploitHeaders,
      });
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

const recipe: ReproductionRecipe = {
  id: "test-recipe",
  title: "a test recipe",
  keywords: ["test recipe"],
  fixture: { request: { method: "POST", path: "/fixture", body: { email: "{{canary}}" } } },
  negativeControl: { method: "GET", path: "/negative" },
  exploit: { method: "GET", path: "/exploit" },
  oracleCheck: (response, canary) => response.body.includes(canary),
};

function reproduceInput(overrides: Partial<Parameters<typeof reproduce>[0]> = {}) {
  return {
    targetProfileId: TARGET_PROFILE_ID,
    imageName: "ghcr.io/vaibhav91one/juice-shop",
    imageDigest: "sha256:" + "a".repeat(64),
    snapshotId: "snap",
    recipe,
    ...overrides,
  };
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a clean negative control and a found canary reproduces, with hashed evidence", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput({ imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1] })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  if (outcome.outcome !== "REPRODUCED") return;

  const canary = calls.find((c) => c.canary)?.canary;
  assert.ok(canary, "the fixture call should have carried a generated canary");
  assert.equal(outcome.evidence.canaryHash, createHash("sha256").update(canary!).digest("hex"));
  assert.equal(outcome.evidence.sandboxId, FAKE_SANDBOX.id);
  assert.equal(outcome.evidence.recipeId, "test-recipe");
  assert.equal(outcome.evidence.fixture.ranToCompletion, true);
  assert.equal(outcome.evidence.negativeControl.canaryFound, false);
  assert.equal(outcome.evidence.exploit.canaryFound, true);
  assert.equal(outcome.evidence.requestBodyHashes.fixture.dispatched, true);
  assert.ok(outcome.evidence.requestBodyHashes.fixture.sha256, "the fixture body carried the canary and must be hashed");
  assert.deepEqual(
    outcome.evidence.requestBodyHashes.negativeControl,
    { dispatched: true, sha256: null },
    "a dispatched GET with no body records dispatch without inventing a hash",
  );
  assert.deepEqual(outcome.evidence.requestBodyHashes.exploit, { dispatched: true, sha256: null });

  assert.ok(!JSON.stringify(outcome.evidence).includes(canary!));

  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id], "the sandbox must always be torn down");
  assert.ok(
    executeCalls.some((c) => c.includes(BUILD_MARKER_COMMAND_FRAGMENT)),
    "a matching build marker must not skip the check -- it has to actually run and pass",
  );
  assert.deepEqual(
    createSandboxCalls[0]?.labels,
    { "bountydesk.recipe": "test-recipe", "bountydesk.targetProfileId": TARGET_PROFILE_ID },
    "the target profile that authorized this run must be threaded through for audit",
  );
  assert.deepEqual(authorizeCalls, [{ targetProfileId: TARGET_PROFILE_ID, recipeId: "test-recipe" }]);
});

test("an unauthorized target profile stops before provisioning a sandbox", async () => {
  resetSpies();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return { ok: false, reason: "NO_BOUND_TARGET" };
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "NO_BOUND_TARGET");
  assert.deepEqual(createSandboxCalls, []);
  assert.deepEqual(deleteSandboxCalls, []);
});

test("caller-supplied image and snapshot values are replaced by the bound target profile", async () => {
  resetSpies();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1]!,
      snapshotId: "authorized-snapshot",
      appPort: 3000,
      recipe,
    };
  };
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () =>
      reproduce(
        reproduceInput({
          imageDigest: "sha256:" + "b".repeat(64),
          snapshotId: "caller-snapshot",
        }),
      ),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  assert.equal(createSandboxCalls[0]?.snapshot, "authorized-snapshot");
  assert.equal(createSandboxCalls[0]?.imageRef, FAKE_SNAPSHOT.imageName);
});

test("the authorized target profile port drives readiness and preview lookup", async () => {
  resetSpies();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1]!,
      snapshotId: "snap",
      appPort: 8080,
      recipe,
    };
  };
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  assert.ok(executeCalls.some((command) => command.includes("http://localhost:8080/")));
  assert.ok(calls.some((call) => call.url.includes("/ports/8080/preview-url")));
});

test("an already-aborted signal stops before authorization or provisioning", async () => {
  resetSpies();
  const controller = new AbortController();
  const reason = new Error("lease lost");
  controller.abort(reason);

  await assert.rejects(() => reproduce(reproduceInput(), { signal: controller.signal }), reason);
  assert.deepEqual(authorizeCalls, []);
  assert.deepEqual(createSandboxCalls, []);
  assert.deepEqual(deleteSandboxCalls, []);
});

test("egress policy mismatch fails closed before app startup or oracle requests", async () => {
  resetSpies();
  createSandboxImpl = async (spec) => {
    createSandboxCalls.push(spec);
    return FAKE_SANDBOX;
  };
  getSandboxImpl = async () => ({ ...FAKE_SANDBOX, networkBlockAll: false });
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "COULD_NOT_DEPLOY");
  assert.ok(!executeCalls.some((command) => command.includes("nohup node build/app")));
  assert.ok(!calls.some((call) => !call.url.includes("/ports/")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("recipe headers cannot override the Daytona preview token", async () => {
  resetSpies();
  const headerRecipe: ReproductionRecipe = {
    ...recipe,
    fixture: {
      request: {
        ...recipe.fixture.request,
        headers: { "X-Daytona-Preview-Token": "recipe-supplied-token" },
      },
    },
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: "sha256:" + "a".repeat(64),
      snapshotId: "snap",
      appPort: 3000,
      recipe: headerRecipe,
    };
  };
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: headerRecipe })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
});

test("a mismatched build marker reports COULD_NOT_DEPLOY, tears down, and never reaches the oracle", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: "not-the-expected-commit\n" };
    }
    return defaultExecuteResult(command);
  };

  // No fetch stub installed: if the marker check failed to short-circuit the flow, the next
  // step (the real preview-url lookup) would hit the network and this test would fail loudly
  // rather than quietly passing on the wrong path.
  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "COULD_NOT_DEPLOY");
  assert.ok(!executeCalls.some((command) => command.includes("nohup node build/app")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id], "a marker mismatch still tears the sandbox down");
});

test("an execute() failure while reading the build marker fails closed, same as a mismatch", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) throw new Error("toolbox unreachable");
    return defaultExecuteResult(command);
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "COULD_NOT_DEPLOY");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a clean negative control and no canary found does not reproduce", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ data: [] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a rejected fixture (non-2xx) stops the run before the negative control or exploit ever fire", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      fixtureStatus: 500,
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ data: [] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
    assert.equal(outcome.evidence?.fixture?.ranToCompletion, false);
    assert.equal(outcome.evidence?.negativeControl?.ranToCompletion, false);
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
  }
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/negative"),
    "the negative control must never run once the fixture is rejected",
  );
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/exploit"),
    "the exploit must never run once the fixture is rejected",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id], "the sandbox is still torn down");
});

test("a redirecting fixture does not follow the target outside the preview origin", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      fixtureStatus: 307,
      fixtureHeaders: { location: "https://attacker.example/steal" },
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.ok(!calls.some((call) => call.url.startsWith("https://attacker.example")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a redirecting exploit leg is incomplete, not sandbox evidence", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitStatus: 302,
      exploitHeaders: { location: "https://attacker.example/result" },
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
  }
  assert.ok(!calls.some((call) => call.url.startsWith("https://attacker.example")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("an error response from an oracle leg is incomplete, not NOT_REPRODUCED", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitStatus: 502,
      exploitBody: () => JSON.stringify({ error: "preview unavailable" }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
  }
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("an oversized oracle response is incomplete and does not stay buffered", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => "x".repeat(1_000_001),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
  }
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a dirty negative control (canary already present) is never trusted, and the exploit never runs", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/exploit"),
    "a dirty negative control must stop the run before the exploit is attempted at all",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a negative control that never completes stops the run before the exploit ever fires", async () => {
  resetSpies();
  const throwingRecipe: ReproductionRecipe = {
    ...recipe,
    oracleCheck: (response, canary) => {
      if (response.body.includes("boom")) throw new Error("malformed negative-control response");
      return response.body.includes(canary);
    },
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: "sha256:" + "a".repeat(64),
      snapshotId: "snap",
      appPort: 3000,
      recipe: throwingRecipe,
    };
  };
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => "boom",
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: throwingRecipe })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.negativeControl?.ranToCompletion, false);
  }
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/exploit"),
    "an incomplete negative control must stop the run before the exploit is attempted at all",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("an exploit oracleCheck that throws never guesses REPRODUCED, but keeps the body hash it already sent", async () => {
  resetSpies();
  const throwingRecipe: ReproductionRecipe = {
    ...recipe,
    exploit: { method: "POST", path: "/exploit", body: { q: "{{canary}}" } },
    oracleCheck: (response) => {
      if (response.body.includes("boom")) throw new Error("malformed response");
      return false;
    },
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: "sha256:" + "a".repeat(64),
      snapshotId: "snap",
      appPort: 3000,
      recipe: throwingRecipe,
    };
  };
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => "boom",
    }),
    () => reproduce(reproduceInput({ recipe: throwingRecipe })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
    // sendToSandbox actually sent the exploit request and computed its hash before oracleCheck
    // threw; that hash must survive, not collapse to null just because what came after failed.
    assert.ok(
      outcome.evidence?.requestBodyHashes?.exploit?.dispatched &&
        outcome.evidence.requestBodyHashes.exploit.sha256,
      "a request that was genuinely dispatched must keep its body hash even if the oracle check after it throws",
    );
  }
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a sandbox that never provisions reports COULD_NOT_DEPLOY and tears down nothing", async () => {
  resetSpies();
  createSandboxImpl = async () => {
    throw new Error("daytona is down");
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "COULD_NOT_DEPLOY");
  assert.deepEqual(deleteSandboxCalls, [], "nothing to tear down when provisioning itself failed");
});

test("a sandbox that never answers its port reports TARGET_UNAVAILABLE and still tears down", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (!command.includes("http://localhost")) return defaultExecuteResult(command);
    return { exitCode: 0, result: "000" };
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a failed app start reports TARGET_UNAVAILABLE without waiting for readiness probes", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes("nohup node build/app")) {
      return { exitCode: 1, result: "missing build/app" };
    }
    return defaultExecuteResult(command);
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.equal(executeCalls.filter((command) => command.includes("http://localhost:3000/")).length, 0);
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a missing snapshot id short-circuits before touching the sandbox client at all", async () => {
  resetSpies();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return {
      ok: true,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: "sha256:" + "a".repeat(64),
      snapshotId: null,
      appPort: 3000,
      recipe,
    };
  };
  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.deepEqual(createSandboxCalls, []);
  assert.deepEqual(deleteSandboxCalls, []);
});

test("cancellation during readiness tears down the sandbox and rejects the run", async () => {
  resetSpies();
  const controller = new AbortController();
  const reason = new Error("lease lost");
  let probes = 0;
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: `${EXPECTED_BUILD_MARKER}\n` };
    }
    if (!command.includes("http://localhost")) return defaultExecuteResult(command);
    probes += 1;
    if (probes === 2) controller.abort(reason);
    return { exitCode: 0, result: "000" };
  };

  await assert.rejects(() => reproduce(reproduceInput(), { signal: controller.signal }), reason);
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("cancellation during build marker check tears down and rejects the run", async () => {
  resetSpies();
  const controller = new AbortController();
  const reason = new Error("lease lost");
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      controller.abort(reason);
      return { exitCode: 0, result: `${EXPECTED_BUILD_MARKER}\n` };
    }
    return defaultExecuteResult(command);
  };

  await assert.rejects(() => reproduce(reproduceInput(), { signal: controller.signal }), reason);
  assert.ok(!executeCalls.some((command) => command.includes("nohup node build/app")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("teardown failure is surfaced with the sandbox id", async () => {
  resetSpies();
  deleteSandboxImpl = async (id) => {
    throw new Error(`delete failed for ${id}`);
  };
  const calls: FetchCall[] = [];

  await assert.rejects(
    () =>
      withFetch(
        fetchStub(calls, {
          negativeControlBody: () => JSON.stringify({ data: [] }),
          exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
        }),
        () => reproduce(reproduceInput()),
      ),
    /failed to delete reproduction sandbox sandbox-under-test/,
  );
});

test("teardown still runs when an unexpected error happens after provisioning", async () => {
  resetSpies();
  // No fetch stub installed: getPortPreviewUrl's call to Daytona's real API will fail against
  // whatever the environment's real fetch does, which is exactly the "unexpected error" this
  // asserts recovers safely. Point it at a host that refuses the connection outright.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;

  try {
    const outcome = await reproduce(reproduceInput());
    assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});
