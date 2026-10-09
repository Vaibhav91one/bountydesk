import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * Appeals against a real Postgres. The properties under test are refusals: a code goes only to the
 * address the delivery went to, only for a verdict that was actually delivered, the same request
 * answers the same for strangers, one appeal stays active per verdict, requests are rate limited,
 * and only a writer reviewer can move an appeal.
 */
const OWNER = "owner@bountydesk.test";
process.env.REVIEWER_EMAILS = OWNER;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let appeals: typeof import("./appeals");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("appeals");
  dbm = await import("@/lib/db");
  appeals = await import("./appeals");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seed(opts: { delivered: boolean; contact?: string; verified?: boolean }) {
  seq += 1;
  const contact = opts.contact ?? `reporter-${seq}@outside.test`;
  const [r] = await dbm.db
    .insert(dbm.report)
    .values({
      channel: "upload",
      sourceRef: `upload:${randomUUID()}`,
      title: `report ${seq}`,
      body: "body",
      state: opts.delivered ? "DELIVERED" : "DELIVERING",
      reporterContact: contact,
      verifiedSender: opts.verified === false ? null : contact,
    })
    .returning({ id: dbm.report.id });
  const verdictId = randomUUID();
  await dbm.db.insert(dbm.verdict).values({
    id: verdictId,
    reportId: r.id,
    outcome: "NOT_REPRODUCED",
    summary: "s",
    payload: `p ${verdictId}`,
    contentHash: `h-${verdictId}`,
  });
  await dbm.db.insert(dbm.outboundDelivery).values({
    reportId: r.id,
    verdictId,
    idempotencyKey: `verdict:${verdictId}`,
    target: contact,
    approvedContentHash: `h-${verdictId}`,
    state: opts.delivered ? "SENT" : "PENDING",
    deliveredAt: opts.delivered ? new Date() : null,
  });
  return { reportId: r.id, verdictId, contact };
}

/** Request a code and return what was mailed, or null when nothing was. */
async function ask(reportId: string, contact: string, ip = `203.0.113.${seq % 250}`) {
  let mailed: { to: string; code: string } | null = null;
  const result = await appeals.requestAppealCode(reportId, contact, ip, async (to, code) => {
    mailed = { to, code };
  });
  return { result, mailed: mailed as { to: string; code: string } | null };
}

test("a code goes to the delivery contact of a delivered verdict and files an appeal", async () => {
  const s = await seed({ delivered: true });
  const { result, mailed } = await ask(s.reportId, s.contact.toUpperCase());
  assert.equal(result.ok, true);
  assert.equal(mailed?.to, s.contact);

  const filed = await appeals.submitAppeal({
    reportId: s.reportId,
    contact: s.contact,
    code: mailed!.code,
    body: "the payload needs a session cookie",
  });
  assert.equal(filed.ok, true);
  const [row] = await appeals.listAppeals(s.reportId);
  assert.equal(row.status, "OPEN");
  assert.equal(row.verdictId, s.verdictId);
  assert.equal(row.contact, s.contact);
});

test("the report's recipient proof is untouched by an appeal request", async () => {
  const s = await seed({ delivered: true });
  await ask(s.reportId, s.contact);
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, s.reportId));
  assert.equal(row.verifiedSender, s.contact);
  assert.equal(row.reporterContact, s.contact);
});

test("a different address gets no code, and its guess is refused like any other bad code", async () => {
  const s = await seed({ delivered: true });
  const { result, mailed } = await ask(s.reportId, "attacker@evil.test");
  assert.equal(result.ok, true, "the response does not differ from the eligible one");
  assert.equal(mailed, null);

  // The real contact's code must not be usable from the attacker's address either.
  const real = await ask(s.reportId, s.contact);
  const stolen = await appeals.submitAppeal({
    reportId: s.reportId,
    contact: "attacker@evil.test",
    code: real.mailed!.code,
    body: "x",
  });
  assert.equal(stolen.ok, false);
  assert.equal((await appeals.listAppeals(s.reportId)).length, 0);
});

