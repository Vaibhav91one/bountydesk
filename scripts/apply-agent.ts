/**
 * One-time operator setup: registers bounty-desk's MCP connectors and agent manifest with the
 * TrueForge harness, so createTrueforgeAnalysisDriver's createSession({agent: {name:
 * "bountydesk"}}) has something to resolve. Re-run whenever agent/bountydesk.agent.json
 * changes; every call is create-or-replace by name, so re-running is safe.
 *
 * A fresh harness needs a model provider and a sandbox provider first, at /settings/harness.
 * The agent manifest pins openai/gpt-5-mini and sets config.sandbox.enabled, and neither
 * resolves against a server with no provider registered.
 *
 *   npm run agent:apply
 */
import { createSdkClient } from "@/lib/trueforge/client";
import { applyManaged, type ApplyScope } from "@/lib/trueforge/harness";

async function main(): Promise<void> {
  // A scope at a time, sharing one client, so the connectors are reported as registered even
  // when the agent step then fails. Applying both in one call would swallow that on a throw,
  // and "did the connectors land?" is the first thing an operator asks next.
  const client = createSdkClient();
  for (const scope of ["connectors", "agent"] satisfies ApplyScope[]) {
    for (const entry of await applyManaged([scope], client)) console.log(entry.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
