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
import { onboardOnce } from "@/lib/build-onboarding/worker";
import { sweepExpiredLeases as sweepOnboarding } from "@/lib/build-onboarding/queue";
import { createDaytonaBuildDriver } from "@/lib/build-onboarding/daytona-build-driver";

import { createHeartbeat, type Heartbeat } from "@/lib/worker-daemon/health";
import { runDaemon, type QueueSpec } from "@/lib/worker-daemon/runner";

const LEASE_SECONDS = 60;
const DEFAULT_WORKER_HEALTH_PORT = 8080;

/**
 * How long a loop may go without finishing an iteration before /healthz calls it stale. Well
 * clear of the cadences a healthy loop keeps (a 5s error backoff, a 30s sweep interval) and
 * still inside what the platform will act on: Zerops checks every 30s and restarts after 60s of
 * failures, so a wedge is caught in about two minutes rather than sitting until someone notices.
 */
const STALL_BUDGET_MS = 90_000;

/**
 * The jobs queue gets its own budget because one claim there legitimately takes minutes: it
 * boots a sandbox and waits on a 90s readiness poll plus 30s HTTP calls before the iteration
 * ends. Restarting the worker mid-provision would throw that away and start it again.
 */
const JOBS_STALL_BUDGET_MS = 300_000;

/**
 * The build-onboarding loop spends a single claim building an image inside a sandbox, which can
 * run up to the build sandbox's ttl. Its stall budget clears that so /healthz does not read a
 * legitimate long build as a wedged loop.
 */
const BUILD_ONBOARDING_STALL_BUDGET_MS = 1_920_000;

/**
 * How long a loop may fail every single iteration before /healthz calls it stale. A loop erroring
 * this steadily is not having a bad minute: Postgres or TrueForge is unreachable from this
 * process, and the queues' own retries have already had dozens of goes at it. Longer than the
 * stall budget on purpose, because unlike a wedge this state is visible in the log the whole
 * time, and a restart is only worth doing once it is clear waiting will not fix it.
 */
const FAILING_BUDGET_MS = 180_000;

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

function startHealthServer(port: number, heartbeat: Heartbeat, signal: AbortSignal): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      // Reports on the work, not on the process: a daemon whose loops have all wedged still
      // answers this port, so a check on the process alone passes while nothing gets claimed. A
      // loop that has gone silent, or one that has failed every iteration long enough to mean a
      // dependency is gone, fails the check so the platform restarts the worker, which is the
      // one thing known to clear a wedge.
      const health = heartbeat.snapshot();
      res.writeHead(health.ok ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ service: "bountydesk-worker", ...health }));
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

  // Node's default is to print a raw stack and exit, which in a deployed worker is a restart with
  // no line saying what died. Exiting is still the right answer, since a rejection nobody awaited
  // means some part of this process is in a state it did not plan for and the lease protocol is
  // built to recover a worker that stops: work in flight expires and a sweeper reclaims it. Say so
  // first, so the next one is readable in the service log.
  process.on("unhandledRejection", (reason) => {
    console.error(`worker daemon exiting on an unhandled rejection: ${errorMessage(reason)}`);
    process.exit(1);
  });

  const analysis = createTrueforgeAnalysisDriver();
  const trueForgeClient = createTrueForgeClient();

  // One owner id per queue, for the lifetime of this process, not regenerated per claim: a
  // process id would be reused across restarts, so each loop gets its own random identity
  // instead.
  const jobsOwner = `daemon-jobs-${randomUUID()}`;
  const agentSessionsOwner = `daemon-agent-sessions-${randomUUID()}`;
  const approvalSubmissionOwner = `daemon-approval-submission-${randomUUID()}`;
  const deliveryOwner = `daemon-delivery-${randomUUID()}`;
  const onboardingOwner = `daemon-build-onboarding-${randomUUID()}`;
  const buildDriver = createDaytonaBuildDriver();

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
    {
      name: "build-onboarding",
      claimOnce: (signal) =>
        onboardOnce(onboardingOwner, {
          buildDriver,
          agentClient: trueForgeClient,
          leaseSeconds: LEASE_SECONDS,
          signal,
        }),
      sweepOnce: sweepOnboarding,
    },
  ];

  // runDaemon runs a claim loop and a sweeper per queue, and /healthz watches all of them, so
  // the names come from the specs above rather than from a second list that could drift.
  const heartbeat = createHeartbeat({
    names: queues.flatMap((queue) => [queue.name, `${queue.name}-sweep`]),
    startedAt: Date.now(),
    defaultBudgetMs: STALL_BUDGET_MS,
    budgets: {
      jobs: JOBS_STALL_BUDGET_MS,
      "build-onboarding": BUILD_ONBOARDING_STALL_BUDGET_MS,
    },
    failureBudgetMs: FAILING_BUDGET_MS,
  });
  startHealthServer(workerHealthPort(), heartbeat, controller.signal);

  console.log(`worker daemon starting, pid ${process.pid}`);
  await runDaemon(queues, {
    signal: controller.signal,
    onProgress: (name, outcome) => heartbeat.record(name, Date.now(), outcome),
  });
  console.log("worker daemon stopped");
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