test("an unknown report answers like a known one and mails nothing", async () => {
  const { result, mailed } = await ask(randomUUID(), "anyone@outside.test");
  assert.equal(result.ok, true);
  assert.equal(mailed, null);
  const filed = await appeals.submitAppeal({
    reportId: randomUUID(),
    contact: "anyone@outside.test",
    code: "123456",
    body: "x",
  });
  assert.deepEqual(filed, { ok: false, status: 400, error: "That code is not valid. Request a new one." });
});

test("a verdict that was only approved, not delivered, cannot be appealed", async () => {
  const s = await seed({ delivered: false });
  const { mailed } = await ask(s.reportId, s.contact);
  assert.equal(mailed, null);
  const filed = await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: "000000", body: "x" });
  assert.equal(filed.ok, false);
  assert.equal((await appeals.listAppeals(s.reportId)).length, 0);
});

test("a contact whose address was never proven gets no code", async () => {
  const s = await seed({ delivered: true, verified: false });
  const { mailed } = await ask(s.reportId, s.contact);
  assert.equal(mailed, null);
});

test("a second appeal on the same verdict is refused while the first is active, allowed once closed", async () => {
  const s = await seed({ delivered: true });
  const first = await ask(s.reportId, s.contact);
  const filed = await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: first.mailed!.code, body: "one" });
  assert.equal(filed.ok, true);

  const second = await ask(s.reportId, s.contact);
  const dup = await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: second.mailed!.code, body: "two" });
  assert.equal(dup.ok, false);
  if (!dup.ok) assert.equal(dup.status, 409);
  assert.equal((await appeals.listAppeals(s.reportId)).length, 1);

  const closed = await appeals.resolveAppeal(s.reportId, (await appeals.listAppeals(s.reportId))[0].id, "close", { email: OWNER, login: "owner" }, "answered");
  assert.equal(closed.ok, true);
  const third = await ask(s.reportId, s.contact);
  const again = await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: third.mailed!.code, body: "three" });
  assert.equal(again.ok, true);
});

test("a wrong code is refused, counted, and a code is single use", async () => {
  const s = await seed({ delivered: true });
  const { mailed } = await ask(s.reportId, s.contact);
  const wrong = mailed!.code === "000000" ? "111111" : "000000";
  assert.equal((await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: wrong, body: "x" })).ok, false);
  const [row] = await dbm.db.select().from(dbm.appealCode).where(dbm.eq(dbm.appealCode.reportId, s.reportId));
  assert.equal(row.attempts, 1);

  assert.equal((await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: mailed!.code, body: "x" })).ok, true);
  assert.equal((await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: mailed!.code, body: "x" })).ok, false);
});

test("the attempt cap and the expiry refuse even the right code", async () => {
  const capped = await seed({ delivered: true });
  const a = await ask(capped.reportId, capped.contact);
  await dbm.db.update(dbm.appealCode).set({ attempts: 5 }).where(dbm.eq(dbm.appealCode.reportId, capped.reportId));
  assert.equal((await appeals.submitAppeal({ reportId: capped.reportId, contact: capped.contact, code: a.mailed!.code, body: "x" })).ok, false);

  const expired = await seed({ delivered: true });
  const b = await ask(expired.reportId, expired.contact);
  await dbm.db.update(dbm.appealCode).set({ expiresAt: new Date(Date.now() - 1000) }).where(dbm.eq(dbm.appealCode.reportId, expired.reportId));
  assert.equal((await appeals.submitAppeal({ reportId: expired.reportId, contact: expired.contact, code: b.mailed!.code, body: "x" })).ok, false);
});

