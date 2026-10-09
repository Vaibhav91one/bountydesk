import { buildFindingsEvidence, buildTranscript } from "@/lib/artifacts/record";
import { and, approvalDecision, db, desc, eq, report, verdict } from "@/lib/db";
import { verdictFindings } from "@/lib/reports/case-facts";

export type ReportExport =
  | { ok: true; filename: string; markdown: string }
  | { ok: false; reason: "not_found" };

/**
 * One shareable Markdown document for a report's current approved verdict: the finding, the
 * verdict text as delivered, and the investigation transcript.
 *
 * Built straight from the same functions lib/artifacts/record.ts uses to produce the three
 * separate per-revision artifact files (buildTranscript, buildFindingsEvidence), not a second
 * copy of that logic, and not read back from Storage, so there is nothing to keep in sync and
 * no dependency on Storage being configured: every input here is a durable row. Scoped to the
 * newest revision with an APPROVED decision, which is also the only text that was ever sent to
 * anyone, so a report with no approved verdict yet has nothing to export.
 */
export async function renderReportExport(reportId: string): Promise<ReportExport> {
  const [row] = await db
    .select({
      verdictId: verdict.id,
      title: report.title,
      outcome: verdict.outcome,
      summary: verdict.summary,
      payload: verdict.payload,
      contentHash: verdict.contentHash,
      revision: verdict.revision,
      evidence: verdict.evidence,
      reviewer: approvalDecision.reviewer,
      decidedAt: approvalDecision.decidedAt,
    })
    .from(verdict)
    .innerJoin(
      approvalDecision,
      and(eq(approvalDecision.verdictId, verdict.id), eq(approvalDecision.decision, "APPROVED")),
    )
    .innerJoin(report, eq(report.id, verdict.reportId))
    .where(eq(verdict.reportId, reportId))
    .orderBy(desc(verdict.revision))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };

  const transcript = await buildTranscript(reportId, row.verdictId);
  const findings = verdictFindings(row.evidence);
  const findingsDoc = findings.length
    ? buildFindingsEvidence(reportId, row.verdictId, findings)
    : null;

  const header = [
    `# ${row.title}`,
    "",
    `- Report: \`${reportId}\``,
    `- Outcome: ${row.outcome}, revision ${row.revision}`,
    `- Approved by ${row.reviewer} on ${row.decidedAt.toISOString()}`,
    `- Content hash: \`${row.contentHash}\``,
  ].join("\n");

  const markdown = [header, row.payload, findingsDoc, transcript]
    .filter((section): section is string => section !== null)
    .join("\n\n---\n\n");

  return {
    ok: true,
    filename: `bountydesk-${reportId.slice(0, 8)}-r${row.revision}.md`,
    markdown,
  };
}
