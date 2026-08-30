import { createHash } from "node:crypto";

import { artifact, db, eq, sessionEvent, verdict } from "@/lib/db";
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
 *
 * Best-effort by design: a Storage outage or a failed insert is logged and swallowed, never
 * thrown, because an artifact is a record of a run and a successful, human-approvable verdict
 * must not be turned into an error by a bookkeeping failure. When Storage is not configured the
 * rows are still written with a null storage_path, so the case file shows the artifact as
 * produced-but-not-stored rather than dropping it.
 */

const CONTENT_TYPE = "text/markdown";

type ArtifactKind = "investigation-transcript" | "verdict-payload";

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

  const lines = [
    "# Investigation transcript",
    "",
    `Report: ${reportId}`,
    `Verdict: ${verdictId}`,
    `Generated: ${new Date().toISOString()}`,
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
      .select({ payload: verdict.payload })
      .from(verdict)
      .where(eq(verdict.id, verdictId))
      .limit(1);
    if (!verdictRow) return;

    const transcript = await buildTranscript(reportId, verdictId);
    await recordOne(reportId, verdictId, "investigation-transcript", transcript);
    await recordOne(reportId, verdictId, "verdict-payload", verdictRow.payload);
  } catch (error) {
    console.error(
      `artifact recording for verdict ${verdictId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
