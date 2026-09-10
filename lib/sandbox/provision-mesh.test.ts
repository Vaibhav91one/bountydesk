import assert from "node:assert/strict";
import test, { before } from "node:test";
import { mock } from "node:test";

import type { Sandbox, SnapshotInfo } from "./daytona";
import type { MeshProvisionAuthorization } from "./provision";

type CreateCall = {
  spec: Record<string, unknown>;
  link?: { parentSandboxId: string };
};

const calls: string[] = [];
const created: CreateCall[] = [];
const deleted: string[] = [];
let executeImpl: (sandbox: Sandbox, command: string) => Promise<{ exitCode: number; result: string }>;

const snapshots: Record<string, SnapshotInfo> = {
  "snap-web": {
    id: "snap-web",
    name: "snap-web",
    state: "active",
    imageName: "ghcr.io/example/web:bountydesk-onboarding",
    cpu: 2,
    mem: 4,
    disk: 10,
  },
  "snap-db": {
    id: "snap-db",
    name: "snap-db",
    state: "active",
    imageName: "ghcr.io/example/db:bountydesk-onboarding",
    cpu: 2,
    mem: 4,
    disk: 10,
  },
};

function sandbox(id: string): Sandbox {
  return {
    id,
    state: "running",
    snapshot: id === "sb-web" ? "snap-web" : "snap-db",
    networkBlockAll: true,
    networkAllowList: null,
    domainAllowList: null,
    toolboxProxyUrl: null,
    runnerId: "runner-1",
    sandboxClass: "small",
    public: false,
  };
}

mock.module("./daytona", {
  namedExports: {
    createSandbox: async (spec: Record<string, unknown>, _override?: string, link?: { parentSandboxId: string }) => {
      const id = created.length === 0 ? "sb-web" : "sb-db";
      created.push({ spec, ...(link ? { link } : {}) });
      calls.push(`create:${id}`);
      return sandbox(id);
    },
    getSandbox: async (id: string) => sandbox(id),
    getSnapshot: async (id: string) => snapshots[id]!,
    execute: async (sb: Sandbox, command: string) => executeImpl(sb, command),
    deleteSandbox: async (id: string) => {
      deleted.push(id);
      calls.push(`delete:${id}`);
    },
  },
});

let provisionMesh: typeof import("./provision").provisionMesh;
let ProvisionCouldNotDeployError: typeof import("./provision").ProvisionCouldNotDeployError;

before(async () => {
  const provisionModule = await import("./provision");
  provisionMesh = provisionModule.provisionMesh;
  ProvisionCouldNotDeployError = provisionModule.ProvisionCouldNotDeployError;
});

function reset(): void {
  calls.length = 0;
  created.length = 0;
  deleted.length = 0;
  executeImpl = async (sb, command) => {
    calls.push(`${sb.id}:${command}`);
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl" };
    if (command.includes("PROBE exit=")) return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted" };
    if (command.startsWith("cat /etc/bountydesk-build-marker")) {
      return { exitCode: 0, result: sb.id === "sb-web" ? "marker-web" : "marker-db" };
    }
    if (command.includes("BOUNTYDESK_PEERS_OK")) return { exitCode: 0, result: "BOUNTYDESK_PEERS_OK" };
    if (command.includes("curl -s -o /dev/null --connect-timeout")) return { exitCode: 0, result: "UP" };
    if (command.includes("-w '%{http_code}'")) return { exitCode: 0, result: "200" };
    return { exitCode: 0, result: "launched" };
  };
}

function auth(): MeshProvisionAuthorization {
  return {
    targetProfileId: "profile-1",
    appService: "web",
    readinessPath: "/health",
    services: [
      {
        service: "web",
        role: "app",
        imageName: "ghcr.io/example/web",
        imageDigest: "sha256:" + "a".repeat(64),
        snapshotId: "snap-web",
        port: 8080,
        buildMarker: "marker-web",
        startCommand: "node server.js",
        peers: ["db"],
      },
      {
        service: "db",
        role: "dependency",
        imageName: "ghcr.io/example/db",
        imageDigest: "sha256:" + "b".repeat(64),
        snapshotId: "snap-db",
        port: 5432,
        buildMarker: "marker-db",
        startCommand: "postgres",
        peers: [],
      },
    ],
  };
}

test("provisionMesh boots linked dependencies, verifies every node, then starts app", async () => {
  reset();
  const result = await provisionMesh(auth());

  assert.deepEqual(result, { sandboxId: "sb-web", appPort: 8080, sandboxIds: ["sb-web", "sb-db"] });
  assert.deepEqual(created.map((entry) => entry.link), [undefined, { parentSandboxId: "sb-web" }]);
  assert.equal(created[0]?.spec.snapshot, "snap-web");
  assert.equal(created[1]?.spec.snapshot, "snap-db");
  assert.equal(calls.filter((call) => call.includes("PROBE exit=")).length, 4);
  assert.ok(calls.some((call) => call.includes("echo \"$ip db\"")));
  assert.ok(calls.some((call) => call.startsWith("sb-db:setsid sh -c 'postgres'")));
  assert.ok(calls.some((call) => call.startsWith("sb-web:setsid sh -c 'node server.js'")));
  assert.deepEqual(deleted, [], "successful provisioning leaves ownership with caller");
});

