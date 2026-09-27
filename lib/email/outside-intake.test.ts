import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { InboundBody } from "./resend";

/**
 * Outside-sender admission against a real Postgres, because the daily limits are counted from the
 * jobs table itself. The Resend reads are faked, so each case controls SPF, DKIM, alignment and
 * size exactly. The alignment parser itself is covered in lib/email/alignment.test.ts.
 */
let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let intake: typeof import("./outside-intake");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("outside_intake");

  dbm = await import("@/lib/db");
  intake = await import("./outside-intake");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;
/** Resend id -> From domain, so the faked raw headers can align with the message under test. */
const domains = new Map<string, string>();

function email(from: string) {
  seq += 1;
  domains.set(`eid-${seq}`, from.split("@")[1]);
  return {
    messageId: `<outside-${seq}@mail.test>`,
    resendEmailId: `eid-${seq}`,
    fromEmail: from,
    fromName: null,
    subject: "XSS",
    text: "",
  };
}

/** The receiving MX's header block, with its Authentication-Results for `domain`. */
function headersFor(domain: string) {
  return [
    "Received: by inbound-smtp.amazonaws.com",
    `Authentication-Results: amazonses.com; spf=pass envelope-from=x@${domain}; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain};`,
    "X-SES-RECEIPT: AEFB",
    `From: <someone@${domain}>`,
    "",
  ].join("\r\n");
}

/** Faked Resend reads. The raw headers align with the message's From unless a test pins its own. */
function fetched(overrides: Partial<InboundBody> = {}, headers?: string) {
  let calls = 0;
  const fetchBody = async (resendEmailId: string): Promise<InboundBody> => {
    calls += 1;
    return {
      text: "steps",
      html: "",
      spf: "pass",
      dkim: "pass",
      sizeBytes: 5,
      rawUrl: `https://raw.test/${resendEmailId}`,
      ...overrides,
    };
  };
  const fetchHeaders = async (rawUrl: string) =>
    headers ?? headersFor(domains.get(rawUrl.slice("https://raw.test/".length)) ?? "unknown.test");
  return { fetchBody, fetchHeaders, calls: () => calls };
}

async function jobFor(messageId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.deliveryId, messageId))
    .limit(1);
  return row;
}

test("a sender passing SPF, DKIM and From alignment is queued as an outside report with its verified address", async () => {
  const message = email("alice@good.test");

  assert.deepEqual(await intake.admitOutsideEmail(message, fetched()), { accepted: true });

  const job = await jobFor(message.messageId);
  const payload = job.payload as { intake: string; verifiedSender: string };
  assert.equal(payload.intake, "outside");
  assert.equal(payload.verifiedSender, "alice@good.test");
});

for (const [label, overrides] of [
  ["SPF fails", { spf: "fail" }],
  ["DKIM fails", { dkim: "fail" }],
  ["DKIM is unsigned or unaligned (gray)", { dkim: "gray" }],
  ["SPF is a softfail (gray)", { spf: "gray" }],
  ["Resend reported no verdict", { spf: "unknown", dkim: "unknown" }],
] as const) {
  test(`a message is dropped when ${label}`, async () => {
    const message = email("mallory@spoof.test");

    const result = await intake.admitOutsideEmail(message, fetched(overrides));

    assert.equal(result.accepted, false);
    assert.match((result as { reason: string }).reason, /not authenticated/);
    assert.equal(await jobFor(message.messageId), undefined, "no job, so no report");
  });
}

test("a forged From whose SPF and DKIM passed for another domain is dropped", async () => {
  const message = email("victim@bigcorp.test");
  const attacker = [
    "Received: by inbound-smtp.amazonaws.com",
    "Authentication-Results: amazonses.com; spf=pass envelope-from=x@attacker.test; dkim=pass header.i=@attacker.test; dmarc=fail header.from=bigcorp.test;",
    "X-SES-RECEIPT: AEFB",
    // The attacker's own copy, below the receiving MX's, claiming the opposite.
    "Authentication-Results: amazonses.com; dkim=pass header.d=bigcorp.test; dmarc=pass header.from=bigcorp.test;",
    "From: <victim@bigcorp.test>",
    "",
  ].join("\r\n");

  const result = await intake.admitOutsideEmail(message, fetched({}, attacker));

  assert.equal(result.accepted, false);
  assert.match((result as { reason: string }).reason, /From not aligned/);
  assert.equal(await jobFor(message.messageId), undefined);
});

