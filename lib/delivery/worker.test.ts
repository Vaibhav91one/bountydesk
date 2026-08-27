import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Real Postgres is required for the lease and active-repository checks. The GitHub boundary
 * stays fake so these tests can force network failures and crash windows deterministically.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type WorkerModule = typeof import("./worker");
type DbModule = typeof import("@/lib/db");

let worker: WorkerModule;
let dbm: DbModule;
let queue: typeof import("./queue");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("delivery_worker");

  dbm = await import("@/lib/db");
  worker = await import("./worker");
  queue = await import("./queue");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

// Stands in for computeContentHash from lib/verdicts/hash: deterministic, and used
// identically at seed time and inside the worker, so a real SHA is not needed to prove the
// mismatch check works.
function fakeHash(payload: string): string {
  return `fake-hash:${payload.length}:${payload.slice(0, 12)}`;
}

// Deliberately JWT-shaped, so the "never persisted" assertion at the bottom of this file is
// checking something that would actually look wrong if it leaked, not an empty string.
const FAKE_TOKEN = "ghs_aaaa.bbbbbbbbbbbb.ccccccccccccdddddddd";

let seq = 0;

/**
 * A full, realistically-connected fixture: installation, connected repository, target
 * profile, report, verdict, and one outbound_delivery row. activeRepository() reads the
 * first three for real, so the suspended/archived/unbound cases in these tests set actual
 * columns rather than faking that function's answer.
 */
