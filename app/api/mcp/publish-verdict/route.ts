import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { mcpServerSecret } from "@/lib/env";
import { publishVerdict, publishVerdictInputSchema } from "@/lib/mcp/publish-verdict";
import { probeTarget, probeTargetReadInputSchema, probeTargetWriteInputSchema } from "@/lib/mcp/probe-target";

// node:crypto and the Postgres connection publishVerdict opens both need the Node runtime.
export const runtime = "nodejs";

/** Same shape as unseal()'s cookie check in lib/auth/session.ts: compare lengths before
 * timingSafeEqual, since the function throws on a length mismatch rather than returning
 * false, and a thrown "different length" is itself a timing signal. */
function isAuthorized(header: string | null): boolean {
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${mcpServerSecret()}`);
  const received = Buffer.from(header);
  if (received.length !== expected.length) return false;

  return timingSafeEqual(received, expected);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "bountydesk-publish-verdict", version: "1.0.0" });

  server.registerTool(
    "publish_verdict",
    {
      description:
        "Draft this report's verdict from your own investigation (outcome, summary, findings), or publish one already approved for this session's pending call. Refuses unless a matching human approval was recorded ahead of time.",
      // The full agent-drafted shape, not capability alone: the poller
      // (lib/agent-sessions/poller.ts) reads a pending call's arguments straight off what
      // TrueForge captured before ever reaching this route, so the schema advertised here is
      // what actually constrains what a real tool-calling model can send. Declaring only
      // `capability` left the model with no schema-level way to submit a draft at all.
      inputSchema: publishVerdictInputSchema.shape,
      annotations: { destructiveHint: true },
    },
    async ({ capability }) => {
      // Post-approval dispatch only ever needs the capability: the draft this same call
      // originally carried was already turned into an immutable verdict row by the poller
      // (draftVerdictFromPendingCall) before a human ever saw it for approval. Re-reading
      // outcome/summary/findings here would let a second, differently worded call under the
      // same capability smuggle different content past that approval.
      const result = await publishVerdict(capability);
      if (result.ok) {
        return { content: [{ type: "text", text: "verdict published" }] };
      }
      return {
        isError: true,
        content: [{ type: "text", text: result.reason }],
      };
    },
  );

  server.registerTool(
    "probe_target",
    {
      description:
        "Send one GET or HEAD request to this session's provisioned target sandbox. Give a method, a same-origin path (e.g. /rest/products/search), and optional headers -- never a URL, host or token; the server resolves and reaches the one sandbox this session's capability is bound to. For a POST, use probe_target_write instead. Refuses cleanly when no sandbox was provisioned for this run.",
      inputSchema: probeTargetReadInputSchema.shape,
    },
    async ({ capability, method, path, headers, body }) => {
      const result = await probeTarget({ capability, method, path, headers, body });
      if (result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ status: result.status, body: result.body }) }] };
      }
      return {
        isError: true,
        content: [{ type: "text", text: result.reason }],
      };
    },
  );

  server.registerTool(
    "probe_target_write",
    {
      description:
        "Send one POST request to this session's provisioned target sandbox -- the write/active counterpart of probe_target, gated by the harness's own human-approval checkpoint before this call executes, the same as scope_add/scope_remove. Give a same-origin path and optional headers/body; never a URL, host or token.",
      inputSchema: probeTargetWriteInputSchema.shape,
      annotations: { destructiveHint: true },
    },
    async ({ capability, method, path, headers, body }) => {
      const result = await probeTarget({ capability, method, path, headers, body }, { approvedForWrite: true });
      if (result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ status: result.status, body: result.body }) }] };
      }
      return {
        isError: true,
        content: [{ type: "text", text: result.reason }],
      };
    },
  );

  return server;
}

/**
 * Stateless MCP endpoint: a fresh server and transport per call, per the SDK's stateless
 * mode (sessionIdGenerator left undefined). Nothing here holds a session across requests,
 * which matches publishVerdict itself opening and closing its own transaction internally.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // A single tool call per request, so a materialized JSON response is simpler than an
    // SSE stream this Next.js route handler would otherwise have to keep open past return.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
  }
}
