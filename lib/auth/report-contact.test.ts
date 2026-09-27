import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Report-scoped contact OTP against a real schema, because the guarantees worth proving are the
 * database's: a correct code within its window sets verified_sender to the proven contact so
 * isVerifiedEmailRecipient passes, a wrong code spends one of a small number of attempts, and an
 * expired or exhausted code is refused. The uploader never lands in the reviewer allowlist.
 */
process.env.REVIEWER_EMAILS = "owner@bountydesk.test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let mod: typeof import("./report-contact");
let recipient: typeof import("@/lib/email/recipient");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("report_contact");
  dbm = await import("@/lib/db");
  mod = await import("./report-contact");
  recipient = await import("@/lib/email/recipient");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
async function uploadReport(): Promise<string> {
  seq += 1;
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "upload",
      sourceRef: `upload:${seq}`,
      title: `upload ${seq}`,
      body: "body",
    })
    .returning({ id: dbm.report.id });
  return r.id;
}

async function contactRow(reportId: string) {
  const [row] = await dbm.db
    .select({
      reporterContact: dbm.report.reporterContact,
      verifiedSender: dbm.report.verifiedSender,
      contactCodeHash: dbm.report.contactCodeHash,
      contactCodeAttempts: dbm.report.contactCodeAttempts,
    })
    .from(dbm.report)
    .where(dbm.eq(dbm.report.id, reportId));
  return row;
}

test("a correct code verifies the contact and lets delivery accept it", async () => {
  const reportId = await uploadReport();
  const uploader = "person@outside.test";

  const started = await mod.startContactVerification(reportId, " Person@Outside.test ");
  assert.equal(started.status, "code_sent");

  // Before verification, the contact is set but not yet a delivery-eligible recipient.
  assert.equal(
    await recipient.isVerifiedEmailRecipient(await contactRow(reportId)),
    false,
  );

  const verified = await mod.verifyContactCode(reportId, started.code);
  assert.deepEqual(verified, { ok: true });

  const row = await contactRow(reportId);
  assert.equal(row.reporterContact, uploader);
  assert.equal(row.verifiedSender, uploader);
  assert.equal(row.contactCodeHash, null);
  assert.equal(await recipient.isVerifiedEmailRecipient(row), true);
});

test("a wrong code is refused and spends one attempt", async () => {
  const reportId = await uploadReport();
  const started = await mod.startContactVerification(reportId, "wrong@outside.test");
  const wrong = started.code === "000000" ? "000001" : "000000";

  const result = await mod.verifyContactCode(reportId, wrong);
  assert.deepEqual(result, { ok: false, error: "That code is not correct." });

  const row = await contactRow(reportId);
  assert.equal(row.contactCodeAttempts, 1);
  assert.equal(row.verifiedSender, null);
});

test("the attempt cap refuses even a correct code once exhausted", async () => {
  const reportId = await uploadReport();
  const started = await mod.startContactVerification(reportId, "capped@outside.test");

  await dbm.db
    .update(dbm.report)
    .set({ contactCodeAttempts: 5 })
    .where(dbm.eq(dbm.report.id, reportId));

  const result = await mod.verifyContactCode(reportId, started.code);
  assert.deepEqual(result, { ok: false, error: "Too many attempts. Send a new code." });
  assert.equal((await contactRow(reportId)).verifiedSender, null);
});

test("an expired code is refused", async () => {
  const reportId = await uploadReport();
  const started = await mod.startContactVerification(reportId, "expired@outside.test");

  await dbm.db
    .update(dbm.report)
    .set({ contactCodeExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.report.id, reportId));

  const result = await mod.verifyContactCode(reportId, started.code);
  assert.deepEqual(result, { ok: false, error: "That code has expired. Send a new one." });
  assert.equal((await contactRow(reportId)).verifiedSender, null);
});

test("a new code resets an earlier proof so a changed address cannot deliver", async () => {
  const reportId = await uploadReport();
  const first = await mod.startContactVerification(reportId, "first@outside.test");
  await mod.verifyContactCode(reportId, first.code);
  assert.equal((await contactRow(reportId)).verifiedSender, "first@outside.test");

  // Starting again for a different address clears the old proof until the new one is entered.
  await mod.startContactVerification(reportId, "second@outside.test");
  const row = await contactRow(reportId);
  assert.equal(row.reporterContact, "second@outside.test");
  assert.equal(row.verifiedSender, null);
  assert.equal(await recipient.isVerifiedEmailRecipient(row), false);
});