test("a message with no raw copy to check alignment against is dropped", async () => {
  const message = email("noraw@good.test");
  assert.equal((await intake.admitOutsideEmail(message, fetched({ rawUrl: null }))).accepted, false);
  assert.equal(await jobFor(message.messageId), undefined);
});

test("a verified message over the size cap is dropped and its sender is told once", async () => {
  const message = email("big@good.test");
  const notified: string[] = [];

  const result = await intake.admitOutsideEmail(message, {
    ...fetched({ sizeBytes: intake.OUTSIDE_LIMITS.maxBytes + 1 }),
    notifyOversized: async (e) => void notified.push(e.fromEmail),
  });

  assert.equal(result.accepted, false);
  // The notice goes only to the address the receiving MX authenticated (SPF, DKIM and alignment
  // all passed above), so it cannot be aimed at a third party.
  assert.deepEqual(notified, ["big@good.test"]);
  // The drop spends a daily slot so it cannot amplify, recorded as a terminal row the worker never
  // claims rather than a report.
  const row = await jobFor(message.messageId);
  assert.equal(row.state, "DONE");
  assert.equal((row.payload as { drop?: string; intake?: string }).drop, "oversized");
  assert.equal((row.payload as { intake?: string }).intake, "outside");
});

test("an oversized message that fails SPF/DKIM is dropped with no notice", async () => {
  const message = email("mallory@spoof.test");
  const notified: string[] = [];

  const result = await intake.admitOutsideEmail(message, {
    ...fetched({ spf: "fail", sizeBytes: intake.OUTSIDE_LIMITS.maxBytes + 1 }),
    notifyOversized: async (e) => void notified.push(e.fromEmail),
  });

  assert.equal(result.accepted, false);
  assert.match((result as { reason: string }).reason, /not authenticated/);
  // A forged oversized message must not be a lever to mail an arbitrary address.
  assert.deepEqual(notified, []);
  assert.equal(await jobFor(message.messageId), undefined);
});

test("an oversized message whose From is not aligned is dropped with no notice", async () => {
  const message = email("victim@bigcorp.test");
  const attacker = [
    "Received: by inbound-smtp.amazonaws.com",
    "Authentication-Results: amazonses.com; spf=pass envelope-from=x@attacker.test; dkim=pass header.i=@attacker.test; dmarc=fail header.from=bigcorp.test;",
    // Without this receipt line checkFromAlignment bails before it even reaches dmarc/dkim, so the
    // test would pass for the wrong reason; with it, the drop is the alignment check doing its job.
    "X-SES-RECEIPT: AEFB",
    "From: <victim@bigcorp.test>",
    "",
  ].join("\r\n");
  const notified: string[] = [];

  const result = await intake.admitOutsideEmail(message, {
    ...fetched({ sizeBytes: intake.OUTSIDE_LIMITS.maxBytes + 1 }, attacker),
    notifyOversized: async (e) => void notified.push(e.fromEmail),
  });

  assert.equal(result.accepted, false);
  assert.match((result as { reason: string }).reason, /From not aligned/);
  assert.deepEqual(notified, []);
  assert.equal(await jobFor(message.messageId), undefined, "a forged oversized message spends no slot");
});

