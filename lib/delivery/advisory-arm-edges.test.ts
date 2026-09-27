import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { GitHubRequestError, type Advisory, type AdvisoryContent } from "@/lib/github/advisory";

/**
 * The advisory delivery arm's refusal and hold edges, the branches advisory-arm.test.ts does not
 * cover: a GitHub 422 on the write, a source ref that parses as neither a reply nor a create, a
 * create target that no longer names the bound repository, and a grant revoked between approval and
 * send on the email-to-advisory create path. A separate file from advisory-arm.test.ts on purpose,
 * so the two do not collide.
 *
 * Real Postgres, because the shared delivery gates and the activeRepository re-check are rows; the
 * GitHub advisory API is faked so each refusal is forced deterministically.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let worker: typeof import("./worker");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("advisory_arm_edges");
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
 * The two advisory calls backed by a map keyed by ghsa_id, the same shape as advisory-arm.test.ts.
 * `updateThrows` and `createThrows` let a write raise the GitHub error the hold path is meant to
 * catch, without a real network.
 */
function fakeAdvisoryDeps(
  seeded: { ghsaId: string; description: string } | null,
  opts: { updateThrows?: GitHubRequestError; createThrows?: GitHubRequestError } = {},
) {
  const store = new Map<string, { ghsaId: string; htmlUrl: string; summary: string; description: string }>();
  if (seeded) {
    store.set(seeded.ghsaId, {
      ghsaId: seeded.ghsaId,
      htmlUrl: `https://github.com/advisories/${seeded.ghsaId}`,
      summary: "reporter summary",
      description: seeded.description,
    });
  }
  const calls = { mint: 0, get: 0, update: 0, create: 0, find: 0 };
  const deps: import("./arm").DeliveryDeps = {
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
    getAdvisory: async ({ ghsaId }): Promise<AdvisoryContent> => {
      calls.get++;
      const found = store.get(ghsaId);
      if (!found) throw new GitHubRequestError(404, "fake: advisory not found");
      return { ...found };
    },
    updateAdvisoryDescription: async ({ ghsaId, description }): Promise<Advisory> => {
      calls.update++;
      if (opts.updateThrows) throw opts.updateThrows;
      const existing = store.get(ghsaId);
      if (!existing) throw new GitHubRequestError(404, "fake: advisory not found");
      existing.description = description;
      return { ghsaId, htmlUrl: existing.htmlUrl };
    },
    findAdvisoryByMarker: async ({ markers }): Promise<(Advisory & { marker: string }) | null> => {
      calls.find++;
      for (const adv of store.values()) {
        const marker = markers.find((m) => adv.description.includes(m));
        if (marker) return { ghsaId: adv.ghsaId, htmlUrl: adv.htmlUrl, marker };
      }
      return null;
    },
    createDraftAdvisory: async ({ summary, description }): Promise<Advisory> => {
      calls.create++;
      if (opts.createThrows) throw opts.createThrows;
      const ghsaId = `GHSA-new-${randomUUID().slice(0, 4)}-dddd`;
      store.set(ghsaId, { ghsaId, htmlUrl: `https://github.com/advisories/${ghsaId}`, summary, description });
      return { ghsaId, htmlUrl: `https://github.com/advisories/${ghsaId}` };
    },
  };
  return { deps, calls, store };
}

/**
 * A fully connected advisory-channel report with a verdict and one outbound_delivery row. The knobs
 * shape the source ref and the outbox target, which are what the arm parses and re-checks.
 */
