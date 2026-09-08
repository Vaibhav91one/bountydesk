import type { AnalysisOnlyReason, ReproductionRecipe } from "@/lib/reproduction/types";
import type { MeshServiceAuth } from "@/lib/sandbox/provision";
import {
  targetProvisioningFromConfig,
  type TargetProvisioningConfig,
} from "./registry";

/**
 * The mesh services pinned in a target profile's config, mapped to what the provisioner needs to
 * boot them, or null for a single-image target. A compose-mesh target stores every service (the app
 * and its dependencies) under config.services at onboarding; the reproduction run reads them here to
 * boot the whole mesh instead of one image.
 */
export function meshServicesFromConfig(config: unknown): MeshServiceAuth[] | null {
  const services = (config as { services?: unknown } | null)?.services;
  if (!Array.isArray(services) || services.length === 0) return null;
  const out: MeshServiceAuth[] = [];
  let hasApp = false;
  for (const raw of services) {
    const s = raw as Record<string, unknown>;
    if (
      typeof s?.service !== "string" ||
      (s.role !== "app" && s.role !== "dependency") ||
      typeof s.imageName !== "string" ||
      typeof s.imageDigest !== "string" ||
      typeof s.snapshotId !== "string"
    ) {
      throw new Error("a pinned mesh service is missing required fields");
    }
    if (s.role === "app") hasApp = true;
    out.push({
      service: s.service,
      role: s.role,
      imageName: s.imageName,
      imageDigest: s.imageDigest,
      snapshotId: s.snapshotId,
      ...(typeof s.snapshotImageRef === "string" ? { snapshotImageRefOverride: s.snapshotImageRef } : {}),
      ...(typeof s.port === "number" ? { port: s.port } : {}),
      ...(typeof s.buildMarker === "string" ? { buildMarker: s.buildMarker } : {}),
      ...(typeof s.startCommand === "string" ? { startCommand: s.startCommand } : {}),
      ...(Array.isArray(s.peers) ? { peers: s.peers.filter((p): p is string => typeof p === "string") } : {}),
    });
  }
  if (!hasApp) throw new Error("pinned mesh services have no app service");
  return out;
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