test("provisionMesh does not wire undeclared peers when peers are omitted", async () => {
  reset();
  const topology = auth();
  topology.services[0] = { ...topology.services[0], peers: undefined };
  await provisionMesh(topology);
  assert.equal(calls.some((call) => call.includes("/etc/hosts")), false);
});

test("provisionMesh tears down the whole group when a dependency fails verification", async () => {
  reset();
  executeImpl = async (sb, command) => {
    if (sb.id === "sb-db" && command.includes("PROBE exit=")) {
      throw new Error("dependency egress probe failed");
    }
    return (async () => {
      if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl" };
      if (command.includes("PROBE exit=")) return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted" };
      if (command.startsWith("cat /etc/bountydesk-build-marker")) return { exitCode: 0, result: "marker-web" };
      if (command.includes("BOUNTYDESK_PEERS_OK")) return { exitCode: 0, result: "BOUNTYDESK_PEERS_OK" };
      return { exitCode: 0, result: "launched" };
    })();
  };

  await assert.rejects(provisionMesh(auth()), (error: unknown) => {
    return error instanceof Error && error.name === "ProvisionTargetUnavailableError";
  });
  assert.deepEqual(deleted, ["sb-db", "sb-web"]);
  assert.ok(ProvisionCouldNotDeployError);
});

test("provisionMesh tears down the group when the app fails its egress probe", async () => {
  reset();
  executeImpl = async (sb, command) => {
    if (sb.id === "sb-web" && command.includes("PROBE exit=")) {
      throw new Error("app egress probe failed");
    }
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl" };
    if (command.includes("PROBE exit=")) return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted" };
    if (command.startsWith("cat /etc/bountydesk-build-marker")) return { exitCode: 0, result: "marker-web" };
    if (command.includes("BOUNTYDESK_PEERS_OK")) return { exitCode: 0, result: "BOUNTYDESK_PEERS_OK" };
    return { exitCode: 0, result: "launched" };
  };

  await assert.rejects(
    provisionMesh(auth()),
    (error: unknown) => error instanceof Error && error.name === "ProvisionTargetUnavailableError",
  );
  assert.deepEqual(deleted, ["sb-db", "sb-web"]);
});

test("provisionMesh refuses a dependency whose build marker does not match", async () => {
  reset();
  executeImpl = async (sb, command) => {
    if (sb.id === "sb-db" && command.startsWith("cat /etc/bountydesk-build-marker")) {
      return { exitCode: 0, result: "some-other-build" };
    }
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl" };
    if (command.includes("PROBE exit=")) return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted" };
    if (command.startsWith("cat /etc/bountydesk-build-marker")) return { exitCode: 0, result: "marker-web" };
    if (command.includes("BOUNTYDESK_PEERS_OK")) return { exitCode: 0, result: "BOUNTYDESK_PEERS_OK" };
    return { exitCode: 0, result: "launched" };
  };

  await assert.rejects(provisionMesh(auth()), /booted the wrong build/);
  assert.deepEqual(deleted, ["sb-db", "sb-web"]);
});

test("provisionMesh fails closed when a peer cannot be wired", async () => {
  reset();
  executeImpl = async (sb, command) => {
    if (command.includes("BOUNTYDESK_PEERS_OK")) {
      return { exitCode: 1, result: "peer lookup failed" };
    }
    if (command.includes("command -v curl")) return { exitCode: 0, result: "TOOL=curl" };
    if (command.includes("PROBE exit=")) return { exitCode: 0, result: "PROBE exit=0 status=403\nBODY Internet is restricted" };
    if (command.startsWith("cat /etc/bountydesk-build-marker")) {
      return { exitCode: 0, result: sb.id === "sb-web" ? "marker-web" : "marker-db" };
    }
    return { exitCode: 0, result: "launched" };
  };

  await assert.rejects(provisionMesh(auth()), /could not wire its peers/);
  assert.deepEqual(deleted, ["sb-db", "sb-web"]);
});

test("provisionMesh leaves an image-only dependency without a marker check", async () => {
  reset();
  const topology = auth();
  topology.services[1] = { ...topology.services[1], buildMarker: undefined };
  await provisionMesh(topology);
  assert.equal(
    calls.some((call) => call.startsWith("sb-db:cat /etc/bountydesk-build-marker")),
    false,
    "a pulled dependency has no repository marker to prove",
  );
  assert.ok(calls.some((call) => call.startsWith("sb-web:cat /etc/bountydesk-build-marker")));
});
