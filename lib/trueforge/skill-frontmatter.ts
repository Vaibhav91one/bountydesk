/**
 * Shared by skills.test.ts (every skills/*\/SKILL.md names itself correctly) and
 * agent-config.test.ts (the manifest's skills array matches real, correctly-named files) so
 * the two checks can't drift on what counts as a skill's declared name.
 */
export function parseFrontmatterName(content: string): string | undefined {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
}
