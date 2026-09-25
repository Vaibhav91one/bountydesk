import { db, eq, report } from "@/lib/db";
import { parseThreadReferences, type InboundEmail } from "@/lib/email/inbound";
import type { OutsideEmailPayload } from "@/lib/email/outside-intake";
import { fetchInboundBody, fetchRawHeaders } from "@/lib/email/resend";
import { activeRepository } from "@/lib/github/lifecycle";
import { ensureReport, findRepliedToReport, recordEvent, recordEventLocked } from "@/lib/reports/lifecycle";
import { holdForDecision, type GateAnalysisPayload } from "@/lib/triage/gate";
import { createTrueForgeClient } from "@/lib/trueforge/client";

import {
  LeaseLostError,
  abandon,
  advance,
  claim,
  complete,
  fail,
  releaseAfterDeadline,
  releaseUnstarted,
  renew,
  type Lease,
} from "./queue";

/**
 * The worker that turns an accepted delivery into a durable report.
 *
 * Job execution runs RECEIVED -> PARSED -> SESSION_CREATED -> RUNNING -> DONE, and this
 * drives one job through as much of that as it can in a single lease. The steps are written
 * as a fall-through rather than a switch on purpose: a worker that dies mid-job leaves the
 * state where it got to, so the next lease resumes from that step instead of redoing the
 * ones that already committed.
 */
export type IssueDelivery = {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    user?: { login?: string };
  };
  repository?: { id?: number; full_name?: string };
  installation?: { id?: number };
};

/**
 * The two durable boundaries around a triage run.
 *
 * `ensureSession` returns only after the report's TrueForge session identity is persisted.
 * It must use the report ID as its provider idempotency key. `run` resumes that session and
 * obeys the abort signal when this worker loses its lease.
 */
export type AnalysisContext = {
  reportId: string;
  lease: Lease;
  signal: AbortSignal;
};

export type AnalysisDriver = {
  ensureSession: (context: AnalysisContext) => Promise<void>;
  run: (context: AnalysisContext) => Promise<void>;
};

async function runWithHeartbeat(
  operation: (context: AnalysisContext) => Promise<void>,
  reportId: string,
  lease: Lease,
  leaseSeconds: number,
  outerSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const signal = outerSignal
    ? AbortSignal.any([controller.signal, outerSignal])
    : controller.signal;
  const intervalMs = Math.max(50, Math.floor((leaseSeconds * 1000) / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal = Promise.resolve();
  let rejectLeaseLoss!: (reason: unknown) => void;
  const leaseLoss = new Promise<never>((_, reject) => {
    rejectLeaseLoss = reject;
  });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  const heartbeat = () => {
    renewal = renew(lease, leaseSeconds)
      .then(() => {
        if (!stopped) timer = setTimeout(heartbeat, intervalMs);
      })
      .catch((error: unknown) => {
        controller.abort(error);
        rejectLeaseLoss(error);
      });
  };

  timer = setTimeout(heartbeat, intervalMs);
  try {
    await Promise.race([
      operation({ reportId, lease, signal }),
      leaseLoss,
      aborted,
    ]);
  } finally {
    stopped = true;
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    await renewal.catch(() => undefined);
  }

  if (signal.aborted) throw signal.reason;
}

export class UnprocessableDelivery extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnprocessableDelivery";
  }
}

function parseDelivery(lease: Lease): {
  payload: IssueDelivery;
  issueNumber: number;
  title: string;
  body: string;
  reporterHandle: string | null;
} {
  const payload = lease.payload as IssueDelivery;

  const fullName = payload.repository?.full_name;
  const number = payload.issue?.number;

  if (!fullName || typeof number !== "number") {
    throw new UnprocessableDelivery("delivery carries no repository full name or issue number");
  }

  return {
    payload,
    issueNumber: number,
    title: payload.issue?.title ?? `${fullName}#${number}`,
    body: payload.issue?.body ?? "",
    reporterHandle: payload.issue?.user?.login ?? null,
  };
}

type EmailJobPayload = InboundEmail | OutsideEmailPayload | GateAnalysisPayload;

function isOutside(payload: unknown): payload is OutsideEmailPayload {
  return (payload as { intake?: unknown } | null)?.intake === "outside";
}

