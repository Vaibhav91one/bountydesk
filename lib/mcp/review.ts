import { codeReviewFinding, codeReviewRun, db, eq, targetOnboarding } from "@/lib/db";

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

/**
 * A finding from the read-only code-review agent. The agent calls this tool (registered at
 * app/api/mcp/review) with its capability token and an array of structured findings. The tool
 * resolves the report through the token, then inserts each finding in one statement.
 *
 * The capability token is the only report identifier the agent sees, just as in
 * report_sandboxability and the build tools. A zero-row insert means the token is stale or
 * unknown, which is the same as an unknown capability -- the review's findings are refused, not
 * silently attributed to another report.
 */

export const MAX_SUMMARY_CHARS = 2_000;
export const MAX_FINDING_FIELDS = 50;

export type RawFinding = {
  file: string;
  line?: number | null;
  category: string;
  summary: string;
  severity: string;
  confidence: string;
};

export type CodeReviewToolResult =
  | { ok: true; message: string; inserted: number }
  | { ok: false; reason: string };

function coerceFindings(raw: unknown): RawFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: RawFinding[] = [];
  for (const item of raw) {
    if (out.length >= MAX_FINDING_FIELDS) break;
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.file !== "string" || typeof r.category !== "string" || typeof r.summary !== "string") continue;
    if (typeof r.severity !== "string" || typeof r.confidence !== "string") continue;
    let line: number | null = null;
    if (r.line !== undefined && r.line !== null) {
      const num = typeof r.line === "number" ? r.line : Number(r.line);
      line = Number.isInteger(num) && num > 0 ? num : null;
    }
    out.push({
      file: r.file.slice(0, 500),
      line,
      category: r.category.slice(0, 100),
      summary: r.summary.slice(0, MAX_SUMMARY_CHARS),
      severity: r.severity.slice(0, 50),
      confidence: r.confidence.slice(0, 50),
    });
  }
  return out;
}

export async function reportCodeReviewFindings(
  capability: string,
  findings: unknown,
): Promise<CodeReviewToolResult> {
  if (!capability) return { ok: false, reason: "unknown capability" };

  const coerced = coerceFindings(findings);
  if (coerced.length === 0) return { ok: false, reason: "findings must be a non-empty array" };

  // Resolve the report through the capability token, then insert each finding fenced to that
  // report. Splitting the lookup and the insert keeps the write a plain insert into
  // code_review_finding (which the append-only trigger guards) rather than an upsert.
  const run = await db
    .select({ reportId: codeReviewRun.reportId })
    .from(codeReviewRun)
    .where(eq(codeReviewRun.capabilityToken, capability))
    .limit(1);
  if (run.length === 0) return { ok: false, reason: "unknown capability" };

  const reportId = run[0].reportId;
  await db.insert(codeReviewFinding).values(
    coerced.map((f) => ({
      reportId,
      file: f.file,
      line: f.line,
      category: f.category,
      summary: f.summary,
      severity: f.severity,
      confidence: f.confidence,
    })),
  );

  return { ok: true, message: `recorded ${coerced.length} code review finding(s)`, inserted: coerced.length };
}
