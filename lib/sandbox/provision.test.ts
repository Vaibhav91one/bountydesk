import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEgressProbe,
  peerHostsCommand,
  provisionMesh,
  ProvisionCouldNotDeployError,
} from "./provision";

const DENIAL = "Internet is restricted";

// curl: the proxy answers a blocked request with 403 and the denial body, and nothing else is
// accepted as proof. This preserves the behaviour that predated the wget fallback.
test("peerHostsCommand resolves each peer by sandbox id and appends its service name to /etc/hosts", () => {
  const cmd = peerHostsCommand([
    { name: "db", sandboxId: "sb-db-1" },
    { name: "redis", sandboxId: "sb-redis-2" },
  ]);
  // Resolves the peer's link ip by its sandbox id (link DNS), then maps the compose service name.
  assert.match(cmd, /getent hosts 'sb-db-1'/);
  assert.match(cmd, /echo "\$ip db" >> \/etc\/hosts/);
  assert.match(cmd, /getent hosts 'sb-redis-2'/);
  assert.match(cmd, /echo "\$ip redis" >> \/etc\/hosts/);
  // Missing peer resolution exits before reporting the wiring marker.
  assert.match(cmd, /if \[ -z "\$ip" \]; then echo 'peer lookup failed'/);
  assert.match(cmd, /echo BOUNTYDESK_PEERS_OK/);
});

test("peerHostsCommand is empty for a service with no peers", () => {
  assert.equal(peerHostsCommand([]), "");
});

test("provisionMesh fails closed before creating sandboxes for invalid topology", async () => {
  const base = {
    targetProfileId: "profile-1",
    appService: "web",
    readinessPath: "/",
    services: [
      {
        service: "web",
        role: "app" as const,
        imageName: "ghcr.io/example/web",
        imageDigest: "sha256:" + "a".repeat(64),
        snapshotId: "snap-web",
        port: 8080,
      },
    ],
  };

  await assert.rejects(
    provisionMesh({ ...base, appService: "wrong" }),
    (error: unknown) => error instanceof ProvisionCouldNotDeployError && /named app service/.test(error.message),
  );
  await assert.rejects(
    provisionMesh({
      ...base,
      services: [{ ...base.services[0], peers: ["missing"] }],
    }),
    (error: unknown) => error instanceof ProvisionCouldNotDeployError && /unknown peer/.test(error.message),
  );
  await assert.rejects(
    provisionMesh({
      ...base,
      services: [{ ...base.services[0], startCommand: "cd /app && docker run example" }],
    }),
    (error: unknown) => error instanceof ProvisionCouldNotDeployError && /host-level/.test(error.message),
  );
});

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
