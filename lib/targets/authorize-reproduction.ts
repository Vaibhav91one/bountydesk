import type { AnalysisOnlyReason, ReproductionRecipe } from "@/lib/reproduction/types";

export type ReproductionAuthorization =
  | {
      ok: true;
      imageName: string;
      imageDigest: string;
      snapshotId: string | null;
      appPort: number;
      recipe: ReproductionRecipe;
    }
  | { ok: false; reason: AnalysisOnlyReason };

function defaultPort(protocol: string): number | null {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  return null;
}

function profileAppPort(config: unknown): number | null {
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

  const recipe = getRecipesForTarget({ name: profile.name, config: profile.config }).find(
    (candidate) => candidate.id === input.recipeId,
  );
  if (!recipe) return { ok: false, reason: "NO_APPROVED_ORACLE" };

  return {
    ok: true,
    imageName: profile.imageName,
    imageDigest: profile.imageDigest,
    snapshotId: profile.snapshotId,
    appPort,
    recipe,
  };
}
