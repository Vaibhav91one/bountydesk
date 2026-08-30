import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// getPortPreviewUrl reads this through requireSecret before it ever reaches the stubbed
// fetch below; CI and a bare checkout have no real key, so this must be set here rather than
// assumed from the environment, same as reproduce.test.ts's own DAYTONA_API_KEY line.
process.env.DAYTONA_API_KEY = "dtn_test_key_not_a_real_one";

/**
 * Real Postgres for the same reason publish-verdict.test.ts uses one: the capability lookup
 * this tool relies on is a real unique index, not something a mock could quietly disagree with.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

let dbm: typeof import("@/lib/db");
let probeTargetModule: typeof import("./probe-target");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("probe_target");

  dbm = await import("@/lib/db");
  probeTargetModule = await import("./probe-target");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

/**
 * By default seeds a report bound to a target profile with no connected repository -- the
 * pinned-target case hasActiveRepositoryGrant treats as always active, matching production's
 * one demo target. `revoked: true` instead binds a connected repository whose grant is already
 * inactive, for the tests that prove probeTarget refuses to serve a session past that point.
 */
async function seedSession(
  overrides: { sandboxId?: string | null; appPort?: number | null; noTargetProfile?: boolean; revoked?: boolean } = {},
): Promise<string> {
  seq += 1;
  const n = seq;

  let targetProfileId: string | null = null;
  let connectedRepositoryId: string | null = null;

  if (!overrides.noTargetProfile) {
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
    targetProfileId = t.id;

    if (overrides.revoked) {
      const [installation] = await dbm.db
        .insert(dbm.githubInstallation)
        .values({ installationId: n, accountLogin: `acct-${n}`, accountId: n, accountType: "User" })
        .returning({ id: dbm.githubInstallation.id });
      const [repo] = await dbm.db
        .insert(dbm.connectedRepository)
        .values({
          installationId: installation.id,
          repoId: n,
          fullName: `owner/repo-${n}`,
          targetProfileId,
          // Inactive: hasActiveRepositoryGrant requires active === true, so this alone revokes it.
          active: false,
        })
        .returning({ id: dbm.connectedRepository.id });
      connectedRepositoryId = repo.id;
    }
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

/** A fetch stub that only ever answers the Daytona preview-url lookup, for tests whose refusal
 * must happen before (or regardless of) any request actually reaching the sandbox. */
function previewOnlyStub(url = "https://preview.example", token = "preview-token-abc"): typeof fetch {
  return (async (input: string | URL | Request) => {
    const requested = typeof input === "string" ? input : input.toString();
    if (requested.includes("/ports/") && requested.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ url, token }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${requested}`);
  }) as typeof fetch;
}

async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("refuses an unknown capability", async () => {
  const result = await probeTargetModule.probeTarget({
    capability: `unknown-${randomUUID()}`,
    method: "GET",
    path: "/",
  });

  assert.deepEqual(result, { ok: false, reason: "unknown capability" });
});

test("refuses a capability with no sandbox provisioned for its session", async () => {
  const capability = await seedSession();

  const result = await probeTargetModule.probeTarget({ capability, method: "GET", path: "/rest/products" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no sandbox is provisioned/);
});

test("refuses a path that doesn't start with a single '/', before ever touching the network", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-1", appPort: 3000 });

  const result = await probeTargetModule.probeTarget({
    capability,
    method: "GET",
    path: "evil.example/x",
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /same-origin path/);
});

test("refuses a path that resolves off the preview origin (WHATWG backslash-as-slash escape)", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-1", appPort: 3000 });

  // For a special (http/https) URL, a leading "/\" is parsed the same as "//": a naive check
  // that only rejects a literal "//" prefix lets this resolve to https://evil.example/x once
  // appended to the preview origin. resolveTargetUrl must catch it by comparing origins, not
  // by pattern-matching the input string.
  const result = await withFetch(previewOnlyStub(), () =>
    probeTargetModule.probeTarget({
      capability,
      method: "GET",
      path: "/\\evil.example/x",
    }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /same-origin request/);
});

test("resolves the session's sandbox, injects the preview token fresh, strips a caller Host, and forwards the response", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-under-test", appPort: 3000 });

  const calls: { url: string; init?: RequestInit }[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.includes("/ports/") && url.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ url: "https://preview.example", token: "preview-token-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ products: [] }), { status: 200 });
  }) as typeof fetch;

  const result = await withFetch(stub, () =>
    probeTargetModule.probeTarget({
      capability,
      method: "GET",
      path: "/rest/products/search?q=juice",
      headers: {
        "x-daytona-preview-token": "caller-supplied-should-be-ignored",
        Host: "attacker.example",
        "x-real-header": "kept",
      },
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, 200);
  assert.equal(result.body, JSON.stringify({ products: [] }));

  const forwarded = calls.find((c) => !c.url.includes("/preview-url"));
  assert.equal(forwarded?.url, "https://preview.example/rest/products/search?q=juice");
  const headers = new Headers(forwarded?.init?.headers);
  assert.equal(
    headers.get("x-daytona-preview-token"),
    "preview-token-abc",
    "the server's own preview token must win over anything the caller supplied",
  );
  assert.notEqual(headers.get("host"), "attacker.example", "a caller-supplied Host must never reach the outbound request");
  assert.equal(headers.get("x-real-header"), "kept", "only Host is stripped, not every caller header");
});

test("refuses cleanly when the preview-url lookup fails", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-gone", appPort: 3000 });

  const stub = (async () => new Response("not found", { status: 404 })) as typeof fetch;

  const result = await withFetch(stub, () =>
    probeTargetModule.probeTarget({ capability, method: "GET", path: "/" }),
  );

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not reach the sandbox/);
});

test("refuses a session whose report never had a bound target profile, even with a sandboxId present", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-orphaned", appPort: 3000, noTargetProfile: true });

  const result = await probeTargetModule.probeTarget({ capability, method: "GET", path: "/" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /authorization has been revoked/);
});

test("refuses a session whose connected repository's grant has since been revoked", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-revoked", appPort: 3000, revoked: true });

  const result = await probeTargetModule.probeTarget({ capability, method: "GET", path: "/" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /authorization has been revoked/);
});

/**
 * POST is gated one layer up (app/api/mcp/publish-verdict/route.ts registers it only under the
 * separate probe_target_write tool name, which the harness's own requireApprovalForTools pauses
 * for a human Allow/Deny before this function is ever called with approvedForWrite: true). These
 * tests exercise this function's own fail-closed backstop for that split.
 */
test("refuses a POST with no opts at all, before ever touching the network", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-write", appPort: 3000 });

  const result = await probeTargetModule.probeTarget({
    capability,
    method: "POST",
    path: "/rest/user/login",
    body: JSON.stringify({ email: "a", password: "b" }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /probe_target_write/);
});

test("refuses a POST with approvedForWrite explicitly false", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-write", appPort: 3000 });

  const result = await probeTargetModule.probeTarget(
    { capability, method: "POST", path: "/rest/user/login" },
    { approvedForWrite: false },
  );

  assert.equal(result.ok, false);
});

test("a POST is forwarded once approvedForWrite is true, the flag only probe_target_write's own handler ever sets", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-write", appPort: 3000 });

  const stub = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/ports/") && url.endsWith("/preview-url")) {
      return new Response(JSON.stringify({ url: "https://preview.example", token: "preview-token-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ authentication: { token: "jwt" } }), { status: 200 });
  }) as typeof fetch;

  const result = await withFetch(stub, () =>
    probeTargetModule.probeTarget(
      {
        capability,
        method: "POST",
        path: "/rest/user/login",
        body: JSON.stringify({ email: "a", password: "b" }),
      },
      { approvedForWrite: true },
    ),
  );

  assert.equal(result.ok, true);
});
