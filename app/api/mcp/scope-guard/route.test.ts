import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Auth is one point of this suite (a wrong or missing bearer header must never reach a tool
 * handler at all, same as publish-verdict's route test), and the rest is an end-to-end smoke
 * test of the tool surface against a real target_profile row: scope_check/scope_add/scope_list
 * round-tripping through Postgres, and audit_read showing the resulting trail. The exhaustive
 * Scope/audit/grant logic lives in lib/scope-guard/*.test.ts; this file only proves the route
 * wiring end to end.
 */
const TOKEN = "scope-guard-route-test-token";
process.env.SCOPE_GUARD_TOKEN = TOKEN;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let POST: typeof import("./route").POST;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("mcp_scope_guard_route");

  dbm = await import("@/lib/db");
  ({ POST } = await import("./route"));
  await dbm.db.execute("select 1");

  await dbm.db.insert(dbm.targetProfile).values({
    name: `route-test-${randomUUID()}`,
    imageDigest: `sha256:${"0".repeat(64)}`,
    scopeRules: [{ allow: "localhost" }],
  });
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function toolCallRequest(name: string, args: Record<string, unknown>, headers: Record<string, string>): Request {
  return new Request("https://bountydesk.test/api/mcp/scope-guard", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await POST(toolCallRequest(name, args, { authorization: `Bearer ${TOKEN}` }));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { isError?: boolean; content: { type: string; text: string }[] } };
  assert.equal(body.result.isError, undefined, `tool call errored: ${body.result.content?.[0]?.text}`);
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

test("a missing Authorization header is rejected before any tool handler runs", async () => {
  const response = await POST(toolCallRequest("scope_list", {}, {}));
  assert.equal(response.status, 401);
});

test("a wrong Authorization header is rejected before any tool handler runs", async () => {
  const response = await POST(toolCallRequest("scope_list", {}, { authorization: "Bearer not-the-token" }));
  assert.equal(response.status, 401);
});

test("scope_check denies an out-of-scope target and audits the denial", async () => {
  const result = await callTool("scope_check", { target: "http://not-in-scope.example" });
  assert.equal(result.allowed, false);

  const audit = await callTool("audit_read", { limit: 1 });
  const entries = audit.entries as { action: string; verdict: string }[];
  assert.equal(entries[0].action, "scope_check");
  assert.equal(entries[0].verdict, "denied");
});

test("scope_check allows a target already on the seeded allowlist", async () => {
  const result = await callTool("scope_check", { target: "http://localhost:3000" });
  assert.equal(result.allowed, true);
  assert.equal(result.matched, "localhost");
});

test("scope_add persists a new entry that scope_check and scope_list both see afterward", async () => {
  const added = await callTool("scope_add", { entry: "example.com" });
  assert.equal(added.error, undefined);
  assert.ok((added.allow as string[]).includes("example.com"));

  const checked = await callTool("scope_check", { target: "http://example.com" });
  assert.equal(checked.allowed, true);

  const listed = await callTool("scope_list", {});
  assert.ok((listed.allow as string[]).includes("example.com"));
});

test("scope_add refuses a cloud metadata address and audits the refusal", async () => {
  const result = await callTool("scope_add", { entry: "169.254.169.254" });
  assert.match(result.error as string, /hard-denied/);
});

test("request_intrusive_approval mints a grant that verify_grant consumes exactly once", async () => {
  await callTool("scope_add", { entry: "example.org" });

  const approval = await callTool("request_intrusive_approval", {
    target: "example.org",
    action: "nmap sweep",
  });
  assert.equal(approval.approved, true);
  const token = approval.grant_token as string;
  assert.ok(token.length > 0);

  const first = await callTool("verify_grant", { token, target: "example.org" });
  assert.equal(first.valid, true);

  const second = await callTool("verify_grant", { token, target: "example.org" });
  assert.equal(second.valid, false);
  assert.equal(second.reason, "grant already used");
});

test("osv_query surfaces a non-2xx OSV response as an error instead of a clean-result shape", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429 })) as typeof fetch;

  try {
    const result = await callTool("osv_query", { name: "left-pad", ecosystem: "npm" });
    assert.equal(result.error, "HTTP 429");
    assert.equal(result.count, undefined, "a failed lookup must not look like {count: 0, vulns: []}");
    assert.equal(result.vulns, undefined);

    const audit = await callTool("audit_read", { limit: 1 });
    const entries = audit.entries as { action: string; verdict: string; reason: string }[];
    assert.equal(entries[0].action, "osv_query");
    assert.equal(entries[0].verdict, "denied");
    assert.match(entries[0].reason, /HTTP 429/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("policy_get reports the current allowlist size", async () => {
  const before = await callTool("scope_list", {});
  const policy = await callTool("policy_get", {});
  assert.equal(policy.allow_size, (before.allow as string[]).length);
  assert.ok(Array.isArray(policy.rules));
});

test("http_probe denies an out-of-scope target without ever opening a socket", async () => {
  const result = await callTool("http_probe", { url: "http://not-in-scope.example/" });
  assert.equal(result.probed, false);
  assert.match(result.error as string, /scope denial/);
});

test("tcp_probe denies an out-of-scope target without ever opening a socket", async () => {
  const result = await callTool("tcp_probe", { host: "not-in-scope.example", port: 9999 });
  assert.equal(result.probed, false);
  assert.match(result.error as string, /scope denial/);
});

/**
 * http_probe/tcp_probe connect to whatever address `localhost` resolves to first (see
 * lib/scope-guard/egress.ts's authorizeConnect), so the test server is bound to that exact
 * address rather than to "127.0.0.1"/"::1" and hoping it matches - on a system where
 * `dns.lookup("localhost")` prefers the other family, a hardcoded bind would make this test
 * flaky for a reason that has nothing to do with the code under test.
 */
test("http_probe and tcp_probe reach an in-scope localhost target, pinned to the resolved address", async () => {
  const [{ address: loopbackAddress }] = await dns.lookup("localhost", { all: true });

  const httpServer: HttpServer = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok from test server");
  });
  await new Promise<void>((resolve) => httpServer.listen(0, loopbackAddress, resolve));
  const httpPort = (httpServer.address() as { port: number }).port;

  const tcpServer: TcpServer = createTcpServer((socket) => {
    socket.end("ok from tcp test server");
  });
  await new Promise<void>((resolve) => tcpServer.listen(0, loopbackAddress, resolve));
  const tcpPort = (tcpServer.address() as { port: number }).port;

  try {
    const httpResult = await callTool("http_probe", { url: `http://localhost:${httpPort}/` });
    assert.equal(httpResult.probed, true);
    assert.equal(httpResult.status, 200);
    assert.match(httpResult.body_preview as string, /ok from test server/);

    const tcpResult = await callTool("tcp_probe", { host: "localhost", port: tcpPort });
    assert.equal(tcpResult.probed, true);
    assert.match(tcpResult.body_preview_utf8 as string, /ok from tcp test server/);
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tcpServer.close(resolve));
  }
});
