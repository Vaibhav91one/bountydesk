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
import {
  DEFAULT_TARGET_NAME,
  JUICE_SHOP_EXPECTED_BUILD_MARKER,
  JUICE_SHOP_IMAGE_NAME,
  JUICE_SHOP_PROFILE_NAME,
  JUICE_SHOP_TAG_PINNED_SNAPSHOT_IMAGE_REF,
  targetDefinitionFor,
  targetProfileConfig,
  type TargetDefinition,
  type TargetPin,
} from "./registry";
import { isValidImageDigest } from "./validation";

export { isValidImageDigest, isValidSnapshotId } from "./validation";

/**
 * The registry and image name the pinned target is built into. A fixed constant, since there
 * is exactly one logical profile and this half of the reference does not vary between builds,
 * but still written to target_profile.imageName alongside the digest: a stored value that must
 * match a code constant is a mismatch a caller can detect, where a value that exists only in
 * code cannot be checked against what a row actually holds.
 */
export const IMAGE_NAME = JUICE_SHOP_IMAGE_NAME;

/**
 * The tag Daytona's registered snapshot declares as its imageName, matching the `docker push`
 * tag in .github/workflows/build-daytona-target.yml. assertSnapshotImage wants an exact digest
 * match, and gets one whenever a snapshot has been registered digest-pinned; today it can't be,
 * because Daytona's own `POST /api/snapshots` rejects any imageName containing "@sha256:" as an
 * "invalid reference format" (confirmed live against both GHCR and a plain Docker Hub image, see
 * PR #31's description). Until that platform limitation is fixed, this is the one explicitly
 * named tag createSandbox is allowed to accept in the digest's place, with buildMarkerCheck
 * re-verifying the image that actually booted immediately afterward, from inside the sandbox.
 */
export const TAG_PINNED_SNAPSHOT_IMAGE_REF = JUICE_SHOP_TAG_PINNED_SNAPSHOT_IMAGE_REF;

/**
 * The commit the Daytona target image is built from, baked into the image at a fixed path by
 * the build workflow (see lib/sandbox/build-marker.ts) so buildMarkerCheck can prove which
 * build actually booted without relying on Daytona's own undocumented internals. Same value as
 * SOURCE_COMMIT in .github/workflows/build-daytona-target.yml; keep both in sync if the target
 * is ever rebuilt from a different commit.
 */
export const EXPECTED_BUILD_MARKER = JUICE_SHOP_EXPECTED_BUILD_MARKER;

/**
 * Compose the digest-pinned reference a SandboxSpec's imageRef expects, from the one piece
 * that actually varies between builds. Throws rather than returning an unusable string: a
 * caller with an invalid digest has a bug worth surfacing at the seam, not three frames later
 * inside assertSafeSpec.
 */
export function imageRefFor(imageDigest: string, imageName = IMAGE_NAME): string {
  if (!isValidImageDigest(imageDigest)) {
    throw new Error(`not a valid image digest: ${imageDigest}`);
  }
  return `${imageName}@${imageDigest}`;
}

export type ConfigureTargetInput = TargetPin & {
  repoId: number;
  targetName?: string;
  targetDefinition?: TargetDefinition;
  /** The Dockerfile the target image was built from, when the target came through the
   *  onboarding pipeline. Stored on the profile so a report against it can offer the file for
   *  download; not part of the pinned identity, so it is never compared in the drift check. */
  dockerfileText?: string;
};

export type ConfigureJuiceShopTargetInput = Omit<
  ConfigureTargetInput,
  "targetName" | "targetDefinition"
>;

export type ConfiguredTarget = {
  repositoryId: string;
  repositoryFullName: string;
  targetProfileId: string;
  targetProfileName: string;
};

export async function configureJuiceShopTarget(
  input: ConfigureJuiceShopTargetInput,
): Promise<ConfiguredTarget> {
  return configureTarget({ ...input, targetName: JUICE_SHOP_PROFILE_NAME });
}

