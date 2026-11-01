import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

import type { ReproduceFn, ReproductionRecipe } from "@/lib/reproduction/types";
import { getRecipesForTarget } from "@/lib/targets/recipes";
import { JUICE_SHOP_EXPECTED_BUILD_MARKER } from "@/lib/targets/registry";

import type { ExecResult, Sandbox, SandboxSpec, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
process.env.BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS = "30";
process.env.BOUNTYDESK_REPRODUCE_READINESS_POLL_MS = "5";

const TARGET_PROFILE_ID = "profile-under-test-classes";

/**
 * This file closes gaps the #343 audit found: an SSRF-OOB run where the listener records no
 * callback, and real-recipe end-to-end runs (both REPRODUCED and NOT_REPRODUCED) for product
 * tampering and the FTP null-byte traversal recipe. It cannot share reproduce.test.ts directly
 * (that file is owned by #416 work in flight), so the seam it rests on -- mocking "./daytona"
 * before reproduce.ts is ever imported -- and the fetch/exec stub shapes are copied from there.
 */

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

const BUILD_MARKER_COMMAND_FRAGMENT = "bountydesk-build-marker";

function defaultExecuteResult(command: string): ExecResult {
  if (command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
    return { exitCode: 0, result: `${JUICE_SHOP_EXPECTED_BUILD_MARKER}\n` };
  }
  if (command.includes("command -v curl")) {
    return { exitCode: 0, result: "TOOL=curl\n" };
  }
  if (command.includes("bountydesk-egress")) {
    return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted\n" };
  }
  return { exitCode: 0, result: "200" };
}

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
  return defaultExecuteResult(command);
};
let deleteSandboxImpl: (id: string) => Promise<void> = async (id) => {
  deleteSandboxCalls.push(id);
};
let authorizeImpl: (input: {
  targetProfileId: string;
  recipeId: string;
}) => Promise<TestReproductionAuthorization>;

