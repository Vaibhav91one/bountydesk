import { isDeepStrictEqual } from "node:util";

import {
  and,
  connectedRepository,
  db,
  eq,
  githubInstallation,
  isNull,
  targetProfile,
} from "@/lib/db";

const PROFILE_NAME = "juice-shop-v17.3.0";
const CONFIG = {
  baseUrl: "http://localhost:3000",
  searchPath: "/rest/products/search",
  canaryRegistrationPath: "/api/Users/",
};
const SCOPE_RULES = [{ allow: "localhost" }];

export type ConfigureJuiceShopTargetInput = {
  repoId: number;
  imageDigest: string;
  snapshotId: string | null;
};

export type ConfiguredTarget = {
  repositoryId: string;
  repositoryFullName: string;
  targetProfileId: string;
  targetProfileName: string;
};

export async function configureJuiceShopTarget(
  input: ConfigureJuiceShopTargetInput,
): Promise<ConfiguredTarget> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(targetProfile)
      .values({
        name: PROFILE_NAME,
        imageDigest: input.imageDigest,
        snapshotId: input.snapshotId,
        config: CONFIG,
        scopeRules: SCOPE_RULES,
      })
      .onConflictDoNothing({ target: targetProfile.name })
      .returning();

    const [target] = inserted
      ? [inserted]
      : await tx
          .select()
          .from(targetProfile)
          .where(eq(targetProfile.name, PROFILE_NAME))
          .limit(1)
          .for("update");

    if (!target) throw new Error(`could not create or find ${PROFILE_NAME}`);
    if (
      target.imageDigest !== input.imageDigest ||
      target.snapshotId !== input.snapshotId ||
      !isDeepStrictEqual(target.config, CONFIG) ||
      !isDeepStrictEqual(target.scopeRules, SCOPE_RULES)
    ) {
      throw new Error(`${PROFILE_NAME} exists with different pinned target settings`);
    }

    const [repository] = await tx
      .select({
        id: connectedRepository.id,
        fullName: connectedRepository.fullName,
      })
      .from(connectedRepository)
      .innerJoin(
        githubInstallation,
        eq(connectedRepository.installationId, githubInstallation.id),
      )
      .where(
        and(
          eq(connectedRepository.repoId, input.repoId),
          eq(connectedRepository.active, true),
          isNull(connectedRepository.archivedAt),
          isNull(githubInstallation.suspendedAt),
          isNull(githubInstallation.deletedAt),
        ),
      )
      .limit(1)
      .for("update");

    if (!repository) {
      throw new Error(
        `GitHub repository ${input.repoId} is not an active connected repository`,
      );
    }

    await tx
      .update(connectedRepository)
      .set({ targetProfileId: target.id, updatedAt: new Date() })
      .where(eq(connectedRepository.id, repository.id));

    return {
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      targetProfileId: target.id,
      targetProfileName: target.name,
    };
  });
}
