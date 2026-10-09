import { createHash } from "node:crypto";

import type { BuildSource } from "@/lib/build-onboarding/build-driver";
import { parseBuildPlan, type BuildPlan } from "@/lib/build-onboarding/build-plan";
import { detectEcosystem } from "@/lib/build-onboarding/classify";
import type { RunOnboardingAgentInput } from "@/lib/build-onboarding/onboarding-agent";
import { db, eq, targetOnboarding } from "@/lib/db";

import type { ReviewedUploadTarget } from "./gate";
import { archiveShape } from "./recipe";

/**
 * Let the onboarding agent author the build for an upload that has no usable Dockerfile: a source
 * tarball without one at its root, or a git URL (whose root is only known after a clone).
 *
 * The agent's tools resolve a target_onboarding row by capability token, so the upload gets one,
 * tied to it by upload_id. The row is only a handle for the agent: its state is never one the
 * build-onboarding worker claims, and the upload build loop reads the plan back and runs the build
 * itself. Everything the agent returns is untrusted. parseBuildPlan re-validates the plan it
 * committed, and the runtime must match the base URL and readiness path the reviewer approved, so the
 * agent cannot move the target to a different port than the one that will be bound.
 */

export type UploadAgent = (input: RunOnboardingAgentInput) => Promise<void>;

/** A negative id derived from the upload id: it cannot collide with a GitHub repo id (positive), and
 *  a retried build finds the same row. 48 bits stay inside a safe integer. */
export function uploadRepoId(uploadId: string): number {
  return -(createHash("sha256").update(uploadId).digest().readUIntBE(0, 6) + 1);
}

function agentInstructions(reviewed: ReviewedUploadTarget, source: Exclude<BuildSource, { kind: "image" }>): string {
  const { definition } = reviewed;
  return [
    source.kind === "git"
      ? "This is an uploaded git source, not a GitHub repository. Use its Dockerfile if it has one."
      : "This is an uploaded source archive with no Dockerfile at its root, not a GitHub repository.",
    `Commit it with name ${definition.name}, baseUrl ${String(definition.config.baseUrl)} and readinessPath`,
    `${definition.provisioning.readinessPath}. The app must listen on that port; do not choose another.`,
    definition.provisioning.startCommand ? `Start it with: ${definition.provisioning.startCommand}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The plan the agent committed for this upload, or null when it gave up, failed, or committed
 *  something that does not match what the reviewer approved. Null means: use the fallback. */
export async function agentBuildPlan(input: {
  uploadId: string;
  reportId: string;
  source: Exclude<BuildSource, { kind: "image" }>;
  reviewed: ReviewedUploadTarget;
  agent: UploadAgent;
  signal?: AbortSignal;
}): Promise<BuildPlan | null> {
  const { uploadId, reportId, source, reviewed, agent, signal } = input;
  const { definition } = reviewed;

  let ecosystem = reviewed.ecosystem;
  if (ecosystem === "none" && source.kind === "archive") {
    ecosystem = await detectEcosystem(archiveShape(source.archive).sourceReader);
  }
  const start = parseBuildPlan({
    strategy: "not-flattenable",
    ecosystem,
    reason: "the onboarding agent did not commit a recipe",
  });
  // The identity anchor is the archive digest or the commit, the same one the final build is pinned on.
  const anchor =
    source.kind === "git"
      ? { resolvedCommitSha: source.resolvedCommitSha, sourceArchiveDigest: null }
      : { resolvedCommitSha: null, sourceArchiveDigest: source.sourceArchiveDigest };
  const fresh = {
    ...anchor,
    state: "UPLOAD_AGENT",
    buildPlan: start,
    agentSandboxId: null,
    progressNote: "building an uploaded source",
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(targetOnboarding)
    .values({
      uploadId,
      repoId: uploadRepoId(uploadId),
      repoFullName: definition.repoFullName,
      sourceRef: `upload:${reportId}`,
      ...fresh,
    })
    .onConflictDoUpdate({ target: targetOnboarding.uploadId, set: fresh })
    .returning({ id: targetOnboarding.id });

  try {
    await agent({
      onboardingId: row.id,
      repoFullName: definition.repoFullName,
      instructions: agentInstructions(reviewed, source),
    });
  } catch (error) {
    await db
      .update(targetOnboarding)
      .set({ state: "UPLOAD_DONE", updatedAt: new Date() })
      .where(eq(targetOnboarding.id, row.id))
      .catch(() => undefined);
    if (signal?.aborted) throw error;
    console.error(`upload ${uploadId} onboarding agent failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  // The row was only the agent's handle. Leaving it in UPLOAD_AGENT would keep its snapshots and images
  // protected from the sweeps forever, so it rests in a terminal state whatever the outcome.
  await db
    .update(targetOnboarding)
    .set({ state: "UPLOAD_DONE", agentCapabilityToken: null, updatedAt: new Date() })
    .where(eq(targetOnboarding.id, row.id));

  const [done] = await db
    .select({ buildPlan: targetOnboarding.buildPlan })
    .from(targetOnboarding)
    .where(eq(targetOnboarding.id, row.id))
    .limit(1);
  let plan: BuildPlan;
  try {
    plan = parseBuildPlan(done?.buildPlan);
  } catch {
    return null;
  }
  if (plan.strategy !== "agent-authored" && plan.strategy !== "compose-mesh") return null;
  if (
    plan.runtime?.baseUrl !== String(definition.config.baseUrl) ||
    plan.runtime.readinessPath !== definition.provisioning.readinessPath
  ) {
    return null;
  }
  // Pin everything the reviewer approved, and drop what widens the sandbox. The driver reads
  // plan.runtime to boot and verify the build and plan.extraEgressHosts to open the allow-list, so the
  // agent keeps neither: only the validated clone host (added by the driver) joins the base egress.
  const provisioning = definition.provisioning;
  const { extraEgressHosts: _dropped, ...rest } = plan;
  void _dropped;
  return {
    ...rest,
    runtime: {
      name: definition.name,
      baseUrl: String(definition.config.baseUrl),
      readinessPath: provisioning.readinessPath,
      ...(provisioning.startCommand ? { startCommand: provisioning.startCommand } : {}),
      ...(provisioning.warmupSeconds !== undefined ? { warmupSeconds: provisioning.warmupSeconds } : {}),
      envPrefix: definition.envPrefix,
      scopeRules: definition.scopeRules,
    },
  };
}
