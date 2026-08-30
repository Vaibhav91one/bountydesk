/**
 * One-time-ish operator setup: registers every skills/*\/SKILL.md file as a TrueForge skill
 * resource, so an agent manifest can reference it by name. Mirrors apply-agent.ts's
 * create-or-replace-by-name pattern, using client.settings.skills.createOrUpdate, which the
 * TrueForge SDK already exposes as a single idempotent call (no manual create-then-list-then-
 * update fallback needed, unlike client.agents).
 *
 * TrueForge fetches skill content from git rather than accepting it inline, so the manifest
 * points at this repository, branch, and path rather than embedding the Markdown body. Run
 * this before agent:apply if a manifest references one of these skill names: a manifest
 * pointing at an unregistered skill fails to apply.
 *
 *   npm run skills:apply
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TrueForge } from "@truefoundry/trueforge-sdk";

import { trueforgeApiKey, trueforgeUrl } from "@/lib/env";

const SKILL_REPO_URL = "https://github.com/Vaibhav91one/bountydesk";
const DEFAULT_SKILL_REPO_REF = "main";

function skillRepoRef(): string {
  const value = process.env.BOUNTYDESK_SKILL_REPO_REF?.trim();
  return value && !value.includes("\n") ? value : DEFAULT_SKILL_REPO_REF;
}

function parseFrontmatter(content: string): { name: string; description: string } {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) throw new Error("SKILL.md is missing its frontmatter block");

  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) throw new Error("frontmatter is missing name or description");

  return { name, description };
}

async function main(): Promise<void> {
  const client = new TrueForge({
    baseUrl: trueforgeUrl(),
    ...(trueforgeApiKey() ? { token: trueforgeApiKey() } : { auth: false as const }),
  });

  const dir = path.dirname(fileURLToPath(import.meta.url));
  const skillsDir = path.join(dir, "..", "skills");
  const skillDirNames = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const dirName of skillDirNames) {
    const skillPath = path.join(skillsDir, dirName, "SKILL.md");
    const { name, description } = parseFrontmatter(readFileSync(skillPath, "utf8"));

    await client.settings.skills.createOrUpdate({
      manifest: {
        type: "git",
        name,
        description,
        url: SKILL_REPO_URL,
        ref: skillRepoRef(),
        path: `skills/${dirName}`,
      },
    });
    console.log(`skill "${name}" registered from skills/${dirName}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
