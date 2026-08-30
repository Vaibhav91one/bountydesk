/**
 * The persistent deployment worker, per docs/deployment.md's "Worker process" section: a
 * long-running Node entry point that drives the same four claim functions the internal tick
 * routes call, continuously rather than once per HTTP request. This is what a Zerops (or any
 * other) private worker service actually runs; the tick routes stay as bounded, authenticated
 * adapters for local and manual diagnostics, not the deployed path.
 *
 *   npm run worker:daemon
 *
 * Stops on SIGINT/SIGTERM: no loop claims new work once the shared signal aborts. Work already
 * claimed is handled by each queue's own abort behavior: runOnce, deliverOnce, and
 * submitApprovalOnce release or fail their lease explicitly on an aborted signal, while
 * pollOnce (see lib/agent-sessions/poller.ts) has no such handling and simply lets its lease
 * expire for the next sweep, the same as an unhandled error would.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

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
const DEFAULT_WORKER_HEALTH_PORT = 8080;

function errorMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function workerHealthPort(): number {
  const raw = process.env.WORKER_HEALTH_PORT ?? String(DEFAULT_WORKER_HEALTH_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("WORKER_HEALTH_PORT must be a TCP port number");
  }
  return port;
}

function startHealthServer(port: number, signal: AbortSignal): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, service: "bountydesk-worker" }));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`worker health server listening on ${port}`);
  });

  signal.addEventListener(
    "abort",
    () => {
      server.close();
    },
    { once: true },
  );

  return server;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const onShutdownSignal = (signal: string) => {
    console.log(`worker daemon received ${signal}, stopping new claims`);
    controller.abort(new Error(`received ${signal}`));
  };
  process.once("SIGINT", () => onShutdownSignal("SIGINT"));
  process.once("SIGTERM", () => onShutdownSignal("SIGTERM"));

  startHealthServer(workerHealthPort(), controller.signal);

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
