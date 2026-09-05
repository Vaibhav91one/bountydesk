import { configureTarget } from "@/lib/targets/configure";
import { profileAppPort } from "@/lib/targets/authorize-reproduction";
import type { TargetDefinition } from "@/lib/targets/registry";
import { provisionTarget, teardownSandbox } from "@/lib/sandbox/provision";
import type { TrueForgeClient } from "@/lib/trueforge/client";

import { onboardingSnapshotImageRef, type BuildDriver } from "./build-driver";
import { proposeManifest } from "./onboarding-agent";
import {
  advance,
  claim,
  fail,
  releaseUnstarted,
  renew,
  LeaseLostError,
  type OnboardingLease,
} from "./queue";

/**
 * Advance one claimable target_onboarding row as far as one lease allows.
 *
 * The same resume-from-state shape as lib/jobs/worker.ts: claim a row, do the one step its state
 * calls for, then advance() to the next state and drop the lease. A step that throws fails the
 * lease (retryable with backoff) rather than losing the row. The long steps (build, manifest
 * proposal, offline verify) run under a heartbeat that renews the lease while they work, so a
 * multi-minute build does not outlive its own lease and get reclaimed by the sweeper.
 *
 * The worker never crosses AWAITING_APPROVAL: claim() does not return that state, so the only way
 * a row reaches APPROVED (and therefore a written TargetProfile) is a human moving it there
 * through lib/build-onboarding/approve-request.ts.
 */
export type OnboardDeps = {
  buildDriver: BuildDriver;
  agentClient: TrueForgeClient;
  /** The offline verify. Injectable so tests exercise the whole path without live Daytona. */
  provision?: typeof provisionTarget;
  teardown?: typeof teardownSandbox;
  leaseSeconds?: number;
  signal?: AbortSignal;
};

export async function onboardOnce(owner: string, deps: OnboardDeps): Promise<string | null> {
  const leaseSeconds = deps.leaseSeconds ?? 60;
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  const provision = deps.provision ?? provisionTarget;
  const teardown = deps.teardown ?? teardownSandbox;

  try {
    switch (lease.state) {
      case "PENDING_BUILD": {
        const result = await withHeartbeat(lease, leaseSeconds, deps.signal, (signal) =>
          deps.buildDriver.build(
            { repoFullName: lease.repoFullName, sourceRef: lease.sourceRef },
            { signal },
          ),
        );
        await advance(lease, "PENDING_MANIFEST", {
          imageName: result.imageName,
          imageDigest: result.imageDigest,
          snapshotId: result.snapshotId,
          buildMarker: result.buildMarker,
          dockerfileText: result.dockerfileText,
        });
        break;
      }

      case "PENDING_MANIFEST": {
        if (!lease.imageName || !lease.buildMarker || !lease.dockerfileText) {
          throw new Error("manifest step reached without build outputs");
        }
        const manifest = await withHeartbeat(lease, leaseSeconds, deps.signal, (signal) =>
          proposeManifest(
            deps.agentClient,
            {
              repoFullName: lease.repoFullName,
              sourceRef: lease.sourceRef,
              imageName: lease.imageName!,
              buildMarker: lease.buildMarker!,
              dockerfileText: lease.dockerfileText!,
            },
            { signal },
          ),
        );
        await advance(lease, "AWAITING_APPROVAL", { proposedManifest: manifest });
        break;
      }

      case "APPROVED": {
        await verifyAndWrite(lease, provision, teardown, leaseSeconds, deps.signal);
        await advance(lease, "CONFIGURED");
        break;
      }

      default:
        // FAILED is claimable only if something reset its next_attempt_at by hand; nothing to do.
        break;
    }
  } catch (error) {
    if (error instanceof LeaseLostError) return lease.id;
    // Shutdown, not a real failure: hand the claim back so the row is retryable at once rather
    // than held until the lease expires and the sweeper reclaims it, matching runOnce's abort
    // path in lib/jobs/worker.ts. A lost lease here means another worker already has it.
    if (deps.signal?.aborted) {
      await releaseUnstarted(lease).catch((e) => {
        if (!(e instanceof LeaseLostError)) throw e;
      });
      return lease.id;
    }
    await fail(lease, error instanceof Error ? error.message : String(error)).catch((e) => {
      if (!(e instanceof LeaseLostError)) throw e;
    });
  }

  return lease.id;
}

