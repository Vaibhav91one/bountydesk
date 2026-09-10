import type { AnalysisOnlyReason, ReproductionRecipe } from "@/lib/reproduction/types";
import type { MeshServiceAuth } from "@/lib/sandbox/provision";
import {
  targetProvisioningFromConfig,
  type TargetProvisioningConfig,
} from "./registry";
import { isValidImageDigest, isValidSnapshotId } from "./validation";

/**
 * The mesh services pinned in a target profile's config, mapped to what the provisioner needs to
 * boot them, or null for a single-image target. A compose-mesh target stores every service (the app
 * and its dependencies) under config.services at onboarding; the reproduction run reads them here to
 * boot the whole mesh instead of one image.
 */
export function meshServicesFromConfig(config: unknown): MeshServiceAuth[] | null {
  if (typeof config !== "object" || config === null) return null;
  const configObject = config as { services?: unknown };
  if (configObject.services === undefined) return null;
  if (!Array.isArray(configObject.services) || configObject.services.length === 0) {
    throw new Error("pinned mesh services must be a nonempty array");
  }
  const services = configObject.services;
  const out: MeshServiceAuth[] = [];
  const names = new Set<string>();
  for (const raw of services) {
    const s = raw as Record<string, unknown> | null;
    if (
      !s ||
      typeof s.service !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(s.service) ||
      names.has(s.service) ||
      (s.role !== "app" && s.role !== "dependency") ||
      typeof s.imageName !== "string" ||
      !/^[A-Za-z0-9._/-]+$/.test(s.imageName) ||
      typeof s.imageDigest !== "string" ||
      !isValidImageDigest(s.imageDigest) ||
      typeof s.snapshotId !== "string" ||
      !isValidSnapshotId(s.snapshotId)
    ) {
      throw new Error("a pinned mesh service is malformed");
    }
    names.add(s.service);

    if (s.port !== undefined && (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 1 || s.port > 65_535)) {
      throw new Error(`pinned mesh service ${s.service} has an invalid port`);
    }
    if (s.role === "app" && s.port === undefined) {
      throw new Error(`pinned mesh app ${s.service} has no port`);
    }
    if (s.startCommand !== undefined) assertSafeMeshStartCommand(s.service, s.startCommand);
    if (s.peers !== undefined && (!Array.isArray(s.peers) || s.peers.some((p) => typeof p !== "string"))) {
      throw new Error(`pinned mesh service ${s.service} has invalid peers`);
    }

    out.push({
      service: s.service,
      role: s.role,
      imageName: s.imageName,
      imageDigest: s.imageDigest,
      snapshotId: s.snapshotId,
      ...(typeof s.snapshotImageRef === "string" ? { snapshotImageRefOverride: s.snapshotImageRef } : {}),
      ...(s.port !== undefined ? { port: s.port as number } : {}),
      ...(typeof s.buildMarker === "string" ? { buildMarker: s.buildMarker } : {}),
      ...(typeof s.startCommand === "string" ? { startCommand: s.startCommand } : {}),
      ...(Array.isArray(s.peers) ? { peers: s.peers as string[] } : {}),
    });
  }
  const apps = out.filter((service) => service.role === "app");
  if (apps.length !== 1) throw new Error("pinned mesh services must have exactly one app service");
  for (const service of out) {
    for (const peer of service.peers ?? []) {
      if (!names.has(peer)) throw new Error(`pinned mesh service ${service.service} references unknown peer ${peer}`);
    }
  }
  return out;
}

function assertSafeMeshStartCommand(service: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000 || /[\r\n]/.test(value)) {
    throw new Error(`pinned mesh service ${service} has an invalid start command`);
  }
  const head = (value.trim().split(/\s+/, 1)[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
  if (/^(docker|docker-compose|podman|nerdctl)$/.test(head) || /(?:^|[;&|]\s*)(?:docker|docker-compose|podman|nerdctl)\s/.test(value)) {
    throw new Error(`pinned mesh service ${service} has a host-level start command`);
  }
  return value;
}

export type ReproductionAuthorization =
  | ({
      ok: true;
      imageName: string;
      imageDigest: string;
      snapshotId: string | null;
      appPort: number;
      recipe: ReproductionRecipe;
    } & TargetProvisioningConfig)
  | { ok: false; reason: AnalysisOnlyReason };

/**
 * Whether a recipe's oracle can deliver a trustworthy verdict against the running orchestrator.
 * Omitted means ready (juice-shop's frozen recipes), false means the oracle would misjudge the
 * target today. Kept as a pure function so the gate below is tested without a database. See the
 * oracleReady doc in lib/reproduction/types.ts.
 */
export function recipeOracleReady(recipe: ReproductionRecipe): boolean {
  return recipe.oracleReady !== false;
}

function defaultPort(protocol: string): number | null {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return null;
}

export function profileAppPort(config: unknown): number | null {
  if (typeof config !== "object" || config === null) return null;
  const baseUrl = (config as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== "string") return null;

  try {
    const parsed = new URL(baseUrl);
    const port = parsed.port ? Number(parsed.port) : defaultPort(parsed.protocol);
    return port && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

export async function authorizeReproductionTarget(input: {
  targetProfileId: string;
  recipeId: string;
}): Promise<ReproductionAuthorization> {
  const [{ db, eq, targetProfile }, { getRecipesForTarget }] = await Promise.all([
    import("@/lib/db"),
    import("./recipes"),
  ]);

  const [profile] = await db
    .select({
      id: targetProfile.id,
      name: targetProfile.name,
      imageName: targetProfile.imageName,
      imageDigest: targetProfile.imageDigest,
      snapshotId: targetProfile.snapshotId,
      config: targetProfile.config,
    })
    .from(targetProfile)
    .where(eq(targetProfile.id, input.targetProfileId))
    .limit(1);

  if (!profile) return { ok: false, reason: "NO_BOUND_TARGET" };
  if (!profile.imageName) return { ok: false, reason: "COULD_NOT_DEPLOY" };
  const appPort = profileAppPort(profile.config);
  if (!appPort) return { ok: false, reason: "NO_APPROVED_ORACLE" };
  const provisioning = targetProvisioningFromConfig(profile.name, profile.config);
  if (!provisioning) return { ok: false, reason: "COULD_NOT_DEPLOY" };

  const recipe = getRecipesForTarget({ name: profile.name, config: profile.config }).find(
    (candidate) => candidate.id === input.recipeId,
  );
  if (!recipe) return { ok: false, reason: "NO_APPROVED_ORACLE" };
  // Fail closed: a recipe whose oracle cannot yet deliver a trustworthy verdict is treated as if
  // there were no approved oracle at all, so the run resolves ANALYSIS_ONLY rather than risking a
  // false REPRODUCED. This is what makes the four onboarding targets safe before their
  // orchestrator gaps are closed (docs/additional-targets.md).
  if (!recipeOracleReady(recipe)) return { ok: false, reason: "NO_APPROVED_ORACLE" };

  return {
    ok: true,
    imageName: profile.imageName,
    imageDigest: profile.imageDigest,
    snapshotId: profile.snapshotId,
    appPort,
    recipe,
    ...provisioning,
  };
}
