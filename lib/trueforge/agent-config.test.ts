import assert from "node:assert/strict";
import test from "node:test";

import agentDefinition from "@/agent/bountydesk.agent.json";

import { buildMcpServerManifest, SCOPE_GUARD_APPROVAL_GATED_TOOLS } from "./agent-config";

test("the BountyDesk agent preloads the approval-gated publish_verdict tool", () => {
  assert.equal(agentDefinition.name, "bountydesk");
  assert.deepEqual(agentDefinition.manifest.mcpServers[0], {
    name: "bountydesk",
    requireApprovalForTools: ["publish_verdict"],
    preload: true,
  });
});

test("the BountyDesk agent's scope-guard connector gates the same tools as SCOPE_GUARD_APPROVAL_GATED_TOOLS", () => {
  const scopeGuardEntry = agentDefinition.manifest.mcpServers.find(
    (server) => server.name === "scope-guard",
  );
  assert.ok(scopeGuardEntry, "manifest is missing a scope-guard mcpServers entry");
  // Deep-equal against the exported constant rather than a literal array: the JSON manifest
  // can't import the TypeScript constant directly, so this test is what catches the two
  // drifting apart instead of a compiler error.
  assert.deepEqual(scopeGuardEntry.requireApprovalForTools, SCOPE_GUARD_APPROVAL_GATED_TOOLS);
  assert.equal(scopeGuardEntry.preload, true);
});

test("the manifest enables sandbox and dynamic sub-agents", () => {
  assert.equal(agentDefinition.manifest.config.sandbox.enabled, true);
  assert.equal(agentDefinition.manifest.config.dynamic_sub_agents.enabled, true);
});

test("the manifest does not wire in skills yet (this PR is mechanics only)", () => {
  const skills = (agentDefinition.manifest as { skills?: unknown[] }).skills;
  assert.ok(skills === undefined || skills.length === 0);
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
