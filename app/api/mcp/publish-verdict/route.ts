import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { mcpServerSecret } from "@/lib/env";
import { publishVerdict } from "@/lib/mcp/publish-verdict";

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
        "Publish the verdict already approved for this session's pending call. Refuses unless a matching human approval was recorded ahead of time.",
      inputSchema: { capability: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ capability }) => {
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
