import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The worker's channel routing, the ARMS map in worker.ts. Two edges the per-arm tests do not
 * reach: an upload-channel report is carried by the same emailArm as email, and a channel with no
 * arm at all is refused cleanly rather than throwing. Real Postgres, because the shared gates the
 * report passes on its way to the arm are all rows; the transport is faked so the send is
 * deterministic.
 */
const OWNER = "reporter@bountydesk.test";
process.env.REVIEWER_EMAILS = OWNER;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let worker: typeof import("./worker");
let emailArmModule: typeof import("./email");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("delivery_routing");

  dbm = await import("@/lib/db");
  worker = await import("./worker");
  emailArmModule = await import("./email");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function fakeHash(payload: string): string {
  return `fake-hash:${payload.length}:${payload.slice(0, 12)}`;
}

let seq = 0;

/**
 * A report with no GitHub side: no installation, connected repository or target profile. The
 * channel and source ref are the knobs, because those are what pick the arm. An OTP-verified
 * upload records its proven contact as verified_sender, which is exactly what an outside email
 * report does, so the recipient re-check reads the same column for both.
 */
async function seedFixture(opts: {
  channel: "upload" | "manual";
  sourceRef: string;
  reporterContact?: string | null;
  verifiedSender?: string | null;
}) {
  seq += 1;
  const contact = opts.reporterContact === undefined ? OWNER : opts.reporterContact;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: opts.channel,
      sourceRef: opts.sourceRef,
      title: `report ${seq}`,
      body: "steps to reproduce",
      state: "DELIVERING",
      reporterContact: contact,
      verifiedSender: opts.verifiedSender ?? null,
      connectedRepositoryId: null,
      targetProfileId: null,
    })
    .returning({ id: dbm.report.id });

  const verdictId = randomUUID();
  const marker = `<!-- bountydesk-delivery:${verdictId} -->`;
  const payload = `Analysis only.\n${marker}`;
  const contentHash = fakeHash(payload);

  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: "ANALYSIS_ONLY",
    summary: "summary",
    payload,
    contentHash,
  });
  await dbm.db.insert(dbm.approvalDecision).values({
    verdictId,
    reviewer: "test-reviewer",
    decision: "APPROVED",
    payloadHash: contentHash,
  });

  const [d] = await dbm.db
    .insert(dbm.outboundDelivery)
    .values({
      reportId: r.id,
      verdictId,
      idempotencyKey: `verdict:${verdictId}`,
      target: contact ?? opts.sourceRef,
      approvedContentHash: contentHash,
    })
    .returning({ id: dbm.outboundDelivery.id });

  return { reportId: r.id, verdictId, deliveryId: d.id, payload, sourceRef: opts.sourceRef };
}

/** claim() inside deliverOnce is global; retire every other row first (see queue.test.ts). */
async function drainOthers() {
  await dbm.db
    .update(dbm.outboundDelivery)
    .set({ state: "SENT", leaseOwner: null, leaseExpiresAt: null });
}

type SendCall = Parameters<import("./arm").DeliveryDeps["sendEmail"]>[0];

/** Every dep throws except the one an assertion allows, so a mis-route is a failure, not a no-op. */
function makeDeps(sendEmail?: (opts: SendCall) => Promise<{ id: string }>) {
  const sent: SendCall[] = [];
  const deps: import("./arm").DeliveryDeps = {
    githubAppId: 123456,
    hashContent: fakeHash,
    mintToken: async () => {
      throw new Error("this delivery must not mint a GitHub token");
    },
    postComment: async () => {
      throw new Error("this delivery must not post a comment");
    },
    listComments: async () => {
      throw new Error("this delivery must not read comments");
    },
    getAdvisory: async () => {
      throw new Error("this delivery must not touch an advisory");
    },
    updateAdvisoryDescription: async () => {
      throw new Error("this delivery must not touch an advisory");
    },
    createDraftAdvisory: async () => {
      throw new Error("this delivery must not touch an advisory");
    },
    findAdvisoryByMarker: async () => {
      throw new Error("this delivery must not touch an advisory");
    },
    sendEmail: async (opts) => {
      sent.push(opts);
      if (sendEmail) return sendEmail(opts);
      return { id: `re_${sent.length}_${randomUUID().slice(0, 8)}` };
    },
  };
  return { deps, sent };
}

async function readRows(fixture: { reportId: string; deliveryId: string }) {
  const [delivery] = await dbm.db
    .select()
    .from(dbm.outboundDelivery)
    .where(dbm.eq(dbm.outboundDelivery.id, fixture.deliveryId));
  const [reportRow] = await dbm.db
    .select()
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, fixture.reportId));
  return { delivery, report: reportRow };
}

test("an upload report is delivered over the email transport and stays DELIVERING on acceptance", async () => {
  await drainOthers();
  // An OTP-verified upload: the proven contact is an outside address, so its authority is the
  // verified_sender match rather than the reviewer allowlist.
  const contact = "uploader@outside.test";
  const fixture = await seedFixture({
    channel: "upload",
    sourceRef: `upload:${randomUUID()}`,
    reporterContact: contact,
    verifiedSender: contact,
  });
  const { deps, sent } = makeDeps();

  const claimed = await worker.deliverOnce("w-upload", { deps });
  assert.equal(claimed, fixture.deliveryId);

  assert.equal(sent.length, 1, "upload rides emailArm");
  assert.equal(sent[0].to, contact);
  assert.equal(sent[0].text, fixture.payload, "the sent body is the approved payload");
  // An upload has no inbound message to thread onto, so no threading headers are set.
  assert.equal(sent[0].headers, undefined);

  const { delivery, report } = await readRows(fixture);
  assert.equal(delivery.state, "SENT");
  assert.ok(delivery.providerMessageId);
  // Provider acceptance is not a receipt, so the report waits for the delivered webhook.
  assert.equal(report.state, "DELIVERING");
  assert.equal(delivery.deliveredAt, null);
});

test("threadingHeaders returns nothing for an upload source ref", () => {
  assert.equal(emailArmModule.threadingHeaders(`upload:${randomUUID()}`), undefined);
});

test("a channel with no arm is refused cleanly, without touching any transport", async () => {
  await drainOthers();
  // "manual" is a valid channel but has no entry in the ARMS map, so it hits the fallthrough.
  const fixture = await seedFixture({
    channel: "manual",
    sourceRef: "manual:1",
    reporterContact: OWNER,
  });
  const { deps, sent } = makeDeps();

  const claimed = await worker.deliverOnce("w-manual", { deps });
  assert.equal(claimed, fixture.deliveryId);

  assert.equal(sent.length, 0, "an unsupported channel reaches no transport");
  const { delivery, report } = await readRows(fixture);
  assert.equal(delivery.state, "FAILED");
  assert.match(delivery.lastError ?? "", /unsupported delivery channel: manual/);
  assert.equal(report.state, "DELIVERING");
});
