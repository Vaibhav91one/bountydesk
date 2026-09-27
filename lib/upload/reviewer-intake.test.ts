import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The reviewer-upload half of intake against a real Postgres. The point of these is the difference
 * from the public path: the report is created with its contact already proven (no OTP), it is not
 * held at NEEDS_DECISION, and the build is queued in one call. The material validation itself is
 * the public path's and is covered by intake.test.ts, so it is not re-proven here.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let intake: typeof import("./intake");
let recipient: typeof import("@/lib/email/recipient");

const REVIEWER = { login: "gatekeeper", email: "reviewer@bountydesk.test" };
const DIGEST = `sha256:${"a".repeat(64)}`;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("reviewer_upload");
  dbm = await import("@/lib/db");
  intake = await import("./intake");
  recipient = await import("@/lib/email/recipient");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function imageSubmission(overrides: Partial<import("./intake").UploadSubmission> = {}) {
  return {
    title: "Broken access control in the admin API",
    body: "Steps to reproduce...",
    contact: REVIEWER.email,
    material: { kind: "image" as const, imageRef: "ghcr.io/vendor/app:1.2", imageDigest: DIGEST },
    ...overrides,
  };
}

async function reportRow(id: string) {
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row;
}

async function uploadRow(id: string) {
  const [row] = await dbm.db.select().from(dbm.uploadIntake).where(dbm.eq(dbm.uploadIntake.reportId, id));
  return row;
}

async function eventTypes(id: string) {
  const rows = await dbm.db
    .select({ type: dbm.sessionEvent.type, data: dbm.sessionEvent.data })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, id));
  return rows;
}

async function reportCount() {
  const [row] = await dbm.db.select({ n: dbm.sql<number>`count(*)::int` }).from(dbm.report);
  return row?.n ?? 0;
}

test("a reviewer upload creates a proven contact, skips the gate, and queues the build", async () => {
  const result = await intake.admitReviewerUpload(imageSubmission(), REVIEWER, {
    port: 3000,
    readinessPath: "/",
  });
  assert.ok(result.ok);
  if (!result.ok) return;

  const row = await reportRow(result.reportId);
  assert.equal(row.channel, "upload");
  // Straight to TRIAGING: never held at NEEDS_DECISION the way an anonymous upload is.
  assert.equal(row.state, "TRIAGING");
  assert.equal(row.reporterContact, REVIEWER.email);
  assert.equal(row.reporterHandle, REVIEWER.login);
  // The contact is proven the moment a reviewer submits, so delivery accepts it without an OTP.
  assert.equal(row.verifiedSender, REVIEWER.email);
  assert.equal(await recipient.isVerifiedEmailRecipient(row), true);
  assert.equal(row.targetProfileId, null);

  const upload = await uploadRow(result.reportId);
  assert.equal(upload.materialKind, "image");
  assert.equal(upload.imageDigest, DIGEST);
  assert.equal(upload.buildState, "PENDING");
  assert.equal(upload.approvedBy, REVIEWER.login);
  assert.ok(upload.reviewedTarget, "the reviewer's target definition is stored for the build loop");

  // No code was ever sent or reserved: this path has no OTP at all.
  assert.equal(await intake.codesSent(result.reportId), 0);

  const events = await eventTypes(result.reportId);
  const verified = events.find((e) => e.type === "upload.contact_verified");
  assert.ok(verified, "the contact is recorded as verified on the audit trail");
  assert.equal((verified.data as { method: string }).method, "reviewer");
  assert.ok(events.some((e) => e.type === "upload.target_approved"), "the build approval is recorded");
});

test("an upload with no material is refused and creates nothing", async () => {
  const before = await reportCount();
  const result = await intake.admitReviewerUpload(imageSubmission({ material: null }), REVIEWER, {
    port: 3000,
    readinessPath: "/",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /material/);
  assert.equal(await reportCount(), before, "no report is created when there is nothing to build");
});

test("bad build settings are refused before any report is created", async () => {
  const before = await reportCount();
  const result = await intake.admitReviewerUpload(imageSubmission(), REVIEWER, {
    port: 0,
    readinessPath: "/",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /port/);
  assert.equal(await reportCount(), before, "invalid target settings leave no orphan report at the gate");
});
