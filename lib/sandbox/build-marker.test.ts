import assert from "node:assert/strict";
import test, { before, mock } from "node:test";

import type { ExecResult, Sandbox } from "./daytona";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";

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

const EXPECTED_MARKER = "1867b926c5f50e4e692dc9c8f61821413cebe0cd";

let executeImpl: (sandbox: Sandbox, command: string) => Promise<ExecResult>;

mock.module("./daytona", {
  namedExports: {
    execute: (sandbox: Sandbox, command: string) => executeImpl(sandbox, command),
  },
});

let buildMarkerCheck: typeof import("./build-marker").buildMarkerCheck;

before(async () => {
  ({ buildMarkerCheck } = await import("./build-marker"));
});

test("a matching marker passes", async () => {
  executeImpl = async () => ({ exitCode: 0, result: `${EXPECTED_MARKER}\n` });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED_MARKER), true);
});

test("a mismatched marker fails", async () => {
  executeImpl = async () => ({ exitCode: 0, result: `${"0".repeat(40)}\n` });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED_MARKER), false);
});

test("execute() throwing is treated as a failure, never assumed to pass", async () => {
  executeImpl = async () => {
    throw new Error("toolbox unreachable");
  };

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED_MARKER), false);
});

test("a non-zero exit code (the marker file is missing) fails closed", async () => {
  executeImpl = async () => ({ exitCode: 1, result: "" });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED_MARKER), false);
});

test("an empty expected marker is refused before executing anything", async () => {
  let called = false;
  executeImpl = async () => {
    called = true;
    return { exitCode: 0, result: EXPECTED_MARKER };
  };

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, "   "), false);
  assert.equal(called, false, "a blank expected marker is a bug worth catching before touching the sandbox");
});
