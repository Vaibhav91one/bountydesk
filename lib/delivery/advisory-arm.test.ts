import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { Advisory } from "@/lib/github/advisory";

/**
 * The advisory delivery arm against a real Postgres, with the GitHub advisory API faked so create,
 * PATCH, replay and refusal are all deterministic. The shared delivery gates (hash, approval,
 * marker, report state) run for real through deliverOnce, so the approval-gate checks here are the
 * same code path a GitHub-comment delivery takes, exercised on the advisory channel.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

let dbm: typeof import("@/lib/db");
let worker: typeof import("./worker");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("advisory_arm");
  dbm = await import("@/lib/db");
  worker = await import("./worker");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function fakeHash(payload: string): string {
  return `fake-hash:${payload.length}:${payload.slice(0, 12)}`;
}

const FAKE_TOKEN = "ghs_aaaa.bbbbbbbbbbbb.ccccccccccccdddddddd";

let seq = 0;

/**
 * A stateful stand-in for the three GitHub advisory calls. Advisories live in a map keyed by
 * ghsa_id, so findAdvisoryByMarker searches descriptions exactly as the real cursor-paged endpoint
 * would, and create/PATCH mutate the same store a retry then reads back.
 */
function fakeAdvisoryDeps(seedAdvisories: { ghsaId: string; description: string }[] = []) {
  const store = new Map<string, { ghsaId: string; htmlUrl: string; description: string }>();
  for (const a of seedAdvisories) {
    store.set(a.ghsaId, { ghsaId: a.ghsaId, htmlUrl: `https://github.com/advisories/${a.ghsaId}`, description: a.description });
  }
  const calls = { mint: 0, find: 0, create: 0, update: 0 };
  const deps: Partial<import("./arm").DeliveryDeps> = {
    githubAppId: 123456,
    hashContent: fakeHash,
    mintToken: async () => {
      calls.mint++;
      return { token: FAKE_TOKEN, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    },
    sendEmail: async () => {
      throw new Error("advisory delivery must not send mail");
    },
    postComment: async () => {
      throw new Error("advisory delivery must not post a comment");
    },
    listComments: async () => {
      throw new Error("advisory delivery must not read comments");
    },
    findAdvisoryByMarker: async ({ markers }) => {
      calls.find++;
      for (const entry of store.values()) {
        const marker = markers.find((m) => entry.description.includes(m));
        if (marker) return { ghsaId: entry.ghsaId, htmlUrl: entry.htmlUrl, marker };
      }
      return null;
    },
    createDraftAdvisory: async ({ description }): Promise<Advisory> => {
      calls.create++;
      const ghsaId = `GHSA-test-${randomUUID().slice(0, 4)}-${calls.create}`;
      const advisory = { ghsaId, htmlUrl: `https://github.com/advisories/${ghsaId}`, description };
      store.set(ghsaId, advisory);
      return { ghsaId, htmlUrl: advisory.htmlUrl };
    },
    updateAdvisoryDescription: async ({ ghsaId, description }): Promise<Advisory> => {
      calls.update++;
      const existing = store.get(ghsaId);
      if (!existing) throw new Error(`fake: advisory ${ghsaId} does not exist`);
      existing.description = description;
      return { ghsaId, htmlUrl: existing.htmlUrl };
    },
  };
  return { deps: deps as import("./arm").DeliveryDeps, calls, store };
}

/**
 * A fully connected advisory-channel report with a verdict and one outbound_delivery row.
 * `priorMarker`, when set, adds an earlier verdict revision for the report whose marker a
 * pre-seeded advisory can carry, so the PATCH path has two revisions to find between.
 */
async function seedFixture(
  opts: {
    suspended?: boolean;
    noApproval?: boolean;
    wrongApprovedHash?: boolean;
    reportState?: "DELIVERING" | "AWAITING_APPROVAL";
    priorMarker?: boolean;
  } = {},
) {
  seq += 1;
  const n = seq;
  const repoId = 500000 + n;
  const ghsaId = `GHSA-fix${n}-aaaa-bbbb`;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 700000 + n,
      accountLogin: `acct-${n}`,
      accountId: 600000 + n,
      accountType: "User",
      suspendedAt: opts.suspended ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });

  const [tp] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `target-${n}`, imageDigest: `sha256:fixture-${n}` })
    .returning({ id: dbm.targetProfile.id });

  const fullName = `acme/adv-${n}`;
  const sourceRef = `github:${repoId}:advisory:${ghsaId}`;
  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({ installationId: installation.id, repoId, fullName, targetProfileId: tp.id })
    .returning({ id: dbm.connectedRepository.id });

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "advisory",
      sourceRef,
      title: `advisory report ${n}`,
      body: "body",
      state: opts.reportState ?? "DELIVERING",
      connectedRepositoryId: repo.id,
      targetProfileId: tp.id,
    })
    .returning({ id: dbm.report.id });

  let priorMarker: string | null = null;
  if (opts.priorMarker) {
    const priorId = randomUUID();
    priorMarker = `<!-- bountydesk-delivery:${priorId} -->`;
    const priorPayload = `Earlier revision.\n${priorMarker}`;
    await dbm.db.insert(dbm.verdict).values({
      id: priorId,
      reportId: r.id,
      outcome: "ANALYSIS_ONLY",
      summary: "prior",
      payload: priorPayload,
      contentHash: fakeHash(priorPayload),
      revision: 1,
    });
  }

  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const payload = `Analysis of the advisory. No reproduction.\n${marker}`;
  const contentHash = fakeHash(payload);

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      id: verdictId,
      reportId: r.id,
      outcome: "ANALYSIS_ONLY",
      summary: "summary",
      payload,
      contentHash,
      revision: opts.priorMarker ? 2 : 1,
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
      target: sourceRef,
      approvedContentHash: opts.wrongApprovedHash ? "tampered-hash" : contentHash,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, verdictId: v.id, deliveryId: d.id, payload, marker, priorMarker, ghsaId, sourceRef };
}