/**
 * A reviewer released a gated outside report (lib/triage/gate.ts releaseForAnalysis). The report
 * already exists, so there is nothing to parse: confirm the gate really did release it and hand
 * it to the same analysis-only run an allowlisted sender's email gets.
 */
async function parseGateRelease(lease: Lease, reportId: string): Promise<Lease> {
  const [row] = await db
    .select({ channel: report.channel, state: report.state })
    .from(report)
    .where(eq(report.id, reportId))
    .limit(1);
  if (!row || row.channel !== "email") {
    throw new UnprocessableDelivery(`gate release names no email report ${reportId}`);
  }
  if (row.state !== "TRIAGING") {
    throw new UnprocessableDelivery(`report ${reportId} is ${row.state}; the gate did not release it`);
  }
  return advance(lease, "PARSED", { reportId });
}

async function parseEmail(lease: Lease): Promise<Lease> {
  const payload = lease.payload as EmailJobPayload;
  if ("intake" in payload && payload.intake === "gate-analysis") {
    return parseGateRelease(lease, payload.reportId);
  }
  const email = payload as InboundEmail | OutsideEmailPayload;
  const outside = isOutside(email);
  const sourceRef = `email:${email.messageId}`;

  // The webhook carries no body, so pull it here rather than at intake. A fetch failure throws and
  // the job retries, which is why this runs before ensureReport: a report is created only once its
  // body is in hand, never as an empty shell. Prefer the plain-text part; fall back to HTML when a
  // sender emits HTML only.
  const fetched = email.resendEmailId ? await fetchInboundBody(email.resendEmailId) : null;
  const body = fetched?.text || fetched?.html || email.text;

  // Link a reply to the report it threads to. The parent's message id is in this reply's
  // In-Reply-To/References, which live only in the raw MIME, so read the header block from the
  // signed URL the body fetch just handed back. Best-effort: a failure here must not stop a report
  // from being created, so a fetch or parse error leaves the reply standalone. Only outside senders
  // carry a verified sender, and findRepliedToReport links only on a verified-sender match, so an
  // allowlisted reply (null sender) never links, which is fine: acks go only to outside reporters.
  let repliesToReportId: string | null = null;
  if (fetched?.rawUrl) {
    try {
      const tokens = parseThreadReferences(await fetchRawHeaders(fetched.rawUrl));
      repliesToReportId = await findRepliedToReport(
        tokens,
        outside ? email.verifiedSender : null,
      );
    } catch (error) {
      console.warn(`email parse: could not link reply ${sourceRef} to a parent: ${String(error)}`);
    }
  }

  // No connected repository and no target profile: an email report has nothing bound to reproduce
  // against, so the pipeline drafts an analysis-only verdict from the text. The verified sender is
  // kept as the reply-to for a future outbound delivery. An outside sender's report starts at
  // the NEEDS_DECISION gate instead, with the address intake verified by SPF and DKIM.
  const reportId = await ensureReport({
    channel: lease.channel,
    sourceRef,
    title: email.subject,
    body,
    reporterHandle: email.fromName,
    reporterContact: email.fromEmail,
    repliesToReportId,
    ...(outside ? { state: "NEEDS_DECISION" as const, verifiedSender: email.verifiedSender } : {}),
    connectedRepositoryId: null,
    targetProfileId: null,
  });

  // Under the report lock: once an outside report exists, a reviewer can act on it at the gate.
  await recordEventLocked(
    reportId,
    "intake.accepted",
    { deliveryId: lease.deliveryId, jobId: lease.id, sourceRef },
    `${lease.id}:intake.accepted`,
  );

  return advance(lease, "PARSED", { reportId });
}

