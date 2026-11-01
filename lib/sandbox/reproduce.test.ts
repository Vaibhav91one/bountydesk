import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before, mock } from "node:test";

import type { ReproduceFn, ReproductionRecipe } from "@/lib/reproduction/types";
import { getRecipesForTarget } from "@/lib/targets/recipes";
import { JUICE_SHOP_EXPECTED_BUILD_MARKER } from "@/lib/targets/registry";

import type { ExecResult, Sandbox, SandboxSpec, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
// Keeps the "never becomes ready" test fast: production's real 90s ceiling would otherwise
// make every run of this file sit through a real timeout for no reason.
process.env.BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS = "30";
process.env.BOUNTYDESK_REPRODUCE_READINESS_POLL_MS = "5";
process.env.BOUNTYDESK_OOB_SETTLE_MS = "0";

const TARGET_PROFILE_ID = "profile-under-test";

type TestReproductionAuthorization =
  | {
      ok: true;
      imageName: string;
      imageDigest: string;
      snapshotId: string | null;
      appPort: number;
      recipe: ReproductionRecipe;
      readinessPath: string;
      expectedBuildMarker: string;
      startCommand?: string;
      snapshotImageRefOverride?: string;
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
let createSandboxImageOverrides: Array<string | undefined> = [];
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
    return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
  }
  if (command.includes("command -v curl")) {
    // httpProbeTool checks for the literal "TOOL=curl" its detection script prints.
    return { exitCode: 0, result: "TOOL=curl\n" };
  }
  if (command.includes("bountydesk-egress")) {
    // runEgressProbe parses "PROBE exit=<n> status=<code>"; a 403 with the restriction body is
    // classifyEgressProbe's "blocked" signal, which is what a no-egress sandbox must prove.
    return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted\n" };
  }
  return { exitCode: 0, result: "200" };
}

/** Overridable per test: lets a test make provisioning, readiness or teardown fail without
 * touching the shared default. */
let createSandboxImpl: (
  spec: SandboxSpec,
  snapshotImageRefOverride?: string,
) => Promise<Sandbox> = async (spec, snapshotImageRefOverride) => {
  createSandboxCalls.push(spec);
  createSandboxImageOverrides.push(snapshotImageRefOverride);
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
  return authorizedTarget();
};

