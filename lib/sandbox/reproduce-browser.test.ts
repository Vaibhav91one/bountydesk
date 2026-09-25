import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

import { JUICE_SHOP_EXPECTED_BUILD_MARKER } from "@/lib/targets/registry";
import type { ReproduceFn, ReproductionRecipe } from "@/lib/reproduction/types";

import type { ExecResult, Sandbox, SnapshotInfo } from "./daytona";

// The browser oracle branch of reproduce.ts, end to end against a faked Daytona. Proves a DOM-XSS
// recipe reaches REPRODUCED only through the isolated browser sandbox and the canary-in-sink check,
// and never through the HTTP legs (which this recipe still carries because the type requires them).
process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
process.env.BOUNTYDESK_REPRODUCE_READINESS_TIMEOUT_MS = "30";
process.env.BOUNTYDESK_REPRODUCE_READINESS_POLL_MS = "5";
process.env.BOUNTYDESK_BROWSER_SNAPSHOT = "browser-snap";
process.env.BOUNTYDESK_BROWSER_IMAGE_REF = "ghcr.io/bountydesk/browser@sha256:" + "b".repeat(64);
process.env.BOUNTYDESK_BROWSER_IMAGE_NAME = "ghcr.io/bountydesk/browser:test-sha";

// browser-probe.ts's EXPECTED_BROWSER_BUILD_MARKER. The browser sandbox reads this back from its own
// image; the target sandbox reads the juice-shop marker. They share the marker path, so the fake
// keys the answer on which sandbox is asking.
const BROWSER_BUILD_MARKER = "browser-dcl-1";

const FAKE_SANDBOX: Sandbox = {
  id: "target-sandbox",
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

// The browser sandbox is a separate sandbox created with a link back to the target. Giving it its
// own id lets the fake return the right build marker for each.
const FAKE_BROWSER_SANDBOX: Sandbox = { ...FAKE_SANDBOX, id: "browser-sandbox" };

const FAKE_SNAPSHOT: SnapshotInfo = {
  id: "snap",
  name: "snap",
  imageName: "ghcr.io/vaibhav91one/juice-shop@sha256:" + "a".repeat(64),
  state: "active",
  cpu: 1,
  mem: 1,
  disk: 3,
};

let deleteSandboxCalls: string[] = [];
let browserFires = true;

function browserOracleResult(command: string): ExecResult {
  const match = /printf %s '([A-Za-z0-9+/=]+)'/.exec(command);
  const params = JSON.parse(Buffer.from(match![1], "base64").toString("utf8")) as {
    steps: Array<{ label: string; hashPayload: string }>;
  };
  const steps = params.steps.map((step) => ({
    label: step.label,
    navigated: true,
    title: browserFires && step.label === "exploit" ? step.hashPayload : "",
    dom: "<html></html>",
    consoleText: "",
    dialogFired: false,
    dialogMessages: [],
  }));
  return { exitCode: 0, result: `BOUNTYDESK_BROWSER_RESULT ${JSON.stringify({ steps })}\n` };
}

function fakeExecute(sandbox: Sandbox, command: string): ExecResult {
  if (command.includes("bountydesk-build-marker")) {
    const marker = sandbox.id === FAKE_BROWSER_SANDBOX.id ? BROWSER_BUILD_MARKER : JUICE_SHOP_EXPECTED_BUILD_MARKER;
    return { exitCode: 0, result: `${marker}\n` };
  }
  if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl\n" };
  if (command.includes("bountydesk-egress")) {
    return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted\n" };
  }
  if (command.includes("browser-oracle.mjs")) return browserOracleResult(command);
  return { exitCode: 0, result: "200" };
}

mock.module("./daytona", {
  namedExports: {
    // Only the browser probe passes a link (back to the target); the target's own sandbox does not.
    createSandbox: async (_spec: unknown, _override: unknown, link?: { parentSandboxId: string }): Promise<Sandbox> =>
      link?.parentSandboxId ? FAKE_BROWSER_SANDBOX : FAKE_SANDBOX,
    getSandbox: async (id: string): Promise<Sandbox> => (id === FAKE_BROWSER_SANDBOX.id ? FAKE_BROWSER_SANDBOX : FAKE_SANDBOX),
    execute: async (sandbox: Sandbox, command: string): Promise<ExecResult> => fakeExecute(sandbox, command),
    deleteSandbox: async (id: string): Promise<void> => {
      deleteSandboxCalls.push(id);
    },
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

const recipe: ReproductionRecipe = {
  id: "juice-shop-dom-xss",
  title: "DOM XSS via hash sink",
  keywords: ["xss", "search"],
  // Required by the type but unused on the browser path: the branch runs before any HTTP leg.
  fixture: { request: { method: "POST", path: "/unused", body: {} } },
  negativeControl: { method: "GET", path: "/unused" },
  exploit: { method: "GET", path: "/unused" },
  oracleCheck: () => false,
  browserExploit: {
    sink: "title",
    negativeControl: { path: "/", hashPayload: "plain-{{canary}}" },
    exploit: { path: "/", hashPayload: "<img src=x onerror=\"document.title='{{canary}}'\">" },
  },
};

let reproduce: ReproduceFn;

before(async () => {
  const { createReproducer } = await import("./reproduce");
  reproduce = createReproducer(async () => ({
    ok: true,
    imageName: "ghcr.io/vaibhav91one/juice-shop",
    imageDigest: "sha256:" + "a".repeat(64),
    snapshotId: "snap",
    appPort: 3000,
    recipe,
    readinessPath: "/",
    expectedBuildMarker: JUICE_SHOP_EXPECTED_BUILD_MARKER,
  }));
});

test("a client-side recipe reaches REPRODUCED through the browser oracle", async () => {
  deleteSandboxCalls = [];
  browserFires = true;
  const result = await reproduce(
    { targetProfileId: "p", imageName: "", imageDigest: "", snapshotId: "snap", recipe },
    undefined,
  );
  assert.equal(result.outcome, "REPRODUCED");
  assert.ok(result.evidence?.canaryHash, "the run records a canary hash, never the value");
  assert.ok(deleteSandboxCalls.includes("target-sandbox"), "the target sandbox is torn down");
});

test("a client-side payload that does not execute is NOT_REPRODUCED", async () => {
  deleteSandboxCalls = [];
  browserFires = false;
  const result = await reproduce(
    { targetProfileId: "p", imageName: "", imageDigest: "", snapshotId: "snap", recipe },
    undefined,
  );
  assert.equal(result.outcome, "NOT_REPRODUCED");
});
