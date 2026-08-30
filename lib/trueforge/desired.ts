/**
 * What this repository declares the harness should hold, and how that lines up with what is
 * actually on the server. Pure: no network, no SDK client, so the drift labelling is testable
 * without faking HTTP.
 *
 * Three of TrueForge's five settings surfaces have a desired set here (connectors, skills,
 * the agent). Model providers and the sandbox provider deliberately do not: they carry
 * credentials an operator pastes, so the repository has nothing to declare for them and the
 * UI reports only whether one is configured.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import agentDefinition from "@/agent/bountydesk.agent.json";
import { appBaseUrl } from "@/lib/auth/oauth";
import { mcpServerSecret, requireEnv, scopeGuardToken } from "@/lib/env";

import { buildMcpServerManifest, buildScopeGuardServerManifest } from "./agent-config";
import { parseFrontmatter } from "./skill-frontmatter";

/** The one agent BountyDesk owns. `createSession` resolves sessions by this name. */
export const MANAGED_AGENT_NAME = "bountydesk";

/**
 * Provider types the harness names after their `type`, with no `name` field in the manifest.
 * Only `custom` is caller-named, and it also requires a base URL.
 */
export const WELL_KNOWN_PROVIDER_TYPES = [
  "openai",
  "anthropic",
  "google-gemini",
  "fireworks",
  "zai",
  "moonshot",
  "together",
  "alibaba",
] as const;

export type WellKnownProviderType = (typeof WELL_KNOWN_PROVIDER_TYPES)[number];

/**
 * TrueForge fetches skill content from git rather than accepting it inline, so a skill
 * manifest points at this repository, ref and path instead of embedding the Markdown body.
 * The harness resolves the ref at read time, so an unpushed local edit is not what the agent
 * loads.
 */
const SKILL_REPO_URL = "https://github.com/Vaibhav91one/bountydesk";
const SKILL_REPO_REF = "main";

export type DesiredMcpServer = ReturnType<typeof buildMcpServerManifest>;

export type DesiredSkill = {
  type: "git";
  name: string;
  description: string;
  url: string;
  ref: string;
  path: string;
};

/**
 * The two connectors the agent manifest references by name. Both take their URL and bearer
 * secret from the environment, not from anything the agent produced.
 */
export function desiredMcpServers(): DesiredMcpServer[] {
  return [
    buildMcpServerManifest(appBaseUrl(), mcpServerSecret()),
    buildScopeGuardServerManifest(requireEnv("SCOPE_GUARD_URL"), scopeGuardToken()),
  ];
}

/**
 * Every skills/*\/SKILL.md as a git skill manifest, named by its own frontmatter rather than
 * its directory. `skills.test.ts` is what keeps the two in step.
 */
export function desiredSkills(skillsRoot = path.join(process.cwd(), "skills")): DesiredSkill[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const { name, description } = parseFrontmatter(
        readFileSync(path.join(skillsRoot, entry.name, "SKILL.md"), "utf8"),
      );
      return {
        type: "git" as const,
        name,
        description,
        url: SKILL_REPO_URL,
        ref: SKILL_REPO_REF,
        path: `skills/${entry.name}`,
      };
    });
}

/** The committed agent manifest, imported rather than read off disk so the bundler sees it. */
export function desiredAgent(): { name: string; manifest: unknown } {
  return { name: agentDefinition.name, manifest: agentDefinition.manifest };
}

/**
 * `managed` is declared here and present on the server, `missing` is declared here and not
 * yet applied, `unmanaged` is on the server and owned by something else.
 *
 * Drift is reported, never repaired by deletion. The live harness carries skills from other
 * projects, the API has no DELETE for skills, connectors or model providers, and a screen
 * that offered to tidy them would be offering to break someone else's agent.
 */
export type Drift = "managed" | "missing" | "unmanaged";

export type Reconciled<L extends { name: string }, D extends { name: string }> = {
  name: string;
  drift: Drift;
  live: L | null;
  desired: D | null;
};

const DRIFT_ORDER: Record<Drift, number> = { managed: 0, missing: 1, unmanaged: 2 };

/**
 * Line the server's resources up against the declared ones, by name.
 *
 * One function for connectors, skills and agents: all three are name-keyed collections whose
 * only interesting question is which side each name appears on. Sorted managed, then missing,
 * then unmanaged, alphabetically within each group, so the screen's order does not depend on
 * whatever order the harness happened to list things in.
 */
export function reconcile<L extends { name: string }, D extends { name: string }>(
  live: readonly L[],
  desired: readonly D[],
): Reconciled<L, D>[] {
  const liveByName = new Map(live.map((item) => [item.name, item]));
  const desiredByName = new Map(desired.map((item) => [item.name, item]));

  const rows = [...new Set([...liveByName.keys(), ...desiredByName.keys()])].map((name) => {
    const liveItem = liveByName.get(name) ?? null;
    const desiredItem = desiredByName.get(name) ?? null;
    const drift: Drift = desiredItem ? (liveItem ? "managed" : "missing") : "unmanaged";
    return { name, drift, live: liveItem, desired: desiredItem };
  });

  return rows.sort(
    (a, b) => DRIFT_ORDER[a.drift] - DRIFT_ORDER[b.drift] || a.name.localeCompare(b.name),
  );
}

/**
 * What to send as `auth.api_key`: the typed key when there is one, otherwise whatever the
 * live record already holds.
 *
 * The harness resolves a submitted value containing `***REDACTED***` back to the stored
 * secret and treats anything else as a rotation, so replaying the redacted string a GET
 * handed back is how an edit keeps a working credential. Replaying it rather than hardcoding
 * the marker means a change to TrueForge's redaction format cannot silently turn a save into
 * a key wipe.
 *
 * Null means there is nothing to send, which the caller refuses locally: a blank key against
 * a provider that does not exist yet would otherwise be a 400 the operator has to interpret.
 */
export function resolveApiKey(typed: string, stored: string | undefined): string | null {
  return typed.trim() || stored || null;
}