/** claim() inside deliverOnce is global; retire every other row first. */
async function drainOthers() {
  await dbm.db.update(dbm.outboundDelivery).set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

async function deliveryRow(id: string) {
  const [row] = await dbm.db
    .select({ state: dbm.outboundDelivery.state, lastError: dbm.outboundDelivery.lastError, rhr: dbm.outboundDelivery.requiresHumanReview })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, id));
  return row;
}

async function reportState(id: string) {
  const [row] = await dbm.db.select({ state: dbm.report.state }).from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row.state;
}

test("no existing advisory: the arm opens a draft and the report is delivered", async () => {
  await drainOthers();
  const f = await seedFixture();
  const { deps, calls, store } = fakeAdvisoryDeps();

  const id = await worker.deliverOnce("adv-create", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 0);
  assert.equal((await deliveryRow(f.deliveryId)).state, "SENT");
  assert.equal(await reportState(f.reportId), "DELIVERED");

  // The advisory carries the approved payload, byte for byte, marker included.
  const written = [...store.values()][0];
  assert.equal(written.description, f.payload);
});

test("crash recovery: an advisory already carrying this verdict's marker is a replay, not a second create", async () => {
  await drainOthers();
  const f = await seedFixture();
  // The advisory already exists from a prior attempt that died before committing SENT.
  const { deps, calls } = fakeAdvisoryDeps([{ ghsaId: f.ghsaId, description: f.payload }]);

  const id = await worker.deliverOnce("adv-replay", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.create, 0, "a marker already present must never open a second advisory");
  assert.equal(calls.update, 0);
  assert.equal((await deliveryRow(f.deliveryId)).state, "SENT");
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("a later revision PATCHes the advisory an earlier revision opened", async () => {
  await drainOthers();
  const f = await seedFixture({ priorMarker: true });
  assert.ok(f.priorMarker);
  // The advisory opened by the earlier revision, carrying that revision's marker.
  const { deps, calls, store } = fakeAdvisoryDeps([{ ghsaId: f.ghsaId, description: `Earlier revision.\n${f.priorMarker}` }]);

  const id = await worker.deliverOnce("adv-patch", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.create, 0, "an existing advisory must be updated, not twinned");
  assert.equal(calls.update, 1);
  assert.equal(store.get(f.ghsaId)?.description, f.payload);
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("the grant revoked between intake and send is refused and held, not delivered", async () => {
  await drainOthers();
  const f = await seedFixture({ suspended: true });
  const { deps, calls } = fakeAdvisoryDeps();

  const id = await worker.deliverOnce("adv-revoked", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.mint, 0, "a refused repository must never mint a token");
  assert.equal(calls.create, 0);

  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.rhr, true, "a lost grant is held for a human to reconnect");
  assert.match(row.lastError ?? "", /no longer connected/);
  // The report is not delivered; it stays where it was.
  assert.equal(await reportState(f.reportId), "DELIVERING");
});

test("the approval-gate hash triple-check still holds for the advisory channel", async () => {
  await drainOthers();
  const f = await seedFixture({ wrongApprovedHash: true });
  const { deps, calls } = fakeAdvisoryDeps();

  await worker.deliverOnce("adv-tampered", { deps });

  assert.equal(calls.mint, 0, "a hash mismatch must be caught before any GitHub call");
  assert.equal(calls.create, 0);
  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /content hash mismatch/);
});

test("an outbox row without an approved decision never reaches the advisory API", async () => {
  await drainOthers();
  const f = await seedFixture({ noApproval: true });
  const { deps, calls } = fakeAdvisoryDeps();

  await worker.deliverOnce("adv-unapproved", { deps });

  assert.equal(calls.mint, 0);
  assert.equal(calls.create, 0);
  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /approved decision/);
});
