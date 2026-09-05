import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  TrueForge,
  TrueForgeApi,
} from "../ops/trueforge/node_modules/@truefoundry/trueforge-sdk/dist/esm/index.mjs";

const SKILL_REPO_URL = "https://github.com/Vaibhav91one/bountydesk";
const DEFAULT_SKILL_REPO_REF = "main";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function cleanOrigin(value) {
  return value.replace(/\/+$/, "");
}

async function waitForHealth(url) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // TrueForge and the proxy start beside this process, so early refusals are normal.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`TrueForge did not become healthy at ${url}`);
}

function parseFrontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) throw new Error("skill is missing frontmatter");

  const values = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    values[key] = value;
  }

  if (!values.name || !values.description) {
    throw new Error("skill frontmatter needs name and description");
  }
  return values;
}

function desiredSkills() {
  return readdirSync("skills", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const frontmatter = parseFrontmatter(
        readFileSync(path.join("skills", entry.name, "SKILL.md"), "utf8"),
      );
      return {
        type: "git",
        name: frontmatter.name,
        description: frontmatter.description,
        url: SKILL_REPO_URL,
        ref: process.env.BOUNTYDESK_SKILL_REPO_REF?.trim() || DEFAULT_SKILL_REPO_REF,
        path: `skills/${entry.name}`,
      };
    });
}

function desiredMcpServers() {
  const appBaseUrl = cleanOrigin(requireEnv("APP_BASE_URL"));
  const scopeGuardUrl = cleanOrigin(requireEnv("SCOPE_GUARD_URL"));
  return [
    {
      name: "bountydesk",
      description: "BountyDesk's publish_verdict approval gate",
      type: "remote",
      url: `${appBaseUrl}/api/mcp/publish-verdict`,
      auth: {
        type: "header",
        headers: { Authorization: `Bearer ${requireEnv("MCP_SERVER_SECRET")}` },
      },
    },
    {
      name: "scope-guard",
      description:
        "BountyDesk's ported scope-guard MCP server: egress allowlisting and the intrusive-action approval gate",
      type: "remote",
      url: `${scopeGuardUrl}/api/mcp/scope-guard`,
      auth: {
        type: "header",
        headers: { Authorization: `Bearer ${requireEnv("SCOPE_GUARD_TOKEN")}` },
      },
    },
  ];
}

async function createOrUpdateAgent(client, name, manifest) {
  try {
    await client.agents.create({ name, manifest });
    console.log(`agent "${name}" created`);
  } catch (error) {
    if (!(error instanceof TrueForgeApi.ConflictError)) throw error;
    const { data: agents } = await client.agents.list();
    const existing = agents.find((agent) => agent.name === name);
    if (!existing) throw error;
    await client.agents.update(existing.id, { manifest });
    console.log(`agent "${name}" updated`);
  }
}

async function main() {
  const port = process.env.TRUEFORGE_PROXY_PORT ?? "8791";
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/healthz`);

  const client = new TrueForge({ baseUrl, token: requireEnv("TRUEFORGE_API_KEY") });

  await client.settings.modelProviders.createOrUpdate({
    manifest: {
      type: "openai",
      auth: { apiKey: requireEnv("OPENAI_API_KEY") },
      models: [
        {
          name: "gpt-5-mini",
          modelId: "gpt-5-mini",
          properties: {},
        },
      ],
    },
  });
  console.log('model provider "openai" configured');

  await client.settings.sandboxProviders.createOrUpdate({
    manifest: {
      type: "daytona",
      auth: { apiKey: requireEnv("DAYTONA_API_KEY") },
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    },
  });
  console.log('sandbox provider "daytona" configured');

  for (const manifest of desiredMcpServers()) {
    await client.settings.mcpServers.createOrUpdate({ manifest });
    console.log(`MCP connector "${manifest.name}" configured`);
  }

  for (const manifest of desiredSkills()) {
    await client.settings.skills.createOrUpdate({ manifest });
    console.log(`skill "${manifest.name}" configured`);
  }

  const agentFiles = readdirSync("agent")
    .filter((file) => file.endsWith(".agent.json"))
    .sort();

  for (const file of agentFiles) {
    const { name, manifest } = JSON.parse(readFileSync(path.join("agent", file), "utf8"));
    await createOrUpdateAgent(client, name, manifest);
  }
}

main()
  .then(() => {
    console.log("TrueForge bootstrap complete");
    setInterval(() => {}, 2 ** 31 - 1);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
