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

test("a message over the size cap is dropped", async () => {
  const message = email("big@good.test");

  const result = await intake.admitOutsideEmail(
    message,
    fetched({ sizeBytes: intake.OUTSIDE_LIMITS.maxBytes + 1 }),
  );

  assert.equal(result.accepted, false);
  assert.equal(await jobFor(message.messageId), undefined);
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
