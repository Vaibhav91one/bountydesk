import { redactReviewerText } from "@/lib/reviewer-chat/context";
import { desc, eq, gte } from "drizzle-orm";

import { connectedRepository, inboundJob, report } from "@/lib/db/schema";
import type { Executor } from "@/lib/db";
import { ageLabelFor } from "@/lib/reports/queue-view";

/**
 * Payload-free intake watch: the recent inbound_job rows a reviewer needs to tell
 * "nothing arrived" apart from "something arrived and got stuck".
 *
 * The query below never selects `payload`, and the label is derived from the linked
 * report's source ref and repository name only. Raw webhook JSON carries issue titles
 * and bodies, so it stays out of every select on this path.
 */
export type IntakeJobState = (typeof inboundJob.state.enumValues)[number];
export type IntakeChannel = (typeof inboundJob.channel.enumValues)[number];

export type IntakeJobView = {
  id: string;
  channel: IntakeChannel;
  state: IntakeJobState;
  deliveryPrefix: string;
  reportId: string | null;
  attempts: number;
  maxAttempts: number;
  receivedAt: string;
  updatedAt: string;
  /** Cut on the server, so client and server render the same minute. */
  ageLabel: string;
  /** Short repo and issue pointer, or null when no report is linked yet. */
  label: string | null;
  /** The exact intake ref, used to group jobs by issue. Null before a report is linked. */
  sourceRef: string | null;
  /** Set once the failure is no longer worth showing (issue closed, or a later job succeeded). */
  dismissedAt: string | null;
  /** Bounded worker error, set only for DEAD_LETTER. */
  reason: string | null;
};

/** One joined row as the reader hands it to the mapper. Never carries a payload. */
export type IntakeJobRow = {
  id: string;
  channel: IntakeChannel;
  state: IntakeJobState;
  deliveryId: string;
  reportId: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  dismissedAt: Date | null;
  sourceRef: string | null;
  repoFullName: string | null;
};

/** How far back the strip looks, how many rows it takes, and what fits on one line. */
export const INTAKE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const INTAKE_LIMIT = 20;
export const INTAKE_STALE_MS = 5 * 60 * 1000;
const REASON_MAX = 120;
const DELIVERY_PREFIX_LEN = 8;

/** "github:123456:issue:482" is what intake writes for a GitHub issue. */
const GITHUB_ISSUE_REF = /^github:\d+:issue:(\d+)$/;

/**
 * A short pointer built without touching payloads: the repo short name plus the issue
 * number when a report is linked, the bare issue number when the repo row is gone, and
 * null when there is nothing safe to derive it from. A job with no report yet, which is
 * the normal state of a freshly received delivery, has no label.
 */
export function intakeLabelFor(
  sourceRef: string | null,
  repoFullName: string | null,
): string | null {
  const issue = sourceRef ? GITHUB_ISSUE_REF.exec(sourceRef) : null;
  if (!issue) return null;
  const repo = repoFullName?.split("/").pop();
  if (!repo) return `#${issue[1]}`;
  return `${repo} #${issue[1]}`;
}

/**
 * Cut a worker error down to the part that is safe to show. Upstream failures can append
 * a response body after a Body marker or as inline JSON, and that tail can repeat webhook
 * content, so the strip only keeps what comes before it.
 */
function cleanWorkerError(value: string): string | null {
  let head = value;
  const bodyLine = head.search(/^\s*Body:/im);
  if (bodyLine !== -1) head = head.slice(0, bodyLine);
  const brace = head.indexOf("{");
  if (brace !== -1) head = head.slice(0, brace);
  head = (head.split(/\r?\n/)[0] ?? "").trim();
  const midBody = head.search(/\bBody:/i);
  if (midBody !== -1) head = head.slice(0, midBody);
  head = head.replace(/\s+/g, " ").trim();
  if (!head) return null;
  return head;
}

/**
 * The worker's own error, trimmed and bounded, and only for dead-lettered jobs. Other
 * states carry no reason because there is nothing wrong to explain yet.
 */