test("the oversized notice is bounded by the daily per-sender limit", async () => {
  const sender = "flood@bounded.test";
  const notified: string[] = [];
  const notifyOversized = async (e: { messageId: string }) => void notified.push(e.messageId);
  const over = { sizeBytes: intake.OUTSIDE_LIMITS.maxBytes + 1 };

  // Each of the first perSenderPerDay oversized messages spends a slot and mails the sender once.
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perSenderPerDay; i += 1) {
    const admission = await intake.admitOutsideEmail(email(sender), { ...fetched(over), notifyOversized });
    assert.equal(admission.accepted, false);
  }
  assert.equal(notified.length, intake.OUTSIDE_LIMITS.perSenderPerDay);

  // The next one is over budget: dropped in silence, with no further outbound mail and no new row.
  const message = email(sender);
  const admission = await intake.admitOutsideEmail(message, { ...fetched(over), notifyOversized });
  assert.equal(admission.accepted, false);
  assert.equal(notified.length, intake.OUTSIDE_LIMITS.perSenderPerDay, "no notice once over the cap");
  assert.equal(await jobFor(message.messageId), undefined, "the over-budget drop spends no slot");
});

test("a notice-send failure does not rethrow, so the inbound message is not redelivered", async () => {
  const message = email("throwing@fail.test");

  // sendOversizedNotice rethrows a transient Resend error; admitOutsideEmail must swallow it, or the
  // route turns it into a 5xx and Resend redelivers the whole message, retrying the send each time.
  const result = await intake.admitOutsideEmail(message, {
    ...fetched({ sizeBytes: intake.OUTSIDE_LIMITS.maxBytes + 1 }),
    notifyOversized: async () => {
      throw new Error("resend 429");
    },
  });

  assert.equal(result.accepted, false);
  // The slot is still spent: on a send failure we err toward less outbound mail, not more.
  const row = await jobFor(message.messageId);
  assert.equal((row.payload as { drop?: string }).drop, "oversized");
});

test("a message with no Resend id cannot be verified and is dropped without a fetch", async () => {
  const message = { ...email("noid@good.test"), resendEmailId: null };
  const fake = fetched();

  assert.equal((await intake.admitOutsideEmail(message, fake)).accepted, false);
  assert.equal(fake.calls(), 0);
});

test("a sender over its daily limit is dropped before Resend is asked", async () => {
  const sender = "prolific@busy.test";
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perSenderPerDay; i += 1) {
    assert.equal((await intake.admitOutsideEmail(email(sender), fetched())).accepted, true);
  }

  const fake = fetched();
  const over = email(sender);
  const result = await intake.admitOutsideEmail(over, fake);

  assert.deepEqual(result, { accepted: false, reason: "sender over its daily limit" });
  assert.equal(fake.calls(), 0, "the limit is checked before the provider fetch");
  assert.equal(await jobFor(over.messageId), undefined);
});

test("a domain over its daily limit is dropped even from a new sender", async () => {
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perDomainPerDay; i += 1) {
    assert.equal((await intake.admitOutsideEmail(email(`user${i}@crowd.test`), fetched())).accepted, true);
  }

  const result = await intake.admitOutsideEmail(email("newcomer@crowd.test"), fetched());

  assert.deepEqual(result, { accepted: false, reason: "domain over its daily limit" });
});

test("mail that failed SPF/DKIM does not spend the real sender's quota", async () => {
  const victim = "victim@target.test";
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perSenderPerDay + 3; i += 1) {
    await intake.admitOutsideEmail(email(victim), fetched({ spf: "fail" }));
  }

  assert.equal((await intake.admitOutsideEmail(email(victim), fetched())).accepted, true);
});

test("a redelivery of an accepted message is not counted against itself", async () => {
  const sender = "redeliver@edge.test";
  const messages = Array.from({ length: intake.OUTSIDE_LIMITS.perSenderPerDay }, () => email(sender));
  for (const message of messages) await intake.admitOutsideEmail(message, fetched());

  assert.deepEqual(await intake.admitOutsideEmail(messages[0], fetched()), { accepted: true });
});

test("a Resend outage throws so the webhook can be redelivered", async () => {
  await assert.rejects(
    intake.admitOutsideEmail(email("later@good.test"), {
      ...fetched(),
      fetchBody: async () => {
        throw new Error("resend receiving fetch failed to connect");
      },
    }),
  );
});

