import type { TargetDefinition } from "@/lib/targets/registry";
import { parseTargetManifest } from "@/lib/targets/manifest";
import type { TrueForgeClient } from "@/lib/trueforge/client";

/**
 * Run the target-onboarding agent and capture the manifest it proposes.
 *
 * Mirrors lib/analysis/trueforge-driver.ts's session-then-turn-then-poll shape, but far simpler:
 * no report, no capability token, no gated tool. The onboarding agent (agent/target-onboarding.
 * agent.json, registered by scripts/apply-agent.ts) inspects the built source and emits a target
 * manifest as its closing message; this drives one turn and reads that message back.
 *
 * The agent's output is not trusted prose: it is passed through parseTargetManifest, the same
 * validator the operator scripts use, which enforces the name, ghcr image, loopback base URL,
 * readiness path and localhost scope. A message that does not parse is a failure the caller
 * retries, not something stored.
 */
export const ONBOARDING_AGENT_NAME = "bountydesk-target-onboarding";

/** How long a proposal turn may run before it is treated as a failed attempt. */
const TURN_DEADLINE_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

export type ProposeManifestInput = {
  repoFullName: string;
  sourceRef: string;
  imageName: string;
  buildMarker: string;
  dockerfileText: string;
};

export class ManifestProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestProposalError";
  }
}

function prompt(input: ProposeManifestInput): string {
  // Everything the agent needs to name the target and describe how to start it, from what the
  // build already established. The agent may open its own sandbox to inspect further; the
  // contract is that its final message is the manifest JSON, nothing else.
  return [
    "Propose the target manifest for this built application. Reply with the manifest JSON only.",
    "",
    `Repository: ${input.repoFullName}`,
    `Source ref: ${input.sourceRef}`,
    `Built image name (untagged): ${input.imageName}`,
    `Build marker (commit): ${input.buildMarker}`,
    "",
    "Dockerfile the image was built from:",
    "```",
    input.dockerfileText,
    "```",
  ].join("\n");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Drive one onboarding turn and return the validated target manifest. Deletes the session on the
 * way out, success or failure, so a proposal never leaves a TrueForge session open behind it.
 */
export async function proposeManifest(
  client: TrueForgeClient,
  input: ProposeManifestInput,
  opts: { signal?: AbortSignal } = {},
): Promise<TargetDefinition> {
  const { sessionId } = await client.createSession({
    signal: opts.signal,
    agentName: ONBOARDING_AGENT_NAME,
  });

  try {
    const { turnId } = await client.createTurn(
      sessionId,
      [{ type: "user.message", content: prompt(input) }],
      { signal: opts.signal },
    );

    const deadline = Date.now() + TURN_DEADLINE_MS;
    for (;;) {
      const snapshot = await client.getTurn(sessionId, turnId, { signal: opts.signal });
      if (snapshot.status === "done_no_action") break;
      if (snapshot.status === "error") {
        throw new ManifestProposalError(`onboarding turn errored: ${snapshot.message}`);
      }
      if (snapshot.status === "cancelled") {
        throw new ManifestProposalError("onboarding turn was cancelled");
      }
      if (snapshot.status === "awaiting_approval") {
        // The onboarding agent has no gated tool; a pending approval means it is wired wrong.
        throw new ManifestProposalError("onboarding turn reached an unexpected approval gate");
      }
      if (Date.now() > deadline) {
        throw new ManifestProposalError("onboarding turn did not finish before its deadline");
      }
      await sleep(POLL_INTERVAL_MS, opts.signal);
    }

    const message = await client.getFinalSummary?.(sessionId, turnId, { signal: opts.signal });
    if (!message) {
      throw new ManifestProposalError("onboarding turn finished without a manifest message");
    }

    // Throws on any invalid field; the worker turns that into a retryable failure rather than
    // storing an unvalidated manifest.
    return parseTargetManifest(extractManifestJson(message));
  } finally {
    await client.deleteSession(sessionId).catch(() => undefined);
  }
}

/**
 * Pull the manifest object out of the agent's message. The agent is asked for JSON only, but a
 * model often wraps it in a ```json fence or a sentence; take the outermost brace span so a
 * stray "Here is the manifest:" does not fail an otherwise valid proposal. parseTargetManifest
 * still rejects anything that is not a well-formed manifest.
 */
function extractManifestJson(message: string): string {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return message;
  return message.slice(start, end + 1);
}