mock.module("./daytona", {
  namedExports: {
    createSandbox: (spec: SandboxSpec, snapshotImageRefOverride?: string) =>
      createSandboxImpl(spec, snapshotImageRefOverride),
    getSandbox: (id: string) => getSandboxImpl(id),
    execute: (sandbox: Sandbox, command: string) => executeImpl(sandbox, command),
    deleteSandbox: (id: string) => deleteSandboxImpl(id),
    listSandboxes: async (): Promise<Sandbox[]> => [],
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
  createSandboxImageOverrides = [];
  deleteSandboxCalls = [];
  executeCalls = [];
  authorizeCalls = [];
  createSandboxImpl = async (spec, snapshotImageRefOverride) => {
    createSandboxCalls.push(spec);
    createSandboxImageOverrides.push(snapshotImageRefOverride);
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
    return authorizedTarget();
  };
}

function authorizedTarget(
  overrides: Partial<Extract<TestReproductionAuthorization, { ok: true }>> = {},
): Extract<TestReproductionAuthorization, { ok: true }> {
  return {
    ok: true,
    imageName: "ghcr.io/vaibhav91one/juice-shop",
    imageDigest: "sha256:" + "a".repeat(64),
    snapshotId: "snap",
    appPort: 3000,
    recipe,
    readinessPath: "/",
    expectedBuildMarker: JUICE_SHOP_EXPECTED_BUILD_MARKER,
    startCommand: "cd /juice-shop && (nohup node build/app >/tmp/bountydesk-app.log 2>&1 &)",
    ...overrides,
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
    /** Only exercised by the exploitFollowUp tests below: a recipe's follow-up leg hits this
     * path, never the ones above. */
    followUpStatus?: number;
    followUpBody?: (canary: string) => string;
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
    if (path === "/followup") {
      calls.push({ url, init, canary: lastCanary });
      return new Response((responses.followUpBody ?? (() => ""))(lastCanary ?? ""), {
        status: responses.followUpStatus ?? 200,
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

/** A stand-in for the login-bypass shape: the exploit mints a token, and only a follow-up
 * request built from that token can prove anything -- oracleCheck on the exploit's own response
 * would just be "did a token come back", the exact gap this recipe field exists to close. */
const recipeWithFollowUp: ReproductionRecipe = {
  id: "test-recipe-follow-up",
  title: "a test recipe with a follow-up leg",
  keywords: ["test recipe"],
  fixture: { request: { method: "POST", path: "/fixture", body: { email: "{{canary}}" } } },
  negativeControl: { method: "GET", path: "/negative" },
  exploit: { method: "POST", path: "/exploit", body: { attempt: "bypass" } },
  oracleCheck: () => false,
  exploitFollowUp: {
    buildRequest: (exploitResponse) => {
      let parsed: { token?: string };
      try {
        parsed = JSON.parse(exploitResponse.body) as { token?: string };
      } catch {
        return undefined;
      }
      if (!parsed.token) return undefined;
      return { method: "GET", path: "/followup", headers: { Authorization: `Bearer ${parsed.token}` } };
    },
    oracleCheck: (response, canary) => response.body.includes(canary),
  },
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
    return authorizedTarget({
      imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1]!,
      snapshotId: "authorized-snapshot",
    });
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
    return authorizedTarget({
      imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1]!,
      appPort: 8080,
    });
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
  assert.ok(executeCalls.some((command) => command.includes("http://127.0.0.1:8080/")));
  assert.ok(calls.some((call) => call.url.includes("/ports/8080/preview-url")));
});

test("the authorized target provisioning drives sandbox startup and build verification", async () => {
  resetSpies();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({
      readinessPath: "/healthz",
      expectedBuildMarker: "custom-target-build",
      startCommand: "start-custom-target",
      snapshotImageRefOverride: "ghcr.io/vaibhav91one/custom-target:verified",
    });
  };
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: "custom-target-build\n" };
    }
    return defaultExecuteResult(command);
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
  assert.equal(createSandboxImageOverrides[0], "ghcr.io/vaibhav91one/custom-target:verified");
  assert.ok(executeCalls.some((command) => command.includes("start-custom-target")));
  assert.ok(
    executeCalls.some((command) => command.includes("http://127.0.0.1:3000/healthz")),
    "readiness must use the target profile's readiness path",
  );
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
    return authorizedTarget({ recipe: headerRecipe });
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
    return authorizedTarget({ recipe: throwingRecipe });
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
    return authorizedTarget({ recipe: throwingRecipe });
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
    if (!command.includes("http://127.0.0.1")) return defaultExecuteResult(command);
    return { exitCode: 0, result: "000" };
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a failed app start reports TARGET_UNAVAILABLE and tears the sandbox down", async () => {
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
  // The start command is launched detached, so its exit is not what flags a bad start any more; the
  // readiness poll finding the port unanswered is. So a failed start no longer short-circuits before
  // readiness, and the run still ends TARGET_UNAVAILABLE and tears the sandbox down.
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a missing snapshot id short-circuits before touching the sandbox client at all", async () => {
  resetSpies();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ snapshotId: null });
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
      return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
    }
    if (!command.includes("http://127.0.0.1")) return defaultExecuteResult(command);
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
      return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
    }
    return defaultExecuteResult(command);
  };

  await assert.rejects(() => reproduce(reproduceInput(), { signal: controller.signal }), reason);
  assert.ok(!executeCalls.some((command) => command.includes("nohup node build/app")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("cancellation reason survives a teardown failure", async () => {
  resetSpies();
  const controller = new AbortController();
  const reason = new Error("lease lost");
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      controller.abort(reason);
      return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
    }
    return defaultExecuteResult(command);
  };
  deleteSandboxImpl = async () => {
    throw new Error("delete failed");
  };

  await assert.rejects(() => reproduce(reproduceInput(), { signal: controller.signal }), reason);
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

test("cancellation during teardown does not hide a delete failure after success", async () => {
  resetSpies();
  const controller = new AbortController();
  deleteSandboxImpl = async (id) => {
    deleteSandboxCalls.push(id);
    controller.abort(new Error("lease lost during delete"));
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
        () => reproduce(reproduceInput(), { signal: controller.signal }),
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

test("readiness falls back to a listen-socket check when the image has no curl or wget", async () => {
  resetSpies();
  // python:3.11-slim and other minimal bases ship neither client; the port-listen fallback must
  // still let a bound app read as ready.
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
    }
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=none\n" };
    if (command.includes("/proc/net/tcp")) return { exitCode: 0, result: "LISTEN\n" };
    return { exitCode: 0, result: "" };
  };
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput({ imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1] })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  // Port 3000 is 0BB8 in the uppercase, zero-padded hex the fallback greps /proc/net/tcp for.
  assert.ok(
    executeCalls.some((c) => c.includes("/proc/net/tcp") && c.includes(":0BB8") && c.includes("0A")),
    "readiness must use the /proc listen-socket fallback when no HTTP client exists",
  );
  assert.ok(
    !executeCalls.some((c) => c.includes("curl -s -o /dev/null -w")),
    "the curl HTTP probe must not run in an image that has no curl",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("readiness with no HTTP client and no listener times out with the app-log diagnostic", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
    }
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=none\n" };
    if (command.includes("/proc/net/tcp")) return { exitCode: 0, result: "000\n" };
    return { exitCode: 0, result: "" };
  };

  const outcome = await reproduce(reproduceInput());

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.ok(
    executeCalls.some((c) => c.includes("-- log:")),
    "the clientless timeout diagnostic must tail the app log",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("readiness still prefers the curl HTTP probe when curl is present", async () => {
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
  assert.ok(
    executeCalls.some((c) => c.includes("curl -s -o /dev/null -w")),
    "curl must be the readiness probe when the image has it",
  );
  assert.ok(
    !executeCalls.some((c) => c.includes("/proc/net/tcp")),
    "the listen-socket fallback must not run when an HTTP client is available",
  );
});

test("verifyNoEgress accepts a clientless image when networkBlockAll is verified, and still rejects an unblocked one", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=none\n" };
    return { exitCode: 0, result: "" };
  };
  const { verifyNoEgress } = await import("./provision");

  // networkBlockAll true and no client: the missing client alone must not fail the check, and no
  // outbound probe should be attempted since there is nothing to attempt it with.
  await verifyNoEgress(FAKE_SANDBOX);
  assert.ok(
    !executeCalls.some((c) => c.includes("bountydesk-egress")),
    "no outbound egress probe should run when the image has no HTTP client",
  );

  // networkBlockAll false still fails closed regardless of client availability.
  await assert.rejects(
    () => verifyNoEgress({ ...FAKE_SANDBOX, networkBlockAll: false }),
    /networkBlockAll false/,
  );

  // The link-network policy is the one accepted alternative; any other range or a domain list fails.
  await verifyNoEgress({ ...FAKE_SANDBOX, networkBlockAll: false, networkAllowList: "172.25.0.0/16" });
  await assert.rejects(
    () => verifyNoEgress({ ...FAKE_SANDBOX, networkBlockAll: false, networkAllowList: "0.0.0.0/0" }),
    /networkBlockAll false/,
  );
  await assert.rejects(
    () => verifyNoEgress({ ...FAKE_SANDBOX, networkBlockAll: false, networkAllowList: "172.25.0.0/16", domainAllowList: "example.com" }),
    /non-empty egress allow list/,
  );
});

function withFollowUpAuthorization() {
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: recipeWithFollowUp });
  };
}

