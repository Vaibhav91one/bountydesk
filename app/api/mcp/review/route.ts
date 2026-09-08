import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { mcpServerSecret } from "@/lib/env";
import { reportSandboxability, type ReviewToolResult } from "@/lib/mcp/review";

// The Postgres write the tool makes needs the Node runtime.
export const runtime = "nodejs";

function isAuthorized(header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${mcpServerSecret()}`);
  const received = Buffer.from(header);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

function render(result: ReviewToolResult) {
  if (result.ok) {
    return { content: [{ type: "text" as const, text: result.message }] };
  }
  return { isError: true, content: [{ type: "text" as const, text: result.reason }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "bountydesk-review", version: "1.0.0" });

  server.registerTool(
    "report_sandboxability",
    {
      description:
        "Report whether this repository can be built into one bootable, offline single image. Read the repo files provided in your task, then call this once. verdict is \"no\" only when the repo clearly cannot: it needs several running services that must talk to each other, depends on external network services it cannot reach offline, or cannot start without real credentials. Use \"yes\" when it plainly can (a self-contained app), and \"unsure\" when you cannot tell from the files. Give a short, specific reason. A \"no\" routes the repo to analysis-only without a build; \"yes\" and \"unsure\" let the build agent try.",
      inputSchema: {
        capability: z.string(),
        verdict: z.enum(["yes", "no", "unsure"]),
        reason: z.string(),
      },
    },
    async ({ capability, verdict, reason }) => render(await reportSandboxability(capability, verdict, reason)),
  );

  return server;
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
  }
}
