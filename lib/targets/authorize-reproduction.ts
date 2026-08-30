import type { AnalysisOnlyReason, ReproductionRecipe } from "@/lib/reproduction/types";
import {
  targetProvisioningFromConfig,
  type TargetProvisioningConfig,
} from "./registry";

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
