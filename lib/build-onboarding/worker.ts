import { configureTarget } from "@/lib/targets/configure";
import { profileAppPort } from "@/lib/targets/authorize-reproduction";
import { parseTargetManifest } from "@/lib/targets/manifest";
import type { TargetDefinition } from "@/lib/targets/registry";
import { provisionTarget, teardownSandbox } from "@/lib/sandbox/provision";
import type { TrueForgeClient } from "@/lib/trueforge/client";

import { parseBuildPlan, planToManifest, type BuildPlan } from "./build-plan";
import { classify, rawSourceReader } from "./classify";
import { knownTargetHints } from "./known-target-hints";
import { onboardingSnapshotImageRef, type BuildDriver } from "./build-driver";
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
  /** Retained for the daemon's wiring; the manifest is now derived from the build plan, so no
   *  onboarding step calls the agent. */
  agentClient: TrueForgeClient;
  /** Classify the repo into a build plan. Injectable so tests exercise the path without fetching the
   *  real repo source; defaults to the deterministic classifier over the public source. */
  classify?: (repoFullName: string) => Promise<BuildPlan>;
  /** The offline verify. Injectable so tests exercise the whole path without live Daytona. */
  provision?: typeof provisionTarget;
  teardown?: typeof teardownSandbox;
  leaseSeconds?: number;
  signal?: AbortSignal;
};

function defaultClassify(repoFullName: string): Promise<BuildPlan> {
  return classify(rawSourceReader(repoFullName), repoFullName, knownTargetHints(repoFullName));
}

export async function onboardOnce(owner: string, deps: OnboardDeps): Promise<string | null> {
  const leaseSeconds = deps.leaseSeconds ?? 60;
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  const provision = deps.provision ?? provisionTarget;
  const teardown = deps.teardown ?? teardownSandbox;

  try {
    switch (lease.state) {
      case "PENDING_PLAN": {
        // Classify the source into a build plan before any build runs. A repo that cannot become one
        // offline image lands in UNSUPPORTED with the reason, an honest resting state a reviewer
        // reads, not a retried failure.
        const doClassify = deps.classify ?? defaultClassify;
        const plan = await withHeartbeat(lease, leaseSeconds, deps.signal, () =>
          doClassify(lease.repoFullName),
        );
        if (plan.strategy === "not-flattenable") {
          await advance(lease, "UNSUPPORTED", { buildPlan: plan });
        } else {
          await advance(lease, "PENDING_BUILD", { buildPlan: plan });
        }
        break;
      }

      case "PENDING_BUILD": {
        const plan = buildablePlan(lease.buildPlan);
        const result = await withHeartbeat(lease, leaseSeconds, deps.signal, (signal) =>
          deps.buildDriver.build(
            { repoFullName: lease.repoFullName, sourceRef: lease.sourceRef, plan },
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
        if (!lease.imageName || !lease.buildMarker) {
          throw new Error("manifest step reached without build outputs");
        }
        // Derive the manifest from the build plan's runtime shape, now that the image exists. The
        // plan already decided the runtime up front from the source, so no second agent turn is run;
        // parseTargetManifest re-validates it exactly as it validates an agent proposal.
        const plan = buildablePlan(lease.buildPlan);
        const manifestObject = planToManifest(plan, {
          repoFullName: lease.repoFullName,
          imageName: lease.imageName,
        });
        const manifest = parseTargetManifest(JSON.stringify(manifestObject));
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
        warmupSeconds: definition.provisioning.warmupSeconds,
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

/** Parse a stored build plan and refuse a not-flattenable one: the build and manifest steps only ever
 *  run for a buildable strategy, so reaching them without one is a bug, not a retryable failure. */
function buildablePlan(value: unknown): Extract<BuildPlan, { strategy: "dockerfile" | "image" | "compose-synth" }> {
  const plan = parseBuildPlan(value);
  if (plan.strategy === "not-flattenable") {
    throw new Error("build step reached with a not-flattenable plan");
  }
  return plan;
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
