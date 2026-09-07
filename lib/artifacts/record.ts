import { createHash } from "node:crypto";

import { artifact, db, eq, report, sessionEvent, targetProfile, verdict } from "@/lib/db";
import type { Finding } from "@/lib/mcp/verdict-draft";
import { verdictFindings } from "@/lib/reports/case-facts";
import { uploadArtifact } from "@/lib/storage/artifacts";

/**
 * Produce the two files a drafted verdict leaves behind, upload them if Storage is configured,
 * and record an artifact row for each. Called once per verdict draft, after the verdict has
 * committed (see lib/mcp/publish-verdict.ts).
 *
 * The two artifacts:
 *   - investigation-transcript: this session's mirrored tool-call events, serialized. Built
 *     only from the argument previews the poller already stored, which are the allowlisted safe
 *     subset (see lib/agent-sessions/poller.ts's ARGUMENT_PREVIEW_ALLOWLIST), so the transcript
 *     carries no raw secret, grant token or capability token.
 *   - verdict-payload: the exact outbound comment body, which the reviewer approves and GitHub
 *     receives.
 *   - findings-evidence: each finding the agent drafted, with the description and the reference
 *     it cited for it. Written only when a run produced findings. This is what the case file
 *     offers instead of printing a sandbox path on screen: the path names a file inside the
 *     harness that a reviewer cannot open, while this is a file they can.
 *
 * Best-effort by design: a Storage outage or a failed insert is logged and swallowed, never
 * thrown, because an artifact is a record of a run and a successful, human-approvable verdict
 * must not be turned into an error by a bookkeeping failure. When Storage is not configured the
 * rows are still written with a null storage_path, so the case file shows the artifact as
 * produced-but-not-stored rather than dropping it.
 */

const CONTENT_TYPE = "text/markdown";

type ArtifactKind =
  | "investigation-transcript"
  | "verdict-payload"
  | "findings-evidence"
  | "target-dockerfile";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Serialize this report's mirrored tool-call events into a readable transcript. Exported for
 * the test that checks it carries only the poller's already-sanitised fields. */
export async function buildTranscript(reportId: string, verdictId: string): Promise<string> {
  const rows = await db
    .select({ type: sessionEvent.type, data: sessionEvent.data, at: sessionEvent.createdAt })
    .from(sessionEvent)
    .where(eq(sessionEvent.reportId, reportId))
    .orderBy(sessionEvent.seq);

  const toolCalls = rows.filter((row) => row.type.startsWith("agent.tool_call:"));

  // Deterministic on purpose: no wall-clock generation stamp. The tool calls carry their own
  // timestamps, and the events are stable once the turn is done, so rebuilding the transcript on
  // a retried draft produces byte-identical output. That is what keeps the uploaded bytes (which
  // x-upsert would replace) matching the sha256 the append-only artifact row already recorded.
  const lines = [
    "# Investigation transcript",
    "",
    `Report: ${reportId}`,
    `Verdict: ${verdictId}`,
    "",
    "## Tool calls",
    "",
  ];

  if (toolCalls.length === 0) {
    lines.push("No tool calls were recorded for this investigation.");
  } else {
    toolCalls.forEach((row, index) => {
      const data = (row.data ?? {}) as { toolName?: unknown; argumentsPreview?: unknown };
      const toolName = typeof data.toolName === "string" ? data.toolName : row.type.slice("agent.tool_call:".length);
      const preview = typeof data.argumentsPreview === "string" ? ` ${data.argumentsPreview}` : "";
      lines.push(`${index + 1}. [${row.at.toISOString().slice(11, 19)}] ${toolName}${preview}`);
    });
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * The findings as a file, in the order the agent drafted them.
 *
 * Built from the stored draft: the same allowlisted fields the case file renders, plus each
 * finding's evidence reference, which the screen omits (it names a path inside the harness
 * sandbox) and this file keeps, because the reference is the citation a reviewer downloads the
 * file to get. Deliberately not built from the live tool-call detail: those arguments and
 * results hold capability tokens, grant tokens and canary values, and lib/reports/tool-calls.ts
 * keeps them out of every durable table on purpose.
 */
export function buildFindingsEvidence(
  reportId: string,
  verdictId: string,
  findings: Finding[],
): string {
  const lines = [
    "# Findings",
    "",
    `Report: ${reportId}`,
    `Verdict: ${verdictId}`,
    "",
  ];

  findings.forEach((finding, index) => {
    lines.push(
      `## ${index + 1}. ${finding.title}`,
      "",
      `Severity: ${finding.severity}`,
      "",
      finding.description,
      "",
      `Evidence reference: ${finding.evidenceRef}`,
      "",
    );
  });

  return lines.join("\n");
}

async function recordOne(
  reportId: string,
  verdictId: string,
  kind: ArtifactKind,
  text: string,
): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  const digest = sha256(bytes);
  const path = `${reportId}/${verdictId}/${kind}.md`;

  // Upload first; the row records whether it landed. A null storage_path is the honest record
  // of "produced, not stored" when Storage is off or the upload failed.
  const storagePath = await uploadArtifact(path, bytes, CONTENT_TYPE);

  await db
    .insert(artifact)
    .values({
      reportId,
      verdictId,
      kind,
      storagePath,
      sha256: digest,
      bytes: bytes.byteLength,
      contentType: CONTENT_TYPE,
    })
    // A retried verdict draft reuses the same (verdict_id, kind); the first write wins and the
    // retry is a no-op, matching how ensureInitialVerdict treats the verdict itself.
    .onConflictDoNothing({ target: [artifact.verdictId, artifact.kind] });
}

export async function recordVerdictArtifacts(reportId: string, verdictId: string): Promise<void> {
  try {
    const [verdictRow] = await db
      .select({ payload: verdict.payload, evidence: verdict.evidence })
      .from(verdict)
      .where(eq(verdict.id, verdictId))
      .limit(1);
    if (!verdictRow) return;

    const transcript = await buildTranscript(reportId, verdictId);
    await recordOne(reportId, verdictId, "investigation-transcript", transcript);
    await recordOne(reportId, verdictId, "verdict-payload", verdictRow.payload);

    // Only when there is something to write. A verdict with no findings would otherwise leave an
    // empty file the case file has to offer and a reviewer has to open to learn nothing.
    const findings = verdictFindings(verdictRow.evidence);
    if (findings.length > 0) {
      await recordOne(
        reportId,
        verdictId,
        "findings-evidence",
        buildFindingsEvidence(reportId, verdictId, findings),
      );
    }

    // The Dockerfile the target was built from, when the target came through onboarding. A
    // target has no report of its own, so the durable file is attached to each report drafted
    // against it, keyed by this verdict. Null for the hand-built demo target, which never went
    // through the pipeline and has no stored Dockerfile.
    const [targetRow] = await db
      .select({ dockerfileText: targetProfile.dockerfileText })
      .from(report)
      .innerJoin(targetProfile, eq(report.targetProfileId, targetProfile.id))
      .where(eq(report.id, reportId))
      .limit(1);
    if (targetRow?.dockerfileText) {
      await recordOne(reportId, verdictId, "target-dockerfile", targetRow.dockerfileText);
    }
  } catch (error) {
    console.error(
      `artifact recording for verdict ${verdictId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