async function parse(lease: Lease): Promise<Lease> {
  if (lease.channel === "email") return parseEmail(lease);

  const { payload, issueNumber, title, body, reporterHandle } = parseDelivery(lease);

  // Access is checked again here, not just at intake. A suspension or a repository removal
  // can land between the 202 and this run, and the target profile is read from the same
  // place either way: the server, never the payload.
  const repository = await activeRepository(payload.installation?.id, payload.repository?.id);
  if (!repository) {
    throw new UnprocessableDelivery(
      `repository ${payload.repository?.full_name ?? "?"} is no longer connected`,
    );
  }

  const sourceRef = `github:${repository.repoId}:issue:${issueNumber}`;

  const reportId = await ensureReport({
    channel: lease.channel,
    sourceRef,
    title,
    body,
    reporterHandle,
    connectedRepositoryId: repository.connectedRepositoryId,
    targetProfileId: repository.targetProfileId,
  });

  await recordEvent(
    reportId,
    "intake.accepted",
    {
      deliveryId: lease.deliveryId,
      jobId: lease.id,
      sourceRef,
    },
    { idempotencyKey: `${lease.id}:intake.accepted` },
  );

  return advance(lease, "PARSED", { reportId });
}

function defaultHold({ reportId, signal }: AnalysisContext): Promise<void> {
  return holdForDecision(reportId, signal, { client: createTrueForgeClient() });
}

/**
 * Drive one job as far as its lease allows. Returns the job id, or null when the queue had
 * nothing claimable.
 *
 * A delivery we can never process is buried rather than retried: five attempts at a
 * repository that is no longer connected produce the same answer five times.
 */
export async function runOnce(
  owner: string,
  {
    analysis,
    hold = defaultHold,
    leaseSeconds = 60,
    signal,
  }: {
    analysis: AnalysisDriver;
    /** The gate step for an outside email report; injectable so tests need no TrueForge. */
    hold?: (context: AnalysisContext) => Promise<void>;
    leaseSeconds?: number;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  if (signal?.aborted) return null;
  const claimed = await claim(owner, leaseSeconds);
  if (!claimed) return null;

  if (signal?.aborted) {
    try {
      await releaseUnstarted(claimed);
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
    }
    return null;
  }

  let lease = claimed;

  try {
    if (lease.state === "RECEIVED") lease = await parse(lease);
    signal?.throwIfAborted();
    // An outside sender's report stops here. The analysis driver never sees it: no session, no
    // sandbox, no clone. The job finishes once the acknowledgement and triage are recorded, and
    // only a reviewer's "Run analysis" queues the job that takes the branch below.
    if (lease.state === "PARSED" && lease.channel === "email" && isOutside(lease.payload)) {
      if (!lease.reportId) {
        throw new UnprocessableDelivery("job reached PARSED with no report attached");
      }
      await runWithHeartbeat(hold, lease.reportId, lease, leaseSeconds, signal);
      await complete(lease);
      return lease.id;
    }
    if (lease.state === "PARSED") {
      if (!lease.reportId) {
        throw new UnprocessableDelivery("job reached PARSED with no report attached");
      }
      await runWithHeartbeat(
        analysis.ensureSession,
        lease.reportId,
        lease,
        leaseSeconds,
        signal,
      );
      lease = await advance(lease, "SESSION_CREATED");
    }
    if (lease.state === "SESSION_CREATED") lease = await advance(lease, "RUNNING");

    signal?.throwIfAborted();
    if (lease.state === "RUNNING") {
      if (!lease.reportId) {
        throw new UnprocessableDelivery("job reached RUNNING with no report attached");
      }

      await runWithHeartbeat(analysis.run, lease.reportId, lease, leaseSeconds, signal);
      await complete(lease);
    }

    return lease.id;
  } catch (error) {
    // A lost lease means another worker owns this job now. Writing anything about it would
    // be writing over that worker, which is the exact thing the fence exists to prevent.
    if (error instanceof LeaseLostError) {
      if (signal?.aborted) throw signal.reason;
      return lease.id;
    }

    const message = error instanceof Error ? error.message : String(error);

    try {
      if (error instanceof UnprocessableDelivery) {
        await abandon(lease, message);
      } else if (signal?.aborted) {
        await releaseAfterDeadline(lease, message);
      } else {
        await fail(lease, message);
      }
    } catch (recoveryError) {
      // The lease can change after the operation fails but before its recovery write. The
      // new owner is then responsible for the job, just as if the operation had lost its fence.
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }

    // The deadline-specific release above leaves the job retryable. The route still needs the
    // error itself so it can return 503 instead of claiming that the tick completed.
    if (signal?.aborted) throw signal.reason;

    return lease.id;
  }
}
