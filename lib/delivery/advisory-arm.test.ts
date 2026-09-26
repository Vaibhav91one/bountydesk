import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { GitHubRequestError, type Advisory, type AdvisoryContent } from "@/lib/github/advisory";

/**
 * The advisory delivery arm against a real Postgres, with the GitHub advisory API faked so the
 * update, replay and refusal paths are deterministic. The shared delivery gates (hash, approval,
 * marker, report state) run for real through deliverOnce, so the approval-gate checks here are the
 * same code path a GitHub-comment delivery takes, exercised on the advisory channel.
 *
 * The key property: an advisory-channel report came from the reporter's own advisory, whose GHSA id
 * is in the source_ref, so delivery edits that advisory rather than opening a new draft.
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
 * A stand-in for the two GitHub advisory calls, backed by a map keyed by ghsa_id. getAdvisory reads
 * the reporter's advisory the report names, and updateAdvisoryDescription edits that same row, so a
 * retry then reads back what the last write left.
 */
function fakeAdvisoryDeps(seeded: { ghsaId: string; description: string } | null) {
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
  let created = 0;
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
      const existing = store.get(ghsaId);
      if (!existing) throw new GitHubRequestError(404, "fake: advisory not found");
      existing.description = description;
      return { ghsaId, htmlUrl: existing.htmlUrl };
    },
    // The email->advisory create path. findAdvisoryByMarker scans the draft store the way the real
    // list-advisories call scans open drafts, so a retry after a create finds its own draft again.
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
      created += 1;
      const ghsaId = `GHSA-new${created}-cccc-dddd`;
      store.set(ghsaId, {
        ghsaId,
        htmlUrl: `https://github.com/advisories/${ghsaId}`,
        summary,
        description,
      });
      return { ghsaId, htmlUrl: `https://github.com/advisories/${ghsaId}` };
    },
  };
  return { deps, calls, store };
}

