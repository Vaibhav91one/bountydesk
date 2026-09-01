/**
 * The one thing the onboarding pipeline cannot do without live infrastructure: turn a source
 * repository into a bootable, pinned target image.
 *
 * Behind this interface so the rest of the pipeline (queue, worker, manifest, approval, verify,
 * write) is exercised end to end against a fake in tests, and the single real implementation
 * (lib/build-onboarding/daytona-build-driver.ts) is the only piece that touches Daytona, Docker
 * and a registry. A driver clones the source, builds its Docker image inside a sandbox with a
 * narrow, server-held egress allow-list, bakes a build marker, registers the image as a Daytona
 * snapshot, and reports back the identifiers the later steps pin against.
 */
export type BuildInput = {
  /** owner/name, used to name the image and label the sandbox. */
  repoFullName: string;
  /** A git URL or ref the driver clones and builds. */
  sourceRef: string;
};

export type BuildResult = {
  /** Untagged registry reference, e.g. ghcr.io/owner/name. Satisfies the manifest image rule. */
  imageName: string;
  /** sha256:<64 hex> of the pushed image. */
  imageDigest: string;
  /** The Daytona snapshot the reproduction sandbox will boot from. */
  snapshotId: string;
  /** The exact Dockerfile the image was built from. Stored durably and offered for download. */
  dockerfileText: string;
  /** The commit baked into /etc/bountydesk-build-marker, re-verified from inside the sandbox. */
  buildMarker: string;
};

export interface BuildDriver {
  build(input: BuildInput, opts?: { signal?: AbortSignal }): Promise<BuildResult>;
}

/**
 * The tag the onboarding snapshot is registered under. The snapshot cannot be registered
 * digest-pinned (Daytona rejects `@sha256:` in POST /snapshots), so both the build driver, when
 * it pushes and registers, and the verify step, when it boots the snapshot, name this exact tag.
 * buildMarkerCheck re-proves the image identity from inside the booted sandbox regardless.
 */
export const ONBOARDING_SNAPSHOT_TAG = "bountydesk-onboarding";

export function onboardingSnapshotImageRef(imageName: string): string {
  return `${imageName}:${ONBOARDING_SNAPSHOT_TAG}`;
}
