import assert from "node:assert/strict";
import test from "node:test";

import agentDefinition from "@/agent/bountydesk.agent.json";

import { buildMcpServerManifest } from "./agent-config";

test("the BountyDesk agent preloads the approval-gated publish_verdict tool", () => {
  assert.equal(agentDefinition.name, "bountydesk");
  assert.deepEqual(agentDefinition.manifest.mcpServers, [
    {
      name: "bountydesk",
      requireApprovalForTools: ["publish_verdict"],
      preload: true,
    },
  ]);
});

test("the MCP connector points at the authenticated publish-verdict route", () => {
  assert.deepEqual(buildMcpServerManifest("https://bountydesk.example", "mcp-secret"), {
    name: "bountydesk",
    description: "BountyDesk's publish_verdict approval gate",
    type: "remote",
    url: "https://bountydesk.example/api/mcp/publish-verdict",
    auth: {
      type: "header",
      headers: { Authorization: "Bearer mcp-secret" },
    },
  });
});