async function seedFixture(
  opts: {
    suspended?: boolean;
    noTargetProfile?: boolean;
    noApproval?: boolean;
    reportState?: "DELIVERING" | "AWAITING_APPROVAL";
    targetOverride?: string;
    verdictForOtherReport?: boolean;
    withoutMarker?: boolean;
    maxAttempts?: number;
    wrongApprovedHash?: boolean;
  } = {},
) {
  seq += 1;
  const n = seq;
  const repoId = 100000 + n;
  const issueNumber = n;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 900000 + n,
      accountLogin: `acct-${n}`,
      accountId: 800000 + n,
      accountType: "User",
      suspendedAt: opts.suspended ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });

  let targetProfileId: string | null = null;
  if (!opts.noTargetProfile) {
    const [tp] = await dbm.db
      .insert(dbm.targetProfile)
      .values({ name: `target-${n}`, imageDigest: `sha256:fixture-${n}` })
      .returning({ id: dbm.targetProfile.id });
    targetProfileId = tp.id;
  }

  const fullName = `acme/repo-${n}`;
  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({
      installationId: installation.id,
      repoId,
      fullName,
      targetProfileId,
    })
    .returning({ id: dbm.connectedRepository.id });

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "github",
      sourceRef: `github:${repoId}:issue:${issueNumber}`,
      title: `report ${n}`,
      body: "body",
      state: opts.reportState ?? "DELIVERING",
      connectedRepositoryId: repo.id,
      targetProfileId,
    })
    .returning({ id: dbm.report.id });

  let verdictReportId = r.id;
  if (opts.verdictForOtherReport) {
    const [otherReport] = await dbm.db
      .insert(dbm.report)
      .values({
        channel: "github",
        sourceRef: `github:${repoId}:issue:${issueNumber + 10_000}`,
        title: `other report ${n}`,
        body: "other body",
        state: "DELIVERING",
        connectedRepositoryId: repo.id,
        targetProfileId,
      })
      .returning({ id: dbm.report.id });
    verdictReportId = otherReport.id;
  }

  // The id is minted in JS, not left to Postgres's default, because the marker embedded in
  // the payload has to name the verdict's id and verdict rows cannot be UPDATEd afterwards
  // (see AGENTS.md: verdict is one of the four append-only tables).
  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:verdict:${verdictId} -->`;
  const payload = opts.withoutMarker
    ? "Reproduced against target. See canary evidence."
    : `Reproduced against target. See canary evidence.\n${marker}`;
  const contentHash = fakeHash(payload);

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      id: verdictId,
      reportId: verdictReportId,
      outcome: "REPRODUCED",
      summary: "summary",
      payload,
      contentHash,
    })
    .returning({ id: dbm.verdict.id });

  if (!opts.noApproval) {
    await dbm.db.insert(dbm.approvalDecision).values({
      verdictId: v.id,
      reviewer: "test-reviewer",
      decision: "APPROVED",
      payloadHash: contentHash,
    });
  }

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId: v.id,
      idempotencyKey: `verdict:${verdictId}`,
      target: opts.targetOverride ?? `github:${repoId}:issue:${issueNumber}`,
      approvedContentHash: opts.wrongApprovedHash
        ? "tampered-hash-does-not-match"
        : contentHash,
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    .returning({ id: dbm.outboundDelivery.id });

  return {
    reportId: r.id,
    verdictId: v.id,
    deliveryId: d.id,
    payload,
    marker,
    fullName,
    issueNumber,
  };
}

/** claim() inside deliverOnce is global; retire every other row first (see queue.test.ts). */
async function drainOthers() {
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

function makeFakeDeps(
  opts: {
    listComments?: import("@/lib/github/comment").IssueComment[];
    postComment?: (call: number) => Promise<{ id: number }>;
  } = {},
) {
  const calls = { mintToken: 0, listComments: 0, postComment: 0 };
  const deps: import("./worker").DeliveryDeps = {
    githubAppId: 123456,
    hashContent: fakeHash,
    mintToken: async () => {
      calls.mintToken++;
      return {
        token: FAKE_TOKEN,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    listComments: async () => {
      calls.listComments++;
      return opts.listComments ?? [];
    },
    postComment: async () => {
      calls.postComment++;
      if (opts.postComment) return opts.postComment(calls.postComment);
      return { id: 1 };
    },
  };
  return { deps, calls };
}

async function deliveryRow(deliveryId: string) {
  const [row] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      lastError: dbm.outboundDelivery.lastError,
      leaseOwner: dbm.outboundDelivery.leaseOwner,
      attempts: dbm.outboundDelivery.attempts,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, deliveryId));
  return row;
}

async function reportRow(reportId: string) {
  const [row] = await dbm.db
    .select({ state: dbm.report.state })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  return row;
}

async function attemptsFor(deliveryId: string) {
  return dbm.db
    .select()
    .from(dbm.deliveryAttempt)
    .where(dbm.eq(dbm.deliveryAttempt.deliveryId, deliveryId));
}

test("happy path: no existing marker, post succeeds, report is delivered", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps, calls } = makeFakeDeps({ listComments: [] });

  const id = await worker.deliverOnce("w-happy", { deps });
  assert.equal(id, fixture.deliveryId);

  assert.equal(calls.mintToken, 1);
  assert.equal(calls.listComments, 1);
  assert.equal(calls.postComment, 1);

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "SENT");

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "DELIVERED");

  const attempts = await attemptsFor(fixture.deliveryId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].error, null);
  assert.equal(attempts[0].responseStatus, 201);
});

test("a transient postComment failure retries and succeeds on the next attempt", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps, calls } = makeFakeDeps({
    listComments: [],
    postComment: async (call) => {
      if (call === 1)
        throw new Error("ECONNRESET: connection reset while posting comment");
      return { id: 2 };
    },
  });

  const firstId = await worker.deliverOnce("w-retry", { deps });
  assert.equal(firstId, fixture.deliveryId);

  const afterFirst = await deliveryRow(fixture.deliveryId);
  assert.equal(
    afterFirst.state,
    "PENDING",
    "a transient failure must stay retryable",
  );
  assert.match(afterFirst.lastError ?? "", /ECONNRESET/);

  const repAfterFirst = await reportRow(fixture.reportId);
  assert.equal(repAfterFirst.state, "DELIVERING");

  // Backoff pushed next_attempt_at into the future; force it open rather than sleeping the
  // test through it.
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, fixture.deliveryId));

  const secondId = await worker.deliverOnce("w-retry", { deps });
  assert.equal(secondId, fixture.deliveryId);

  const afterSecond = await deliveryRow(fixture.deliveryId);
  assert.equal(afterSecond.state, "SENT");

  const repAfterSecond = await reportRow(fixture.reportId);
  assert.equal(repAfterSecond.state, "DELIVERED");

  assert.equal(
    calls.postComment,
    2,
    "the second call must have actually retried the post",
  );
});

test("a final-state failure records one attempt and releases the lease", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps } = makeFakeDeps({
    listComments: [],
    postComment: async () => {
      await dbm.db
        .update(dbm.report)
        .set({ state: "CANCELLED" })
        .where(dbm.eq(dbm.report.id, fixture.reportId));
      return { id: 3 };
    },
  });

  await worker.deliverOnce("w-final-state-failure", { deps });

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "PENDING");
  assert.match(delivery.lastError ?? "", /DELIVERING/);
  const attempts = await attemptsFor(fixture.deliveryId);
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].error ?? "", /DELIVERING/);
});

test("a failure before the GitHub calls releases the claimed delivery", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps, calls } = makeFakeDeps();
  deps.hashContent = () => {
    throw new Error("hash implementation unavailable");
  };

  await worker.deliverOnce("w-pre-send-failure", { deps });

  assert.equal(calls.mintToken, 0);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "PENDING");
  assert.match(delivery.lastError ?? "", /hash implementation unavailable/);
  const attempts = await attemptsFor(fixture.deliveryId);
  assert.equal(attempts.length, 1);
});

test("a slow GitHub lookup renews the lease before another worker can reclaim it", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps } = makeFakeDeps();
  let competingClaim: Awaited<ReturnType<typeof queue.claim>> | undefined;
  deps.listComments = async () => {
    await new Promise((resolve) => setTimeout(resolve, 6_200));
    competingClaim = await queue.claim("w-competing", 60);
    return [];
  };

  await worker.deliverOnce("w-heartbeat", { deps, leaseSeconds: 5 });

  assert.equal(competingClaim, null);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "SENT");
});

test("an outer deadline aborts an in-flight GitHub lookup and releases the delivery", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps } = makeFakeDeps();
  const controller = new AbortController();
  deps.listComments = async ({ signal }) => {
    controller.abort(new Error("tick deadline exceeded"));
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return [];
  };

  await worker.deliverOnce("w-deadline", { deps, signal: controller.signal });

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "PENDING");
  assert.equal(delivery.leaseOwner, null);
  assert.match(delivery.lastError ?? "", /tick deadline exceeded/);
});

test("an expired deadline does not claim or consume a delivery attempt", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const controller = new AbortController();
  controller.abort(new Error("tick deadline exceeded"));

  const result = await worker.deliverOnce("w-expired", {
    deps: makeFakeDeps().deps,
    signal: controller.signal,
  });

  assert.equal(result, null);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.leaseOwner, null);
});

test("exhausting maxAttempts fails the delivery but leaves the report in DELIVERING", async () => {
  await drainOthers();
  const fixture = await seedFixture({ maxAttempts: 2 });
  const { deps } = makeFakeDeps({
    listComments: [],
    postComment: async () => {
      throw new Error("GitHub 503: upstream unavailable");
    },
  });

  await worker.deliverOnce("w-doomed", { deps });
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.outboundDelivery.id, fixture.deliveryId));
  await worker.deliverOnce("w-doomed", { deps });

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");

  // This is the point of the whole exercise, per AGENTS.md and lib/reports/states.ts: there
  // is no delivery-failure state in the report enum, so a report that ran out of send
  // attempts stays exactly where it was. The FAILED row plus its delivery_attempt history is
  // the durable signal a human is meant to notice.
  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "DELIVERING");
});

test("a marker already on the issue is treated as delivered, without posting again", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps, calls } = makeFakeDeps({
    listComments: [
      {
        body: fixture.payload,
        authorLogin: "bountydesk-triage[bot]",
        authorType: "Bot",
        githubAppId: 123456,
      },
    ],
  });

  const id = await worker.deliverOnce("w-recovered", { deps });
  assert.equal(id, fixture.deliveryId);

  assert.equal(calls.mintToken, 1);
  assert.equal(calls.listComments, 1);
  assert.equal(
    calls.postComment,
    0,
    "crash recovery must never post a second comment",
  );

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "SENT");

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "DELIVERED");

  const attempts = await attemptsFor(fixture.deliveryId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].responseStatus, null);
});

test("a matching marker from an issue participant cannot acknowledge delivery", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps, calls } = makeFakeDeps({
    listComments: [
      {
        body: fixture.payload,
        authorLogin: "reporter",
        authorType: "User",
        githubAppId: null,
      },
    ],
  });

  await worker.deliverOnce("w-forged-marker", { deps });

  assert.equal(calls.postComment, 1);
  assert.equal((await deliveryRow(fixture.deliveryId)).state, "SENT");
});

test("a marker from a different BountyDesk delivery cannot acknowledge this one", async () => {
  await drainOthers();
  const fixture = await seedFixture();
  const { deps, calls } = makeFakeDeps({
    listComments: [
      {
        body: fixture.payload.replace(fixture.verdictId, randomUUID()),
        authorLogin: "bountydesk-triage[bot]",
        authorType: "Bot",
        githubAppId: 123456,
      },
    ],
  });

  await worker.deliverOnce("w-other-delivery", { deps });

  assert.equal(calls.postComment, 1);
  assert.equal((await deliveryRow(fixture.deliveryId)).state, "SENT");
});

test("the database permits distinct deliveries for the same verdict", async () => {
  await drainOthers();
  const fixture = await seedFixture();

  const inserted = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: fixture.reportId,
      verdictId: fixture.verdictId,
      idempotencyKey: `duplicate-${randomUUID()}`,
      target: `github:1:issue:1`,
      approvedContentHash: fakeHash(fixture.payload),
    })
    .returning({ id: dbm.outboundDelivery.id });

  assert.equal(inserted.length, 1);
});

test("a suspended installation is refused permanently, before any token is minted", async () => {
  await drainOthers();
  const fixture = await seedFixture({ suspended: true });
  const { deps, calls } = makeFakeDeps();

  const id = await worker.deliverOnce("w-refused", { deps });
  assert.equal(id, fixture.deliveryId);

  assert.equal(
    calls.mintToken,
    0,
    "a refused repository must never reach token minting",
  );
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "DELIVERING");

  const attempts = await attemptsFor(fixture.deliveryId);
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].error ?? "", /no longer connected/);
});

test("a content-hash mismatch fails permanently without ever contacting GitHub", async () => {
  await drainOthers();
  const fixture = await seedFixture({ wrongApprovedHash: true });
  const { deps, calls } = makeFakeDeps();

  const id = await worker.deliverOnce("w-tampered", { deps });
  assert.equal(id, fixture.deliveryId);

  assert.equal(
    calls.mintToken,
    0,
    "stored corruption must be caught before minting a token",
  );
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");

  const rep = await reportRow(fixture.reportId);
  assert.equal(rep.state, "DELIVERING");

  const attempts = await attemptsFor(fixture.deliveryId);
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].error ?? "", /content hash mismatch/);
});

test("an outbox row without an approved decision is refused before token minting", async () => {
  await drainOthers();
  const fixture = await seedFixture({ noApproval: true });
  const { deps, calls } = makeFakeDeps();

  const id = await worker.deliverOnce("w-unapproved", { deps });
  assert.equal(id, fixture.deliveryId);
  assert.equal(calls.mintToken, 0);
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);

  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");
  assert.match(delivery.lastError ?? "", /approved decision/);
});

test("an approved outbox row is refused unless the report is DELIVERING", async () => {
  await drainOthers();
  const fixture = await seedFixture({ reportState: "AWAITING_APPROVAL" });
  const { deps, calls } = makeFakeDeps();

  await worker.deliverOnce("w-wrong-report-state", { deps });

  assert.equal(calls.mintToken, 0);
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");
  assert.match(delivery.lastError ?? "", /DELIVERING/);
});

test("an outbox target that differs from the report source is refused", async () => {
  await drainOthers();
  const fixture = await seedFixture({
    targetOverride: "github:999999:issue:77",
  });
  const { deps, calls } = makeFakeDeps();

  await worker.deliverOnce("w-wrong-target", { deps });

  assert.equal(calls.mintToken, 0);
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");
  assert.match(delivery.lastError ?? "", /target/);
});

test("a verdict belonging to another report is refused", async () => {
  await drainOthers();
  const fixture = await seedFixture({ verdictForOtherReport: true });
  const { deps, calls } = makeFakeDeps();

  await worker.deliverOnce("w-wrong-verdict-report", { deps });

  assert.equal(calls.mintToken, 0);
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");
  assert.match(delivery.lastError ?? "", /does not belong/);
});

test("an approved payload without its replay marker is refused", async () => {
  await drainOthers();
  const fixture = await seedFixture({ withoutMarker: true });
  const { deps, calls } = makeFakeDeps();

  await worker.deliverOnce("w-missing-marker", { deps });

  assert.equal(calls.mintToken, 0);
  assert.equal(calls.listComments, 0);
  assert.equal(calls.postComment, 0);
  const delivery = await deliveryRow(fixture.deliveryId);
  assert.equal(delivery.state, "FAILED");
  assert.match(delivery.lastError ?? "", /marker/);
});

test("no delivery_attempt row ever stores the installation token or app JWT", async () => {
  const rows = await dbm.db
    .select({
      responseBody: dbm.deliveryAttempt.responseBody,
      error: dbm.deliveryAttempt.error,
    })
    .from(dbm.deliveryAttempt);

  assert.ok(
    rows.length > 0,
    "the earlier tests should have left attempt rows to check",
  );

  for (const row of rows) {
    for (const field of [row.responseBody, row.error]) {
      if (!field) continue;
      assert.ok(
        !field.includes(FAKE_TOKEN),
        `a stored field contained the fake token: ${field}`,
      );
      assert.doesNotMatch(
        field,
        /^ghs_/,
        "a token-shaped string leaked into a stored field",
      );
    }
  }
});