test("exploitFollowUp happy path: a minted token whose follow-up carries the canary reproduces", async () => {
  resetSpies();
  withFollowUpAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ token: "minted-jwt" }),
      followUpBody: (canary) => JSON.stringify({ data: [{ email: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithFollowUp })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  assert.ok(
    calls.some((c) => new URL(c.url).pathname === "/followup"),
    "the follow-up request must actually be dispatched",
  );
  assert.ok(
    calls.some((c) => {
      const auth = new Headers(c.init?.headers).get("authorization");
      return auth === "Bearer minted-jwt";
    }),
    "the follow-up request must carry the token extracted from the exploit response",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("exploitFollowUp: a token whose follow-up response lacks this run's canary does not reproduce", async () => {
  resetSpies();
  withFollowUpAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ token: "minted-jwt" }),
      // A real admin dump comes back, just not proven to be *this run's* canary -- exactly the
      // case the withheld "was any token minted" oracle couldn't tell apart from a real bypass.
      followUpBody: () => JSON.stringify({ data: [{ email: "admin@juice-sh.op" }] }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithFollowUp })),
  );

  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("exploitFollowUp: no token minted skips the follow-up request entirely and does not reproduce", async () => {
  resetSpies();
  withFollowUpAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ message: "no token this time" }),
      followUpBody: (canary) => JSON.stringify({ data: [{ email: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithFollowUp })),
  );

  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/followup"),
    "buildRequest declined to build anything, so no follow-up request should ever be sent",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("exploitFollowUp: a failing follow-up request is ANALYSIS_ONLY, never a guessed verdict", async () => {
  resetSpies();
  withFollowUpAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ token: "minted-jwt" }),
      followUpStatus: 502,
      followUpBody: () => JSON.stringify({ error: "preview unavailable" }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithFollowUp })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
  }
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("negativeControlAcceptedStatuses: a declared non-2xx status still completes the negative control", async () => {
  resetSpies();
  const recipeWithAcceptedStatus: ReproductionRecipe = {
    ...recipe,
    negativeControl: { method: "GET", path: "/negative" },
    negativeControlAcceptedStatuses: [401],
    oracleCheck: (response, canary) => response.body.includes(canary),
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: recipeWithAcceptedStatus });
  };
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlStatus: 401,
      negativeControlBody: () => JSON.stringify({ message: "Invalid email or password" }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithAcceptedStatus })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  if (outcome.outcome === "REPRODUCED") {
    assert.equal(outcome.evidence.negativeControl.ranToCompletion, true);
    assert.equal(outcome.evidence.negativeControl.canaryFound, false);
  }
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("negativeControlAcceptedStatuses: an undeclared non-2xx status is still an incomplete leg", async () => {
  resetSpies();
  const recipeWithAcceptedStatus: ReproductionRecipe = {
    ...recipe,
    negativeControl: { method: "GET", path: "/negative" },
    negativeControlAcceptedStatuses: [401],
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: recipeWithAcceptedStatus });
  };
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlStatus: 503,
      negativeControlBody: () => JSON.stringify({ error: "unavailable" }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithAcceptedStatus })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.negativeControl?.ranToCompletion, false);
  }
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/exploit"),
    "an incomplete negative control must still stop the run before the exploit is attempted",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("negativeControlAcceptedStatuses also widens the exploit's own dispatch when it shares the negative control's endpoint", async () => {
  resetSpies();
  const recipeWithAcceptedExploitStatus: ReproductionRecipe = {
    ...recipeWithFollowUp,
    negativeControlAcceptedStatuses: [401],
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: recipeWithAcceptedExploitStatus });
  };
  const calls: FetchCall[] = [];

  // A login-style exploit that shares its endpoint with the negative control can be rejected the
  // same legitimate way (401, no token) -- a real, complete answer, not a proxy hiccup.
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitStatus: 401,
      exploitBody: () => JSON.stringify({ message: "Invalid email or password" }),
      followUpBody: (canary) => JSON.stringify({ data: [{ email: canary }] }),
    }),
    () => reproduce(reproduceInput({ recipe: recipeWithAcceptedExploitStatus })),
  );

  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  if (outcome.outcome === "NOT_REPRODUCED") {
    assert.equal(outcome.evidence.exploit.ranToCompletion, true);
  }
  assert.ok(
    !calls.some((c) => new URL(c.url).pathname === "/followup"),
    "a rejected exploit mints no token, so no follow-up request should ever be sent",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

// Setup steps: an access-control recipe (IDOR) needs per-run principals and a resource id before
// its control and exploit legs can be written, so the fixture alone (one request, canary only) is
// not enough. Captured values are substituted as {{name}} into later requests.

const TOKEN_A = "tok-A.part_1-x";

function jsonField(body: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const idorRecipe: ReproductionRecipe = {
  id: "test-idor",
  title: "a test IDOR recipe",
  keywords: ["idor"],
  fixture: { request: { method: "POST", path: "/fixture", body: { email: "{{canary}}" } } },
  setup: [
    {
      request: { method: "POST", path: "/login-a", body: { who: "a" } },
      capture: { tokenA: (response) => jsonField(response.body, "token") },
    },
    {
      request: { method: "POST", path: "/seed-b", body: { note: "{{canary}}" } },
      capture: { resourceId: (response) => jsonField(response.body, "id") },
    },
  ],
  negativeControl: { method: "GET", path: "/own", headers: { Authorization: "Bearer {{tokenA}}" } },
  exploit: { method: "GET", path: "/resource/{{resourceId}}", headers: { Authorization: "Bearer {{tokenA}}" } },
  oracleCheck: (response, canary) => response.body.includes(canary),
};

function setupFetchStub(
  calls: FetchCall[],
  opts: {
    loginStatus?: number;
    loginBody?: string;
    seedBody?: string;
    resourceBodyFor?: (auth: string | null) => string;
    openStatus?: number;
    ownStatus?: number;
  } = {},
): typeof fetch {
  let canary: string | null = null;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/ports/") && url.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ sandboxId: FAKE_SANDBOX.id, url: PREVIEW_URL, token: PREVIEW_TOKEN }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({ url, init, canary });
    const parsed = new URL(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (parsed.pathname === "/fixture") {
      canary = (JSON.parse(String(init?.body)) as { email: string }).email;
      return new Response("{}", { status: 201 });
    }
    if (parsed.pathname === "/login-a") {
      return new Response(opts.loginBody ?? JSON.stringify({ token: TOKEN_A }), { status: opts.loginStatus ?? 200 });
    }
    if (parsed.pathname === "/seed-b") {
      return new Response(opts.seedBody ?? JSON.stringify({ id: "res-42" }), { status: 201 });
    }
    if (parsed.pathname === "/own") return new Response("{}", { status: opts.ownStatus ?? 200 });
    if (parsed.pathname === "/resource/res-42") {
      const body = (opts.resourceBodyFor ?? ((a) => (a === `Bearer ${TOKEN_A}` ? JSON.stringify({ note: canary }) : "{}")))(auth);
      return new Response(body, { status: 200 });
    }
    // The principal-free control. Juice Shop answers 401 to a request with no token. An endpoint
    // open to everyone answers 200 with the canary, which is the case the control exists to catch.
    if (parsed.pathname === "/open/res-42") {
      const status = opts.openStatus ?? 401;
      return new Response(status === 200 ? JSON.stringify({ note: canary }) : "{}", { status });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function withIdorAuthorization(recipeOverride: ReproductionRecipe = idorRecipe) {
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: recipeOverride });
  };
}

test("setup: captured values reach later requests, so another principal's resource is reproduced as an IDOR", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls), () => reproduce(reproduceInput({ recipe: idorRecipe })));

  assert.equal(outcome.outcome, "REPRODUCED");
  const exploit = calls.find((c) => new URL(c.url).pathname === "/resource/res-42");
  assert.ok(exploit, "the exploit path must carry the captured resource id");
  assert.equal(new Headers(exploit.init?.headers).get("authorization"), `Bearer ${TOKEN_A}`);
  const control = calls.find((c) => new URL(c.url).pathname === "/own");
  assert.equal(new Headers(control?.init?.headers).get("authorization"), `Bearer ${TOKEN_A}`);
});