test("an over-long appeal is refused", async () => {
  const s = await seed({ delivered: true });
  const { mailed } = await ask(s.reportId, s.contact);
  const filed = await appeals.submitAppeal({
    reportId: s.reportId,
    contact: s.contact,
    code: mailed!.code,
    body: "x".repeat(appeals.APPEAL_LIMITS.maxBodyChars + 1),
  });
  assert.equal(filed.ok, false);
});

test("code requests are limited per client address, eligible or not", async () => {
  const ip = "198.51.100.77";
  for (let i = 0; i < appeals.APPEAL_LIMITS.perAddressPerDay; i++) {
    assert.equal((await ask(randomUUID(), "x@outside.test", ip)).result.ok, true);
  }
  const over = await ask(randomUUID(), "x@outside.test", ip);
  assert.equal(over.result.ok, false);
  if (!over.result.ok) assert.equal(over.result.status, 429);
});

test("a report's contact is mailed at most maxCodesPerReportPerDay codes a day", async () => {
  const s = await seed({ delivered: true });
  let sent = 0;
  for (let i = 0; i < appeals.APPEAL_LIMITS.maxCodesPerReportPerDay + 2; i++) {
    sent += (await ask(s.reportId, s.contact, `192.0.2.${i + 1}`)).mailed ? 1 : 0;
  }
  assert.equal(sent, appeals.APPEAL_LIMITS.maxCodesPerReportPerDay);
});

test("only a writer reviewer can acknowledge or close an appeal", async () => {
  const s = await seed({ delivered: true });
  const { mailed } = await ask(s.reportId, s.contact);
  await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: mailed!.code, body: "x" });
  const [row] = await appeals.listAppeals(s.reportId);

  await dbm.db.insert(dbm.reviewer).values({ email: "viewer@bountydesk.test", role: "read_only", verifiedAt: new Date() });
  for (const email of ["viewer@bountydesk.test", "stranger@outside.test", s.contact]) {
    const refused = await appeals.resolveAppeal(s.reportId, row.id, "close", { email, login: "x" });
    assert.equal(refused.ok, false, email);
  }
  assert.equal((await appeals.listAppeals(s.reportId))[0].status, "OPEN");

  assert.equal((await appeals.resolveAppeal(s.reportId, row.id, "acknowledge", { email: OWNER, login: "owner" })).ok, true);
  assert.equal((await appeals.listAppeals(s.reportId))[0].status, "ACKNOWLEDGED");
  assert.equal((await appeals.resolveAppeal(s.reportId, row.id, "close", { email: OWNER, login: "owner" }, "done")).ok, true);
  const [closed] = await appeals.listAppeals(s.reportId);
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.resolvedBy, "owner");
  assert.equal((await appeals.resolveAppeal(s.reportId, row.id, "acknowledge", { email: OWNER, login: "owner" })).ok, false);
});

test("an appeal cannot be moved through a different report's id", async () => {
  const a = await seed({ delivered: true });
  const b = await seed({ delivered: true });
  const { mailed } = await ask(a.reportId, a.contact);
  await appeals.submitAppeal({ reportId: a.reportId, contact: a.contact, code: mailed!.code, body: "x" });
  const [row] = await appeals.listAppeals(a.reportId);
  const result = await appeals.resolveAppeal(b.reportId, row.id, "close", { email: OWNER, login: "owner" });
  assert.equal(result.ok, false);
  assert.equal((await appeals.listAppeals(a.reportId))[0].status, "OPEN");
});

test("spending codes does not free slots in the daily mail cap", async () => {
  const s = await seed({ delivered: true });
  const first = await ask(s.reportId, s.contact, "192.0.2.201");
  await appeals.submitAppeal({ reportId: s.reportId, contact: s.contact, code: first.mailed!.code, body: "x" });
  let sent = 1;
  for (let i = 0; i < 4; i++) sent += (await ask(s.reportId, s.contact, `192.0.2.${202 + i}`)).mailed ? 1 : 0;
  assert.equal(sent, appeals.APPEAL_LIMITS.maxCodesPerReportPerDay);
});
