/**
 * Shared by skills.test.ts (every skills/*\/SKILL.md names itself correctly),
 * agent-config.test.ts (the manifest's skills array matches real, correctly-named files) and
 * lib/trueforge/desired.ts (what gets registered with the harness), so the three cannot drift
 * on what counts as a skill's declared name.
 */

function field(content: string, key: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

/**
 * The declared name, or undefined when there isn't one. Lenient on purpose: its callers are
 * tests that assert on the value, and `undefined` gives a clearer failure than a thrown parse
 * error would.
 */
export function parseFrontmatterName(content: string): string | undefined {
  return field(content, "name");
}

/**
 * Both fields the harness needs to register a skill, or a throw naming what is missing.
 * Strict where parseFrontmatterName is lenient: a malformed SKILL.md must stop an apply
 * rather than register a skill under an empty name and description.
 */
export function parseFrontmatter(content: string): { name: string; description: string } {
  if (!/^---\n([\s\S]*?)\n---/.test(content)) {
    throw new Error("SKILL.md is missing its frontmatter block");
  }

  const name = field(content, "name");
  const description = field(content, "description");
  if (!name || !description) throw new Error("frontmatter is missing name or description");

  return { name, description };
}
