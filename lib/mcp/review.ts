import { db, eq, targetOnboarding } from "@/lib/db";

/**
 * The single tool behind the sandboxability review agent (app/api/mcp/review).
 *
 * The read-only review turn reads a handful of repo files (embedded in its prompt by the driver in
 * lib/analysis/sandboxability.ts) and reports whether the repository can be built into one bootable
 * offline image. It never builds, clones, or opens a sandbox; it only records a routing hint the
 * onboarding worker reads to decide whether to skip the build turn.
 *
 * It resolves the calling review by the same opaque capability-token indirection the build tools use
 * (lib/mcp/build.ts), so the model never sees a repo or row id. The verdict is best-effort, not a
 * trust boundary: a wrong "no" only sends a repo to analysis-only and a wrong "yes"/"unsure" only
 * spends a build turn. Neither can produce a false REPRODUCED, because the build, offline-verify and
 * human-approval gates are untouched.
 */

export type ReviewVerdict = "yes" | "no" | "unsure";
export type ReviewResult = { verdict: ReviewVerdict; reason: string };

export type ReviewToolResult = { ok: true; message: string } | { ok: false; reason: string };

const MAX_REASON = 1_000;

function isVerdict(value: string): value is ReviewVerdict {
  return value === "yes" || value === "no" || value === "unsure";
}

export async function reportSandboxability(
  capability: string,
  verdict: string,
  reason: string,
): Promise<ReviewToolResult> {
  if (!capability) return { ok: false, reason: "unknown capability" };
  if (!isVerdict(verdict)) {
    return { ok: false, reason: 'verdict must be "yes", "no" or "unsure"' };
  }
  const why =
    typeof reason === "string" && reason.trim().length > 0
      ? reason.trim().slice(0, MAX_REASON)
      : "no reason given";

  // Write fenced on the capability token in one statement, not a resolve-then-update: a replacement
  // review may have installed its own token in between, and this stale turn must not overwrite it. A
  // zero-row update means the token is no longer ours, which is the same as an unknown capability.
  const result: ReviewResult = { verdict, reason: why };
  const updated = await db
    .update(targetOnboarding)
    .set({ reviewResult: result, updatedAt: new Date() })
    .where(eq(targetOnboarding.agentCapabilityToken, capability))
    .returning({ id: targetOnboarding.id });
  if (updated.length === 0) return { ok: false, reason: "unknown capability" };

  return { ok: true, message: `recorded sandboxability verdict "${verdict}"` };
}
