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
import type { BuildPlan } from "./build-plan";

export type BuildInput = {
  /** owner/name, used to name the image and label the sandbox. */
  repoFullName: string;
  /** The commit or ref the driver checks out, so the build is pinned to an exact source. */
  sourceRef: string;
  /** The classifier's plan, deciding the build strategy, ecosystem egress and (for compose) the
   *  datastores to bundle and seed. Must be a buildable strategy, never `not-flattenable`. */
  plan: BuildPlan;
};

/**
 * One service of a compose-mesh build. Each is either built from the repo (its image carries the
 * build marker) or pulled as a stock image (no marker), pushed or referenced, and registered as its
 * own Daytona snapshot. At reproduction each runs as its own linked sandbox; the app is the one the
 * agent probes, and a dependency is reached by the app over the link group by sandbox id.
 */
export type BuiltService = {
  service: string;
  role: "app" | "dependency";
  /** Untagged registry reference for a built service, or the stock image name for a pulled one. */
  imageName: string;
  /** sha256:<64 hex> of the image. */
  imageDigest: string;
  /** The Daytona snapshot this service boots from. */
  snapshotId: string;
  /** The tag the snapshot was registered under; the reproduction override names it exactly. */
  snapshotImageRef: string;
  /** The service's listening port, absent for a background worker with no inbound port. */
  port?: number;
  /** Present for a service we built (its image carries the marker), absent for a pulled image. */
  buildMarker?: string;
  /** The command that starts a built service. Its image entrypoint is overridden to idle so it does
   *  not auto-start before its peers are reachable; the provisioner wires peers, then runs this. A
   *  pulled dependency (a stock datastore) auto-starts from its own entrypoint and has none. */
  startCommand?: string;
  /** The service's env; a value naming another service is rewritten to that peer's sandbox id at
   *  provision time, so it is kept verbatim here. */
  env?: Record<string, string>;
  /** Compose service names this service connects to, so the provisioner injects the right peers. */
  peers?: string[];
};

export type BuildResult = {
  /** Untagged registry reference, e.g. ghcr.io/owner/name. Satisfies the manifest image rule. For a
   *  compose-mesh build this is the app service's image; the rest are in `services`. */
  imageName: string;
  /** sha256:<64 hex> of the pushed image. */
  imageDigest: string;
  /** The Daytona snapshot the reproduction sandbox will boot from. */
  snapshotId: string;
  /** The exact Dockerfile the image was built from. Stored durably and offered for download. */
  dockerfileText: string;
  /** The captured output of the docker build steps, capped. Stored for a reviewer to download. */
  buildLog: string;
  /** The commit baked into /etc/bountydesk-build-marker, re-verified from inside the sandbox. */
  buildMarker: string;
  /** A hash over the build plan, base-image digest and commit, so the pinned target identity records
   *  how it was built and not only what came out (docs/decisions.md Q20). */
  buildRecipeDigest: string;
  /** Present for a compose-mesh build: every service, the app and its dependencies. The top-level
   *  image fields above mirror the app service, so the single-image consumers keep working. */
  services?: BuiltService[];
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