/** A fully connected advisory-channel report with a verdict and one outbound_delivery row. */
async function seedFixture(
  opts: {
    suspended?: boolean;
    noApproval?: boolean;
    wrongApprovedHash?: boolean;
    reportState?: "DELIVERING" | "AWAITING_APPROVAL";
    // An email report bound to an advisory-capable repo: channel email, source_ref email:..., and an
    // outbox row whose channel override is advisory and whose target names the repo for a create.
    emailAdvisory?: boolean;
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
  // An advisory-channel report names its own advisory; an email->advisory report has no GHSA yet, so
  // its source_ref is the inbound message and the outbox target is the create sentinel for the repo.
  const sourceRef = opts.emailAdvisory ? `email:<msg-${n}@mail.example>` : `github:${repoId}:advisory:${ghsaId}`;
  const outboxTarget = opts.emailAdvisory ? `github:${repoId}:advisory:create` : sourceRef;
  const [repo] = await dbm.db
    .insert(dbm.connectedRepository)
    .values({ installationId: installation.id, repoId, fullName, targetProfileId: tp.id })
    .returning({ id: dbm.connectedRepository.id });

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: opts.emailAdvisory ? "email" : "advisory",
      sourceRef,
      title: `advisory report ${n}`,
      body: "body",
      state: opts.reportState ?? "DELIVERING",
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
    .values({
      id: verdictId,
      reportId: r.id,
      outcome: "ANALYSIS_ONLY",
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
      target: outboxTarget,
      channel: opts.emailAdvisory ? "advisory" : null,
      approvedContentHash: opts.wrongApprovedHash ? "tampered-hash" : contentHash,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, verdictId: v.id, deliveryId: d.id, payload, marker, ghsaId, sourceRef };
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

test("delivery edits the reporter's advisory by its GHSA id, not a new draft", async () => {
  await drainOthers();
  const f = await seedFixture();
  // The reporter's advisory as it stands before the verdict: their original writeup.
  const { deps, calls, store } = fakeAdvisoryDeps({ ghsaId: f.ghsaId, description: "the reporter's original report" });

  const id = await worker.deliverOnce("adv-update", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.get, 1);
  assert.equal(calls.update, 1);
  assert.equal((await deliveryRow(f.deliveryId)).state, "SENT");
  assert.equal(await reportState(f.reportId), "DELIVERED");

  // The advisory the report named now carries the approved payload, byte for byte, marker included.
  assert.equal(store.size, 1, "no second advisory is opened");
  assert.equal(store.get(f.ghsaId)?.description, f.payload);
});

test("crash recovery: an advisory already carrying this verdict's marker is a replay, not a second edit", async () => {
  await drainOthers();
  const f = await seedFixture();
  // A prior attempt already PATCHed the description before it could commit SENT.
  const { deps, calls } = fakeAdvisoryDeps({ ghsaId: f.ghsaId, description: f.payload });

  const id = await worker.deliverOnce("adv-replay", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.update, 0, "a marker already present must never edit again");
  assert.equal((await deliveryRow(f.deliveryId)).state, "SENT");
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("a later revision PATCHes the same advisory up to the new approved text", async () => {
  await drainOthers();
  const f = await seedFixture();
  // The advisory carries an earlier revision's text (a different verdict's marker).
  const earlier = `Earlier revision.\n<!-- bountydesk-delivery:${randomUUID()} -->`;
  const { deps, calls, store } = fakeAdvisoryDeps({ ghsaId: f.ghsaId, description: earlier });

  const id = await worker.deliverOnce("adv-revise", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.update, 1);
  assert.equal(store.get(f.ghsaId)?.description, f.payload);
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("an advisory the App cannot read is refused and held, not delivered", async () => {
  await drainOthers();
  const f = await seedFixture();
  // getAdvisory 404s: the installation never accepted advisories:read, or cannot see this one.
  const { deps, calls } = fakeAdvisoryDeps(null);

  const id = await worker.deliverOnce("adv-404", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.update, 0);
  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.rhr, true);
  assert.match(row.lastError ?? "", /refused the advisory write/);
  assert.equal(await reportState(f.reportId), "DELIVERING");
});

test("the grant revoked between intake and send is refused and held, not delivered", async () => {
  await drainOthers();
  const f = await seedFixture({ suspended: true });
  const { deps, calls } = fakeAdvisoryDeps({ ghsaId: f.ghsaId, description: "original" });

  const id = await worker.deliverOnce("adv-revoked", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.mint, 0, "a refused repository must never mint a token");
  assert.equal(calls.get, 0);

  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.equal(row.rhr, true, "a lost grant is held for a human to reconnect");
  assert.match(row.lastError ?? "", /no longer connected/);
  assert.equal(await reportState(f.reportId), "DELIVERING");
});

test("the approval-gate hash triple-check still holds for the advisory channel", async () => {
  await drainOthers();
  const f = await seedFixture({ wrongApprovedHash: true });
  const { deps, calls } = fakeAdvisoryDeps({ ghsaId: f.ghsaId, description: "original" });

  await worker.deliverOnce("adv-tampered", { deps });

  assert.equal(calls.mint, 0, "a hash mismatch must be caught before any GitHub call");
  assert.equal(calls.get, 0);
  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /content hash mismatch/);
});

test("an outbox row without an approved decision never reaches the advisory API", async () => {
  await drainOthers();
  const f = await seedFixture({ noApproval: true });
  const { deps, calls } = fakeAdvisoryDeps({ ghsaId: f.ghsaId, description: "original" });

  await worker.deliverOnce("adv-unapproved", { deps });

  assert.equal(calls.mint, 0);
  assert.equal(calls.get, 0);
  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /approved decision/);
});

test("an email report bound to an advisory-capable repo opens a draft advisory and delivers", async () => {
  await drainOthers();
  const f = await seedFixture({ emailAdvisory: true });
  // No advisory exists yet: this is the reporter's first contact through the repo's advisory surface.
  const { deps, calls, store } = fakeAdvisoryDeps(null);

  const id = await worker.deliverOnce("adv-create", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.find, 1, "the create path looks for an existing draft before opening one");
  assert.equal(calls.create, 1);
  assert.equal(calls.update, 0);
  assert.equal(store.size, 1, "exactly one draft advisory is opened");
  assert.equal([...store.values()][0].description, f.payload, "the draft carries the approved payload byte for byte");
  assert.equal((await deliveryRow(f.deliveryId)).state, "SENT");
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("create-path crash recovery: a draft already carrying this verdict's marker is a replay, not a second draft", async () => {
  await drainOthers();
  const f = await seedFixture({ emailAdvisory: true });
  // A prior attempt opened the draft (its description carries this verdict's marker) but died before
  // committing SENT. The retry must find it by marker and treat it as delivered, never open a twin.
  const { deps, calls, store } = fakeAdvisoryDeps({ ghsaId: "GHSA-prior-aaaa-bbbb", description: f.payload });

  const id = await worker.deliverOnce("adv-create-replay", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.create, 0, "a marker already present must never open a second draft");
  assert.equal(calls.update, 0);
  assert.equal(store.size, 1);
  assert.equal((await deliveryRow(f.deliveryId)).state, "SENT");
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("create-path revision: a draft carrying an earlier revision's marker is PATCHed up, not twinned", async () => {
  await drainOthers();
  const f = await seedFixture({ emailAdvisory: true });
  // A real earlier revision of this report, the one that opened the draft. findAdvisoryByMarker only
  // matches markers of the report's own verdicts, so the earlier revision has to exist as a row.
  const earlierId = randomUUID();
  await dbm.db.insert(dbm.verdict).values({
    id: earlierId,
    reportId: f.reportId,
    revision: 2,
    outcome: "ANALYSIS_ONLY",
    summary: "earlier",
    payload: `Earlier revision.\n<!-- bountydesk-delivery:${earlierId} -->`,
    contentHash: fakeHash("earlier"),
  });
  const earlier = `Earlier revision.\n<!-- bountydesk-delivery:${earlierId} -->`;
  const { deps, calls, store } = fakeAdvisoryDeps({ ghsaId: "GHSA-rev-aaaa-bbbb", description: earlier });

  const id = await worker.deliverOnce("adv-create-revise", { deps });
  assert.equal(id, f.deliveryId);
  assert.equal(calls.create, 0, "an existing draft is reused rather than twinned");
  assert.equal(calls.update, 1);
  assert.equal(store.get("GHSA-rev-aaaa-bbbb")?.description, f.payload);
  assert.equal(await reportState(f.reportId), "DELIVERED");
});

test("the approval-gate hash check still holds on the email->advisory create path", async () => {
  await drainOthers();
  const f = await seedFixture({ emailAdvisory: true, wrongApprovedHash: true });
  const { deps, calls } = fakeAdvisoryDeps(null);

  await worker.deliverOnce("adv-create-tampered", { deps });

  assert.equal(calls.mint, 0, "a hash mismatch must be caught before any GitHub call");
  assert.equal(calls.create, 0);
  const row = await deliveryRow(f.deliveryId);
  assert.equal(row.state, "FAILED");
  assert.match(row.lastError ?? "", /content hash mismatch/);
});
