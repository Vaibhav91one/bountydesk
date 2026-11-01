import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

import type { ExecResult, Sandbox, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
process.env.BOUNTYDESK_WORKBENCH_ENABLED = "1";
process.env.BOUNTYDESK_WORKBENCH_SNAPSHOT = "workbench-snap";
process.env.BOUNTYDESK_WORKBENCH_IMAGE_REF = "ghcr.io/bountydesk/workbench@sha256:" + "c".repeat(64);
process.env.BOUNTYDESK_WORKBENCH_IMAGE_NAME = "ghcr.io/bountydesk/workbench:test-sha";

const EXPECTED_MARKER = "workbench-out-2";

const FAKE_WORKBENCH_SANDBOX: Sandbox = {
  id: "workbench-sandbox-1",
  state: "started",
  snapshot: "workbench-snap",
  networkBlockAll: true,
  networkAllowList: null,
  domainAllowList: null,
  toolboxProxyUrl: "https://toolbox.example",
  runnerId: "runner-1",
  sandboxClass: "container",
  public: false,
};

const FAKE_SNAPSHOT: SnapshotInfo = {
  id: "workbench-snap",
  name: "workbench-snap",
  imageName: "ghcr.io/bountydesk/workbench@sha256:" + "c".repeat(64),
  state: "active",
  cpu: 1,
  mem: 1,
  disk: 3,
};

let createSandboxCalls: Array<{ linkParent?: string; override?: string }> = [];
let deleteSandboxCalls: string[] = [];
let egressVerdict: "blocked" | "reached" = "blocked";
let markerValue: string | null = EXPECTED_MARKER;
let runnerRan = false;
let lastRunnerCommand = "";
let runnerStdout = "recon hit on /admin";
let runnerStderr = "";
let runnerExitCode = 0;

function decodeParams(command: string): { tool: string; targetOrigin: string; path: string; tags?: string[] } {
  const match = /printf %s '([A-Za-z0-9+/=]+)'/.exec(command);
  if (!match) throw new Error("runner command carried no base64 params");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
}

function runnerResult(command: string): ExecResult {
  const params = decodeParams(command);
  const payload = { tool: params.tool, exitCode: runnerExitCode, stdout: runnerStdout, stderr: runnerStderr };
  return { exitCode: 0, result: `runner chatter\nBOUNTYDESK_WORKBENCH_RESULT ${JSON.stringify(payload)}\n` };
}

function fakeExecute(_sandbox: Sandbox, command: string): ExecResult {
  if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl\n" };
  if (command.includes("bountydesk-egress")) {
    return egressVerdict === "blocked"
      ? { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted\n" }
      : { exitCode: 0, result: "PROBE exit=0 status=200\nBODY hello from the internet\n" };
  }
  if (command.includes("/etc/bountydesk-build-marker")) {
    return markerValue === null ? { exitCode: 1, result: "" } : { exitCode: 0, result: `${markerValue}\n` };
  }
  if (command.includes("workbench-runner.mjs")) {
    runnerRan = true;
    lastRunnerCommand = command;
    return runnerResult(command);
  }
  return { exitCode: 0, result: "200" };
}

mock.module("./daytona", {
  namedExports: {
    createSandbox: async (
      _spec: unknown,
      override?: unknown,
      link?: { parentSandboxId: string },
    ): Promise<Sandbox> => {
      createSandboxCalls.push({ linkParent: link?.parentSandboxId, override: override as string | undefined });
      return FAKE_WORKBENCH_SANDBOX;
    },
    getSandbox: async (): Promise<Sandbox> => FAKE_WORKBENCH_SANDBOX,
    execute: async (sandbox: Sandbox, command: string): Promise<ExecResult> => fakeExecute(sandbox, command),
    deleteSandbox: async (id: string): Promise<void> => {
      deleteSandboxCalls.push(id);
    },
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

// decideOutcome and reproduce.ts's oracle boundary must stay untouched by this file. Spying on
// the module (rather than trusting a grep of workbench-probe.ts) proves it at runtime: whatever
// this file imports, decideOutcome is never invoked as a side effect of running the workbench.
const decideOutcomeSpy = mock.fn(() => "REPRODUCED");
mock.module("@/lib/reproduction/decide", {
  namedExports: { decideOutcome: decideOutcomeSpy },
});

let mod: typeof import("./workbench-probe");

before(async () => {
  mod = await import("./workbench-probe");
});

beforeEach(() => {
  createSandboxCalls = [];
  deleteSandboxCalls = [];
  egressVerdict = "blocked";
  markerValue = EXPECTED_MARKER;
  runnerRan = false;
  lastRunnerCommand = "";
  runnerStdout = "recon hit on /admin";
  runnerStderr = "";
  runnerExitCode = 0;
  decideOutcomeSpy.mock.resetCalls();
});

const TARGET = { targetSandboxId: "target-sandbox-9", targetPort: 3000 };

test("workbenchProbeConfig is null when BOUNTYDESK_WORKBENCH_ENABLED is unset, even with the image configured", () => {
  const prev = process.env.BOUNTYDESK_WORKBENCH_ENABLED;
  delete process.env.BOUNTYDESK_WORKBENCH_ENABLED;
  try {
    assert.equal(mod.workbenchProbeConfig(), null);
  } finally {
    process.env.BOUNTYDESK_WORKBENCH_ENABLED = prev;
  }
});

test("workbenchProbeConfig is null when the flag is on but the image is not configured", () => {
  const prev = process.env.BOUNTYDESK_WORKBENCH_SNAPSHOT;
  delete process.env.BOUNTYDESK_WORKBENCH_SNAPSHOT;
  try {
    assert.equal(mod.workbenchProbeConfig(), null);
  } finally {
    process.env.BOUNTYDESK_WORKBENCH_SNAPSHOT = prev;
  }
});

test("runWorkbench refuses when the feature is not configured, and provisions nothing", async () => {
  const prev = process.env.BOUNTYDESK_WORKBENCH_ENABLED;
  delete process.env.BOUNTYDESK_WORKBENCH_ENABLED;
  try {
    const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "/" });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /not configured/);
    assert.equal(createSandboxCalls.length, 0);
  } finally {
    process.env.BOUNTYDESK_WORKBENCH_ENABLED = prev;
  }
});

test("runWorkbench refuses a tool outside the allowlist, before provisioning anything", async () => {
  // @ts-expect-error -- deliberately an out-of-allowlist tool, exactly what an agent might try.
  const result = await mod.runWorkbench(TARGET, { tool: "sqlmap", path: "/" });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /unsupported workbench tool/);
  assert.equal(createSandboxCalls.length, 0, "an unlisted tool never reaches a sandbox");
});

test("runWorkbench refuses an off-origin path before provisioning anything", async () => {
  const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "//evil.com/x" });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /same-origin/);
  assert.equal(createSandboxCalls.length, 0);
});