/**
 * Boot the freshly built snapshot in a no-egress sandbox and prove it is what it claims, then
 * write the TargetProfile and bind the repo. The image the build authored is authoritative about
 * where the image lives, so the manifest's imageName is overridden with the build's before either
 * the verify or the write.
 */
async function verifyAndWrite(
  lease: OnboardingLease,
  provision: typeof provisionTarget,
  teardown: typeof teardownSandbox,
  leaseSeconds: number,
  outerSignal?: AbortSignal,
): Promise<void> {
  if (!lease.imageName || !lease.imageDigest || !lease.snapshotId || !lease.buildMarker) {
    throw new Error("approved onboarding row is missing its build outputs");
  }
  const manifest = asTargetDefinition(lease.proposedManifest);
  const definition: TargetDefinition = { ...manifest, imageName: lease.imageName };

  const appPort = profileAppPort(definition.config);
  if (!appPort) throw new Error("proposed manifest has no usable app port in its baseUrl");
  const readinessPath = definition.provisioning.readinessPath;
  const snapshotImageRef = onboardingSnapshotImageRef(lease.imageName);

  const { sandboxId } = await withHeartbeat(lease, leaseSeconds, outerSignal, (signal) =>
    provision(
      {
        imageName: lease.imageName!,
        imageDigest: lease.imageDigest!,
        snapshotId: lease.snapshotId!,
        targetProfileId: lease.id,
        readinessPath,
        expectedBuildMarker: lease.buildMarker!,
        startCommand: definition.provisioning.startCommand,
        snapshotImageRefOverride: snapshotImageRef,
      },
      appPort,
      { signal },
    ),
  );
  // The verify sandbox is the caller's to tear down on success (provisionTarget only tears down
  // its own failures). Do it before the write, so a failed write does not leak the sandbox.
  await teardown(sandboxId, false);

  await configureTarget({
    repoId: lease.repoId,
    targetDefinition: definition,
    imageDigest: lease.imageDigest,
    snapshotId: lease.snapshotId,
    buildMarker: lease.buildMarker,
    snapshotImageRefOverride: snapshotImageRef,
    dockerfileText: lease.dockerfileText ?? undefined,
  });
}

/** A stored manifest is server-authored (validated by parseTargetManifest before it was stored),
 *  but re-check its shape at the seam rather than cast blind. */
function asTargetDefinition(value: unknown): TargetDefinition {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as TargetDefinition).name !== "string" ||
    typeof (value as TargetDefinition).imageName !== "string" ||
    typeof (value as TargetDefinition).config !== "object" ||
    (value as TargetDefinition).provisioning === undefined
  ) {
    throw new Error("stored proposed manifest is not a target definition");
  }
  return value as TargetDefinition;
}

/**
 * Run one long step while renewing the lease underneath it, and surface a lost lease as a thrown
 * LeaseLostError. Same shape as lib/jobs/worker.ts's runWithHeartbeat, generalised over a step
 * that returns a value.
 */
async function withHeartbeat<T>(
  lease: OnboardingLease,
  leaseSeconds: number,
  outerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([controller.signal, outerSignal])
    : controller.signal;
  const intervalMs = Math.max(50, Math.floor((leaseSeconds * 1000) / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal = Promise.resolve();
  let rejectLeaseLoss!: (reason: unknown) => void;
  const leaseLoss = new Promise<never>((_, reject) => {
    rejectLeaseLoss = reject;
  });

  const heartbeat = () => {
    renewal = renew(lease, leaseSeconds)
      .then(() => {
        if (!stopped) timer = setTimeout(heartbeat, intervalMs);
      })
      .catch((error: unknown) => {
        controller.abort(error);
        rejectLeaseLoss(error);
      });
  };

  timer = setTimeout(heartbeat, intervalMs);
  try {
    return await Promise.race([operation(signal), leaseLoss]);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await renewal.catch(() => undefined);
  }
}
