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

const HEX = "27431c48ea981f99ffd59bf15271936c2b305197a963ab737aea919aeb80fdee";
const EXPECTED = `sha256:${HEX}`;

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

test("a matching resolved digest passes", async () => {
  executeImpl = async () => ({
    exitCode: 0,
    result: `cr.app.daytona.io/sbox/daytona-${HEX}:daytona\n`,
  });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED), true);
});

test("a mismatched resolved digest fails", async () => {
  const wrongHex = "0".repeat(64);
  executeImpl = async () => ({
    exitCode: 0,
    result: `cr.app.daytona.io/sbox/daytona-${wrongHex}:daytona\n`,
  });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED), false);
});

test("execute() throwing is treated as a failure, never assumed to pass", async () => {
  executeImpl = async () => {
    throw new Error("toolbox unreachable");
  };

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED), false);
});

test("a non-zero exit code (env var unset) fails closed", async () => {
  executeImpl = async () => ({ exitCode: 1, result: "" });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED), false);
});

test("output that doesn't parse as a snapshot reference fails closed", async () => {
  executeImpl = async () => ({ exitCode: 0, result: "not-a-daytona-snapshot-string\n" });

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, EXPECTED), false);
});

test("an invalid expected digest is refused before executing anything", async () => {
  let called = false;
  executeImpl = async () => {
    called = true;
    return { exitCode: 0, result: `cr.app.daytona.io/sbox/daytona-${HEX}:daytona` };
  };

  assert.equal(await buildMarkerCheck(FAKE_SANDBOX, "not-a-digest"), false);
  assert.equal(called, false, "a malformed expected digest is a bug worth catching before touching the sandbox");
});