test("setup: a control that already shows the canary is never trusted, and the exploit never runs", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];
  const leakyControl: ReproductionRecipe = { ...idorRecipe, oracleCheck: () => true };
  withIdorAuthorization(leakyControl);

  const outcome = await withFetch(setupFetchStub(calls), () => reproduce(reproduceInput({ recipe: leakyControl })));

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  assert.ok(!calls.some((c) => new URL(c.url).pathname.startsWith("/resource/")));
});

test("setup: an endpoint that denies the other principal is NOT_REPRODUCED", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { resourceBodyFor: () => "{}" }), () =>
    reproduce(reproduceInput({ recipe: idorRecipe })),
  );

  assert.equal(outcome.outcome, "NOT_REPRODUCED");
});

test("setup: a failing setup step stops the run before the control or exploit, as ANALYSIS_ONLY", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { loginStatus: 500 }), () =>
    reproduce(reproduceInput({ recipe: idorRecipe })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  const paths = calls.map((c) => new URL(c.url).pathname);
  assert.ok(!paths.includes("/own") && !paths.some((p) => p.startsWith("/resource/")));
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("setup: a capture that finds nothing is an incomplete run, never a guessed verdict", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { loginBody: "{}" }), () =>
    reproduce(reproduceInput({ recipe: idorRecipe })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  assert.ok(!calls.some((c) => new URL(c.url).pathname === "/own"));
});