export async function configureTarget(input: ConfigureTargetInput): Promise<ConfiguredTarget> {
  const definition = targetDefinitionForInput(input);
  const config = targetProfileConfig(definition, input);

  return db.transaction(async (tx) => {
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
    assertRepositoryMatchesTarget(repository.fullName, definition);

    const [inserted] = await tx
      .insert(targetProfile)
      .values({
        name: definition.name,
        imageName: definition.imageName,
        imageDigest: input.imageDigest,
        snapshotId: input.snapshotId,
        config,
        scopeRules: definition.scopeRules,
        dockerfileText: input.dockerfileText ?? null,
      })
      .onConflictDoNothing({ target: targetProfile.name })
      .returning();

    const [target] = inserted
      ? [inserted]
      : await tx
          .select()
          .from(targetProfile)
          .where(eq(targetProfile.name, definition.name))
          .limit(1)
          .for("update");

    if (!target) throw new Error(`could not create or find ${definition.name}`);
    if (
      target.imageName !== definition.imageName ||
      target.imageDigest !== input.imageDigest ||
      target.snapshotId !== input.snapshotId ||
      !isDeepStrictEqual(target.config, config) ||
      !isDeepStrictEqual(target.scopeRules, definition.scopeRules)
    ) {
      throw new Error(`${definition.name} exists with different pinned target settings`);
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

/**
 * Repoint the pinned target profile at a new build, in place.
 *
 * `configureJuiceShopTarget` refuses drift on purpose: a caller that quietly got a different
 * digest than the one already pinned is far more likely to be a misconfiguration than an
 * intended change. That means rotating to a verified new build needs its own path, one that
 * says out loud "yes, replace what is pinned" rather than getting there by tripping the
 * mismatch guard.
 *
 * The row's id does not change, so every `connected_repository` and `report` already pointing
 * at it keeps pointing at the same profile after rotation; only the pinned fields underneath
 * it move. There is nothing to rotate if the profile does not exist yet, so this refuses to
 * create one: that is what `configureJuiceShopTarget` is for.
 */
export async function rotateJuiceShopTarget(
  input: ConfigureJuiceShopTargetInput,
): Promise<ConfiguredTarget> {
  return rotateTarget({ ...input, targetName: JUICE_SHOP_PROFILE_NAME });
}

export async function rotateTarget(input: ConfigureTargetInput): Promise<ConfiguredTarget> {
  const definition = targetDefinitionForInput(input);
  const config = targetProfileConfig(definition, input);

  return db.transaction(async (tx) => {
    const [repository] = await tx
      .select({
        id: connectedRepository.id,
        fullName: connectedRepository.fullName,
        targetProfileId: connectedRepository.targetProfileId,
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
    assertRepositoryMatchesTarget(repository.fullName, definition);

    const [target] = await tx
      .select()
      .from(targetProfile)
      .where(eq(targetProfile.name, definition.name))
      .limit(1)
      .for("update");

    if (!target) {
      throw new Error(`${definition.name} does not exist yet; nothing to rotate`);
    }

    if (repository.targetProfileId !== target.id) {
      throw new Error(
        `GitHub repository ${input.repoId} is not bound to target profile ${definition.name}`,
      );
    }

    const [updatedTarget] = await tx
      .update(targetProfile)
      .set({
        imageName: definition.imageName,
        imageDigest: input.imageDigest,
        snapshotId: input.snapshotId,
        config,
        scopeRules: definition.scopeRules,
        ...(input.dockerfileText !== undefined ? { dockerfileText: input.dockerfileText } : {}),
        updatedAt: new Date(),
      })
      .where(eq(targetProfile.id, target.id))
      .returning();

    if (!updatedTarget) {
      throw new Error(`${definition.name} does not exist yet; nothing to rotate`);
    }

    return {
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      targetProfileId: updatedTarget.id,
      targetProfileName: updatedTarget.name,
    };
  });
}

function targetDefinitionForInput(input: ConfigureTargetInput): TargetDefinition {
  if (input.targetDefinition) {
    if (input.targetName && input.targetName !== input.targetDefinition.name) {
      throw new Error(`target name ${input.targetName} does not match manifest ${input.targetDefinition.name}`);
    }
    return input.targetDefinition;
  }
  return requireTargetDefinition(input.targetName ?? DEFAULT_TARGET_NAME);
}

function requireTargetDefinition(targetName: string): TargetDefinition {
  const definition = targetDefinitionFor(targetName);
  if (!definition) throw new Error(`unknown target profile ${targetName}`);
  return definition;
}

function assertRepositoryMatchesTarget(fullName: string, definition: TargetDefinition): void {
  if (fullName.toLowerCase() !== definition.repoFullName.toLowerCase()) {
    throw new Error(
      `GitHub repository ${fullName} does not match target profile ${definition.name}`,
    );
  }
}
