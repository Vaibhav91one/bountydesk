/**
 * The network half of the harness settings screen: read every TrueForge settings surface,
 * apply the ones this repository owns, and save the two that hold operator credentials.
 *
 * The screen exists because only three of the five surfaces had a code path. Skills,
 * connectors and the agent were applied by scripts; nothing registered a model provider or a
 * sandbox provider, so a fresh harness rejects the agent manifest with "Unknown model
 * openai/gpt-5-mini, provider not configured" and the runbook's bootstrap cannot complete.
 */
import { TrueForge, TrueForgeApi, TrueForgeError } from "@truefoundry/trueforge-sdk";

import { createSdkClient } from "./client";
import {
  desiredAgent,
  desiredMcpServers,
  desiredSkills,
  MANAGED_AGENT_NAME,
  reconcile,
  type Reconciled,
  type WellKnownProviderType,
} from "./desired";

/**
 * One section's read, isolated. A harness that is down, or a `TRUEFORGE_URL` that is unset,
 * must not take the whole page with it: an operator opening this screen is usually there
 * because something is wrong, and a crashed page tells them nothing about which part.
 */
export type Section<T> = { ok: true; value: T } | { ok: false; error: string };

/** No `auth` field anywhere in the view types: nothing key-shaped crosses to the browser. */
export type ModelView = {
  name: string;
  modelId: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
};

export type ModelProviderView = {
  name: string;
  type: string;
  baseUrl: string | null;
  models: ModelView[];
};

export type SandboxView = {
  type: string;
  status: string;
  statusReason: string | null;
  execTimeoutMs: number;
  autoStopIntervalInMinutes: number;
  autoArchiveIntervalInMinutes: number;
  autoDeleteIntervalInMinutes: number;
};

export type ConnectorView = {
  name: string;
  description: string;
  url: string;
  authStatus: string;
};

export type SkillView = { name: string; description: string; url: string; ref: string; path: string | null };

export type AgentView = { id: string; name: string; model: string; skills: string[]; connectors: string[] };

export type CatalogProviderView = { type: string; models: ModelView[] };

export type HarnessSnapshot = {
  modelProviders: Section<ModelProviderView[]>;
  sandbox: Section<SandboxView | null>;
  connectors: Section<Reconciled<ConnectorView, { name: string }>[]>;
  skills: Section<Reconciled<SkillView, { name: string; description: string; ref: string; path: string }>[]>;
  agents: Section<Reconciled<AgentView, { name: string }>[]>;
  catalog: Section<CatalogProviderView[]>;
  /** The committed manifest, shown beside whatever the server holds on the agent tab. */
  agentManifest: string;
};

/**
 * A TrueForge failure in words an operator can act on. The status codes mean different
 * things here: 422 is a live external check that failed, so retrying the same request cannot
 * help until the environment changes, and saying "try again" would be a lie.
 */