test("setup: a captured value with header or path control characters is refused before it is sent", async () => {
  for (const hostile of ["tok\r\nX-Evil: 1", "../../etc/passwd", "a b", ""]) {
    resetSpies();
    withIdorAuthorization();
    const calls: FetchCall[] = [];

    const outcome = await withFetch(setupFetchStub(calls, { loginBody: JSON.stringify({ token: hostile }) }), () =>
      reproduce(reproduceInput({ recipe: idorRecipe })),
    );

    assert.equal(outcome.outcome, "ANALYSIS_ONLY", JSON.stringify(hostile));
    assert.ok(!calls.some((c) => new URL(c.url).pathname === "/own"), "nothing after setup may be sent");
  }
});

test("setup: captured values are never written into the evidence", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls), () => reproduce(reproduceInput({ recipe: idorRecipe })));

  assert.equal(outcome.outcome, "REPRODUCED");
  assert.ok(!JSON.stringify(outcome).includes(TOKEN_A));
  assert.ok(!JSON.stringify(outcome).includes("res-42"));
});

test("setup: a failed setup step is recorded as a setup failure, not as a fixture that never seeded the canary", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { loginStatus: 500 }), () =>
    reproduce(reproduceInput({ recipe: idorRecipe })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome !== "ANALYSIS_ONLY") return;
  // The fixture request itself returned 2xx, and verdict evidence cannot be edited later.
  assert.equal(outcome.evidence?.fixture?.ranToCompletion, true);
  assert.equal(outcome.evidence?.setup?.ranToCompletion, false);
  assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
});

test("setup: a rejected fixture request still reports the fixture failure and skips setup entirely", async () => {
  resetSpies();
  withIdorAuthorization();
  const calls: FetchCall[] = [];
  const stub = setupFetchStub(calls);
  const rejectingFixture = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/fixture") return new Response("{}", { status: 500 });
    return stub(input, init);
  }) as typeof fetch;

  const outcome = await withFetch(rejectingFixture, () => reproduce(reproduceInput({ recipe: idorRecipe })));

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome !== "ANALYSIS_ONLY") return;
  assert.equal(outcome.evidence?.fixture?.ranToCompletion, false);
  assert.equal(outcome.evidence?.setup, undefined, "setup never ran, so there is nothing to record");
  assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
});

test("setup: a recipe with no setup steps records no setup evidence", async () => {
  resetSpies();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce(reproduceInput()),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  if (outcome.outcome !== "REPRODUCED") return;
  assert.equal(outcome.evidence.setup, undefined);
});

test("setup: a captured value that is a dot segment is refused, since the URL parser would collapse it into another path", async () => {
  for (const hostile of [".", ".."]) {
    resetSpies();
    withIdorAuthorization();
    const calls: FetchCall[] = [];

    const outcome = await withFetch(setupFetchStub(calls, { seedBody: JSON.stringify({ id: hostile }) }), () =>
      reproduce(reproduceInput({ recipe: idorRecipe })),
    );

    assert.equal(outcome.outcome, "ANALYSIS_ONLY", JSON.stringify(hostile));
    assert.ok(!calls.some((c) => new URL(c.url).pathname === "/own"), "nothing after setup may be sent");
  }
});

const idorWithOpenControl: ReproductionRecipe = {
  ...idorRecipe,
  additionalNegativeControls: [{ request: { method: "GET", path: "/open/{{resourceId}}" }, acceptedStatuses: [401] }],
};

