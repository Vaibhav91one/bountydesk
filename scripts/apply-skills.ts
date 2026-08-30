/**
 * One-time-ish operator setup: registers every skills/*\/SKILL.md file as a TrueForge skill
 * resource, so an agent manifest can reference it by name. Run this before agent:apply if a
 * manifest references one of these skill names: a manifest pointing at an unregistered skill
 * fails to apply.
 *
 *   npm run skills:apply
 */
import { applyManaged } from "@/lib/trueforge/harness";

async function main(): Promise<void> {
  for (const entry of await applyManaged(["skills"])) {
    console.log(entry.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
