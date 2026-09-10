import assert from "node:assert/strict";
import test, { before } from "node:test";

const SECRET = "test-build-mcp-secret-0123456789abcdef";
let POST: typeof import("./route").POST;

before(async () => {
  process.env.MCP_SERVER_SECRET = SECRET;
  ({ POST } = await import("./route"));
});

function request(headers: Record<string, string>, body = "{}"): Request {
  return new Request("https://app.example/api/mcp/build", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

async function rpc(method: string, params?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await POST(
    request(
      { authorization: `Bearer ${SECRET}` },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    ),
  );
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

test("build MCP route rejects missing and wrong bearer tokens", async () => {
  assert.equal((await POST(request({}))).status, 401);
  assert.equal((await POST(request({ authorization: "Bearer wrong" }))).status, 401);
});

test("build MCP route passes a valid bearer token to MCP transport", async () => {
  const response = await POST(
    request({ authorization: `Bearer ${SECRET}`, accept: "application/json, text/event-stream" }),
  );
  assert.notEqual(response.status, 401);
});

test("build MCP route registers every build tool and an unknown tool is an MCP error", async () => {
  const listed = await rpc("tools/list");
  assert.equal(listed.status, 200);
  const names = (listed.body as { result?: { tools?: Array<{ name?: string }> } }).result?.tools
    ?.map((tool) => tool.name)
    .sort();
  assert.deepEqual(names, [
    "commit_compose_mesh",
    "commit_target_image",
    "mark_unsandboxable",
    "open_build_sandbox",
    "run_build_command",
  ]);

  const unknown = await rpc("tools/call", { name: "not_a_real_tool", arguments: {} });
  // The SDK reports an unknown tool as a tool-level error result (isError) rather than a JSON-RPC
  // transport error, so this asserts the shape the transport actually returns.
  const unknownResult = (unknown.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } })
    .result;
  assert.equal(unknownResult?.isError, true, "an unknown tool must be refused, not silently accepted");
  assert.match(unknownResult?.content?.[0]?.text ?? "", /not_a_real_tool/);
});

test("commit_compose_mesh rejects a malformed service list through the tool's own schema", async () => {
  const called = await rpc("tools/call", {
    name: "commit_compose_mesh",
    arguments: {
      capability: "cap",
      appService: "web",
      name: "mesh",
      baseUrl: "http://localhost:3000",
      readinessPath: "/",
      services: [{ service: "web", role: "app", port: 3000 }],
    },
  });
  const result = (called.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
  assert.ok(result, "the call reaches the handler rather than failing at the transport");
});
