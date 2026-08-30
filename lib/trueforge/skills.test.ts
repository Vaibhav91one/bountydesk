import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseFrontmatterName } from "./skill-frontmatter";

/**
 * Pure filesystem check, no DB and no TrueForge SDK: apply-skills.ts registers each
 * skills/*\/SKILL.md by the name in its frontmatter, and an agent manifest references that
 * same name. A directory renamed without its frontmatter following (or the reverse) would
 * silently register the wrong name, so this catches the mismatch at test time instead of at
 * an `agent:apply` run someone forgets to re-check.
 */
const skillsDir = path.join(process.cwd(), "skills");
const skillDirNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test("every skills/*/SKILL.md directory exists and is non-empty", () => {
  assert.ok(skillDirNames.length > 0, "expected at least one skill directory");
});

for (const dirName of skillDirNames) {
  test(`skills/${dirName}/SKILL.md declares name bountydesk-${dirName}`, () => {
    const content = readFileSync(path.join(skillsDir, dirName, "SKILL.md"), "utf8");
    const name = parseFrontmatterName(content);

    assert.equal(name, `bountydesk-${dirName}`);
  });
}
