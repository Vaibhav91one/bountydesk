import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { mcpServerSecret } from "@/lib/env";
import {
  commitTargetImage,
  markUnsandboxable,
  openBuildSandbox,
  runBuildCommand,
  type BuildToolResult,
} from "@/lib/mcp/build";

// The Postgres connection and Daytona calls these tools make need the Node runtime.
export const runtime = "nodejs";
// run_build_command drives a docker build in the sandbox, which can take minutes, so ask the host for
// the longest function it allows. On a platform that caps below this a heavy build can still outrun the
// limit; the agent should keep single commands as short as it can, and a build too slow for the host is
// a signal to mark the repo unsandboxable.
export const maxDuration = 300;

function isAuthorized(header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${mcpServerSecret()}`);
  const received = Buffer.from(header);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

function render(result: BuildToolResult) {
  if (result.ok) {
    const payload = { message: result.message, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), ...(result.output !== undefined ? { output: result.output } : {}) };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  }
  return { isError: true, content: [{ type: "text" as const, text: result.reason }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "bountydesk-build", version: "1.0.0" });

  server.registerTool(
    "open_build_sandbox",
    {
      description:
        "Open an ephemeral Docker-in-Docker sandbox for onboarding this repository. The repo is cloned at /work/source and dockerd is started. Call this once before run_build_command. No URL, host or id: the server holds the repository and the sandbox's egress allow-list.",
      inputSchema: { capability: z.string() },
    },
    async ({ capability }) => render(await openBuildSandbox(capability)),
  );

  server.registerTool(
    "run_build_command",
    {
      description:
        "Run one shell command in this session's build sandbox (write a Dockerfile, docker build, docker run the container, curl it to check it serves and its data is present). Returns the exit code and the tail of stdout/stderr. Iterate here until the app boots and a data-backed request returns real content, then call commit_target_image.",
      inputSchema: { capability: z.string(), command: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ capability, command }) => render(await runBuildCommand(capability, command)),
  );

  server.registerTool(
    "commit_target_image",
    {
      description:
        "Commit the Dockerfile you converged on as this repository's target recipe. Give the full Dockerfile text, the target name (lowercase, from the repo), the loopback baseUrl (e.g. http://localhost:3000), a same-origin readinessPath that returns 2xx, and an optional warmupSeconds for a slow start. The platform rebuilds this for the pinned artifact, verifies it boots offline, and routes it to a human reviewer. Gated: a human approves before this runs.",
      inputSchema: {
        capability: z.string(),
        dockerfileText: z.string(),
        buildContext: z.string().optional(),
        name: z.string(),
        baseUrl: z.string(),
        readinessPath: z.string(),
        startCommand: z.string().optional(),
        warmupSeconds: z.number().int().min(0).max(600).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (input) => render(await commitTargetImage(input)),
  );

  server.registerTool(
    "mark_unsandboxable",
    {
      description:
        "Declare that this repository cannot be built into one bootable offline image (it needs multiple running services, external network services it cannot reach offline, or credentials to boot). Give a short reason. Its reports will then take the analysis-only route instead of reproduction.",
      inputSchema: { capability: z.string(), reason: z.string() },
    },
    async ({ capability, reason }) => render(await markUnsandboxable(capability, reason)),
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