test("runWorkbench scans only the server-held target sandbox, never an agent-supplied host", async () => {
  // The caller can supply a tool, a path and nuclei tags, but never the target's address: the
  // function signature takes that from WorkbenchTargetRef, which the MCP wrapper fills from the
  // session row, not from any field on the request object.
  const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "/rest/products/search" });
  assert.equal(result.ok, true);
  assert.equal(createSandboxCalls[0].linkParent, TARGET.targetSandboxId);
  const params = decodeParams(lastRunnerCommand);
  assert.equal(params.targetOrigin, `http://${TARGET.targetSandboxId}:${TARGET.targetPort}`);
  assert.equal(params.path, "/rest/products/search");
});

test("runWorkbench fails closed and tears down when egress is not blocked", async () => {
  egressVerdict = "reached";
  const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "/" });
  assert.equal(result.ok, false, "a workbench sandbox that can reach the internet is never used");
  assert.equal(runnerRan, false, "no tool runs once egress leaks");
  assert.deepEqual(deleteSandboxCalls, [FAKE_WORKBENCH_SANDBOX.id], "the leaky sandbox is torn down");
});

test("runWorkbench fails closed and tears down when the build marker does not match", async () => {
  markerValue = "workbench-someoldsha";
  const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "/" });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /wrong build/);
  assert.equal(runnerRan, false, "the marker check runs before any tool executes");
  assert.deepEqual(deleteSandboxCalls, [FAKE_WORKBENCH_SANDBOX.id]);
});

test("runWorkbench fails closed when the build marker file is missing", async () => {
  markerValue = null;
  const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "/" });
  assert.equal(result.ok, false);
  assert.equal(runnerRan, false);
});

test("runWorkbench tears the sandbox down on the happy path too", async () => {
  const result = await mod.runWorkbench(TARGET, { tool: "nuclei", path: "/", tags: ["cve"] });
  assert.equal(result.ok, true);
  assert.equal(runnerRan, true);
  assert.deepEqual(deleteSandboxCalls, [FAKE_WORKBENCH_SANDBOX.id]);
});

test("runWorkbench drops a nuclei tag that is not lowercase-alnum-hyphen", async () => {
  await mod.runWorkbench(TARGET, { tool: "nuclei", path: "/", tags: ["cve-2021", "DROP TABLE", "ok-tag"] });
  const params = decodeParams(lastRunnerCommand);
  assert.deepEqual(params.tags, ["cve-2021", "ok-tag"]);
});

test("runWorkbench caps stdout and reports truncation", async () => {
  runnerStdout = "x".repeat(300_000);
  const result = await mod.runWorkbench(TARGET, { tool: "httpx", path: "/" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.stdout.length, 200_000);
    assert.equal(result.truncated, true);
  }
});

test("runWorkbench never calls decideOutcome: the workbench is evidence only", async () => {
  await mod.runWorkbench(TARGET, { tool: "nuclei", path: "/", tags: ["cve"] });
  assert.equal(decideOutcomeSpy.mock.callCount(), 0, "a scan hit is a lead, never a verdict this module computes");
});
