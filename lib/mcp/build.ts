import { db, eq, targetOnboarding } from "@/lib/db";
import { requireEnv } from "@/lib/env";
import { parseBuildPlan, type Ecosystem } from "@/lib/build-onboarding/build-plan";
import { selectEgressHosts } from "@/lib/build-onboarding/egress-profiles";
import {
  createBuildSandbox,
  deleteSandbox,
  execute,
  getSandbox,
  type Sandbox,
} from "@/lib/sandbox/daytona";

/**
 * The handlers behind the onboarding agent's build tools (registered on app/api/mcp/build).
 *
 * The agent stands a repo up by iterating in one ephemeral Docker-in-Docker sandbox: open it, run
 * build commands (write a Dockerfile, docker build, run the container, curl it), then either commit
 * the Dockerfile it converged on or declare the repo unsandboxable. The tools resolve the calling
 * session by an opaque capability token, exactly as probe_target resolves an agent_session, so the
 * model never sees a repo or sandbox id and cannot reach a row that is not its own.
 *
 * These tools deliberately do NOT drive the onboarding state machine. The build-onboarding worker
 * holds the row's lease while the agent turn runs; a tool advancing the state would fight that fence.
 * Instead commit/mark record their result on `build_plan` (an agent-authored plan, or a
 * not-flattenable reason) and the worker reads it after the turn and advances. Egress stays
 * server-held: the sandbox's allow-list comes from the detected ecosystem, never from the model, and
 * the committed image is still rebuilt by the driver, offline-verified, and human-approved before it
 * can become a target.
 */

const BUILD_CPU = 2;
const BUILD_MEMORY_GB = 4;
const BUILD_DISK_GB = 10;
const BUILD_TTL_MINUTES = 30;
const EXEC_TIMEOUT_S = 300;
/** Cap the output handed back to the model, so a chatty build log cannot blow the turn's context. */
const OUTPUT_TAIL = 4_000;

export type BuildToolResult =
  | { ok: true; message: string; output?: string; exitCode?: number }
  | { ok: false; reason: string };

type OnboardingRow = typeof targetOnboarding.$inferSelect;

async function resolveOnboarding(capability: string): Promise<OnboardingRow | null> {
  if (!capability) return null;
  const [row] = await db
    .select()
    .from(targetOnboarding)
    .where(eq(targetOnboarding.agentCapabilityToken, capability))
    .limit(1);
  return row ?? null;
}

function ecosystemOf(row: OnboardingRow): Ecosystem {
  const plan = row.buildPlan as { ecosystem?: unknown } | null;
  const eco = plan?.ecosystem;
  return typeof eco === "string" ? (eco as Ecosystem) : "none";
}

/** Reconstruct the live sandbox this session is iterating in, or null if none is open. */
async function sessionSandbox(row: OnboardingRow): Promise<Sandbox | null> {
  if (!row.agentSandboxId) return null;
  try {
    return await getSandbox(row.agentSandboxId);
  } catch {
    return null;
  }
}

export async function openBuildSandbox(capability: string): Promise<BuildToolResult> {
  const row = await resolveOnboarding(capability);
  if (!row) return { ok: false, reason: "unknown capability" };

  const existing = await sessionSandbox(row);
  if (existing) {
    return { ok: true, message: "a build sandbox is already open for this session; reuse it" };
  }

  const hosts = selectEgressHosts({ ecosystem: ecosystemOf(row) });
  const sandbox = await createBuildSandbox(
    {
      snapshot: requireEnv("BUILD_BASE_SNAPSHOT"),
      cpu: BUILD_CPU,
      memoryGb: BUILD_MEMORY_GB,
      diskGb: BUILD_DISK_GB,
      ttlMinutes: BUILD_TTL_MINUTES,
      labels: { "bountydesk.purpose": "onboarding-agent", "bountydesk.repo": row.repoFullName },
    },
    hosts,
  );

  await db
    .update(targetOnboarding)
    .set({ agentSandboxId: sandbox.id, updatedAt: new Date() })
    .where(eq(targetOnboarding.id, row.id));

  // Clone the repo and start dockerd so the agent can build straight away. The clone URL is the
  // server-held repository name, never a model-supplied ref.
  const cloneUrl = `https://github.com/${row.repoFullName}.git`;
  await execute(sandbox, `sh -lc ${shArg(`git clone --depth 1 ${shArg(cloneUrl)} /work/source`)}`, EXEC_TIMEOUT_S).catch(
    () => undefined,
  );
  await execute(
    sandbox,
    `sh -lc ${shArg("dockerd >/tmp/dockerd.log 2>&1 & for i in $(seq 1 30); do docker version >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1")}`,
    EXEC_TIMEOUT_S,
  ).catch(() => undefined);
  // The DinD base image often ships without an HTTP client, so the agent cannot curl the container
  // it builds. Provide one best-effort so it does not burn iterations discovering that.
  await execute(
    sandbox,
    `sh -lc ${shArg("command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null 2>&1 || (apt-get update >/dev/null 2>&1 && apt-get install -y curl >/dev/null 2>&1) || true")}`,
    EXEC_TIMEOUT_S,
  ).catch(() => undefined);

  return {
    ok: true,
    message:
      "build sandbox open. The repo is cloned at /work/source and dockerd is running. Write a Dockerfile, build it, run the container, and curl it, all via run_build_command.",
  };
}

