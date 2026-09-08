import assert from "node:assert/strict";
import test, { before } from "node:test";

const SECRET = "test-mcp-secret-0123456789abcdef";
let POST: typeof import("./route").POST;

before(async () => {
  process.env.MCP_SERVER_SECRET = SECRET;
  ({ POST } = await import("./route"));
});

function request(headers: Record<string, string>): Request {
  return new Request("https://app.example/api/mcp/review", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

test("a missing authorization header is rejected", async () => {
  const res = await POST(request({}));
  assert.equal(res.status, 401);
});

test("a wrong bearer token is rejected", async () => {
  const res = await POST(request({ authorization: "Bearer not-the-secret" }));
  assert.equal(res.status, 401);
});

test("the configured bearer token passes auth", async () => {
  // Past the auth gate the streamable transport handles the (non-MCP) body, which is not our concern
  // here; all that matters is a valid token is not turned away as unauthorized.
  const res = await POST(
    request({ authorization: `Bearer ${SECRET}`, accept: "application/json, text/event-stream" }),
  );
  assert.notEqual(res.status, 401);
});
