import { activeRepository } from "@/lib/github/lifecycle";
import { ensureReport, recordEvent } from "@/lib/reports/lifecycle";

import { LeaseLostError, abandon, advance, claim, complete, fail, type Lease } from "./queue";

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
 * What the triage run does once the report exists.
 *
 * A seam, not an abstraction for its own sake: the real implementation is a TrueForge
 * session, and this is where it plugs in. The default does nothing but say it ran, which is
 * what makes the loop testable before either exists.
 */
export type Analyze = (context: { reportId: string; lease: Lease }) => Promise<void>;

export const noopAnalyze: Analyze = async ({ reportId }) => {
  await recordEvent(reportId, "triage.skipped", {
    reason: "no analysis is wired up yet",
  });
};

export class UnprocessableDelivery extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnprocessableDelivery";
  }
}

/** Turn the webhook payload into the fields a report is made of. */
function parseDelivery(lease: Lease): {
  payload: IssueDelivery;
  sourceRef: string;
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
    // The stable pointer back to the origin, and the report's idempotency key.
    sourceRef: `${fullName}#${number}`,
    title: payload.issue?.title ?? `${fullName}#${number}`,
    body: payload.issue?.body ?? "",
    reporterHandle: payload.issue?.user?.login ?? null,
  };
}

async function parse(lease: Lease): Promise<Lease> {
  const { payload, sourceRef, title, body, reporterHandle } = parseDelivery(lease);

  // Access is checked again here, not just at intake. A suspension or a repository removal
  // can land between the 202 and this run, and the target profile is read from the same
  // place either way: the server, never the payload.
  const repository = await activeRepository(payload.installation?.id, payload.repository?.id);
  if (!repository) {
    throw new UnprocessableDelivery(
      `repository ${payload.repository?.full_name ?? "?"} is no longer connected`,
    );
  }

  const reportId = await ensureReport({
    channel: lease.channel,
    sourceRef,
    title,
    body,
    reporterHandle,
    connectedRepositoryId: repository.connectedRepositoryId,
    targetProfileId: repository.targetProfileId,
  });

  await recordEvent(reportId, "intake.accepted", {
    deliveryId: lease.deliveryId,
    jobId: lease.id,
    sourceRef,
  });

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
  { analyze = noopAnalyze, leaseSeconds = 60 }: { analyze?: Analyze; leaseSeconds?: number } = {},
): Promise<string | null> {
  const claimed = await claim(owner, leaseSeconds);
  if (!claimed) return null;

  let lease = claimed;

  try {
    if (lease.state === "RECEIVED") lease = await parse(lease);
    if (lease.state === "PARSED") lease = await advance(lease, "SESSION_CREATED");
    if (lease.state === "SESSION_CREATED") lease = await advance(lease, "RUNNING");

    if (lease.state === "RUNNING") {
      if (!lease.reportId) {
        throw new UnprocessableDelivery("job reached RUNNING with no report attached");
      }

      await analyze({ reportId: lease.reportId, lease });
      await complete(lease);
    }

    return lease.id;
  } catch (error) {
    // A lost lease means another worker owns this job now. Writing anything about it would
    // be writing over that worker, which is the exact thing the fence exists to prevent.
    if (error instanceof LeaseLostError) throw error;

    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof UnprocessableDelivery) {
      await abandon(lease, message);
      return lease.id;
    }

    await fail(lease, message);
    return lease.id;
  }
}
