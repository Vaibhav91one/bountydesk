import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The worker against a real Postgres.
 *
 * What is asserted here is mostly what happens when a run does not go cleanly: a worker that
 * dies half way, a repository whose access was withdrawn after the 202, a payload that is
 * not a report. The happy path is one test; the rest is the part that has to hold.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

let dbm: typeof import("@/lib/db");
let queue: typeof import("./queue");
let worker: typeof import("./worker");
let reports: typeof import("@/lib/reports/lifecycle");

let targetProfileId: string;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("worker");

  dbm = await import("@/lib/db");
  queue = await import("./queue");
  worker = await import("./worker");
  reports = await import("@/lib/reports/lifecycle");

  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: "juice-shop-v17.3.0", imageDigest: `sha256:${"0".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });

  targetProfileId = profile.id;
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let ids = 0;

/** A connected, configured repository: what the Channels screen will set up. */
async function connectedRepo({ configured = true, granted = true } = {}) {
  ids += 1;
  const installationId = 500_000 + ids;
  const repoId = 700_000 + ids;
  const fullName = `acme/reports-${ids}`;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({ installationId, accountLogin: "acme", accountId: 77 })
    .returning({ id: dbm.githubInstallation.id });

  await dbm.db.insert(dbm.connectedRepository).values({
    installationId: installation.id,
    repoId,
    fullName,
    active: granted,
    targetProfileId: configured ? targetProfileId : null,
  });

  return { installationId, repoId, fullName };
}

type Repo = Awaited<ReturnType<typeof connectedRepo>>;

let deliveries = 0;

async function enqueueIssue(repo: Repo, overrides: Record<string, unknown> = {}) {
  deliveries += 1;

  return queue.enqueue({
    channel: "github",
    deliveryId: `worker-delivery-${deliveries}`,
    payload: {
      action: "opened",
      issue: {
        number: 42,
        title: "SQL injection in product search",
        body: "steps to reproduce",
        user: { login: "reporter" },
      },
      repository: { id: repo.repoId, full_name: repo.fullName },
      installation: { id: repo.installationId },
      ...overrides,
    },
  });
}

async function job(jobId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.id, jobId))
    .limit(1);

  return row;
}

/**
 * Retire everything else in the queue.
 *
 * claim() is global-FIFO by design, taking the oldest claimable row rather than one
 * belonging to the caller, so a test that enqueues and then runs would otherwise be handed
 * an earlier test's job.
 */
async function drain() {
  await dbm.db
    .update(dbm.inboundJob)
    .set({ state: "DONE", leaseOwner: null, leaseExpiresAt: null });
}

test("an empty queue is not an error", async () => {
  await drain();
  assert.equal(await worker.runOnce("worker-1"), null);
});

test("a delivery becomes a report and the job finishes", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo);

  assert.equal(await worker.runOnce("worker-1"), jobId);

  const finished = await job(jobId);
  assert.equal(finished.state, "DONE");
  assert.equal(finished.leaseOwner, null);
  assert.ok(finished.reportId);

  const [created] = await dbm.db
    .select()
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, finished.reportId as string));

  assert.equal(created.sourceRef, `${repo.fullName}#42`);
  assert.equal(created.title, "SQL injection in product search");
  assert.equal(created.reporterHandle, "reporter");
  assert.equal(created.state, "TRIAGING");

  // The target comes from the server-held binding, never from the payload.
  assert.equal(created.targetProfileId, targetProfileId);
});

test("the audit trail records the intake", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo);
  await worker.runOnce("worker-1");

  const finished = await job(jobId);
  const events = await dbm.db
    .select()
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, finished.reportId as string));

  assert.deepEqual(
    events.map((e) => e.type).sort(),
    ["intake.accepted", "triage.skipped"],
  );
  assert.deepEqual(
    events.map((e) => e.seq).sort(),
    [1, 2],
  );
});