test("additionalNegativeControls: an IDOR whose principal-free control is 401 reproduces, and the control was sent with no credentials", async () => {
  resetSpies();
  withIdorAuthorization(idorWithOpenControl);
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls), () =>
    reproduce(reproduceInput({ recipe: idorWithOpenControl })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  const open = calls.find((c) => new URL(c.url).pathname === "/open/res-42");
  assert.ok(open, "the principal-free control must be sent");
  assert.equal(new Headers(open.init?.headers).get("authorization"), null);
  assert.ok(calls.some((c) => new URL(c.url).pathname === "/resource/res-42"), "the exploit runs once the folded control is clean");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("additionalNegativeControls: an endpoint open to everyone discloses the canary to the principal-free control, so the run is ANALYSIS_ONLY and the exploit never fires", async () => {
  resetSpies();
  withIdorAuthorization(idorWithOpenControl);
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { openStatus: 200 }), () =>
    reproduce(reproduceInput({ recipe: idorWithOpenControl })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.negativeControl?.canaryFound, true);
  }
  assert.ok(!calls.some((c) => new URL(c.url).pathname.startsWith("/resource/")), "the exploit must not be sent");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("additionalNegativeControls: a principal-free control that answers 500 is not an accepted status, so the run is never REPRODUCED", async () => {
  resetSpies();
  withIdorAuthorization(idorWithOpenControl);
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { openStatus: 500 }), () =>
    reproduce(reproduceInput({ recipe: idorWithOpenControl })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  assert.ok(!calls.some((c) => new URL(c.url).pathname.startsWith("/resource/")), "the exploit must not be sent");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("additionalNegativeControls: a status one extra control accepts does not loosen the primary control", async () => {
  resetSpies();
  withIdorAuthorization(idorWithOpenControl);
  const calls: FetchCall[] = [];

  const outcome = await withFetch(setupFetchStub(calls, { ownStatus: 401 }), () =>
    reproduce(reproduceInput({ recipe: idorWithOpenControl })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  assert.ok(!calls.some((c) => new URL(c.url).pathname.startsWith("/open/")), "no extra control after an incomplete primary");
  assert.ok(!calls.some((c) => new URL(c.url).pathname.startsWith("/resource/")), "the exploit must not be sent");
});

test("substituteCanary replaces {{canary}} and percent-encoded {{canary}} in request paths and headers", async () => {
  resetSpies();
  const pathAndHeaderRecipe: ReproductionRecipe = {
    id: "path-and-header-canary",
    title: "Canary in GET query and header",
    keywords: [],
    fixture: { request: { method: "GET", path: "/fixture?seed={{canary}}" } },
    negativeControl: { method: "GET", path: "/search?id=1", headers: { "X-Probe": "baseline" } },
    exploit: {
      method: "GET",
      path: `/search?id=${encodeURIComponent("2 UNION SELECT '{{canary}}'")}`,
      headers: { "X-Probe": "probe-{{canary}}" },
    },
    oracleCheck: (response, canary) => response.status === 200 && response.body.includes(canary),
  };
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: pathAndHeaderRecipe });
  };

  const seenUrls: string[] = [];
  const seenProbeHeaders: Array<string | null> = [];
  let seededCanary = "";

  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ url: "https://3000-sandbox.example", token: "tok" }), { status: 200 });
    }
    seenUrls.push(url);
    const headers = new Headers(init?.headers);
    seenProbeHeaders.push(headers.get("x-probe"));
    const parsed = new URL(url);
    if (parsed.pathname === "/fixture") {
      seededCanary = parsed.searchParams.get("seed") ?? "";
      return new Response("ok", { status: 200 });
    }
    if (parsed.searchParams.get("id")?.includes(seededCanary) && headers.get("x-probe") === `probe-${seededCanary}`) {
      return new Response(`row: ${seededCanary}`, { status: 200 });
    }
    return new Response("row: admin", { status: 200 });
  }) as typeof fetch;

  const outcome = await withFetch(stub, () => reproduce(reproduceInput({ recipe: pathAndHeaderRecipe })));
  assert.equal(outcome.outcome, "REPRODUCED");
  assert.ok(seededCanary.length > 0 && !seededCanary.includes("{{canary}}"));
  assert.ok(seenUrls.every((u) => !u.includes("{{canary}}") && !u.toLowerCase().includes("%7b%7bcanary%7d%7d")));
});

type OobRun = {
  /** Log content the listener holds when the negative control is read (a late or foreign callback). */
  logAtControl?: string;
  exploitStatus?: number;
  clearOk?: boolean;
  listenerStarts?: boolean;
  /** Whether the exploit request makes the target call back to the listener. */
  exploitCallsBack?: boolean;
  /** Write the exploit placeholder in mixed-case percent encoding. */
  mixedCasePlaceholder?: boolean;
};

/** The canary the controller put in the listener read command (grep -aF -- '<canary>'). */
function canaryFromCommand(command: string): string {
  return /grep -aF -- '([^']+)'/.exec(command)?.[1] ?? "";
}

