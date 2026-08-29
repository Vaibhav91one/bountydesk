/**
 * The persistent deployment worker, per docs/deployment.md's "Worker process" section: a
 * long-running Node entry point that drives the same four claim functions the internal tick
 * routes call, continuously rather than once per HTTP request. This is what a Zerops (or any
 * other) private worker service actually runs; the tick routes stay as bounded, authenticated
 * adapters for local and manual diagnostics, not the deployed path.
 *
 *   npm run worker:daemon
 *
 * Stops on SIGINT/SIGTERM: new claims stop immediately, and whatever's already claimed is left
 * for its own lease to recover, the same as a crash would be handled.
 */
import { randomUUID } from "node:crypto";

import { createTrueforgeAnalysisDriver } from "@/lib/analysis/trueforge-driver";
import { sweepExpiredLeases as sweepJobs } from "@/lib/jobs/queue";
import { runOnce } from "@/lib/jobs/worker";
import { sweepExpiredLeases as sweepAgentSessions } from "@/lib/agent-sessions/queue";
import { pollOnce } from "@/lib/agent-sessions/poller";
import { sweepExpiredLeases as sweepApprovalSubmissions } from "@/lib/approval-submission/queue";
import { submitApprovalOnce } from "@/lib/approval-submission/worker";
import { sweepExpiredLeases as sweepDeliveries } from "@/lib/delivery/queue";
import { deliverOnce } from "@/lib/delivery/worker";
import { createTrueForgeClient } from "@/lib/trueforge/client";

import { runDaemon, type QueueSpec } from "@/lib/worker-daemon/runner";

const LEASE_SECONDS = 60;

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onShutdownSignal = (signal: string) => {
    console.log(`worker daemon received ${signal}, stopping new claims`);
    controller.abort(new Error(`received ${signal}`));
  };
  process.once("SIGINT", () => onShutdownSignal("SIGINT"));
  process.once("SIGTERM", () => onShutdownSignal("SIGTERM"));

  const analysis = createTrueforgeAnalysisDriver();
  const trueForgeClient = createTrueForgeClient();

  // One owner id per queue, for the lifetime of this process, not regenerated per claim: a
  // process id would be reused across restarts, so each loop gets its own random identity
  // instead.
  const jobsOwner = `daemon-jobs-${randomUUID()}`;
  const agentSessionsOwner = `daemon-agent-sessions-${randomUUID()}`;
  const approvalSubmissionOwner = `daemon-approval-submission-${randomUUID()}`;
  const deliveryOwner = `daemon-delivery-${randomUUID()}`;

  const queues: QueueSpec[] = [
    {
      name: "jobs",
      claimOnce: (signal) =>
        runOnce(jobsOwner, { analysis, leaseSeconds: LEASE_SECONDS, signal }),
      sweepOnce: sweepJobs,
    },
    {
      name: "agent-sessions",
      claimOnce: (signal) =>
        pollOnce(agentSessionsOwner, {
          client: trueForgeClient,
          leaseSeconds: LEASE_SECONDS,
          signal,
        }),
      sweepOnce: sweepAgentSessions,
    },
    {
      name: "approval-submission",
      claimOnce: (signal) =>
        submitApprovalOnce(approvalSubmissionOwner, {
          client: trueForgeClient,
          leaseSeconds: LEASE_SECONDS,
          signal,
        }),
      sweepOnce: sweepApprovalSubmissions,
    },
    {
      name: "delivery",
      claimOnce: (signal) =>
        deliverOnce(deliveryOwner, { leaseSeconds: LEASE_SECONDS, signal }),
      sweepOnce: sweepDeliveries,
    },
  ];

  console.log(`worker daemon starting, pid ${process.pid}`);
  await runDaemon(queues, { signal: controller.signal });
  console.log("worker daemon stopped");
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