export function deadLetterReasonFor(
  state: IntakeJobState,
  lastError: string | null,
): string | null {
  if (state !== "DEAD_LETTER") return null;
  // The worker's error can echo upstream text, so secrets are stripped before it reaches a browser.
  const redacted = lastError ? redactReviewerText(lastError).trim() : "";
  if (!redacted) return null;
  const cleaned = cleanWorkerError(redacted);
  if (!cleaned) return null;
  const status = cleaned.match(/Status code:\s*(\d{3})/i);
  if (status) return `The investigation service returned an error (${status[1]})`;
  return cleaned.length > REASON_MAX ? cleaned.slice(0, REASON_MAX) : cleaned;
}

/** One joined row into the wire shape. Pure, so it is testable without a database. */
export function mapIntakeRow(row: IntakeJobRow, nowMs: number = Date.now()): IntakeJobView {
  return {
    id: row.id,
    channel: row.channel,
    state: row.state,
    deliveryPrefix: row.deliveryId.slice(0, DELIVERY_PREFIX_LEN),
    reportId: row.reportId,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    receivedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ageLabel: ageLabelFor(row.createdAt, nowMs),
    label: intakeLabelFor(row.sourceRef, row.repoFullName),
    sourceRef: row.sourceRef,
    dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
    reason: deadLetterReasonFor(row.state, row.lastError),
  };
}

/**
 * Whether a job earns a line in the strip. Finished jobs already have their report on
 * the board, so they stay out. A fresh RECEIVED or PARSED row is normal queueing, not
 * news; one that old with no worker claim behind it is the stuck case this strip is for.
 * Anything running and anything dead-lettered always shows.
 */
export function shouldShowIntakeJob(
  job: Pick<IntakeJobView, "state" | "receivedAt" | "dismissedAt">,
  nowMs: number = Date.now(),
): boolean {
  if (job.dismissedAt) return false;
  if (job.state === "DONE") return false;
  if (job.state === "DEAD_LETTER") return true;
  if (job.state === "SESSION_CREATED" || job.state === "RUNNING") return true;
  return nowMs - new Date(job.receivedAt).getTime() > INTAKE_STALE_MS;
}

export function visibleIntakeJobs(
  jobs: IntakeJobView[],
  nowMs: number = Date.now(),
): IntakeJobView[] {
  // A DONE job for an issue is fresh proof that intake works for it, so an older dead-lettered
  // job for the same issue is stale news and drops out. Rows arrive newest-first, so a DONE seen
  // here is always newer than a DEAD_LETTER met later in the walk.
  const succeeded = new Set<string>();
  const visible: IntakeJobView[] = [];
  for (const job of jobs) {
    if (job.state === "DONE") {
      if (job.sourceRef) succeeded.add(job.sourceRef);
      continue;
    }
    if (job.state === "DEAD_LETTER" && job.sourceRef && succeeded.has(job.sourceRef)) continue;
    if (shouldShowIntakeJob(job, nowMs)) visible.push(job);
  }
  return visible;
}

/**
 * Recent inbound_job rows, newest first, mapped to the payload-free shape.
 *
 * Takes an optional transaction so a caller can reuse one; otherwise it borrows the
 * shared pool. The pool is imported lazily so that unit tests can import the pure
 * mapping above without needing DATABASE_URL set.
 */
export async function readRecentIntakeJobs(
  now: Date = new Date(),
  tx?: Executor,
): Promise<IntakeJobView[]> {
  const runner: Executor = tx ?? (await import("@/lib/db")).db;
  const rows = await runner
    .select({
      id: inboundJob.id,
      channel: inboundJob.channel,
      state: inboundJob.state,
      deliveryId: inboundJob.deliveryId,
      reportId: inboundJob.reportId,
      attempts: inboundJob.attempts,
      maxAttempts: inboundJob.maxAttempts,
      lastError: inboundJob.lastError,
      createdAt: inboundJob.createdAt,
      updatedAt: inboundJob.updatedAt,
      dismissedAt: inboundJob.dismissedAt,
      sourceRef: report.sourceRef,
      repoFullName: connectedRepository.fullName,
    })
    .from(inboundJob)
    .leftJoin(report, eq(report.id, inboundJob.reportId))
    .leftJoin(connectedRepository, eq(connectedRepository.id, report.connectedRepositoryId))
    .where(gte(inboundJob.createdAt, new Date(now.getTime() - INTAKE_WINDOW_MS)))
    .orderBy(desc(inboundJob.createdAt))
    .limit(INTAKE_LIMIT);
  return rows.map((row) => mapIntakeRow(row, now.getTime()));
}