export async function runBuildCommand(capability: string, command: string): Promise<BuildToolResult> {
  const row = await resolveOnboarding(capability);
  if (!row) return { ok: false, reason: "unknown capability" };
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, reason: "command must be a nonempty string" };
  }
  const sandbox = await sessionSandbox(row);
  if (!sandbox) return { ok: false, reason: "no build sandbox is open; call open_build_sandbox first" };

  const result = await execute(sandbox, `sh -lc ${shArg(command)}`, EXEC_TIMEOUT_S);
  return {
    ok: true,
    message: result.exitCode === 0 ? "command succeeded" : `command exited ${result.exitCode}`,
    exitCode: result.exitCode,
    output: result.result.slice(-OUTPUT_TAIL),
  };
}

export type CommitTargetInput = {
  capability: string;
  dockerfileText: string;
  buildContext?: string;
  name: string;
  baseUrl: string;
  readinessPath: string;
  startCommand?: string;
  warmupSeconds?: number;
};

export async function commitTargetImage(input: CommitTargetInput): Promise<BuildToolResult> {
  const row = await resolveOnboarding(input.capability);
  if (!row) return { ok: false, reason: "unknown capability" };

  let plan;
  try {
    // parseBuildPlan is the untrusted-input boundary: it validates the agent's Dockerfile, runtime
    // name, loopback base URL, readiness path and (rejected) host-model start commands.
    plan = parseBuildPlan({
      strategy: "agent-authored",
      ecosystem: ecosystemOf(row),
      dockerfileText: input.dockerfileText,
      buildContext: input.buildContext ?? ".",
      seed: { kind: "none" },
      runtime: {
        name: input.name,
        baseUrl: input.baseUrl,
        readinessPath: input.readinessPath,
        ...(input.startCommand ? { startCommand: input.startCommand } : {}),
        ...(input.warmupSeconds !== undefined ? { warmupSeconds: input.warmupSeconds } : {}),
      },
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // Record the recipe; the worker reads build_plan after the turn and advances to the build step. Do
  // not change state here (the worker owns the lease).
  await db
    .update(targetOnboarding)
    .set({ buildPlan: plan, updatedAt: new Date() })
    .where(eq(targetOnboarding.id, row.id));

  return {
    ok: true,
    message:
      "recipe committed. The platform will rebuild this Dockerfile for the pinned artifact, verify it boots offline, and route it to a human reviewer.",
  };
}

export async function markUnsandboxable(capability: string, reason: string): Promise<BuildToolResult> {
  const row = await resolveOnboarding(capability);
  if (!row) return { ok: false, reason: "unknown capability" };
  const why = typeof reason === "string" && reason.trim().length > 0 ? reason.trim() : "the agent could not build a bootable single image for this repository";

  const plan = parseBuildPlan({
    strategy: "not-flattenable",
    ecosystem: ecosystemOf(row),
    reason: why.slice(0, 1_000),
  });
  await db
    .update(targetOnboarding)
    .set({ buildPlan: plan, updatedAt: new Date() })
    .where(eq(targetOnboarding.id, row.id));

  return { ok: true, message: "recorded that this repository cannot be sandboxed; its reports will go the analysis-only route" };
}

/** Best-effort teardown of a session's build sandbox, called by the worker when the agent turn ends. */
export async function teardownBuildSandbox(sandboxId: string | null): Promise<void> {
  if (!sandboxId) return;
  await deleteSandbox(sandboxId).catch(() => undefined);
}

/** Single-quote for POSIX sh so a value with metacharacters cannot break out of the command. */
function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
