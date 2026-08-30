import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import agentDefinition from "@/agent/bountydesk.agent.json";

import { buildMcpServerManifest, SCOPE_GUARD_APPROVAL_GATED_TOOLS } from "./agent-config";
import { parseFrontmatterName } from "./skill-frontmatter";

const EXPECTED_SKILL_NAMES = [
  "bountydesk-recon",
  "bountydesk-challenges",
  "bountydesk-validation",
  "bountydesk-triage",
  "bountydesk-api-security",
  "bountydesk-payloads",
  "bountydesk-dast",
  "bountydesk-cve-lab-construction",
  "bountydesk-firmware",
  "bountydesk-mobile",
  "bountydesk-demo-targets",
];

test("the BountyDesk agent preloads the approval-gated publish_verdict and probe_target_write tools", () => {
  assert.equal(agentDefinition.name, "bountydesk");
  assert.deepEqual(agentDefinition.manifest.mcpServers[0], {
    name: "bountydesk",
    requireApprovalForTools: ["publish_verdict", "probe_target_write"],
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

test("the manifest wires in exactly the 11 ported skills, each backed by a real SKILL.md", () => {
  const skills = agentDefinition.manifest.skills.map((skill) => skill.name);
  assert.deepEqual([...skills].sort(), [...EXPECTED_SKILL_NAMES].sort());

  for (const name of skills) {
    // bountydesk-<dir> is the naming convention skills.test.ts also enforces; deriving the
    // directory from the name here (rather than hardcoding a second name/dir map) means the
    // two checks can't silently drift on what "the skill directory" means.
    const dirName = name.replace(/^bountydesk-/, "");
    const skillPath = path.join(process.cwd(), "skills", dirName, "SKILL.md");
    const content = readFileSync(skillPath, "utf8");
    assert.equal(parseFrontmatterName(content), name);
  }
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