test("a worker that dies mid-job resumes rather than starting over", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo);

  // First pass gets as far as creating the report, then the analysis step throws.
  await assert.doesNotReject(
    worker.runOnce("worker-1", {
      analyze: async () => {
        throw new Error("worker died");
      },
    }),
  );

  const afterCrash = await job(jobId);
  assert.equal(afterCrash.state, "RUNNING", "the state it reached is kept");
  assert.equal(afterCrash.lastError, "worker died");
  assert.equal(afterCrash.leaseOwner, null, "the lease is released for the next worker");
  const reportId = afterCrash.reportId;
  assert.ok(reportId);

  // Backoff would otherwise hold this job back from the next claim.
  await dbm.db
    .update(dbm.inboundJob)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.inboundJob.id, jobId));

  let parsedAgain = false;
  await worker.runOnce("worker-2", {
    analyze: async () => {
      parsedAgain = true;
    },
  });

  const finished = await job(jobId);
  assert.equal(finished.state, "DONE");
  assert.equal(parsedAgain, true);
  assert.equal(finished.reportId, reportId, "the same report, not a second one");

  const rows = await dbm.db
    .select({ id: dbm.report.id })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.sourceRef, `${repo.fullName}#42`));

  assert.equal(rows.length, 1);
});

test("a repository disconnected after the 202 is buried, not retried", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo);

  // The suspension lands between accepting the delivery and running it.
  await dbm.db
    .update(dbm.githubInstallation)
    .set({ suspendedAt: new Date() })
    .where(dbm.eq(dbm.githubInstallation.installationId, repo.installationId));

  await worker.runOnce("worker-1");

  const buried = await job(jobId);
  assert.equal(buried.state, "DEAD_LETTER");
  assert.equal(buried.attempts, 1, "no attempts are burned re-asking a settled question");
  assert.match(buried.lastError as string, /no longer connected/);

  const rows = await dbm.db
    .select({ id: dbm.report.id })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.sourceRef, `${repo.fullName}#42`));

  assert.equal(rows.length, 0, "no report is created");
});

test("a repository with no target bound is buried", async () => {
  await drain();
  const repo = await connectedRepo({ configured: false });
  const { jobId } = await enqueueIssue(repo);

  await worker.runOnce("worker-1");

  assert.equal((await job(jobId)).state, "DEAD_LETTER");
});

test("a payload that is not a report is buried", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo, { issue: { title: "no number" } });

  await worker.runOnce("worker-1");

  const buried = await job(jobId);
  assert.equal(buried.state, "DEAD_LETTER");
  assert.match(buried.lastError as string, /issue number/);
});

test("a transient failure is retried with the state preserved", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo);

  await worker.runOnce("worker-1", {
    analyze: async () => {
      throw new Error("TrueForge is having a moment");
    },
  });

  const failed = await job(jobId);
  assert.equal(failed.state, "RUNNING", "not dead-lettered: this one might work next time");
  assert.equal(failed.attempts, 1);
  assert.ok((failed.nextAttemptAt as Date).getTime() > Date.now(), "backoff is set");
});

test("a report cannot be moved from a state it is no longer in", async () => {
  await drain();
  const repo = await connectedRepo();
  const { jobId } = await enqueueIssue(repo);
  await worker.runOnce("worker-1");

  const reportId = (await job(jobId)).reportId as string;

  await reports.transition(reportId, "TRIAGING", "REPRODUCING");
  assert.equal(await reports.reportState(reportId), "REPRODUCING");

  // A second worker still holding the stale read writes nothing.
  await assert.rejects(
    reports.transition(reportId, "TRIAGING", "ANALYSIS_ONLY"),
    reports.ReportStateConflictError,
  );

  await assert.rejects(
    reports.transition(reportId, "REPRODUCING", "DELIVERED"),
    /illegal report transition/,
  );

  assert.equal(await reports.reportState(reportId), "REPRODUCING");
});
