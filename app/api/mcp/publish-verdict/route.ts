import { timingSafeEqual } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { mcpServerSecret } from "@/lib/env";
import { publishVerdict, publishVerdictInputSchema } from "@/lib/mcp/publish-verdict";
import { readCodeReviewFindings, readCodeReviewFindingsInputSchema } from "@/lib/mcp/read-code-review-findings";
import { probeBrowser, probeBrowserInputSchema } from "@/lib/mcp/probe-browser";
import { probeWorkbench, probeWorkbenchInputSchema } from "@/lib/mcp/probe-workbench";
import { probeTarget, probeTargetReadInputSchema, probeTargetWriteInputSchema } from "@/lib/mcp/probe-target";
import { workbenchProbeConfig } from "@/lib/sandbox/workbench-probe";

// node:crypto and the Postgres connection publishVerdict opens both need the Node runtime.
export const runtime = "nodejs";
// probe_workbench runs a rate-limited nuclei scan that can take about two minutes end to end
// (sandbox boot plus the 120s tool budget), so ask for the longest function the host allows.
export const maxDuration = 300;

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

  server.registerTool(
    "probe_browser",
    {
      description:
        "Render one page of this session's provisioned target in a real headless browser and hand back what it observed: the post-load DOM, the page's console output, and whether a JavaScript dialog fired. Use this for a client-side bug probe_target cannot see (DOM/SPA XSS, a hash-to-sink flow), not for ordinary requests. Give a same-origin path (before any '#') and an optional hashPayload (the URL fragment, after '#', where a client-side payload belongs); never a URL, host or token. The browser runs offline, isolated to this one target, so no separate approval is needed. Refuses cleanly when no sandbox was provisioned or the browser probe is not configured.",
      inputSchema: probeBrowserInputSchema.shape,
    },
    async ({ capability, path, hashPayload }) => {
      const result = await probeBrowser({ capability, path, hashPayload });
      if (result.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                navigated: result.navigated,
                title: result.title,
                dom: result.dom,
                consoleText: result.consoleText,
                dialogFired: result.dialogFired,
                dialogMessages: result.dialogMessages,
              }),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: result.reason }],
      };
    },
  );

  // Flag-gated (BOUNTYDESK_WORKBENCH_ENABLED, default off, issue #327 Phase 0): the tool is not
  // registered at all unless the deployment turned it on, so an agent on a deployment where it is
  // off never sees it in its tool list, rather than seeing it and getting a runtime refusal.
  if (workbenchProbeConfig()) {
    server.registerTool(
      "probe_workbench",
      {
        description:
          "Run one allowlisted recon tool (httpx, nuclei, or newman) from an isolated, offline sandbox against a same-origin path on this session's provisioned target, and get back its raw output. Evidence only: a hit here is a lead to confirm with probe_target, never a verdict by itself. Give capability, tool, a same-origin path, and for nuclei an optional tags list; never a URL, host or token. Refuses cleanly when no sandbox was provisioned.",
        inputSchema: probeWorkbenchInputSchema.shape,
      },
      async ({ capability, tool, path, tags }) => {
        const result = await probeWorkbench({ capability, tool, path, tags });
        if (result.ok) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  tool: result.tool,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  truncated: result.truncated,
                }),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: result.reason }],
        };
      },
    );
  }

  server.registerTool(
    "read_code_review_findings",
    {
      description:
        "Read the stored code-review findings for this session's report, if a reviewer ran a code review. They are leads, not proof: use one to decide what to probe, and cite it only if your own probe evidence confirms it. Read-only; give only the capability.",
      inputSchema: readCodeReviewFindingsInputSchema.shape,
    },
    async ({ capability }) => {
      const result = await readCodeReviewFindings({ capability });
      if (result.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ findings: result.findings }) }] };
      }
      return { isError: true, content: [{ type: "text", text: result.reason }] };
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
