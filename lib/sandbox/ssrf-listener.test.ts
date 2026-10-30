import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

import type { ExecResult, Sandbox, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
process.env.BOUNTYDESK_BROWSER_SNAPSHOT = "browser-snap";
process.env.BOUNTYDESK_BROWSER_IMAGE_REF = "ghcr.io/bountydesk/browser@sha256:" + "b".repeat(64);
process.env.BOUNTYDESK_BROWSER_IMAGE_NAME = "ghcr.io/bountydesk/browser:test-sha";

const EXPECTED_MARKER = "browser-out-1";

const FAKE_LISTENER_SANDBOX: Sandbox = {
  id: "oob-listener-sandbox-1",
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

let createSandboxCalls: Array<{ linkParent?: string; override?: string }> = [];
let deleteSandboxCalls: string[] = [];
let egressVerdict: "blocked" | "reached" = "blocked";
let markerValue: string | null = EXPECTED_MARKER;
let startSucceeds = true;
let logContent = "";

function fakeExecute(_sandbox: Sandbox, command: string): ExecResult {
  if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl\n" };
  if (command.includes("bountydesk-egress")) {
    return egressVerdict === "blocked"
      ? { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted\n" }
      : { exitCode: 0, result: "PROBE exit=0 status=200\nBODY hello from the internet\n" };
  }
  if (command.includes("/etc/bountydesk-build-marker")) {
    return markerValue === null
      ? { exitCode: 1, result: "" }
      : { exitCode: 0, result: `${markerValue}\n` };
  }
  if (command.includes("bountydesk-oob-server.js")) {
    return startSucceeds
      ? { exitCode: 0, result: "BOUNTYDESK_OOB_LISTENER_READY\n" }
      : { exitCode: 1, result: "" };
  }
  if (command.includes("BOUNTYDESK_OOB_CLEARED")) {
    logContent = "";
    return { exitCode: 0, result: "BOUNTYDESK_OOB_CLEARED\n" };
  }
  if (command.includes("BOUNTYDESK_OOB_LOG_BEGIN")) {
    return {
      exitCode: 0,
      result: `BOUNTYDESK_OOB_LOG_BEGIN\n${logContent}\nBOUNTYDESK_OOB_LOG_END\n`,
    };
  }
  return { exitCode: 0, result: "" };
}

mock.module("./daytona", {
  namedExports: {
    createSandbox: async (_spec: unknown, override?: unknown, link?: { parentSandboxId: string }): Promise<Sandbox> => {
      createSandboxCalls.push({ linkParent: link?.parentSandboxId, override: override as string | undefined });
      return FAKE_LISTENER_SANDBOX;
    },
    getSandbox: async (): Promise<Sandbox> => FAKE_LISTENER_SANDBOX,
    execute: async (sandbox: Sandbox, command: string): Promise<ExecResult> => fakeExecute(sandbox, command),
    deleteSandbox: async (id: string): Promise<void> => {
      deleteSandboxCalls.push(id);
    },
    getSnapshot: async (): Promise<SnapshotInfo> => FAKE_SNAPSHOT,
  },
});

let mod: typeof import("./ssrf-listener");

before(async () => {
  mod = await import("./ssrf-listener");
});

beforeEach(() => {
  createSandboxCalls = [];
  deleteSandboxCalls = [];
  egressVerdict = "blocked";
  markerValue = EXPECTED_MARKER;
  startSucceeds = true;
  logContent = "";
});

test("startOobListener links to the target sandbox, verifies no egress and marker, and reads canary hits", async () => {
  const started = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(started.ok, true);
  if (!started.ok) return;

  assert.deepEqual(createSandboxCalls, [
    { linkParent: "target-sandbox-1", override: "ghcr.io/bountydesk/browser:test-sha" },
  ]);
  assert.equal(started.session.callbackUrl, "http://oob-listener-sandbox-1:8080");

  assert.deepEqual(await started.session.sawCanary("canary-123"), { ok: true, found: false });

  logContent = JSON.stringify({ method: "GET", url: "/canary-123.jpg" });
  assert.deepEqual(await started.session.sawCanary("canary-123"), { ok: true, found: true });

  assert.equal(await started.session.clearLog(), true);
  assert.deepEqual(await started.session.sawCanary("canary-123"), { ok: true, found: false });

  await started.session.close(false);
  assert.deepEqual(deleteSandboxCalls, ["oob-listener-sandbox-1"]);
});

test("startOobListener fails closed and tears down if egress is not blocked or build marker mismatches", async () => {
  egressVerdict = "reached";
  const openEgress = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(openEgress.ok, false);
  assert.deepEqual(deleteSandboxCalls, ["oob-listener-sandbox-1"]);

  deleteSandboxCalls = [];
  egressVerdict = "blocked";
  markerValue = "wrong-marker";
  const badMarker = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(badMarker.ok, false);
  assert.deepEqual(deleteSandboxCalls, ["oob-listener-sandbox-1"]);
});
