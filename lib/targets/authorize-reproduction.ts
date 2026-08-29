import type { AnalysisOnlyReason, ReproductionRecipe } from "@/lib/reproduction/types";

export type ReproductionAuthorization =
  | {
      ok: true;
      imageDigest: string;
      snapshotId: string | null;
      recipe: ReproductionRecipe;
    }
  | { ok: false; reason: AnalysisOnlyReason };

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
      imageDigest: targetProfile.imageDigest,
      snapshotId: targetProfile.snapshotId,
      config: targetProfile.config,
    })
    .from(targetProfile)
    .where(eq(targetProfile.id, input.targetProfileId))
    .limit(1);

  if (!profile) return { ok: false, reason: "NO_BOUND_TARGET" };

  const recipe = getRecipesForTarget({ name: profile.name, config: profile.config }).find(
    (candidate) => candidate.id === input.recipeId,
  );
  if (!recipe) return { ok: false, reason: "NO_APPROVED_ORACLE" };

  return {
    ok: true,
    imageDigest: profile.imageDigest,
    snapshotId: profile.snapshotId,
    recipe,
  };
}