/**
 * overLimit is a pure decision over already-counted rows plus the tunable config, so these need no
 * database: the point is the exemption logic. An exempt domain (a free-mail provider) is not charged
 * the shared per-domain bucket, but the per-sender cap binds it like anyone else.
 */
const limitConfig = {
  perSenderPerDay: 5,
  perDomainPerDay: 20,
  maxBytes: 512 * 1024,
  exemptDomains: ["gmail.com"],
};

test("overLimit caps a sender at the per-sender limit even on an exempt domain", () => {
  assert.equal(
    intake.overLimit({ sender: 5, domain: 0 }, "a@gmail.com", limitConfig),
    "sender over its daily limit",
  );
});

test("overLimit skips the per-domain cap for an exempt domain", () => {
  assert.equal(intake.overLimit({ sender: 0, domain: 999 }, "a@gmail.com", limitConfig), null);
});

test("overLimit still caps a non-exempt domain", () => {
  assert.equal(
    intake.overLimit({ sender: 0, domain: 20 }, "a@company.test", limitConfig),
    "domain over its daily limit",
  );
});

test("normalizeSender collapses gmail dots and subaddressing and folds googlemail into gmail", () => {
  assert.equal(intake.normalizeSender("A.B+tag@GoogleMail.com"), "ab@gmail.com");
  assert.equal(intake.normalizeSender("a.b@gmail.com"), "ab@gmail.com");
  // Subaddressing is stripped on any domain; dots are left alone off gmail.
  assert.equal(intake.normalizeSender("dev+anything@company.test"), "dev@company.test");
  assert.equal(intake.normalizeSender("plain@company.test"), "plain@company.test");
});

test("gmail subaddress and dot variants of one mailbox share a single per-sender bucket", async () => {
  // Five spellings, all delivered to one Gmail inbox and all passing auth, exhaust the 5/day cap
  // together. Without normalization each would be a fresh sender under an exempt domain with no
  // ceiling, which is the flood this fix closes.
  const variants = [
    "flood+1@gmail.com",
    "flood+2@gmail.com",
    "fl.ood+x@gmail.com",
    "f.l.o.o.d@gmail.com",
    "flood+again@gmail.com",
  ];
  for (const from of variants) {
    assert.deepEqual(await intake.admitOutsideEmail(email(from), fetched()), { accepted: true });
  }

  const result = await intake.admitOutsideEmail(email("flood@gmail.com"), fetched());
  assert.deepEqual(result, { accepted: false, reason: "sender over its daily limit" });
});

test("two different gmail mailboxes keep independent per-sender buckets", async () => {
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perSenderPerDay; i += 1) {
    assert.equal((await intake.admitOutsideEmail(email("alice@gmail.com"), fetched())).accepted, true);
  }
  // alice is capped, but bob is a distinct mailbox on the same exempt domain, so #242's intent holds.
  assert.equal((await intake.admitOutsideEmail(email("alice@gmail.com"), fetched())).accepted, false);
  assert.equal((await intake.admitOutsideEmail(email("bob@gmail.com"), fetched())).accepted, true);
});

test("a plus tag is stripped on a non-gmail domain too", async () => {
  // subaddr.test is not exempt, but the per-sender cap (5) bites before the per-domain cap (20), so
  // this isolates the subaddress collapse from the domain check.
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perSenderPerDay; i += 1) {
    assert.equal((await intake.admitOutsideEmail(email(`dev+${i}@subaddr.test`), fetched())).accepted, true);
  }
  const result = await intake.admitOutsideEmail(email("dev+final@subaddr.test"), fetched());
  assert.deepEqual(result, { accepted: false, reason: "sender over its daily limit" });
});

test("an exempt domain still has no aggregate ceiling across distinct mailboxes", async () => {
  // More distinct Gmail mailboxes than the per-domain cap, one message each: all accepted, because
  // the exemption is preserved and the per-sender cap never bites at one apiece.
  for (let i = 0; i < intake.OUTSIDE_LIMITS.perDomainPerDay + 3; i += 1) {
    assert.equal((await intake.admitOutsideEmail(email(`person${i}@gmail.com`), fetched())).accepted, true);
  }
});
