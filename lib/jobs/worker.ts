import { activeRepository } from "@/lib/github/lifecycle";
import { ensureReport, recordEvent } from "@/lib/reports/lifecycle";

import {
  LeaseLostError,
  abandon,
  advance,
  claim,
  complete,
  fail,
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

async function parse(lease: Lease): Promise<Lease> {
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
    leaseSeconds = 60,
    signal,
  }: { analysis: AnalysisDriver; leaseSeconds?: number; signal?: AbortSignal },
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
    if (error instanceof LeaseLostError) return lease.id;

    const message = error instanceof Error ? error.message : String(error);

    try {
      if (error instanceof UnprocessableDelivery) {
        await abandon(lease, message);
      } else {
        await fail(lease, message);
      }
    } catch (recoveryError) {
      // The lease can change after the operation fails but before its recovery write. The
      // new owner is then responsible for the job, just as if the operation had lost its fence.
      if (!(recoveryError instanceof LeaseLostError)) throw recoveryError;
    }

    return lease.id;
  }
}
