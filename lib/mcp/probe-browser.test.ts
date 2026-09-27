import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";
// Deliberately leave BOUNTYDESK_BROWSER_SNAPSHOT / _IMAGE_REF unset: these tests exercise the MCP
// wrapper's session and grant gates, which run before any sandbox is provisioned. A valid session
// that passes every gate then hits browserProbeConfig() returning null, so no sandbox is ever
// created here. The provisioning and oracle logic is covered in lib/sandbox/browser-probe.test.ts.

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let probeBrowserModule: typeof import("./probe-browser");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("probe_browser");
  dbm = await import("@/lib/db");
  probeBrowserModule = await import("./probe-browser");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/** Same shape as probe-target.test.ts's seedSession, trimmed to what these tests need: a report
 * bound to a pinned target (grant always active) unless `revoked` binds an inactive connected
 * repository instead. */
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
  const result = await probeBrowserModule.probeBrowser({ capability: "whatever", path: "evil.example/x" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /same-origin path/);
});

test("refuses an unknown capability", async () => {
  const result = await probeBrowserModule.probeBrowser({ capability: `unknown-${randomUUID()}`, path: "/" });
  assert.deepEqual(result, { ok: false, reason: "unknown capability" });
});

test("refuses a capability with no sandbox provisioned for its session", async () => {
  const capability = await seedSession();
  const result = await probeBrowserModule.probeBrowser({ capability, path: "/" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no sandbox is provisioned/);
});

test("refuses once the target's repository grant is revoked", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-1", appPort: 3000, revoked: true });
  const result = await probeBrowserModule.probeBrowser({ capability, path: "/" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /revoked/);
});

test("a fully authorized session still refuses cleanly when the browser probe is not configured", async () => {
  // This proves the wrapper passed every session and grant gate and delegated to runBrowserProbe,
  // which is off in this deployment, so nothing is provisioned.
  const capability = await seedSession({ sandboxId: "sandbox-1", appPort: 3000 });
  const result = await probeBrowserModule.probeBrowser({ capability, path: "/", hashPayload: "x" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not configured/);
});
