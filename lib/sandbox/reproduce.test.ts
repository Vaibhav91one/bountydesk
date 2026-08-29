import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before, mock } from "node:test";

import type { ReproductionRecipe } from "@/lib/reproduction/types";

import type { ExecResult, Sandbox, SandboxSpec, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
// Keeps the "never becomes ready" test fast: production's real 90s ceiling would otherwise
// make every run of this file sit through a real timeout for no reason.
process.env.BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS = "30";
process.env.BOUNTYDESK_REPRODUCE_READINESS_POLL_MS = "5";

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

/** Overridable per test: lets a test make provisioning, readiness or teardown fail without
 * touching the shared default. */
let createSandboxImpl: (spec: SandboxSpec) => Promise<Sandbox> = async (spec) => {
  createSandboxCalls.push(spec);
  return FAKE_SANDBOX;
};
let executeImpl: (sandbox: Sandbox, command: string) => Promise<ExecResult> = async (_sandbox, command) => {
  executeCalls.push(command);
  // Any status starting with 2 satisfies waitForAppReady's readiness regex; the start-app
  // call's result is never inspected, so the same canned answer covers both execute() calls.
  return { exitCode: 0, result: "200" };
};
let deleteSandboxImpl: (id: string) => Promise<void> = async (id) => {
  deleteSandboxCalls.push(id);
};

mock.module("./daytona", {
  namedExports: {
    createSandbox: (spec: SandboxSpec) => createSandboxImpl(spec),
    execute: (sandbox: Sandbox, command: string) => executeImpl(sandbox, command),
    deleteSandbox: (id: string) => deleteSandboxImpl(id),
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

let reproduce: typeof import("./reproduce").reproduce;

before(async () => {
  ({ reproduce } = await import("./reproduce"));
});

function resetSpies(): void {
  createSandboxCalls = [];
  deleteSandboxCalls = [];
  executeCalls = [];
  createSandboxImpl = async (spec) => {
    createSandboxCalls.push(spec);
    return FAKE_SANDBOX;
  };
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    return { exitCode: 0, result: "200" };
  };
  deleteSandboxImpl = async (id) => {
    deleteSandboxCalls.push(id);
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
      return new Response(JSON.stringify({ status: "success" }), { status: 201 });
    }
    if (path === "/negative") {
      calls.push({ url, init, canary: lastCanary });
      return new Response(responses.negativeControlBody(lastCanary ?? ""), { status: 200 });
    }
    if (path === "/exploit") {
      calls.push({ url, init, canary: lastCanary });
      return new Response(responses.exploitBody(lastCanary ?? ""), { status: 200 });
    }

    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

const recipe: ReproductionRecipe = {
  id: "test-recipe",
  title: "a test recipe",
  fixture: { request: { method: "POST", path: "/fixture", body: { email: "{{canary}}" } } },
  negativeControl: { method: "GET", path: "/negative" },
  exploit: { method: "GET", path: "/exploit" },
  oracleCheck: (response, canary) => response.body.includes(canary),
};

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
    () => reproduce({ imageDigest: FAKE_SNAPSHOT.imageName!.split("@")[1], snapshotId: "snap", recipe }),
  );

  assert.equal(outcome.outcome, "REPRODUCED");
  if (outcome.outcome !== "REPRODUCED") return;

  const canary = calls.find((c) => c.canary)?.canary;
  assert.ok(canary, "the fixture call should have carried a generated canary");
  assert.equal(outcome.evidence.canaryHash, createHash("sha256").update(canary!).digest("hex"));
  assert.equal(outcome.evidence.sandboxId, FAKE_SANDBOX.id);
  assert.equal(outcome.evidence.recipeId, "test-recipe");
  assert.equal(outcome.evidence.negativeControl.canaryFound, false);
  assert.equal(outcome.evidence.exploit.canaryFound, true);
  assert.ok(outcome.evidence.requestBodyHashes.negativeControl === null, "a GET with no body hashes to null");
  assert.ok(outcome.evidence.requestBodyHashes.exploit === null);

  // The raw canary must never appear anywhere in what gets recorded -- only its hash.
  assert.ok(!JSON.stringify(outcome.evidence).includes(canary!));

  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id], "the sandbox must always be torn down");
});

test("a clean negative control and no canary found does not reproduce", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => JSON.stringify({ data: [] }),
    }),
    () => reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: "snap", recipe }),
  );

  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a dirty negative control (canary already present) is never trusted", async () => {
  resetSpies();
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
      exploitBody: (canary) => JSON.stringify({ data: [{ name: canary }] }),
    }),
    () => reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: "snap", recipe }),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("an exploit oracleCheck that throws never guesses REPRODUCED", async () => {
  resetSpies();
  const throwingRecipe: ReproductionRecipe = {
    ...recipe,
    oracleCheck: (response) => {
      if (response.body.includes("boom")) throw new Error("malformed response");
      return false;
    },
  };
  const calls: FetchCall[] = [];
  const outcome = await withFetch(
    fetchStub(calls, {
      negativeControlBody: () => JSON.stringify({ data: [] }),
      exploitBody: () => "boom",
    }),
    () => reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: "snap", recipe: throwingRecipe }),
  );

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") {
    assert.equal(outcome.reason, "NO_APPROVED_ORACLE");
    assert.equal(outcome.evidence?.exploit?.ranToCompletion, false);
  }
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a sandbox that never provisions reports COULD_NOT_DEPLOY and tears down nothing", async () => {
  resetSpies();
  createSandboxImpl = async () => {
    throw new Error("daytona is down");
  };

  const outcome = await reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: "snap", recipe });

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "COULD_NOT_DEPLOY");
  assert.deepEqual(deleteSandboxCalls, [], "nothing to tear down when provisioning itself failed");
});

test("a sandbox that never answers its port reports TARGET_UNAVAILABLE and still tears down", async () => {
  resetSpies();
  executeImpl = async (_sandbox, command) => {
    executeCalls.push(command);
    return { exitCode: 0, result: "000" };
  };

  const outcome = await reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: "snap", recipe });

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("a missing snapshot id short-circuits before touching the sandbox client at all", async () => {
  resetSpies();
  const outcome = await reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: null, recipe });

  assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  if (outcome.outcome === "ANALYSIS_ONLY") assert.equal(outcome.reason, "TARGET_UNAVAILABLE");
  assert.deepEqual(createSandboxCalls, []);
  assert.deepEqual(deleteSandboxCalls, []);
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
    const outcome = await reproduce({ imageDigest: "sha256:" + "a".repeat(64), snapshotId: "snap", recipe });
    assert.equal(outcome.outcome, "ANALYSIS_ONLY");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});
