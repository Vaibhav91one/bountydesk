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

/**
 * The registry and image name the pinned target is built into. A fixed constant, since there
 * is exactly one logical profile and this half of the reference does not vary between builds,
 * but still written to target_profile.imageName alongside the digest: a stored value that must
 * match a code constant is a mismatch a caller can detect, where a value that exists only in
 * code cannot be checked against what a row actually holds.
 */
export const IMAGE_NAME = "ghcr.io/vaibhav91one/juice-shop";

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
export const TAG_PINNED_SNAPSHOT_IMAGE_REF = `${IMAGE_NAME}:v17.3.0-bountydesk-sandbox`;

/**
 * The commit the Daytona target image is built from, baked into the image at a fixed path by
 * the build workflow (see lib/sandbox/build-marker.ts) so buildMarkerCheck can prove which
 * build actually booted without relying on Daytona's own undocumented internals. Same value as
 * SOURCE_COMMIT in .github/workflows/build-daytona-target.yml; keep both in sync if the target
 * is ever rebuilt from a different commit.
 */
export const EXPECTED_BUILD_MARKER = "1867b926c5f50e4e692dc9c8f61821413cebe0cd";

const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/**
 * Same character class createSandbox already accepts for a snapshot identifier. An env.example
 * placeholder like "<immutable-daytona-snapshot-id>" fails this on its own, since angle
 * brackets are not in it, so no separate placeholder blocklist is needed.
 */
const SNAPSHOT_ID_RE = /^[A-Za-z0-9._:@/-]{1,200}$/;

export function isValidImageDigest(value: string): boolean {
  return IMAGE_DIGEST_RE.test(value);
}

export function isValidSnapshotId(value: string): boolean {
  return SNAPSHOT_ID_RE.test(value);
}

/**
 * Compose the digest-pinned reference a SandboxSpec's imageRef expects, from the one piece
 * that actually varies between builds. Throws rather than returning an unusable string: a
 * caller with an invalid digest has a bug worth surfacing at the seam, not three frames later
 * inside assertSafeSpec.
 */
export function imageRefFor(imageDigest: string): string {
  if (!isValidImageDigest(imageDigest)) {
    throw new Error(`not a valid image digest: ${imageDigest}`);
  }
  return `${IMAGE_NAME}@${imageDigest}`;
}

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
        imageName: IMAGE_NAME,
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
      target.imageName !== IMAGE_NAME ||
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
  return db.transaction(async (tx) => {
    const [target] = await tx
      .update(targetProfile)
      .set({
        imageName: IMAGE_NAME,
        imageDigest: input.imageDigest,
        snapshotId: input.snapshotId,
        config: CONFIG,
        scopeRules: SCOPE_RULES,
        updatedAt: new Date(),
      })
      .where(eq(targetProfile.name, PROFILE_NAME))
      .returning();

    if (!target) {
      throw new Error(`${PROFILE_NAME} does not exist yet; nothing to rotate`);
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

    return {
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      targetProfileId: target.id,
      targetProfileName: target.name,
    };
  });
}