export function harnessError(error: unknown): string {
  if (error instanceof TrueForgeError) {
    const detail = messageFromBody(error.body) ?? error.message;
    // No status code means the request never reached a server. The SDK reports that as a bare
    // "fetch failed", which tells an operator nothing about which harness did not answer.
    if (error.statusCode === undefined) {
      return `Could not reach the TrueForge harness at ${process.env.TRUEFORGE_URL ?? "TRUEFORGE_URL"}: ${detail}`;
    }
    if (error.statusCode === 400) return `TrueForge rejected the request: ${detail}`;
    if (error.statusCode === 409) return `That name is already taken on the harness: ${detail}`;
    if (error.statusCode === 422) {
      return `TrueForge could not verify this against the live service, so retrying will not help until the underlying problem is fixed: ${detail}`;
    }
    return detail;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The `{ error: { message } }` envelope every TrueForge failure uses. */
function messageFromBody(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return null;
  const message = (inner as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: harnessError(error) };
  }
}

function toModelView(model: TrueForgeApi.ConfiguredModel | TrueForgeApi.CatalogModel): ModelView {
  return {
    name: model.name,
    modelId: model.modelId,
    contextLength: model.properties.contextLength ?? null,
    maxOutputTokens: model.properties.maxOutputTokens ?? null,
  };
}

/**
 * Everything the screen renders, in one round of parallel reads.
 *
 * `allSettled` rather than `all`: a slow or broken section becomes its own error row, and the
 * other four still render. Client construction sits inside the same try because
 * `trueforgeUrl()` throws when the harness is unconfigured, which is a state the screen has
 * to be able to show rather than crash on.
 */
export async function readHarness(): Promise<HarnessSnapshot> {
  let client: TrueForge;
  try {
    client = createSdkClient();
  } catch (error) {
    const failed: Section<never> = { ok: false, error: harnessError(error) };
    return {
      modelProviders: failed,
      sandbox: failed,
      connectors: failed,
      skills: failed,
      agents: failed,
      catalog: failed,
      agentManifest: JSON.stringify(desiredAgent().manifest, null, 2),
    };
  }

  const [modelProviders, sandbox, connectors, skills, agents, catalog] = await Promise.all([
    section(async () =>
      (await client.settings.modelProviders.list()).data.map((provider) => ({
        name: provider.name,
        type: provider.manifest.type,
        baseUrl: "baseUrl" in provider.manifest ? provider.manifest.baseUrl ?? null : null,
        models: provider.manifest.models.map(toModelView),
      })),
    ),

    section(async () => {
      try {
        const { data } = await client.settings.sandboxProviders.get();
        return {
          type: data.manifest.type,
          status: data.status,
          statusReason: data.statusReason,
          execTimeoutMs: data.manifest.execTimeoutMs,
          autoStopIntervalInMinutes: data.manifest.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: data.manifest.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: data.manifest.autoDeleteIntervalInMinutes,
        } satisfies SandboxView;
      } catch (error) {
        // A first run has no sandbox provider. That is the state this screen was built to
        // fix, so it renders as an empty form rather than as a section-wide error.
        if (error instanceof TrueForgeApi.NotFoundError) return null;
        throw error;
      }
    }),

    section(async () =>
      reconcile(
        (await client.settings.mcpServers.list()).data.map((server) => ({
          name: server.name,
          description: server.manifest.description,
          url: server.manifest.url,
          authStatus: server.authStatus.status,
        })),
        desiredMcpServers().map(({ name }) => ({ name })),
      ),
    ),

    section(async () =>
      reconcile(
        (await client.settings.skills.list()).data.map((skill) => ({
          name: skill.name,
          description: skill.manifest.description,
          url: skill.manifest.url,
          ref: skill.manifest.ref,
          path: skill.manifest.path ?? null,
        })),
        desiredSkills(),
      ),
    ),

    section(async () =>
      reconcile(
        (await client.agents.list()).data.map((agent) => ({
          id: agent.id,
          name: agent.name,
          model: agent.manifest.model.name,
          skills: (agent.manifest.skills ?? []).map((skill) => skill.name),
          connectors: (agent.manifest.mcpServers ?? []).map((server) => server.name),
        })),
        [{ name: MANAGED_AGENT_NAME }],
      ),
    ),

    section(async () =>
      (await client.catalogs.modelProviders.list()).data
        .filter((entry) => "models" in entry)
        .map((entry) => ({ type: entry.type, models: entry.models.map(toModelView) })),
    ),
  ]);

  return {
    modelProviders,
    sandbox,
    connectors,
    skills,
    agents,
    catalog,
    agentManifest: JSON.stringify(desiredAgent().manifest, null, 2),
  };
}

export type ApplyScope = "connectors" | "skills" | "agent";
export type ApplyEntry = { scope: ApplyScope; message: string };

/**
 * Register what this repository owns with the harness, in dependency order.
 *
 * One implementation for the two scripts and the screen. The agent's create-then-update
 * fallback and the git skill manifest shape used to live only under `scripts/`, which is
 * outside the test glob; a screen that reimplemented them would give two code paths that can
 * disagree about what "applied" means while only one is what the runbook runs.
 *
 * Order is not cosmetic: an agent referencing an unregistered skill or connector is refused,
 * so the agent goes last whenever it is in scope.
 */
export async function applyManaged(
  scopes: readonly ApplyScope[],
  client: TrueForge = createSdkClient(),
): Promise<ApplyEntry[]> {
  const entries: ApplyEntry[] = [];

  if (scopes.includes("connectors")) {
    for (const manifest of desiredMcpServers()) {
      await client.settings.mcpServers.createOrUpdate({ manifest });
      entries.push({ scope: "connectors", message: `MCP connector "${manifest.name}" registered at ${manifest.url}` });
    }
  }

  if (scopes.includes("skills")) {
    for (const manifest of desiredSkills()) {
      await client.settings.skills.createOrUpdate({ manifest });
      entries.push({ scope: "skills", message: `skill "${manifest.name}" registered from ${manifest.path}` });
    }
  }

  if (scopes.includes("agent")) {
    const { name, manifest } = desiredAgent();
    const spec = manifest as TrueForgeApi.AgentSpec;
    try {
      await client.agents.create({ name, manifest: spec });
      entries.push({ scope: "agent", message: `agent "${name}" created` });
    } catch (error) {
      // `name` is immutable and POST /agents 409s on a name that exists, so an update needs
      // the server-generated id, which only the list carries.
      if (!(error instanceof TrueForgeApi.ConflictError)) throw error;
      const { data: agents } = await client.agents.list();
      const existing = agents.find((agent) => agent.name === name);
      if (!existing) throw error;
      await client.agents.update(existing.id, { manifest: spec });
      entries.push({ scope: "agent", message: `agent "${name}" updated` });
    }
  }

  return entries;
}

export type ModelInput = {
  name: string;
  modelId: string;
  contextLength?: number;
  maxOutputTokens?: number;
};

export type ModelProviderInput = {
  type: WellKnownProviderType | "custom";
  /** Only `custom` is caller-named; a well-known provider is named after its type. */
  name?: string;
  /** Required for `custom`, optional as an override elsewhere. */
  baseUrl?: string;
  apiKey: string;
  models: ModelInput[];
};

/**
 * Create or replace one model provider.
 *
 * PUT is a full replace, never a merge, so `models` is always the complete list the provider
 * should end up with. Removing a model is therefore a save without it, which is also how
 * TrueForge's own settings UI implements its per-model trash icon.
 */
export async function saveModelProvider(
  input: ModelProviderInput,
  client: TrueForge = createSdkClient(),
): Promise<void> {
  const models: TrueForgeApi.ConfiguredModel[] = input.models.map((model) => ({
    name: model.name,
    modelId: model.modelId,
    properties: {
      ...(model.contextLength ? { contextLength: model.contextLength } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    },
  }));

  const manifest =
    input.type === "custom"
      ? ({
          type: "custom",
          name: input.name ?? "",
          baseUrl: input.baseUrl ?? "",
          auth: { apiKey: input.apiKey },
          models,
        } satisfies TrueForgeApi.CustomModelProvider)
      : ({
          type: input.type,
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
          auth: { apiKey: input.apiKey },
          models,
        } as TrueForgeApi.ModelProviderManifest);

  await client.settings.modelProviders.createOrUpdate({ manifest });
}

export type SandboxInput = {
  apiKey: string;
  execTimeoutMs: number;
  autoStopIntervalInMinutes: number;
  autoArchiveIntervalInMinutes: number;
  autoDeleteIntervalInMinutes: number;
};

/**
 * Create or replace the single sandbox provider.
 *
 * All four intervals are required with no server-side defaults, so this always sends the
 * complete manifest. This is TrueForge's own Daytona provider, the one every skill in the
 * agent manifest depends on through `config.sandbox.enabled`. It is not the reproduction
 * sandbox pipeline in lib/sandbox/daytona.ts, which BountyDesk provisions itself from
 * `DAYTONA_API_KEY`.
 */
export async function saveSandboxProvider(
  input: SandboxInput,
  client: TrueForge = createSdkClient(),
): Promise<void> {
  await client.settings.sandboxProviders.createOrUpdate({
    manifest: {
      type: "daytona",
      auth: { apiKey: input.apiKey },
      execTimeoutMs: input.execTimeoutMs,
      autoStopIntervalInMinutes: input.autoStopIntervalInMinutes,
      autoArchiveIntervalInMinutes: input.autoArchiveIntervalInMinutes,
      autoDeleteIntervalInMinutes: input.autoDeleteIntervalInMinutes,
    },
  });
}

/**
 * The stored (redacted) key for one provider, or undefined when nothing is stored. What a
 * save with a blank key field replays, so an interval edit does not rotate a working key.
 */
export async function storedModelProviderKey(
  name: string,
  client: TrueForge = createSdkClient(),
): Promise<string | undefined> {
  const { data } = await client.settings.modelProviders.list();
  return data.find((provider) => provider.name === name)?.manifest.auth?.apiKey;
}

/** Same, for the sandbox singleton. Absent is the normal first-run state, not an error. */
export async function storedSandboxKey(
  client: TrueForge = createSdkClient(),
): Promise<string | undefined> {
  try {
    return (await client.settings.sandboxProviders.get()).data.manifest.auth.apiKey;
  } catch (error) {
    if (error instanceof TrueForgeApi.NotFoundError) return undefined;
    throw error;
  }
}
