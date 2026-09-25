import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

import type { BrowserExploitLeg } from "@/lib/reproduction/types";

import type { ExecResult, Sandbox, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
// The feature is off unless both are set. Every test here needs it on, so set them before the
// module under test reads them through browserProbeConfig().
process.env.BOUNTYDESK_BROWSER_SNAPSHOT = "browser-snap";
process.env.BOUNTYDESK_BROWSER_IMAGE_REF = "ghcr.io/bountydesk/browser@sha256:" + "b".repeat(64);

const FAKE_BROWSER_SANDBOX: Sandbox = {
  id: "browser-sandbox-1",
  state: "started",
  snapshot: "browser-snap",
  networkBlockAll: true,
  networkAllowList: null,
  domainAllowList: null,
  toolboxProxyUrl: "https://toolbox.example",
  runnerId: "runner-1",
  sandboxClass: "container",
  public: false,
};

const FAKE_SNAPSHOT: SnapshotInfo = {
  id: "browser-snap",
  name: "browser-snap",
  imageName: "ghcr.io/bountydesk/browser@sha256:" + "b".repeat(64),
  state: "active",
  cpu: 1,
  mem: 1,
  disk: 3,
};

let createSandboxCalls: Array<{ linkParent?: string }> = [];
let deleteSandboxCalls: string[] = [];
let egressVerdict: "blocked" | "reached" = "blocked";
let lastOracleCommand = "";

/** How the faked browser renders each step. The fake decodes the base64 params the host wrote and,
 * for a step whose label says it should fire, echoes that step's own fragment (which carries the
 * substituted canary) into document.title. That mirrors a real DOM sink writing the canary into the
 * title, so the host's own grep is what the assertions actually exercise. */
let stepFires: (label: string) => boolean = (label) => label === "exploit";
let stepNavigates: (label: string) => boolean = () => true;

function decodeParams(command: string): { steps: Array<{ label: string; path: string; hashPayload: string }> } {
  const match = /printf %s '([A-Za-z0-9+/=]+)'/.exec(command);
  if (!match) throw new Error("oracle command carried no base64 params");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function oracleResult(command: string): ExecResult {
  const params = decodeParams(command);
  const steps = params.steps.map((step) => ({
    label: step.label,
    navigated: stepNavigates(step.label),
    // A fired sink puts the fragment (with the canary) into the title; a clean one leaves it empty.
    title: stepFires(step.label) ? step.hashPayload : "",
    dom: "<html><head></head><body>ok</body></html>",
    consoleText: "",
    dialogFired: false,
    dialogMessages: [],
  }));
  return { exitCode: 0, result: `some webcmd chatter\nBOUNTYDESK_BROWSER_RESULT ${JSON.stringify({ steps })}\n` };
}

function fakeExecute(_sandbox: Sandbox, command: string): ExecResult {
  if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl\n" };
  if (command.includes("bountydesk-egress")) {
    return egressVerdict === "blocked"
      ? { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted\n" }
      : { exitCode: 0, result: "PROBE exit=0 status=200\nBODY hello from the internet\n" };
  }
  if (command.includes("browser-oracle.mjs")) {
    lastOracleCommand = command;
    return oracleResult(command);
  }
  return { exitCode: 0, result: "200" };
}

mock.module("./daytona", {
  namedExports: {
    createSandbox: async (_spec: unknown, _override: unknown, link?: { parentSandboxId: string }): Promise<Sandbox> => {
      createSandboxCalls.push({ linkParent: link?.parentSandboxId });
      return FAKE_BROWSER_SANDBOX;
    },
    getSandbox: async (): Promise<Sandbox> => FAKE_BROWSER_SANDBOX,
    execute: async (sandbox: Sandbox, command: string): Promise<ExecResult> => fakeExecute(sandbox, command),
    deleteSandbox: async (id: string): Promise<void> => {
      deleteSandboxCalls.push(id);
    },
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

let mod: typeof import("./browser-probe");

before(async () => {
  mod = await import("./browser-probe");
});

beforeEach(() => {
  createSandboxCalls = [];
  deleteSandboxCalls = [];
  egressVerdict = "blocked";
  stepFires = (label) => label === "exploit";
  stepNavigates = () => true;
  lastOracleCommand = "";
});

const TARGET = { targetSandboxId: "target-sandbox-9", targetPort: 3000 };

const CANARY = "canary-abc123";

function leg(overrides: Partial<BrowserExploitLeg> = {}): BrowserExploitLeg {
  return {
    sink: "title",
    negativeControl: { path: "/", hashPayload: "plain-{{canary}}" },
    exploit: { path: "/", hashPayload: "<img src=x onerror=\"document.title='{{canary}}'\">" },
    ...overrides,
  };
}

test("runBrowserProbe refuses when the feature is not configured", async () => {
  const prev = process.env.BOUNTYDESK_BROWSER_SNAPSHOT;
  delete process.env.BOUNTYDESK_BROWSER_SNAPSHOT;
  try {
    const result = await mod.runBrowserProbe(TARGET, [{ label: "p", path: "/", hashPayload: "" }]);
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /not configured/);
    assert.equal(createSandboxCalls.length, 0, "nothing is provisioned when the feature is off");
  } finally {
    process.env.BOUNTYDESK_BROWSER_SNAPSHOT = prev;
  }
});

test("runBrowserProbe drops an off-origin step path before provisioning", async () => {
  // A leading // makes the URL parser read evil.com as the host, so this resolves off-origin.
  const result = await mod.runBrowserProbe(TARGET, [{ label: "p", path: "//evil.com/x", hashPayload: "" }]);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /same-origin/);
  assert.equal(createSandboxCalls.length, 0, "an off-origin path never reaches a sandbox");
});

test("runBrowserProbe links the browser sandbox to the target and tears it down", async () => {
  const result = await mod.runBrowserProbe(TARGET, [{ label: "p", path: "/", hashPayload: "" }]);
  assert.equal(result.ok, true);
  assert.equal(createSandboxCalls.length, 1);
  assert.equal(createSandboxCalls[0].linkParent, TARGET.targetSandboxId, "the browser links to the target sandbox");
  assert.deepEqual(deleteSandboxCalls, [FAKE_BROWSER_SANDBOX.id], "the browser sandbox is always torn down");
});

test("runBrowserProbe fails closed and tears down when egress is not blocked", async () => {
  egressVerdict = "reached";
  const result = await mod.runBrowserProbe(TARGET, [{ label: "p", path: "/", hashPayload: "" }]);
  assert.equal(result.ok, false, "a browser sandbox that can reach the internet is never used");
  assert.deepEqual(deleteSandboxCalls, [FAKE_BROWSER_SANDBOX.id], "the leaky sandbox is torn down");
});

test("runBrowserOracle returns REPRODUCED when the exploit puts the canary in the title", async () => {
  const result = await mod.runBrowserOracle(TARGET, leg(), CANARY);
  assert.equal(result.ok, true);
  assert.equal((result as { decision: string }).decision, "REPRODUCED");
});

test("runBrowserOracle returns NOT_REPRODUCED when the payload does not execute", async () => {
  stepFires = () => false; // neither leg's sink fires
  const result = await mod.runBrowserOracle(TARGET, leg(), CANARY);
  assert.equal(result.ok, true);
  assert.equal((result as { decision: string }).decision, "NOT_REPRODUCED");
});

test("runBrowserOracle refuses a dirty negative control", async () => {
  stepFires = () => true; // the canary shows in the sink even on the inert leg
  const result = await mod.runBrowserOracle(TARGET, leg(), CANARY);
  assert.equal(result.ok, true);
  assert.equal((result as { decision: string }).decision, "ANALYSIS_ONLY");
});

test("runBrowserOracle is ANALYSIS_ONLY when the target never rendered", async () => {
  stepNavigates = () => false;
  const result = await mod.runBrowserOracle(TARGET, leg(), CANARY);
  assert.equal(result.ok, true);
  assert.equal((result as { decision: string }).decision, "ANALYSIS_ONLY");
});

test("the canary rides only in the fragment, never the server-visible path", async () => {
  // The server-invisible fragment is the whole basis for trusting the sink: prove the substituted
  // canary lands only in each step's fragment and never in the path the server would see.
  await mod.runBrowserOracle(TARGET, leg(), CANARY);
  const params = decodeParams(lastOracleCommand);
  const exploit = params.steps.find((s) => s.label === "exploit")!;
  assert.ok(exploit.hashPayload.includes(CANARY), "the canary is substituted into the fragment");
  for (const step of params.steps) {
    assert.ok(!step.path.includes(CANARY), "the canary never appears in the server-visible path");
  }
});
