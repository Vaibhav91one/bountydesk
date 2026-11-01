import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before, mock } from "node:test";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";

// runWorkbench is replaced so the happy path proves what the wrapper hands it without provisioning
// anything. The sandbox logic itself is covered in lib/sandbox/workbench-probe.test.ts.
const runWorkbenchMock = mock.fn(async (...args: unknown[]) => {
  void args;
  return { ok: true as const, tool: "httpx" as const, exitCode: 0, stdout: "ok", stderr: "", truncated: false };
});
mock.module("@/lib/sandbox/workbench-probe", {
  namedExports: { runWorkbench: runWorkbenchMock },
});

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let probeWorkbenchModule: typeof import("./probe-workbench");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("probe_workbench");
  dbm = await import("@/lib/db");
  probeWorkbenchModule = await import("./probe-workbench");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** Same shape as probe-browser.test.ts's seedSession: a report bound to a pinned target (grant
 * always active) unless `revoked` binds an inactive connected repository instead. */
async function seedSession(
  overrides: { sandboxId?: string | null; appPort?: number | null; revoked?: boolean } = {},
): Promise<string> {
  seq += 1;
  const n = seq;

  const [t] = await dbm.db
    .insert(dbm.targetProfile)
    .values({
      name: `juice-shop-${n}`,
      imageName: "ghcr.io/vaibhav91one/juice-shop",
      imageDigest: "sha256:" + "a".repeat(64),
      config: { baseUrl: "http://localhost:3000" },
      scopeRules: [],
    })
    .returning({ id: dbm.targetProfile.id });
  const targetProfileId = t.id;

  let connectedRepositoryId: string | null = null;
  if (overrides.revoked) {
    const [installation] = await dbm.db
      .insert(dbm.githubInstallation)
      .values({ installationId: n, accountLogin: `acct-${n}`, accountId: n, accountType: "User" })
      .returning({ id: dbm.githubInstallation.id });
    const [repo] = await dbm.db
      .insert(dbm.connectedRepository)
      .values({ installationId: installation.id, repoId: n, fullName: `owner/repo-${n}`, targetProfileId, active: false })
      .returning({ id: dbm.connectedRepository.id });
    connectedRepositoryId = repo.id;
  }

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${n}`,
      title: `report ${n}`,
      body: "body",
      state: "REPRODUCING",
      targetProfileId,
      connectedRepositoryId,
    })
    .returning({ id: dbm.report.id });

  const capabilityToken = `cap-${n}-${randomUUID()}`;
  await dbm.db.insert(dbm.agentSession).values({
    reportId: r.id,
    capabilityToken,
    sessionId: `session-${n}`,
    sandboxId: overrides.sandboxId === undefined ? null : overrides.sandboxId,
    appPort: overrides.appPort === undefined ? null : overrides.appPort,
  });

  return capabilityToken;
}

test("refuses a path that does not start with a single '/', before any lookup", async () => {
  const result = await probeWorkbenchModule.probeWorkbench({
    capability: "whatever",
    tool: "httpx",
    path: "evil.example/x",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /same-origin path/);
});

test("refuses an unknown capability", async () => {
  const result = await probeWorkbenchModule.probeWorkbench({
    capability: `unknown-${randomUUID()}`,
    tool: "httpx",
    path: "/",
  });
  assert.deepEqual(result, { ok: false, reason: "unknown capability" });
});

test("refuses a capability with no sandbox provisioned for its session", async () => {
  const capability = await seedSession();
  const result = await probeWorkbenchModule.probeWorkbench({ capability, tool: "httpx", path: "/" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no sandbox is provisioned/);
});

test("refuses once the target's repository grant is revoked", async () => {
  const before = runWorkbenchMock.mock.callCount();
  const capability = await seedSession({ sandboxId: "sandbox-1", appPort: 3000, revoked: true });
  const result = await probeWorkbenchModule.probeWorkbench({ capability, tool: "httpx", path: "/" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /revoked/);
  assert.equal(runWorkbenchMock.mock.callCount(), before, "a revoked target is never scanned");
});

test("a fully authorized session runs the workbench against the session's server-held target", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-7", appPort: 4321 });
  const result = await probeWorkbenchModule.probeWorkbench({
    capability,
    tool: "nuclei",
    path: "/rest/products",
    tags: ["cve"],
  });
  assert.equal(result.ok, true);
  const call = runWorkbenchMock.mock.calls.at(-1)!;
  assert.deepEqual(call.arguments[0], { targetSandboxId: "sandbox-7", targetPort: 4321 });
  assert.deepEqual(call.arguments[1], { tool: "nuclei", path: "/rest/products", tags: ["cve"] });
});