mock.module("./daytona", {
  namedExports: {
    createSandbox: (spec: SandboxSpec, snapshotImageRefOverride?: string) =>
      createSandboxImpl(spec, snapshotImageRefOverride),
    getSandbox: (id: string) => getSandboxImpl(id),
    execute: (sandbox: Sandbox, command: string) => executeImpl(sandbox, command),
    deleteSandbox: (id: string) => deleteSandboxImpl(id),
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

let reproduce: ReproduceFn;

before(async () => {
  const reproduceModule = await import("./reproduce");
  const { createReproducer } = reproduceModule;
  reproduce = createReproducer((input) => authorizeImpl(input));
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
}

function authorizedTarget(
  overrides: Partial<Extract<TestReproductionAuthorization, { ok: true }>>,
): Extract<TestReproductionAuthorization, { ok: true }> {
  return {
    ok: true,
    imageName: "ghcr.io/vaibhav91one/juice-shop",
    imageDigest: "sha256:" + "a".repeat(64),
    snapshotId: "snap",
    appPort: 3000,
    readinessPath: "/",
    expectedBuildMarker: JUICE_SHOP_EXPECTED_BUILD_MARKER,
    startCommand: "cd /juice-shop && (nohup node build/app >/tmp/bountydesk-app.log 2>&1 &)",
    ...overrides,
  } as Extract<TestReproductionAuthorization, { ok: true }>;
}

const CANARY_HEADER = "x-daytona-preview-token";
const PREVIEW_URL = "https://preview.example";
const PREVIEW_TOKEN = "preview-token-123";

function reproduceInput(recipe: ReproductionRecipe) {
  return {
    targetProfileId: TARGET_PROFILE_ID,
    imageName: "ghcr.io/vaibhav91one/juice-shop",
    imageDigest: "sha256:" + "a".repeat(64),
    snapshotId: "snap",
    recipe,
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

const JUICE_SHOP_CONFIG = {
  baseUrl: "http://localhost:3000",
  searchPath: "/rest/products/search",
  canaryRegistrationPath: "/api/Users/",
};

function recipeById(id: string): ReproductionRecipe {
  const found = getRecipesForTarget({ name: "juice-shop-v17.3.0", config: JUICE_SHOP_CONFIG }).find(
    (r) => r.id === id,
  );
  assert.ok(found, `recipe ${id} must exist`);
  return found;
}

function authorizeWith(recipe: ReproductionRecipe): void {
  authorizeImpl = async (input) => {
    authorizeCalls.push(input);
    return authorizedTarget({ recipe });
  };
}

/**
 * A fetch stub that routes on method + path, the same approach reproduce.test.ts's
 * productTamperingStub uses, since the real recipes below do not share one request shape.
 */
function routedFetchStub(
  handlers: Record<string, (init: RequestInit | undefined, canary: string | null) => Response>,
  getCanary: () => string | null,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/ports/") && url.endsWith("/preview-url")) {
      return new Response(
        JSON.stringify({ sandboxId: FAKE_SANDBOX.id, url: PREVIEW_URL, token: PREVIEW_TOKEN }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const headers = new Headers(init?.headers);
    assert.equal(headers.get(CANARY_HEADER), PREVIEW_TOKEN, "every sandbox-facing call must carry the preview token");

    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    const key = `${method} ${pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch to ${key}`);
    return handler(init, getCanary());
  }) as typeof fetch;
}

// Product tampering: the real recipe (lib/targets/recipes.ts, juice-shop-product-tampering-unauth).
// reproduce.test.ts already covers REPRODUCED and a dirty-control ANALYSIS_ONLY; the gap closed
// here is the NOT_REPRODUCED path, where the control stays clean but the write never persists.

test("product tampering: end to end, a clean control and a persisted canary reproduces", async () => {
  resetSpies();
  const recipe = recipeById("juice-shop-product-tampering-unauth");
  authorizeWith(recipe);

  let canary: string | null = null;
  const stub = routedFetchStub(
    {
      "POST /api/Users/": (init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
        canary = body.email ?? null;
        return new Response(JSON.stringify({ status: "success" }), { status: 201 });
      },
      "PUT /api/Users/1": () => new Response("Unauthorized", { status: 401 }),
      "PUT /api/Products/1": (_init, c) =>
        new Response(JSON.stringify({ status: "success", data: { id: 1, description: c } }), { status: 200 }),
      "GET /api/Products/1": (_init, c) =>
        new Response(JSON.stringify({ status: "success", data: { id: 1, description: c } }), { status: 200 }),
    },
    () => canary,
  );

  const outcome = await withFetch(stub, () => reproduce(reproduceInput(recipe)));
  assert.equal(outcome.outcome, "REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("product tampering: end to end, a clean control but a write that never persists is NOT_REPRODUCED", async () => {
  resetSpies();
  const recipe = recipeById("juice-shop-product-tampering-unauth");
  authorizeWith(recipe);

  let canary: string | null = null;
  const stub = routedFetchStub(
    {
      "POST /api/Users/": (init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
        canary = body.email ?? null;
        return new Response(JSON.stringify({ status: "success" }), { status: 201 });
      },
      "PUT /api/Users/1": () => new Response("Unauthorized", { status: 401 }),
      // The write itself answers 200 (so the exploit leg completes), but the follow-up read
      // never shows the canary: nothing was actually persisted.
      "PUT /api/Products/1": (_init, c) =>
        new Response(JSON.stringify({ status: "success", data: { id: 1, description: c } }), { status: 200 }),
      "GET /api/Products/1": () =>
        new Response(JSON.stringify({ status: "success", data: { id: 1, description: "unchanged" } }), {
          status: 200,
        }),
    },
    () => canary,
  );

  const outcome = await withFetch(stub, () => reproduce(reproduceInput(recipe)));
  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

// FTP poison null-byte traversal: the real recipe (juice-shop-ftp-poison-null-byte). No test at
// all existed for it before this file.

test("ftp null-byte traversal: end to end, a disclosed backup file reproduces", async () => {
  resetSpies();
  const recipe = recipeById("juice-shop-ftp-poison-null-byte");
  authorizeWith(recipe);

  const stub = routedFetchStub(
    {
      "POST /api/Users/": () => new Response(JSON.stringify({ status: "success" }), { status: 201 }),
      "GET /ftp/legal.md": () => new Response("OWASP Juice Shop terms", { status: 200 }),
      "GET /ftp/package.json.bak%2500.md": () =>
        new Response(JSON.stringify({ name: "juice-shop", version: "17.3.0" }), { status: 200 }),
    },
    () => null,
  );

  const outcome = await withFetch(stub, () => reproduce(reproduceInput(recipe)));
  assert.equal(outcome.outcome, "REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

test("ftp null-byte traversal: end to end, a clean control and no disclosed backup is NOT_REPRODUCED", async () => {
  resetSpies();
  const recipe = recipeById("juice-shop-ftp-poison-null-byte");
  authorizeWith(recipe);

  const stub = routedFetchStub(
    {
      "POST /api/Users/": () => new Response(JSON.stringify({ status: "success" }), { status: 201 }),
      "GET /ftp/legal.md": () => new Response("OWASP Juice Shop terms", { status: 200 }),
      // The filter bypass is patched: the null-byte path falls through to the allowlisted
      // extension check and serves the public legal file instead of the backup, a complete
      // 200 leg carrying no backup-file evidence.
      "GET /ftp/package.json.bak%2500.md": () => new Response("OWASP Juice Shop terms", { status: 200 }),
    },
    () => null,
  );

  const outcome = await withFetch(stub, () => reproduce(reproduceInput(recipe)));
  assert.equal(outcome.outcome, "NOT_REPRODUCED");
  assert.deepEqual(deleteSandboxCalls, [FAKE_SANDBOX.id]);
});

// SSRF OOB listener: the real recipe (juice-shop-ssrf-profile-image). The existing oobListener
// test in reproduce.test.ts only exercises the REPRODUCED path with a stand-in recipe. The gap
// closed here is the listener seeing no callback at all, which must end NOT_REPRODUCED rather
// than ANALYSIS_ONLY or a guessed REPRODUCED.

test("ssrf oob listener: end to end, no recorded callback is NOT_REPRODUCED", async () => {
  resetSpies();
  process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT = "snap";
  process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF = "ghcr.io/vaibhav91one/juice-shop@sha256:" + "a".repeat(64);
  process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME = "ghcr.io/vaibhav91one/juice-shop:test-oob";
  // A dedicated listener image needs its own marker, or the listener refuses to start and the run
  // ends ANALYSIS_ONLY before the no-callback path this test is about is ever reached.
  process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER = "oob-test-marker";
  process.env.BOUNTYDESK_OOB_SETTLE_MS = "0";

  const recipe = recipeById("juice-shop-ssrf-profile-image");
  authorizeWith(recipe);

  let createdCount = 0;
  createSandboxImpl = async (spec, snapshotImageRefOverride) => {
    createSandboxCalls.push(spec);
    createSandboxImageOverrides.push(snapshotImageRefOverride);
    createdCount += 1;
    return createdCount === 1 ? FAKE_SANDBOX : { ...FAKE_SANDBOX, id: "oob-listener-peer" };
  };
  getSandboxImpl = async (id) => (id === "oob-listener-peer" ? { ...FAKE_SANDBOX, id: "oob-listener-peer" } : FAKE_SANDBOX);
  // The listener never records anything: the exploit's SSRF request never reaches it (blocked
  // egress, a fixed host allowlist, whatever the real bug class failure mode is).
  const listenerLog = "";
  executeImpl = async (sb, command) => {
    executeCalls.push(`${sb.id}:${command}`);
    if (sb.id === "oob-listener-peer" && command.includes(BUILD_MARKER_COMMAND_FRAGMENT)) {
      return { exitCode: 0, result: "oob-test-marker\n" };
    }
    if (command.includes("bountydesk-oob-server.js")) {
      return { exitCode: 0, result: "BOUNTYDESK_OOB_LISTENER_READY\n" };
    }
    if (command.includes("BOUNTYDESK_OOB_CLEARED")) {
      return { exitCode: 0, result: "BOUNTYDESK_OOB_CLEARED\n" };
    }
    if (command.includes("BOUNTYDESK_OOB_LOG_BEGIN")) {
      return { exitCode: 0, result: `BOUNTYDESK_OOB_LOG_BEGIN\n${listenerLog}\nBOUNTYDESK_OOB_LOG_END\n` };
    }
    return defaultExecuteResult(command);
  };

  let userToken: string | null = null;
  const stub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ url: "https://3000-sandbox.example", token: "tok" }), { status: 200 });
    }
    const parsed = new URL(url);
    if (parsed.pathname === "/api/Users/") {
      return new Response(JSON.stringify({ status: "success" }), { status: 201 });
    }
    if (parsed.pathname === "/rest/user/login") {
      userToken = "tok-ssrf-not-reproduced";
      return new Response(JSON.stringify({ authentication: { token: userToken } }), { status: 200 });
    }
    if (parsed.pathname === "/profile") {
      return new Response("", { status: 302 });
    }
    if (parsed.pathname === "/profile/image/url") {
      // The target accepts the request and redirects like any other submission, but never
      // actually calls out to the listener.
      return new Response("", { status: 302 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const outcome = await withFetch(stub, () => reproduce(reproduceInput(recipe)));
    assert.equal(outcome.outcome, "NOT_REPRODUCED");
    // The listener log was actually read, so NOT_REPRODUCED came from an empty log, not a listener
    // that never started.
    assert.ok(executeCalls.some((c) => c.startsWith("oob-listener-peer:") && c.includes("BOUNTYDESK_OOB_LOG_BEGIN")));
    assert.deepEqual(deleteSandboxCalls, ["oob-listener-peer", FAKE_SANDBOX.id]);
  } finally {
    delete process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT;
    delete process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF;
    delete process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME;
    delete process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER;
    delete process.env.BOUNTYDESK_OOB_SETTLE_MS;
  }
});