async function seedFixture(
  opts: {
    suspended?: boolean;
    // A source ref that is neither a create sentinel nor a github:...:advisory:<ghsa> reply target.
    badSourceRef?: boolean;
    // An email report bound to an advisory-capable repo: channel email, and an outbox row whose
    // channel override is advisory and whose target is the create sentinel for the repo.
    emailAdvisory?: boolean;
    // An email->advisory create target that names a different repository than the report's.
    createTargetOtherRepo?: boolean;
  } = {},
) {
  seq += 1;
  const n = seq;
  const repoId = 550000 + n;
  const ghsaId = `GHSA-edge${n}-aaaa-bbbb`;

  const [installation] = await dbm.db
    .insert(dbm.githubInstallation)
    .values({
      installationId: 750000 + n,
      accountLogin: `acct-${n}`,
      accountId: 650000 + n,
      accountType: "User",
      suspendedAt: opts.suspended ? new Date() : null,
    })
    .returning({ id: dbm.githubInstallation.id });

  const [tp] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `target-${n}`, imageDigest: `sha256:fixture-${n}` })
    .returning({ id: dbm.targetProfile.id });

  const fullName = `acme/adv-edge-${n}`;
  let sourceRef: string;
  if (opts.badSourceRef) {
    sourceRef = `github:${repoId}:advisory:`; // group 2 empty, so the reply pattern does not match
  } else if (opts.emailAdvisory) {
    sourceRef = `email:<msg-${n}@mail.example>`;
  } else {
    sourceRef = `github:${repoId}:advisory:${ghsaId}`;
  }
  const outboxTarget = opts.emailAdvisory
    ? `github:${opts.createTargetOtherRepo ? repoId + 4242 : repoId}:advisory:create`
    : sourceRef;

  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({ installationId: installation.id, repoId, fullName, targetProfileId: tp.id })
    .returning({ id: dbm.connectedRepository.id });

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: opts.emailAdvisory ? "email" : "advisory",
      sourceRef,
      title: `advisory edge report ${n}`,
      body: "body",
      state: "DELIVERING",
      connectedRepositoryId: repo.id,
      targetProfileId: tp.id,
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const payload = `Analysis of the advisory. No reproduction.\n${marker}`;
  const contentHash = fakeHash(payload);

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({ id: verdictId, reportId: r.id, outcome: "ANALYSIS_ONLY", summary: "summary", payload, contentHash })
    .returning({ id: dbm.verdict.id });

  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId: v.id,
    reviewer: "test-reviewer",
    decision: "APPROVED",
    payloadHash: contentHash,
  });

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId: v.id,
      idempotencyKey: `verdict:${verdictId}`,
      target: outboxTarget,
      channel: opts.emailAdvisory ? "advisory" : null,
      approvedContentHash: contentHash,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, verdictId: v.id, deliveryId: d.id, payload, marker, ghsaId };
}

/** claim() inside deliverOnce is global; retire every other row first. */
async function drainOthers() {
  await dbm.db.update(dbm.outboundDelivery).set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

async function deliveryRow(id: string) {
  const [row] = await dbm.db
    .select({
      state: dbm.outboundDelivery.state,
      lastError: dbm.outboundDelivery.lastError,
      rhr: dbm.outboundDelivery.requiresHumanReview,
    })
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, id));
  return row;
}

async function reportState(id: string) {
  const [row] = await dbm.db.select({ state: dbm.report.state }).from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row.state;
}

test("a 422 on the advisory write is held for a human, not retried", async () => {
  await drainOthers();
  const f = await seedFixture();
  // getAdvisory finds the reporter's advisory with no marker yet, so the arm attempts the PATCH,
  // and GitHub rejects the edit with a 422.
  const { deps, calls } = fakeAdvisoryDeps(
    { ghsaId: f.ghsaId, description: "the reporter's original report" },
    { updateThrows: new GitHubRequestError(422, "fake: unprocessable advisory edit") },
  );

  const id = await worker.deliverOnce("adv-422", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.get, 1);
  assert.equal(calls.update, 1, "the write was attempted before it was refused");

  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.rhr, true, "a 422 is not fixed by retrying, so it is held");
  // A 422 is a validation error on the drafted advisory, not a permission or feature gap, so the
  // held message names it as such and does not send a human to change a permission.
  assert.match(row.lastError ?? "", /validation error rather than a permission problem/);
  assert.doesNotMatch(row.lastError ?? "", /accept "Repository security advisories: write"/);
  assert.equal(await reportState(f.reportId), "DELIVERING");
});

test("an unparseable advisory source ref is refused before any GitHub call", async () => {
  await drainOthers();
  const f = await seedFixture({ badSourceRef: true });
  const { deps, calls } = fakeAdvisoryDeps(null);

  const id = await worker.deliverOnce("adv-bad-ref", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.mint, 0, "an unparseable ref never mints a token");
  assert.equal(calls.get, 0);

  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /unparseable advisory source ref/);
  // A malformed ref is a plain refusal, not a hold: no human action reconnects it.
  assert.equal(row.rhr, false);
});

test("a create target that names a different repository is refused", async () => {
  await drainOthers();
  const f = await seedFixture({ emailAdvisory: true, createTargetOtherRepo: true });
  const { deps, calls } = fakeAdvisoryDeps(null);

  const id = await worker.deliverOnce("adv-create-mismatch", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.create, 0, "a target that moved never opens a draft");

  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /target does not match/);
  assert.equal(await reportState(f.reportId), "DELIVERING");
});

test("email-to-advisory: a grant revoked between approval and send is held, with no draft opened", async () => {
  await drainOthers();
  const f = await seedFixture({ emailAdvisory: true, suspended: true });
  const { deps, calls } = fakeAdvisoryDeps(null);

  const id = await worker.deliverOnce("adv-email-revoked", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.mint, 0, "a refused repository never mints a token");
  assert.equal(calls.create, 0);
  assert.equal(calls.find, 0);

  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.rhr, true, "a lost grant is held for a human to reconnect");
  assert.match(row.lastError ?? "", /no longer connected/);
  assert.equal(await reportState(f.reportId), "DELIVERING");
});
