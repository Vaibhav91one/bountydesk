import { randomUUID } from "node:crypto";

import { db, eq, targetOnboarding } from "@/lib/db";
import type { TrueForgeClient } from "@/lib/trueforge/client";
import { teardownBuildSandbox } from "@/lib/mcp/build";

/**
 * Run the onboarding agent so it stands a repository up as one bootable target image.
 *
 * The agent works through its build tools (app/api/mcp/build): it opens a Docker-in-Docker sandbox,
 * iterates a Dockerfile until the app boots with its data present, then calls commit_target_image or
 * mark_unsandboxable. Those tools write the result onto the onboarding row's `build_plan` (an
 * agent-authored plan, or a not-flattenable reason); this driver just runs the turn to completion and
 * cleans up. The worker reads `build_plan` afterward and advances the state machine, so this function
 * never touches the state itself.
 *
 * The agent resolves its own onboarding row through an opaque capability token this driver mints and
 * stores on the row before the turn (the onboarding analogue of agent_session.capability_token). The
 * token is cleared and the build sandbox torn down on the way out, success or failure.
 */
export const ONBOARDING_AGENT_NAME = "bountydesk-target-onboarding";

/** How long an onboarding turn may run before it is treated as a failed attempt. The agent may run
 *  several multi-minute docker builds; this sits under the build-onboarding stall budget, and the
 *  worker renews the row's lease around it. */
const TURN_DEADLINE_MS = 25 * 60_000;
const POLL_INTERVAL_MS = 3_000;

export class OnboardingAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingAgentError";
  }
}

function buildOnboardingTurnMessage(repoFullName: string, capability: string): string {
  return [
    `Onboard the repository ${repoFullName} as a BountyDesk reproduction target.`,
    "",
    "Use your build tools. Pass this capability token as the `capability` argument to every build",
    `tool call, and to nothing else: ${capability}`,
    "",
    "Open the build sandbox, iterate a Dockerfile until the app boots offline and a data-backed",
    "request returns real content, then call commit_target_image. If the repository cannot be built",
    "into one bootable offline image, call mark_unsandboxable with a specific reason. Do not reply",
    "with prose instead of a tool call; the outcome is the tool call you make.",
  ].join("\n");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export type RunOnboardingAgentInput = { onboardingId: string; repoFullName: string };

export async function runOnboardingAgent(
  client: TrueForgeClient,
  input: RunOnboardingAgentInput,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const capability = randomUUID();
  await db
    .update(targetOnboarding)
    .set({ agentCapabilityToken: capability, updatedAt: new Date() })
    .where(eq(targetOnboarding.id, input.onboardingId));

  const { sessionId } = await client.createSession({ signal: opts.signal, agentName: ONBOARDING_AGENT_NAME });

  try {
    const { turnId } = await client.createTurn(
      sessionId,
      [{ type: "user.message", content: buildOnboardingTurnMessage(input.repoFullName, capability) }],
      { signal: opts.signal },
    );

    const deadline = Date.now() + TURN_DEADLINE_MS;
    for (;;) {
      const snapshot = await client.getTurn(sessionId, turnId, { signal: opts.signal });
      if (snapshot.status === "done_no_action") break;
      if (snapshot.status === "error") throw new OnboardingAgentError(`onboarding turn errored: ${snapshot.message}`);
      if (snapshot.status === "cancelled") throw new OnboardingAgentError("onboarding turn was cancelled");
      if (snapshot.status === "awaiting_approval") {
        // The build tools are ungated; a pending approval means the agent is wired wrong.
        throw new OnboardingAgentError("onboarding turn reached an unexpected approval gate");
      }
      if (Date.now() > deadline) throw new OnboardingAgentError("onboarding turn did not finish before its deadline");
      await sleep(POLL_INTERVAL_MS, opts.signal);
    }
  } finally {
    await client.deleteSession(sessionId).catch(() => undefined);
    // Tear down the agent's exploratory build sandbox and clear its session handles, whatever the
    // outcome. The committed recipe (build_plan) is what the worker acts on, not the sandbox.
    const [row] = await db
      .select({ sandboxId: targetOnboarding.agentSandboxId })
      .from(targetOnboarding)
      .where(eq(targetOnboarding.id, input.onboardingId))
      .limit(1);
    await teardownBuildSandbox(row?.sandboxId ?? null);
    await db
      .update(targetOnboarding)
      .set({ agentCapabilityToken: null, agentSandboxId: null, updatedAt: new Date() })
      .where(eq(targetOnboarding.id, input.onboardingId));
  }
}
