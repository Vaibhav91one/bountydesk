import {
  configureConnectionlessTarget,
  rotateConnectionlessTarget,
  TargetProfileExistsError,
  type ConfiguredTarget,
} from "@/lib/targets/configure";
import type { TargetDefinition } from "@/lib/targets/registry";

import { onboardingSnapshotImageRef, type BuildResult } from "./build-driver";

/**
 * Bind a target that has no GitHub repository behind it, the first real caller of
 * configureConnectionlessTarget. It takes a validated, server-authored target definition and the
 * outputs of a build (a repo clone, an uploaded archive, or a prebuilt image) and writes the pinned
 * profile. Scope and every other pinned field come from the definition and the verified build, never
 * from anything a reporter sent.
 *
 * The image the build authored is authoritative about where the image lives, so the definition's
 * imageName is overridden with the build's before the write, matching the GitHub path (verifyAndWrite).
 *
 * A re-onboard with changed pins rotates the profile in place (keeping its row id, so bound reports
 * stay bound) only when the caller passes mayRotate and it resolves true. mayRotate is the caller's
 * proof that it still holds the current claim on this target, checked after the drift is seen. Without
 * it the drift error is rethrown: a stale worker whose lease was re-claimed must not repoint a profile
 * that a newer attempt already wrote and a live run may be using.
 */
export async function bindConnectionlessTargetFromBuild(
  definition: TargetDefinition,
  build: BuildResult,
  { mayRotate }: { mayRotate?: () => Promise<boolean> } = {},
): Promise<ConfiguredTarget> {
  // Every source, a prebuilt image included, is pushed and snapshotted under the onboarding tag.
  const snapshotImageRef = onboardingSnapshotImageRef(build.imageName);
  // A compose-mesh build carries every service; pin them into the config so the reproduction run boots
  // the same mesh, exactly as the GitHub verify-and-write path does.
  const pinnedDefinition: TargetDefinition = build.services
    ? { ...definition, imageName: build.imageName, config: { ...definition.config, services: build.services } }
    : { ...definition, imageName: build.imageName };

  const args = {
    targetDefinition: pinnedDefinition,
    imageDigest: build.imageDigest,
    snapshotId: build.snapshotId,
    buildMarker: build.buildMarker,
    buildRecipeDigest: build.buildRecipeDigest,
    snapshotImageRefOverride: snapshotImageRef,
    ...(build.resolvedCommitSha ? { resolvedCommitSha: build.resolvedCommitSha } : {}),
    ...(build.sourceArchiveDigest ? { sourceArchiveDigest: build.sourceArchiveDigest } : {}),
    ...(build.dockerfileText ? { dockerfileText: build.dockerfileText } : {}),
  };
  try {
    return await configureConnectionlessTarget(args);
  } catch (error) {
    if (!(error instanceof TargetProfileExistsError) || !mayRotate || !(await mayRotate())) throw error;
    return await rotateConnectionlessTarget(args);
  }
}
