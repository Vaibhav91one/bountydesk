import { connectedRepository, db, eq, targetOnboarding, targetProfile } from "@/lib/db";
import { configureTarget, rotateTarget, TargetProfileExistsError } from "@/lib/targets/configure";
import { profileAppPort } from "@/lib/targets/authorize-reproduction";
import { parseTargetManifest, validateStartCommand } from "@/lib/targets/manifest";
import type { TargetDefinition } from "@/lib/targets/registry";
import {
  provisionMesh,
  provisionTarget,
  teardownSandbox,
  type MeshServiceAuth,
} from "@/lib/sandbox/provision";
import { sweepTrialSnapshots } from "@/lib/sandbox/daytona";
import type { TrueForgeClient } from "@/lib/trueforge/client";

import { parseBuildPlan, planToManifest, type BuildPlan } from "./build-plan";
import { classify, rawSourceReader } from "./classify";
import { knownTargetHints } from "./known-target-hints";
import { hasIdentityAnchor, resolveRepositoryCommit, resolveRepositoryLineage, type RepositoryLineage } from "./source-identity";
import { runOnboardingAgent, type RunOnboardingAgentInput } from "./onboarding-agent";
import {
  runSandboxabilityReview,
  type RunSandboxabilityReviewInput,
} from "@/lib/analysis/sandboxability";
import type { ReviewResult } from "@/lib/mcp/review";
import { onboardingSnapshotImageRef, type BuildDriver, type BuiltService } from "./build-driver";
import {
  advance,
  claim,
  fail,
  releaseUnstarted,
  renew,
  setOnboardingProgress,
  setResolvedSourceIdentity,
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
  classify?: (repoFullName: string, resolvedCommitSha?: string) => Promise<BuildPlan>;
  /** Resolve the server-owned repository ref to an immutable commit before source reads/builds. */
  resolveCommit?: (repoFullName: string, sourceRef: string) => Promise<string>;
  resolveLineage?: (repoFullName: string) => Promise<RepositoryLineage>;
  /** Run the onboarding agent for a repo the deterministic classifier could not flatten. Injectable so
   *  tests exercise the ladder without a live TrueForge turn; defaults to the real agent turn, which
   *  writes its result onto the row's build_plan. */
  runOnboardingAgent?: (input: RunOnboardingAgentInput) => Promise<void>;
  /** Run the read-only sandboxability review for a repo the deterministic classifier could not flatten,
   *  before the build agent. Injectable so tests exercise the routing without a live review turn;
   *  defaults to the real review, which is fail-open (any failure resolves to "unsure"). */
  runSandboxabilityReview?: (input: RunSandboxabilityReviewInput) => Promise<ReviewResult>;
  /** The offline verify. Injectable so tests exercise the whole path without live Daytona. */
  provision?: typeof provisionTarget;
  provisionMesh?: typeof provisionMesh;
  teardown?: typeof teardownSandbox;
  leaseSeconds?: number;
  signal?: AbortSignal;
};

function defaultClassify(repoFullName: string, resolvedCommitSha?: string): Promise<BuildPlan> {
  if (!resolvedCommitSha) throw new Error("onboarding classification requires a server-resolved commit SHA");
  return classify(rawSourceReader(repoFullName, resolvedCommitSha), repoFullName, knownTargetHints(repoFullName));
}

/** Re-read the plan the onboarding agent wrote onto the row through its commit/mark tools. A row with
 *  no plan means the agent ended its turn without committing or refusing; treat that as a
 *  not-flattenable outcome so the ladder falls to UNSUPPORTED rather than a retried failure. */
async function readBuildPlan(onboardingId: string): Promise<BuildPlan> {
  const [row] = await db
    .select({ buildPlan: targetOnboarding.buildPlan })
    .from(targetOnboarding)
    .where(eq(targetOnboarding.id, onboardingId))
    .limit(1);
  if (!row?.buildPlan) {
    return { strategy: "not-flattenable", ecosystem: "none", reason: "the onboarding agent produced no build recipe" };
  }
  return parseBuildPlan(row.buildPlan);
}

