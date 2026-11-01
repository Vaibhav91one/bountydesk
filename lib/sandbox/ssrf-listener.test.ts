import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

import type { ExecResult, Sandbox, SnapshotInfo } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
process.env.BOUNTYDESK_BROWSER_SNAPSHOT = "browser-snap";
process.env.BOUNTYDESK_BROWSER_IMAGE_REF = "ghcr.io/bountydesk/browser@sha256:" + "b".repeat(64);
process.env.BOUNTYDESK_BROWSER_IMAGE_NAME = "ghcr.io/bountydesk/browser:test-sha";
process.env.BOUNTYDESK_OOB_SETTLE_MS = "0";

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
let createSandboxThrows = false;
let clearFails = false;
let orphans: Sandbox[] = [];
let lastReadCommand = "";

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
    if (clearFails) return { exitCode: 1, result: "" };
    logContent = "";
    return { exitCode: 0, result: "BOUNTYDESK_OOB_CLEARED\n" };
  }
  if (command.includes("BOUNTYDESK_OOB_LOG_BEGIN")) {
    lastReadCommand = command;
    const body = logContent;
    if (command.includes("mv -f")) logContent = "";
    return {
      exitCode: 0,
      result: `BOUNTYDESK_OOB_LOG_BEGIN\n${body}\nBOUNTYDESK_OOB_LOG_END\n`,
    };
  }
  return { exitCode: 0, result: "" };
}

mock.module("./daytona", {
  namedExports: {
    createSandbox: async (_spec: unknown, override?: unknown, link?: { parentSandboxId: string }): Promise<Sandbox> => {
      createSandboxCalls.push({ linkParent: link?.parentSandboxId, override: override as string | undefined });
      if (createSandboxThrows) throw new Error("provider 500 after create");
      return FAKE_LISTENER_SANDBOX;
    },
    getSandbox: async (): Promise<Sandbox> => FAKE_LISTENER_SANDBOX,
    execute: async (sandbox: Sandbox, command: string): Promise<ExecResult> => fakeExecute(sandbox, command),
    deleteSandbox: async (id: string): Promise<void> => {
      deleteSandboxCalls.push(id);
    },
    listSandboxes: async (): Promise<Sandbox[]> => orphans,
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
  createSandboxThrows = false;
  clearFails = false;
  orphans = [];
  lastReadCommand = "";
  delete process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER;
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

test("sawCanary drain reads and resets the log in one exec, so a late callback is not erased unread", async () => {
  const started = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  logContent = JSON.stringify({ method: "GET", url: "/canary-late.jpg" });
  assert.deepEqual(await started.session.sawCanary("canary-late", undefined, { drain: true }), { ok: true, found: true });
  assert.match(lastReadCommand, /mv -f .* && touch /);
  assert.equal(logContent, "");
});

test("sawCanary ignores another run's canary and filters by canary on the listener so the size cap cannot hide it", async () => {
  const started = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  logContent = JSON.stringify({ method: "GET", url: "/someone-elses-canary.jpg" });
  assert.deepEqual(await started.session.sawCanary("canary-mine"), { ok: true, found: false });
  assert.match(lastReadCommand, /grep -aF -- 'canary-mine' /);
  // A canary that could break out of the single-quoted shell argument is refused, not interpolated.
  assert.deepEqual(await started.session.sawCanary("x'; rm -rf /; '"), { ok: false });
});

test("clearLog reports failure when the listener cannot reset the log", async () => {
  const started = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(started.ok, true);
  if (!started.ok) return;
  clearFails = true;
  assert.equal(await started.session.clearLog(), false);
});

test("a dedicated listener image needs its own BUILD_MARKER and it is the marker checked", async () => {
  process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT = "oob-snap";
  process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF = "ghcr.io/bountydesk/oob@sha256:" + "c".repeat(64);
  process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME = "ghcr.io/bountydesk/oob:test";
  try {
    assert.equal(mod.oobListenerConfig(), null);
    process.env.BOUNTYDESK_OOB_LISTENER_BUILD_MARKER = "oob-img-7";
    assert.equal(mod.oobListenerConfig()?.expectedBuildMarker, "oob-img-7");
    // The sandbox reports the browser marker, which no longer satisfies the dedicated image.
    const mismatch = await mod.startOobListener("target-sandbox-1", 8080);
    assert.equal(mismatch.ok, false);
  } finally {
    delete process.env.BOUNTYDESK_OOB_LISTENER_SNAPSHOT;
    delete process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_REF;
    delete process.env.BOUNTYDESK_OOB_LISTENER_IMAGE_NAME;
  }
});

test("a createSandbox failure sweeps any listener the provider created without returning an id", async () => {
  createSandboxThrows = true;
  orphans = [{ ...FAKE_LISTENER_SANDBOX, id: "orphan-listener" }];
  const started = await mod.startOobListener("target-sandbox-1", 8080);
  assert.equal(started.ok, false);
  assert.deepEqual(deleteSandboxCalls, ["orphan-listener"]);
});
