import assert from "node:assert/strict";
import test from "node:test";

import { classifyEgressProbe } from "./provision";

const DENIAL = "Internet is restricted";

// curl: the proxy answers a blocked request with 403 and the denial body, and nothing else is
// accepted as proof. This preserves the behaviour that predated the wget fallback.
test("curl: 403 with the denial body is the only pass", () => {
  assert.equal(
    classifyEgressProbe({ tool: "curl", exitCode: 0, status: "403", body: DENIAL, stderr: "" }),
    "blocked",
  );
});

test("curl: a real 200 is reached, which fails the check", () => {
  assert.equal(
    classifyEgressProbe({ tool: "curl", exitCode: 0, status: "200", body: "<html>ok</html>", stderr: "" }),
    "reached",
  );
});

test("curl: a 403 without the denial body is not proof, so it fails closed as reached", () => {
  assert.equal(
    classifyEgressProbe({ tool: "curl", exitCode: 0, status: "403", body: "nope", stderr: "" }),
    "reached",
  );
});

test("curl: a dead connection (no status) fails closed as reached", () => {
  assert.equal(
    classifyEgressProbe({ tool: "curl", exitCode: 7, status: null, body: "", stderr: "" }),
    "reached",
  );
});

// wget (busybox/alpine): a clean exit means it downloaded a 2xx from a real service.
test("wget: exit 0 means it reached a real service", () => {
  assert.equal(
    classifyEgressProbe({ tool: "wget", exitCode: 0, status: null, body: "<html>ok</html>", stderr: "" }),
    "reached",
  );
});

test("wget: a non-zero exit carrying the 403 server-error line is blocked", () => {
  assert.equal(
    classifyEgressProbe({
      tool: "wget",
      exitCode: 1,
      status: null,
      body: "",
      stderr: "wget: server returned error: HTTP/1.1 403 Forbidden",
    }),
    "blocked",
  );
});

test("wget: the proxy denial body also proves blocked", () => {
  assert.equal(
    classifyEgressProbe({ tool: "wget", exitCode: 1, status: null, body: DENIAL, stderr: "" }),
    "blocked",
  );
});

test("wget: a bare timeout with no denial signal is inconclusive, not a pass", () => {
  assert.equal(
    classifyEgressProbe({
      tool: "wget",
      exitCode: 1,
      status: null,
      body: "",
      stderr: "wget: download timed out",
    }),
    "inconclusive",
  );
});

// The load-bearing security property: open egress can never read as blocked, whichever tool ran.
test("open egress never reads as blocked", () => {
  assert.notEqual(
    classifyEgressProbe({ tool: "curl", exitCode: 0, status: "200", body: "real", stderr: "" }),
    "blocked",
  );
  assert.notEqual(
    classifyEgressProbe({ tool: "wget", exitCode: 0, status: null, body: "real", stderr: "" }),
    "blocked",
  );
});
