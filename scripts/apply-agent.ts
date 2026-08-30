/**
 * One-time operator setup: registers bounty-desk's MCP connector and agent manifest with the
 * TrueForge harness, so createTrueforgeAnalysisDriver's createSession({agent: {name:
 * "bountydesk"}}) has something to resolve. Re-run whenever agent/bountydesk.agent.json
 * changes; both calls are create-or-replace by name, so re-running is safe.
 *
 *   npm run agent:apply
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { appBaseUrl } from "@/lib/auth/oauth";
import { mcpServerSecret, requireEnv, scopeGuardToken, trueforgeApiKey, trueforgeUrl } from "@/lib/env";
import { buildMcpServerManifest, buildScopeGuardServerManifest } from "@/lib/trueforge/agent-config";

async function main(): Promise<void> {
  const client = new TrueForge({
    baseUrl: trueforgeUrl(),
    ...(trueforgeApiKey() ? { token: trueforgeApiKey() } : { auth: false as const }),
  });

  const baseUrl = appBaseUrl();
  const mcpUrl = `${baseUrl}/api/mcp/publish-verdict`;
  await client.settings.mcpServers.createOrUpdate({
    manifest: buildMcpServerManifest(baseUrl, mcpServerSecret()),
  });
  console.log(`MCP connector "bountydesk" registered at ${mcpUrl}`);

  // Registers the connector itself. `agent/bountydesk.agent.json`, applied below, lists it
  // with `requireApprovalForTools` already set to SCOPE_GUARD_APPROVAL_GATED_TOOLS.
  const scopeGuardUrl = requireEnv("SCOPE_GUARD_URL");
  await client.settings.mcpServers.createOrUpdate({
    manifest: buildScopeGuardServerManifest(scopeGuardUrl, scopeGuardToken()),
  });
  console.log(`MCP connector "scope-guard" registered at ${scopeGuardUrl}/api/mcp/scope-guard`);

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.join(dir, "..", "agent", "bountydesk.agent.json");
  const { name, manifest } = JSON.parse(readFileSync(manifestPath, "utf8"));

  try {
    await client.agents.create({ name, manifest });
    console.log(`agent "${name}" created`);
  } catch (error) {
    if (!(error instanceof TrueForgeApi.ConflictError)) throw error;
    const { data: agents } = await client.agents.list();
    const existing = agents.find((a) => a.name === name);
    if (!existing) throw error;
    await client.agents.update(existing.id, { manifest });
    console.log(`agent "${name}" updated`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
