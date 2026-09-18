/**
 * One-time operator setup: registers bounty-desk's MCP connectors and every agent manifest with
 * the TrueForge harness, so createTrueforgeAnalysisDriver's createSession has named agents to
 * resolve. Re-run whenever a connector or an agent/*.agent.json changes; every call is
 * create-or-replace by name, so re-running is safe.
 *
 * A fresh harness needs a model provider and a sandbox provider first, at /settings/harness.
 * The agent manifest pins openai/gpt-5-mini and sets config.sandbox.enabled, and neither
 * resolves against a server with no provider registered.
 *
 *   npm run agent:apply
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TrueForgeApi } from "@truefoundry/trueforge-sdk";

import { createSdkClient } from "@/lib/trueforge/client";
import { MANAGED_AGENT_NAME } from "@/lib/trueforge/desired";
import { applyManaged, type ApplyScope } from "@/lib/trueforge/harness";

async function main(): Promise<void> {
  // A scope at a time, sharing one client, so the connectors are reported as registered even
  // when the agent step then fails. Applying both in one call would swallow that on a throw,
  // and "did the connectors land?" is the first thing an operator asks next.
  const client = createSdkClient();
  for (const scope of ["connectors", "agent"] satisfies ApplyScope[]) {
    for (const entry of await applyManaged([scope], client)) console.log(entry.message);
  }

  // The settings screen manages only the primary agent (applyManaged just registered it above).
  // Any other agent/*.agent.json, such as the target-onboarding agent for the dynamic-target
  // tier, still has to reach the harness so a session can resolve it by name. Same
  // create-or-update by name applyManaged uses, run straight against the SDK for the manifests
  // the shared path does not own.
  const agentDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent");
  const extraManifests = readdirSync(agentDir)
    .filter((name) => name.endsWith(".agent.json"))
    .sort()
    .map((file) => ({ file, ...JSON.parse(readFileSync(path.join(agentDir, file), "utf8")) }))
    .filter((entry) => entry.name !== MANAGED_AGENT_NAME);

  for (const { file, name, manifest } of extraManifests) {
    try {
      await client.agents.create({ name, manifest });
      console.log(`agent "${name}" created from agent/${file}`);
    } catch (error) {
      if (!(error instanceof TrueForgeApi.ConflictError)) throw error;
      const { data: agents } = await client.agents.list();
      const existing = agents.find((a) => a.name === name);
      if (!existing) throw error;
      await client.agents.update(existing.id, { manifest });
      console.log(`agent "${name}" updated from agent/${file}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