async function runOob(run: OobRun) {
  resetSpies();
  process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT = "snap";
  process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF = "ghcr.io/vaibhav91one/juice-shop@sha256:" + "a".repeat(64);
  process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME = "ghcr.io/vaibhav91one/juice-shop:test-oob";
  process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER = "browser-out-1";

  const oobRecipe: ReproductionRecipe = {
    id: "ssrf-oob-test",
    title: "SSRF OOB callback",
    keywords: [],
    fixture: { request: { method: "POST", path: "/fixture", body: { email: "{{canary}}" } } },
    oobListener: { port: 8080 },
    setup: [
      {
        request: { method: "POST", path: "/login", body: { email: "{{canary}}" } },
        capture: { userToken: () => "tok-ssrf" },
      },
    ],
    negativeControl: {
      method: "GET",
      path: "/profile",
      headers: { Cookie: "token={{userToken}}" },
    },
    negativeControlAcceptedStatuses: [302],
    exploit: {
      method: "POST",
      path: "/profile/image/url",
      headers: { Cookie: "token={{userToken}}" },
      body: { imageUrl: `{{oobUrl}}/${run.mixedCasePlaceholder ? "%7b%7Bcanary%7D%7D" : "{{canary}}"}.jpg` },
    },
    oracleCheck: () => false,
  };

  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: oobRecipe });
  };

  let createdCount = 0;
  let listenerLog = "";
  let controlSeeded = false;
  createSandboxImpl = async (spec, snapshotImageRefOverride) => {
    createSandboxCalls.push(spec);
    createSandboxImageOverrides.push(snapshotImageRefOverride);
    createdCount += 1;
    return createdCount === 1 ? FAKE_SANDBOX : { ...FAKE_SANDBOX, id: "oob-listener-peer" };
  };
  getSandboxImpl = async (id) => (id === "oob-listener-peer" ? { ...FAKE_SANDBOX, id: "oob-listener-peer" } : FAKE_SANDBOX);
  executeImpl = async (sb, command) => {
    executeCalls.push(`${sb.id}:${command}`);
    if (sb.id === "oob-listener-peer" && command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: "browser-out-1\n" };
    }
    if (command.includes("bountydesk-oob-server.js")) {
      return run.listenerStarts === false
        ? { exitCode: 1, result: "" }
        : { exitCode: 0, result: "BOUNTYDESK_OOB_LISTENER_READY\n" };
    }
    if (command.includes("BOUNTYDESK_OOB_CLEARED")) {
      if (run.clearOk === false) return { exitCode: 1, result: "" };
      listenerLog = "";
      return { exitCode: 0, result: "BOUNTYDESK_OOB_CLEARED\n" };
    }
    if (command.includes("BOUNTYDESK_OOB_LOG_BEGIN")) {
      // The first (control) read sees whatever the scenario planted; a drain resets the log.
      if (!controlSeeded) {
        controlSeeded = true;
        if (run.logAtControl !== undefined) {
          listenerLog = run.logAtControl.replace("CANARY", canaryFromCommand(command));
        }
      }
      const body = listenerLog;
      if (command.includes("mv -f")) listenerLog = "";
      return { exitCode: 0, result: `BOUNTYDESK_OOB_LOG_BEGIN\n${body}\nBOUNTYDESK_OOB_LOG_END\n` };
    }
    return defaultExecuteResult(command);
  };

  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ url: "https://3000-sandbox.example", token: "tok" }), { status: 200 });
    }
    const parsed = new URL(url);
    if (parsed.pathname === "/fixture" || parsed.pathname === "/login") {
      return new Response("{}", { status: 200 });
    }
    if (parsed.pathname === "/profile") {
      return new Response("", { status: 302 });
    }
    if (parsed.pathname === "/profile/image/url") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { imageUrl?: string };
      // Target makes the SSRF request to the listener peer URL when exploited.
      if (run.exploitCallsBack !== false) listenerLog = JSON.stringify({ method: "GET", url: body.imageUrl });
      return new Response("", { status: run.exploitStatus ?? 302 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const outcome = await withFetch(stub, () => reproduce(reproduceInput({ recipe: oobRecipe })));
    return { outcome, listenerLog };
  } finally {
    delete process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT;
    delete process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF;
    delete process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME;
    delete process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER;
  }
}

test("oobListener: provisions linked listener, substitutes {{oobUrl}}, and reproduces when the listener records the canary", async () => {
  const { outcome, listenerLog } = await runOob({});
  assert.equal(outcome.outcome, "REPRODUCED");
  assert.ok(listenerLog.includes("http://oob-listener-peer:8080/"));
  assert.ok(!JSON.stringify(outcome).includes("http://oob-listener-peer:8080"));
  assert.deepEqual(deleteSandboxCalls, ["oob-listener-peer", FAKE_SANDBOX.id]);
});

test("oobListener: a dirty negative control (late callback) gives ANALYSIS_ONLY, never REPRODUCED", async () => {
  const { outcome } = await runOob({ logAtControl: '{"method":"GET","url":"/CANARY.jpg"}' });
  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
});

test("oobListener: a log holding only another run's canary does not dirty the control", async () => {
  const { outcome } = await runOob({ logAtControl: '{"method":"GET","url":"/some-other-runs-canary.jpg"}' });
  assert.equal(outcome.outcome, "REPRODUCED");
});

