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

async function seedSession(overrides: { sandboxId?: string | null; appPort?: number | null } = {}): Promise<string> {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:1:issue:${n}`,
      title: `report ${n}`,
      body: "body",
      state: "REPRODUCING",
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

test("refuses a path that isn't a same-origin path", async () => {
  const capability = await seedSession({ sandboxId: "sandbox-1", appPort: 3000 });

  const result = await probeTargetModule.probeTarget({
    capability,
    method: "GET",
    path: "//evil.example/x",
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /same-origin path/);
});

test("resolves the session's sandbox, injects the preview token fresh, and forwards the response", async () => {
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
      headers: { "x-daytona-preview-token": "caller-supplied-should-be-ignored" },
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