export async function onboardOnce(owner: string, deps: OnboardDeps): Promise<string | null> {
  const leaseSeconds = deps.leaseSeconds ?? 60;
  const lease = await claim(owner, leaseSeconds);
  if (!lease) return null;

  const provision = deps.provision ?? provisionTarget;
  const provisionMeshFn = deps.provisionMesh ?? provisionMesh;
  const teardown = deps.teardown ?? teardownSandbox;

  try {
    switch (lease.state) {
      case "PENDING_PLAN": {
        // The onboarding ladder. Rung 1: the deterministic classifier turns a Dockerfile/compose repo
        // into a build plan. Rung 2 (the agent): a repo it cannot flatten is handed to the onboarding
        // agent, which tries to build it into one bootable image in a sandbox and writes its result
        // (an agent-authored plan, or a not-flattenable reason) onto build_plan. A repo that comes out
        // not-flattenable lands in UNSUPPORTED with the reason, an honest resting state a reviewer
        // reads, not a retried failure.
        await setOnboardingProgress(lease.id, "reading the repository").catch(() => undefined);
        await recordLineage(lease.repoId, lease.repoFullName, deps.resolveLineage ?? resolveRepositoryLineage);
        if (!lease.resolvedCommitSha) {
          const resolveCommit = deps.resolveCommit ?? resolveRepositoryCommit;
          const resolvedCommitSha = await withHeartbeat(lease, leaseSeconds, deps.signal, () =>
            resolveCommit(lease.repoFullName, lease.sourceRef),
          );
          await setResolvedSourceIdentity(lease, resolvedCommitSha);
          lease.resolvedCommitSha = resolvedCommitSha;
        }
        const doClassify = deps.classify ?? defaultClassify;
        let plan = await withHeartbeat(lease, leaseSeconds, deps.signal, () =>
          doClassify(lease.repoFullName, lease.resolvedCommitSha ?? undefined),
        );

        if (plan.strategy === "not-flattenable") {
          const ecosystem = plan.ecosystem;
          // Store the deterministic plan first so the review and the agent read the detected ecosystem
          // (and therefore the build-sandbox egress) from build_plan.
          await db
            .update(targetOnboarding)
            .set({ buildPlan: plan, updatedAt: new Date() })
            .where(eq(targetOnboarding.id, lease.id));

          // The sandboxability review (the read-only code-review pre-check) runs before the build agent.
          // A "no" skips the multi-minute build turn and routes the repo to analysis-only; "yes"/"unsure"
          // fall through to the build agent unchanged. It is fail-open (any failure -> "unsure"), so an
          // unregistered review agent leaves onboarding behaving exactly as before.
          await setOnboardingProgress(lease.id, "checking whether it can be sandboxed").catch(() => undefined);
          // withHeartbeat hands its operation the combined lease-loss signal; pass it into the default
          // review so a lost lease cancels the remote turn instead of leaving it polling after another
          // worker takes over. Injected reviews ignore the signal.
          const review = await withHeartbeat(lease, leaseSeconds, deps.signal, (signal) => {
            const runReview =
              deps.runSandboxabilityReview ??
              ((input: RunSandboxabilityReviewInput) =>
                runSandboxabilityReview(deps.agentClient, input, { signal }));
            return runReview({ onboardingId: lease.id, repoFullName: lease.repoFullName });
          });

          if (review.verdict === "no") {
            plan = {
              strategy: "not-flattenable",
              ecosystem,
              reason: review.reason.trim().length > 0 ? review.reason : plan.reason,
            };
            await db
              .update(targetOnboarding)
              .set({ buildPlan: plan, updatedAt: new Date() })
              .where(eq(targetOnboarding.id, lease.id));
          } else {
            await setOnboardingProgress(lease.id, "building the target image").catch(() => undefined);
            const runAgent =
              deps.runOnboardingAgent ??
              ((input: RunOnboardingAgentInput) => runOnboardingAgent(deps.agentClient, input, { signal: deps.signal }));
            await withHeartbeat(lease, leaseSeconds, deps.signal, () =>
              runAgent({ onboardingId: lease.id, repoFullName: lease.repoFullName }),
            );
            plan = await readBuildPlan(lease.id);
          }
        }

        if (plan.strategy === "not-flattenable") {
          // A report on this repo reads the reason and gets a read-only static review of the source
          // instead of a reproduction (lib/analysis/static-review.ts).
          await advance(lease, "UNSUPPORTED", { buildPlan: plan, analysisOnlyReason: "COULD_NOT_BUILD" });
        } else {
          await advance(lease, "PENDING_BUILD", { buildPlan: plan });
        }
        break;
      }

      case "PENDING_BUILD": {
        await setOnboardingProgress(lease.id, "rebuilding and verifying the image").catch(() => undefined);
        const plan = buildablePlan(lease.buildPlan);
        const result = await withHeartbeat(lease, leaseSeconds, deps.signal, (signal) =>
          deps.buildDriver.build(
            {
              repoFullName: lease.repoFullName,
              sourceRef: lease.sourceRef,
              ...(lease.resolvedCommitSha ? { resolvedCommitSha: lease.resolvedCommitSha } : {}),
              ...(lease.sourceArchiveDigest ? { sourceArchiveDigest: lease.sourceArchiveDigest } : {}),
              plan,
            },
            { signal },
          ),
        );
        await advance(lease, "PENDING_MANIFEST", {
          imageName: result.imageName,
          imageDigest: result.imageDigest,
          snapshotId: result.snapshotId,
          buildMarker: result.buildMarker,
          buildRecipeDigest: result.buildRecipeDigest,
          ...(result.resolvedCommitSha ? { resolvedCommitSha: result.resolvedCommitSha } : {}),
          ...(result.sourceArchiveDigest ? { sourceArchiveDigest: result.sourceArchiveDigest } : {}),
          dockerfileText: result.dockerfileText,
          buildLog: result.buildLog,
          // A compose-mesh build carries every service; a single-image build has none, and the
          // column stays null. The top-level fields above already mirror the app service.
          ...(result.services ? { builtServices: result.services } : {}),
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
        await verifyAndWrite(lease, provision, provisionMeshFn, teardown, leaseSeconds, deps.signal);
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
    // Only the build step failing means the target cannot be built. fail() records the reason once
    // the attempts run out and the row is FAILED; a classify or verify failure records none, so a
    // report on that repo is never told its target failed to build.
    const reason = lease.state === "PENDING_BUILD" ? "COULD_NOT_BUILD" : null;
    await fail(lease, error instanceof Error ? error.message : String(error), reason).catch((e) => {
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
  provisionMeshFn: typeof provisionMesh,
  teardown: typeof teardownSandbox,
  leaseSeconds: number,
  outerSignal?: AbortSignal,
): Promise<void> {
  if (
    !lease.imageName ||
    !lease.imageDigest ||
    !lease.snapshotId ||
    !lease.buildMarker ||
    !lease.buildRecipeDigest
  ) {
    throw new Error("approved onboarding row is missing its build outputs");
  }
  // The identity anchor is a commit SHA, a source archive digest, or the image digest; a non-git
  // target has no commit but is still anchored, so this checks for any one rather than the commit.
  if (
    !hasIdentityAnchor({
      resolvedCommitSha: lease.resolvedCommitSha,
      sourceArchiveDigest: lease.sourceArchiveDigest,
      imageDigest: lease.imageDigest,
    })
  ) {
    throw new Error("approved onboarding row has no identity anchor");
  }
  const manifest = asTargetDefinition(lease.proposedManifest);
  const definition: TargetDefinition = { ...manifest, imageName: lease.imageName };

  const appPort = profileAppPort(definition.config);
  if (!appPort) throw new Error("proposed manifest has no usable app port in its baseUrl");
  const readinessPath = definition.provisioning.readinessPath;
  const snapshotImageRef = onboardingSnapshotImageRef(lease.imageName);

  // Revalidate the proposed start command right before it is booted and stored. parseTargetManifest
  // validated it when the manifest was proposed; this is the defence-in-depth re-check at the write
  // seam, in case a stored manifest was changed between proposal and approval. The offline provision
  // below then actually runs the command and waits for readiness, so a command that does not boot
  // fails the verify and the profile is never written. Mesh services validate per service in
  // meshServiceAuth / assertSafeMeshStartCommand.
  if (definition.provisioning.startCommand !== undefined) {
    validateStartCommand(definition.provisioning.startCommand);
  }

  // A compose-mesh build carries every service; the offline verify boots the whole mesh. A
  // single-image build boots the one snapshot exactly as before. Either way the sandboxes the verify
  // created are torn down here before the write, so a failed write does not leak them.
  const builtServices = parseBuiltServices(lease.builtServices);
  let sandboxIds: string[];
  if (builtServices) {
    const result = await withHeartbeat(lease, leaseSeconds, outerSignal, (signal) =>
      provisionMeshFn(
        {
          targetProfileId: lease.id,
          appService: appServiceName(builtServices),
          services: builtServices.map(meshServiceAuth),
          readinessPath,
          warmupSeconds: definition.provisioning.warmupSeconds,
        },
        { signal },
      ),
    );
    sandboxIds = result.sandboxIds;
  } else {
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
    sandboxIds = [sandboxId];
  }
  // Attempt every verification sandbox before surfacing a failure: a sequential loop that threw on
  // the first delete would leave the rest running with nothing left holding their ids. The write
  // below still waits for a clean teardown, so an orphaned sandbox fails the step rather than being
  // recorded as configured.
  const teardownErrors: unknown[] = [];
  for (const id of sandboxIds) {
    try {
      await teardown(id, false);
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  if (teardownErrors.length > 0) {
    throw new Error(
      `could not tear down ${teardownErrors.length} of ${sandboxIds.length} verification sandboxes: ${teardownErrors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join("; ")}`,
    );
  }

  // The mesh services are pinned into the profile config so the reproduction run boots the same mesh.
  const pinnedDefinition: TargetDefinition = builtServices
    ? { ...definition, config: { ...definition.config, services: builtServices } }
    : definition;
  const pin = {
    repoId: lease.repoId,
    targetDefinition: pinnedDefinition,
    imageDigest: lease.imageDigest,
    snapshotId: lease.snapshotId,
    buildMarker: lease.buildMarker,
    buildRecipeDigest: lease.buildRecipeDigest ?? undefined,
    resolvedCommitSha: lease.resolvedCommitSha ?? undefined,
    sourceArchiveDigest: lease.sourceArchiveDigest ?? undefined,
    snapshotImageRefOverride: snapshotImageRef,
    dockerfileText: lease.dockerfileText ?? undefined,
  };
  // Onboarding a repo that already has a profile (a re-onboard, or a verified rebuild) reuses the
  // profile name, and configureTarget refuses to overwrite one whose pinned settings differ. This
  // run has just built and offline-verified the new image, so it is exactly the "yes, replace what
  // is pinned" case rotateTarget exists for: create when there is nothing to replace, rotate in place
  // when there is. Rotation keeps the profile id, so every report and connected repo stays bound.
  try {
    await configureTarget(pin);
  } catch (error) {
    if (!(error instanceof TargetProfileExistsError)) throw error;
    await rotateTarget(pin);
  }
}

/** Parse a stored build plan and refuse a not-flattenable one: the build and manifest steps only ever
 *  run for a buildable strategy, so reaching them without one is a bug, not a retryable failure. */
function buildablePlan(
  value: unknown,
): Extract<BuildPlan, { strategy: "dockerfile" | "image" | "compose-synth" | "compose-mesh" | "agent-authored" }> {
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

/** Read the built mesh services stored at the build step. Null means a single-image build; a
 * present but malformed value fails closed instead of silently downgrading to that path. */
export function parseBuiltServices(value: unknown): BuiltService[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("stored built services must be a nonempty array");
  }
  const names = new Set<string>();
  const apps: BuiltService[] = [];
  for (const raw of value) {
    const svc = raw as Partial<BuiltService> | null;
    if (
      typeof svc !== "object" ||
      svc === null ||
      typeof svc.service !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(svc.service) ||
      names.has(svc.service) ||
      (svc.role !== "app" && svc.role !== "dependency") ||
      typeof svc.imageName !== "string" ||
      typeof svc.imageDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(svc.imageDigest) ||
      typeof svc.snapshotId !== "string"
    ) {
      throw new Error("a stored built service is malformed");
    }
    names.add(svc.service);
    if (svc.role === "app") apps.push(svc as BuiltService);
    if (svc.port !== undefined && (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65_535)) {
      throw new Error(`stored built service ${svc.service} has an invalid port`);
    }
    if (svc.peers !== undefined && (!Array.isArray(svc.peers) || svc.peers.some((peer) => typeof peer !== "string"))) {
      throw new Error(`stored built service ${svc.service} has invalid peers`);
    }
    assertSafeMeshStartCommand(svc.service, svc.startCommand);
  }
  if (apps.length !== 1) throw new Error("stored built services must have exactly one app service");
  for (const raw of value as BuiltService[]) {
    for (const peer of raw.peers ?? []) {
      if (!names.has(peer)) throw new Error(`stored built service ${raw.service} references unknown peer ${peer}`);
    }
  }
  return value as BuiltService[];
}

function appServiceName(services: BuiltService[]): string {
  const app = services.find((s) => s.role === "app");
  if (!app) throw new Error("built mesh services have no app service");
  return app.service;
}

/** Map a stored built service to what the mesh provisioner needs to boot it. */
export function assertSafeMeshStartCommand(service: string, command: string | undefined): string | undefined {
  const startCommand = command?.trim();
  if (
    startCommand &&
    /^(?:(?:cd\s+[^;&]+)\s*&&\s*)?(docker|docker-compose|podman|nerdctl)(?:\s|$)/.test(startCommand)
  ) {
    throw new Error(`mesh service ${service} has a host-level start command: ${startCommand}`);
  }
  return startCommand;
}

function meshServiceAuth(s: BuiltService): MeshServiceAuth {
  const startCommand = assertSafeMeshStartCommand(s.service, s.startCommand);
  return {
    service: s.service,
    role: s.role,
    imageName: s.imageName,
    imageDigest: s.imageDigest,
    snapshotId: s.snapshotId,
    ...(s.snapshotImageRef ? { snapshotImageRefOverride: s.snapshotImageRef } : {}),
    ...(s.port !== undefined ? { port: s.port } : {}),
    ...(s.buildMarker ? { buildMarker: s.buildMarker } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(s.peers ? { peers: s.peers } : {}),
  };
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

/**
 * Record which repository this one was forked from, so an email that links the upstream project
 * finds the fork's target. It is a convenience for matching, never a condition of onboarding, so
 * any failure is logged and onboarding carries on.
 */
async function recordLineage(
  repoId: number,
  repoFullName: string,
  resolve: (repoFullName: string) => Promise<RepositoryLineage>,
): Promise<void> {
  try {
    const { parent, source } = await resolve(repoFullName);
    await db
      .update(connectedRepository)
      .set({ parentFullName: parent, sourceFullName: source, updatedAt: new Date() })
      .where(eq(connectedRepository.repoId, repoId));
  } catch (error) {
    console.warn(`could not record the fork lineage of ${repoFullName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// A row past one of these has either bound its snapshot to a profile (CONFIGURED, so the profile
// query protects it) or produced nothing worth keeping (UNSUPPORTED, FAILED). Every other state is
// in flight, and its built snapshot must be protected from the sweep until the row records it.
const ONBOARDING_TERMINAL = new Set(["CONFIGURED", "UNSUPPORTED", "FAILED"]);

/** Snapshot ids on a stored services value. A target profile config holds `{ services: [...] }`; a
 *  target_onboarding built_services column is the array itself, so both shapes are read here. */
function meshSnapshotIds(value: unknown): string[] {
  const array = Array.isArray(value)
    ? value
    : Array.isArray((value as { services?: unknown } | null)?.services)
      ? (value as { services: unknown[] }).services
      : [];
  const ids: string[] = [];
  for (const service of array) {
    const id = (service as { snapshotId?: unknown } | null)?.snapshotId;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * Every snapshot id a live target boots from or an in-flight onboarding still holds: every target
 * profile's snapshot (single-image and each mesh service), plus every non-terminal onboarding row's
 * built snapshot. sweepTrialSnapshots never deletes one of these, so an onboarding whose snapshot is
 * built but whose row is not yet approved is safe from the sweep.
 */
export async function collectProtectedSnapshotIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const profiles = await db
    .select({ snapshotId: targetProfile.snapshotId, config: targetProfile.config })
    .from(targetProfile);
  for (const profile of profiles) {
    if (profile.snapshotId) ids.add(profile.snapshotId);
    for (const id of meshSnapshotIds(profile.config)) ids.add(id);
  }
  const rows = await db
    .select({
      state: targetOnboarding.state,
      snapshotId: targetOnboarding.snapshotId,
      builtServices: targetOnboarding.builtServices,
    })
    .from(targetOnboarding);
  for (const row of rows) {
    if (ONBOARDING_TERMINAL.has(row.state)) continue;
    if (row.snapshotId) ids.add(row.snapshotId);
    for (const id of meshSnapshotIds(row.builtServices)) ids.add(id);
  }
  return ids;
}

/**
 * Reclaim build-created snapshots that no live target depends on.
 *
 * Read the protected set from the database, then sweep. This runs as maintenance, not on the
 * onboarding hot path: a hot-path sweep could race a concurrent build and delete a snapshot the
 * database has not yet recorded, and it would reach the live Daytona API from every onboarding.
 */
export async function sweepOrphanSnapshots(): Promise<{ deleted: string[]; kept: string[] }> {
  return sweepTrialSnapshots(await collectProtectedSnapshotIds());
}
