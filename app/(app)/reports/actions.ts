"use server";

import { requireReviewer } from "@/lib/auth/dal";
import { formatStamp } from "@/lib/format";
import { isReportId, readCase } from "@/lib/reports/case";

/**
 * What the report sheet shows.
 *
 * Read on open rather than sent with the list: the index is up to two hundred rows and nobody
 * opens two hundred sheets, so shipping every report's events and verdict to the browser to
 * cover the one that gets clicked is a lot of bytes for a screen that is usually closed.
 *
 * Read only. Everything that changes a report is behind the approval gate on the case file,
 * and nothing here is a permission: a sheet saying "awaiting approval" is a claim about the
 * moment it was opened.
 */
export type ReportSheetData = {
  id: string;
  title: string;
  state: string;
  sourceLabel: string;
  issueUrl: string | null;
  repositoryFullName: string | null;
  reporterHandle: string | null;
  target: string | null;
  targetDigest: string | null;
  updatedAt: string;
  createdAt: string;
  eventCount: number;
  events: { seq: number; type: string; at: string }[];
  verdict: { outcome: string; summary: string; revision: number; contentHash: string } | null;
  approval: { decision: string; reviewer: string; note: string | null; at: string } | null;
  delivery: { state: string; attempts: number; lastError: string | null } | null;
  awaiting: boolean;
};

export async function reportSheet(id: string): Promise<ReportSheetData | null> {
  // The session is checked here as well as on the page. A server action is its own entry
  // point: whatever rendered the button that calls it is not what authorises the read.
  await requireReviewer();

  // The id arrives from the browser, so it is checked here as well as on the page. A malformed
  // one compared against a uuid column is a Postgres error, which would surface as a failed
  // sheet rather than the "no longer exists" it actually means.
  if (!isReportId(id)) return null;

  const file = await readCase(id);
  if (!file) return null;

  return {
    id: file.id,
    title: file.title,
    state: file.state,
    sourceLabel: file.sourceLabel,
    issueUrl: file.issueUrl,
    repositoryFullName: file.repositoryFullName,
    reporterHandle: file.reporterHandle,
    target: file.target?.name ?? null,
    targetDigest: file.target?.imageDigest || null,
    updatedAt: formatStamp(file.updatedAt),
    createdAt: formatStamp(file.createdAt),
    eventCount: file.events.length,
    // The last five, newest last, which is the shape the case file's trace uses.
    events: file.events.slice(-5).map((event) => ({
      seq: event.seq,
      type: event.type,
      at: event.at.toISOString().slice(11, 19),
    })),
    verdict: file.verdict
      ? {
          outcome: file.verdict.outcome,
          summary: file.verdict.summary,
          revision: file.verdict.revision,
          contentHash: file.verdict.contentHash,
        }
      : null,
    approval: file.approval
      ? {
          decision: file.approval.decision,
          reviewer: file.approval.reviewer,
          note: file.approval.note,
          at: formatStamp(file.approval.decidedAt),
        }
      : null,
    delivery: file.delivery
      ? {
          state: file.delivery.state,
          attempts: file.delivery.attempts,
          lastError: file.delivery.lastError,
        }
      : null,
    awaiting: file.awaitingVerdictId !== null,
  };
}