test("oobListener: no callback from the exploit is never REPRODUCED", async () => {
  const { outcome } = await runOob({ exploitCallsBack: false });
  assert.notEqual(outcome.outcome, "REPRODUCED");
});

test("oobListener: the listener decides, so a callback followed by a 500 still reproduces", async () => {
  const { outcome } = await runOob({ exploitStatus: 500 });
  assert.equal(outcome.outcome, "REPRODUCED");
});

test("oobListener: a clearLog failure stops before the exploit and gives ANALYSIS_ONLY", async () => {
  const { outcome } = await runOob({ clearOk: false });
  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
});

test("oobListener: a listener start failure gives ANALYSIS_ONLY and still tears the listener down", async () => {
  const { outcome } = await runOob({ listenerStarts: false });
  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  assert.ok(deleteSandboxCalls.includes("oob-listener-peer"));
});

test("oobListener: a mixed-case percent-encoded canary placeholder is still substituted", async () => {
  const { outcome } = await runOob({ mixedCasePlaceholder: true });
  assert.equal(outcome.outcome, "REPRODUCED");
});
// Product tampering (juice-shop-product-tampering-unauth): the real recipe, not a stand-in. Its
// control is a PUT to /api/Users/1 and its exploit and follow-up are PUT and GET on /api/Products/1,
// so the stub routes on method and path together, which fetchStub above does not.

function productTamperingRecipe(): ReproductionRecipe {
  const found = getRecipesForTarget({
    name: "juice-shop-v17.3.0",
    config: {
      baseUrl: "http://localhost:3000",
      searchPath: "/rest/products/search",
      canaryRegistrationPath: "/api/Users/",
    },
  }).find((r) => r.id === "juice-shop-product-tampering-unauth");
  assert.ok(found);
  return found;
}

function withProductTamperingAuthorization() {
  const target = productTamperingRecipe();
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe: target });
  };
}

function productTamperingStub(
  calls: FetchCall[],
  responses: {
    negativeControlStatus: number;
    negativeControlBody: (canary: string) => string;
    exploitStatus: number;
    exploitBody: (canary: string) => string;
    followUpBody: (canary: string) => string;
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

    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    calls.push({ url, init, canary: lastCanary });

    if (method === "POST" && pathname === "/api/Users/") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      lastCanary = body.email ?? null;
      return new Response(JSON.stringify({ status: "success" }), { status: 201 });
    }
    if (method === "PUT" && pathname === "/api/Users/1") {
      return new Response(responses.negativeControlBody(lastCanary ?? ""), {
        status: responses.negativeControlStatus,
      });
    }
    if (method === "PUT" && pathname === "/api/Products/1") {
      return new Response(responses.exploitBody(lastCanary ?? ""), { status: responses.exploitStatus });
    }
    if (method === "GET" && pathname === "/api/Products/1") {
      return new Response(responses.followUpBody(lastCanary ?? ""), { status: 200 });
    }

    throw new Error(`unexpected fetch to ${method} ${url}`);
  }) as typeof fetch;
}

test("product tampering: an unauthenticated PUT whose canary persists in the product reproduces", async () => {
  resetSpies();
  withProductTamperingAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    productTamperingStub(calls, {
      negativeControlStatus: 401,
      negativeControlBody: () => "Unauthorized",
      exploitStatus: 200,
      exploitBody: (canary) => JSON.stringify({ status: "success", data: { id: 1, description: canary } }),
      followUpBody: (canary) => JSON.stringify({ status: "success", data: { id: 1, description: canary } }),
    }),
    () => reproduce(reproduceInput({ recipe: productTamperingRecipe() })),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  const exploit = calls.find((c) => c.init?.method === "PUT" && new URL(c.url).pathname === "/api/Products/1");
  assert.ok(exploit, "the exploit PUT must be dispatched");
  assert.equal(new Headers(exploit.init?.headers).get("authorization"), null, "the exploit carries no credentials");
  assert.ok(
    calls.some((c) => c.init?.method === "GET" && new URL(c.url).pathname === "/api/Products/1"),
    "the follow-up GET must be dispatched to prove the write persisted",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("product tampering: a dirty negative control (protected PUT echoes the canary) is never trusted, and the exploit never runs", async () => {
  resetSpies();
  withProductTamperingAuthorization();
  const calls: FetchCall[] = [];

  const outcome = await withFetch(
    productTamperingStub(calls, {
      negativeControlStatus: 200,
      negativeControlBody: (canary) => JSON.stringify({ status: "success", data: { id: 1, email: canary } }),
      exploitStatus: 200,
      exploitBody: (canary) => JSON.stringify({ status: "success", data: { id: 1, description: canary } }),
      followUpBody: (canary) => JSON.stringify({ status: "success", data: { id: 1, description: canary } }),
    }),
    () => reproduce(reproduceInput({ recipe: productTamperingRecipe() })),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  assert.ok(
    !calls.some((c) => c.init?.method === "PUT" && new URL(c.url).pathname === "/api/Products/1"),
    "a dirty negative control must stop the run before the exploit is attempted at all",
  );
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});


