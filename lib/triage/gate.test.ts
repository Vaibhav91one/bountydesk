import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import type { TrueForgeClient, TurnSnapshot } from "@/lib/trueforge/client";

/**
 * The outside-sender gate end to end against a real Postgres: the worker creating a held report,
 * the acknowledgement and triage it records, and each of the three reviewer decisions. What must
 * hold is that nothing analyses a held report, that each decision acts once, and that the
 * duplicate reply goes out only after a human marks the duplicate.
 */
process.env.REVIEWER_EMAILS = "owner@bountydesk.test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let queue: typeof import("@/lib/jobs/queue");
let worker: typeof import("@/lib/jobs/worker");
let gate: typeof import("./gate");
let notice: typeof import("@/lib/email/notice");
let bind: typeof import("@/lib/targets/bind");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("triage_gate");

  dbm = await import("@/lib/db");
  queue = await import("@/lib/jobs/queue");
  worker = await import("@/lib/jobs/worker");
  gate = await import("./gate");
  notice = await import("@/lib/email/notice");
  bind = await import("@/lib/targets/bind");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

type SendCall = { to: string; subject: string; text: string; idempotencyKey: string; html?: string };

function fakeSend(opts: { fail?: boolean } = {}) {
  const calls: SendCall[] = [];
  const send = async (call: SendCall) => {
    calls.push(call);
    if (opts.fail) throw new Error("connection reset");
    return { id: `re_${calls.length}` };
  };
  return { calls, send: send as unknown as import("@/lib/email/notice").SendNotice };
}

const TRIAGE_REPLY = JSON.stringify({
  summary: "Reporter claims stored XSS in the product review form.",
  vulnerabilityClass: "stored XSS",
  severity: "medium",
  spamLikelihood: "low",
});

function fakeClient(reply: string | null = TRIAGE_REPLY, status: TurnSnapshot["status"] = "done_no_action") {
  const inputs: string[] = [];
  const client = {
    createSession: async () => ({ sessionId: "sess-1" }),
    deleteSession: async () => {},
    createTurn: async (_s: string, input: { type: string; content?: string }[]) => {
      inputs.push(input[0].content ?? "");
      return { turnId: "turn-1", snapshot: { status: "running" } as TurnSnapshot };
    },
    getTurn: async () => ({ status }) as TurnSnapshot,
    getTurnInput: async () => [],
    getFinalSummary: async () => reply,
  } as unknown as TrueForgeClient;
  return { client, inputs };
}

function analysisSpy() {
  const calls: string[] = [];
  const driver: import("@/lib/jobs/worker").AnalysisDriver = {
    ensureSession: async ({ reportId }) => {
      calls.push(`session:${reportId}`);
    },
    run: async ({ reportId }) => {
      calls.push(`run:${reportId}`);
    },
  };
  return { calls, driver };
}

/** claim() is global-FIFO, so retire every earlier row first (see lib/jobs/worker.test.ts). */
async function drain() {
  await dbm.db.update(dbm.inboundJob).set({ state: "DONE", leaseOwner: null, leaseExpiresAt: null });
}

let seq = 0;

async function enqueueEmail(opts: { outside: boolean; from?: string; subject?: string; text?: string }) {
  seq += 1;
  const from = opts.from ?? `researcher${seq}@outside.test`;
  const email = {
    messageId: `<gate-${seq}-${Date.now()}@mail.test>`,
    resendEmailId: null,
    fromEmail: from,
    fromName: null,
    subject: opts.subject ?? `Stored XSS in reviews ${seq}`,
    text: opts.text ?? "The review form stores script tags and runs them for every visitor.",
  };
  const payload = opts.outside ? { ...email, intake: "outside", verifiedSender: from } : email;
  await queue.enqueue({ channel: "email", deliveryId: email.messageId, payload });
  return email;
}

async function reportFor(messageId: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.report)
    .where(dbm.eq(dbm.report.sourceRef, `email:${messageId}`))
    .limit(1);
  return row;
}

async function reportById(id: string) {
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, id)).limit(1);
  return row;
}

async function eventTypes(reportId: string): Promise<string[]> {
  const rows = await dbm.db
    .select({ type: dbm.sessionEvent.type })
    .from(dbm.sessionEvent)
    .where(dbm.eq(dbm.sessionEvent.reportId, reportId));
  return rows.map((r) => r.type);
}

/** Run the worker once on an outside job, with a fake triage client and a fake mailer. */
async function runOutside(client = fakeClient().client, send = fakeSend().send) {
  const spy = analysisSpy();
  await worker.runOnce("gate-worker", {
    analysis: spy.driver,
    hold: ({ reportId, signal }) => gate.holdForDecision(reportId, signal, { client, send }),
  });
  return spy;
}

async function heldReport(opts: { subject?: string; text?: string } = {}) {
  await drain();
  const email = await enqueueEmail({ outside: true, ...opts });
  const mail = fakeSend();
  await runOutside(fakeClient().client, mail.send);
  return { report: await reportFor(email.messageId), email, mail };
}

test("an allowlisted sender's email is unchanged: TRIAGING and straight into analysis", async () => {
  await drain();
  const email = await enqueueEmail({ outside: false, from: "owner@bountydesk.test" });
  const spy = analysisSpy();
  const mail = fakeSend();

  await worker.runOnce("gate-worker", {
    analysis: spy.driver,
    hold: async () => {
      throw new Error("an allowlisted report must never reach the gate");
    },
  });

  const row = await reportFor(email.messageId);
  assert.equal(row.state, "TRIAGING");
  assert.equal(row.verifiedSender, null);
  assert.deepEqual(spy.calls, [`session:${row.id}`, `run:${row.id}`]);
  assert.equal(mail.calls.length, 0, "no acknowledgement for an allowlisted sender");
});

test("an outside report is held at the gate with no analysis, and the job finishes", async () => {
  await drain();
  const email = await enqueueEmail({ outside: true });
  const mail = fakeSend();
  const triage = fakeClient();

  const spy = await runOutside(triage.client, mail.send);

  const row = await reportFor(email.messageId);
  assert.equal(row.state, "NEEDS_DECISION");
  assert.equal(row.verifiedSender, email.fromEmail);
  assert.equal(row.reporterContact, email.fromEmail);
  assert.deepEqual(spy.calls, [], "no session, no run, no sandbox before a human says so");

  const [job] = await dbm.db
    .select({ state: dbm.inboundJob.state })
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.deliveryId, email.messageId));
  assert.equal(job.state, "DONE");

  // Exactly one mail, and it is the fixed acknowledgement: no report text in it.
  assert.equal(mail.calls.length, 1);
  assert.equal(mail.calls[0].to, email.fromEmail);
  assert.match(mail.calls[0].subject, /^Re: Stored XSS in reviews/);
  assert.equal(mail.calls[0].text, notice.NOTICES.acknowledgement.text);
  assert.equal(mail.calls[0].html, undefined);

  // The email reached the triage agent fenced as untrusted data.
  assert.match(triage.inputs[0], /\[UNTRUSTED_EMAIL\][\s\S]*script tags[\s\S]*\[\/UNTRUSTED_EMAIL\]/);

  const view = await gate.readGate(row.id);
  assert.equal(view.triage?.triage?.vulnerabilityClass, "stored XSS");
  assert.equal(view.triage?.triage?.severity, "medium");
  assert.ok(Array.isArray(view.triage?.duplicateCandidates));
  const types = await eventTypes(row.id);
  assert.ok(types.includes("intake.acknowledgement_sent"));
  assert.ok(!types.includes("intake.duplicate_sent"), "no duplicate reply without a human");
});

test("a failed triage still holds the report at the gate", async () => {
  await drain();
  const email = await enqueueEmail({ outside: true });
  await runOutside(fakeClient(null, "error").client);

  const row = await reportFor(email.messageId);
  assert.equal(row.state, "NEEDS_DECISION");
  const view = await gate.readGate(row.id);
  assert.equal(view.triage?.triage, null);
});

test("a triage turn that tries to act is discarded", async () => {
  await drain();
  const email = await enqueueEmail({ outside: true });
  await runOutside(fakeClient(TRIAGE_REPLY, "awaiting_approval").client);

  const view = await gate.readGate((await reportFor(email.messageId)).id);
  assert.equal(view.triage?.triage, null);
});

test("a retried hold does not acknowledge or triage twice", async () => {
  const { report: row, mail } = await heldReport();
  const again = fakeSend();

  await gate.holdForDecision(row.id, new AbortController().signal, { client: fakeClient().client, send: again.send });

  assert.equal(mail.calls.length, 1);
  assert.equal(again.calls.length, 0);
  const triaged = (await eventTypes(row.id)).filter((t) => t === gate.TRIAGED_EVENT);
  assert.equal(triaged.length, 1);
});

/** A report created at the gate by the worker, before its hold step has run. */
async function parsedOnly() {
  await drain();
  const email = await enqueueEmail({ outside: true });
  // A hold that does nothing, so the test can drive holdForDecision itself.
  await worker.runOnce("gate-worker", { analysis: analysisSpy().driver, hold: async () => {} });
  return reportFor(email.messageId);
}

test("a reviewer decision during the triage turn leaves no triage record and no error", async () => {
  const row = await parsedOnly();
  const { client } = fakeClient();
  // The turn is where the minutes go: release the report while it is "running".
  const racing = {
    ...client,
    createTurn: async (...args: Parameters<TrueForgeClient["createTurn"]>) => {
      assert.deepEqual(await gate.releaseForAnalysis(row.id, "reviewer"), { ok: true });
      return client.createTurn(...args);
    },
  } as TrueForgeClient;

  await gate.holdForDecision(row.id, new AbortController().signal, { client: racing, send: fakeSend().send });

  assert.equal((await reportById(row.id)).state, "TRIAGING");
  const types = await eventTypes(row.id);
  assert.ok(!types.includes(gate.TRIAGED_EVENT), "a report that left the gate gets no triage");
  assert.ok(types.includes("intake.analysis_released"));
});

test("a reviewer decision between the acknowledgement and the triage skips the triage turn", async () => {
  const row = await parsedOnly();
  const mail = fakeSend();
  const send = (async (call: SendCall) => {
    const sent = await (mail.send as unknown as (c: SendCall) => Promise<{ id: string }>)(call);
    await gate.rejectAtGate(row.id, "reviewer", true);
    return sent;
  }) as unknown as import("@/lib/email/notice").SendNotice;
  const triage = fakeClient();

  await gate.holdForDecision(row.id, new AbortController().signal, { client: triage.client, send });

  assert.equal(mail.calls.length, 1, "the acknowledgement still went out");
  assert.equal(triage.inputs.length, 0, "no triage turn for a closed report");
  const types = await eventTypes(row.id);
  assert.ok(types.includes("intake.marked_spam"));
  assert.ok(!types.includes(gate.TRIAGED_EVENT));
});

test("a similar earlier report is offered as a duplicate candidate", async () => {
  const first = await heldReport({
    subject: "SQL injection in the product search endpoint",
    text: "The q parameter of /rest/products/search is concatenated into SQL. Payload ' OR 1=1 returns every product.",
  });
  const second = await heldReport({
    subject: "SQL injection in product search",
    text: "The q parameter in /rest/products/search is concatenated into the SQL query. Sending ' OR 1=1 returns all products.",
  });

  const view = await gate.readGate(second.report.id);
  assert.equal(view.triage?.duplicateCandidates[0]?.reportId, first.report.id);
  // A candidate is only a hint: the report is still waiting.
  assert.equal((await reportById(second.report.id)).state, "NEEDS_DECISION");
});

test("candidate ranking keeps only the closest few above the threshold", async () => {
  const { rankCandidates } = await import("./duplicates");
  const rows = [
    { id: "a", title: "SQL injection in search", body: "q parameter concatenated into SQL query" },
    { id: "b", title: "Newsletter", body: "buy cheap watches today" },
    { id: "c", title: "SQL injection in the search box", body: "the q parameter goes into the SQL query unescaped" },
  ];

  const ranked = rankCandidates("SQL injection: the search q parameter is concatenated into the SQL query", rows);

  assert.deepEqual(ranked.map((r) => r.reportId).sort(), ["a", "c"]);
  assert.ok(ranked[0].score >= ranked[ranked.length - 1].score);
  assert.deepEqual(rankCandidates("", rows), []);
});

test("reject closes the report and sends the fixed out-of-scope reply once", async () => {
  const { report: row } = await heldReport();
  const reply = fakeSend();

  assert.deepEqual(await gate.rejectAtGate(row.id, "reviewer", false, reply.send), { ok: true });

  assert.equal((await reportById(row.id)).state, "DENIED");
  assert.equal(reply.calls.length, 1);
  assert.equal(reply.calls[0].to, row.reporterContact);
  assert.match(reply.calls[0].subject, /^Re: Stored XSS in reviews/);
  assert.equal(reply.calls[0].text, notice.NOTICES.rejected.text);
  assert.equal(reply.calls[0].idempotencyKey, `notice:rejected:${row.id}`);
  const types = await eventTypes(row.id);
  assert.ok(types.includes("intake.rejected"));
  assert.ok(types.includes("intake.rejected_sent"));
  assert.equal((await gate.readGate(row.id)).rejectReplySent, true);
  // A second click finds nothing left to decide, and mails nothing more.
  assert.equal((await gate.rejectAtGate(row.id, "reviewer", false, reply.send)).ok, false);
  assert.equal(reply.calls.length, 1);
});

test("mark as spam closes the report and records it as spam, sending nothing", async () => {
  const { report: row } = await heldReport();
  const reply = fakeSend();

  assert.deepEqual(await gate.rejectAtGate(row.id, "reviewer", true, reply.send), { ok: true });

  assert.equal((await reportById(row.id)).state, "DENIED");
  assert.equal(reply.calls.length, 0, "a spammer gets no confirmation the address is read");
  const types = await eventTypes(row.id);
  assert.ok(types.includes("intake.marked_spam"));
  assert.ok(!types.includes("intake.rejected_sent"));
  // Nothing to resend: a spam close never offers the reject reply.
  assert.equal((await gate.readGate(row.id)).rejectReplySent, null);
  assert.equal((await gate.rejectAtGate(row.id, "reviewer", false, reply.send)).ok, false);
  assert.equal(reply.calls.length, 0);
});

test("a reject reply that failed to send can be sent again without reclosing", async () => {
  const { report: row } = await heldReport();

  const broken = fakeSend({ fail: true });
  const first = await gate.rejectAtGate(row.id, "reviewer", false, broken.send);
  assert.equal(first.ok, false);
  assert.match(first.reason, /Closed as rejected/);
  assert.equal((await reportById(row.id)).state, "DENIED", "the close committed before the send");
  assert.ok(!(await eventTypes(row.id)).includes("intake.rejected_sent"), "no sent event on a failed send");
  assert.equal((await gate.readGate(row.id)).rejectReplySent, false);

  const working = fakeSend();
  assert.deepEqual(await gate.rejectAtGate(row.id, "reviewer", false, working.send), { ok: true });
  assert.equal(working.calls.length, 1);
  assert.equal(working.calls[0].idempotencyKey, `notice:rejected:${row.id}`);

  const types = await eventTypes(row.id);
  assert.equal(types.filter((t) => t === "intake.rejected").length, 1, "the close is not recorded twice");
  assert.equal(types.filter((t) => t === "intake.rejected_sent").length, 1);
  assert.equal((await gate.readGate(row.id)).rejectReplySent, true);
});

test("run analysis releases the report into the normal analysis-only run, once", async () => {
  const { report: row } = await heldReport();
  await drain();

  assert.deepEqual(await gate.releaseForAnalysis(row.id, "reviewer"), { ok: true });
  assert.equal((await reportById(row.id)).state, "TRIAGING");
  // A double click is refused, and queues nothing more.
  assert.equal((await gate.releaseForAnalysis(row.id, "reviewer")).ok, false);

  const spy = analysisSpy();
  await worker.runOnce("gate-worker", { analysis: spy.driver });
  assert.deepEqual(spy.calls, [`session:${row.id}`, `run:${row.id}`]);

  const jobs = await dbm.db
    .select({ state: dbm.inboundJob.state })
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.reportId, row.id));
  assert.equal(jobs.filter((j) => j.state === "DONE").length, 2, "the intake job and one release job");
});

test("a release job for a report the gate never released is buried, not analysed", async () => {
  const { report: row } = await heldReport();
  await drain();
  // Forged: the report is still NEEDS_DECISION, so no reviewer released it.
  await queue.enqueue({
    channel: "email",
    deliveryId: `gate-analysis:${row.id}`,
    payload: { intake: "gate-analysis", reportId: row.id },
  });

  const spy = analysisSpy();
  await worker.runOnce("gate-worker", { analysis: spy.driver });

  assert.deepEqual(spy.calls, []);
  const [job] = await dbm.db
    .select({ state: dbm.inboundJob.state })
    .from(dbm.inboundJob)
    .where(dbm.eq(dbm.inboundJob.deliveryId, `gate-analysis:${row.id}`));
  assert.equal(job.state, "DEAD_LETTER");
  assert.equal((await reportById(row.id)).state, "NEEDS_DECISION");
});

test("mark duplicate links, closes, and sends the fixed duplicate reply once", async () => {
  const original = await heldReport();
  const { report: row } = await heldReport();
  const mail = fakeSend();

  assert.deepEqual(await gate.markDuplicateAtGate(row.id, original.report.id, "reviewer", mail.send), { ok: true });

  const after = await reportById(row.id);
  assert.equal(after.state, "DENIED");
  assert.equal(after.duplicateOfReportId, original.report.id);
  assert.equal(mail.calls.length, 1);
  assert.equal(mail.calls[0].to, row.reporterContact);
  assert.match(mail.calls[0].subject, /^Re: Stored XSS in reviews/);
  assert.equal(mail.calls[0].text, notice.NOTICES.duplicate.text);
  assert.ok(!mail.calls[0].text.includes(original.report.id), "the reply names no other report");

  // Clicking again neither closes twice nor mails twice.
  assert.deepEqual(await gate.markDuplicateAtGate(row.id, original.report.id, "reviewer", mail.send), { ok: true });
  assert.equal(mail.calls.length, 1);
  const view = await gate.readGate(row.id);
  assert.equal(view.duplicateOf?.id, original.report.id);
  assert.equal(view.duplicateReplySent, true);
});

test("a duplicate reply that failed to send can be sent again without reclosing", async () => {
  const original = await heldReport();
  const { report: row } = await heldReport();

  const broken = fakeSend({ fail: true });
  const first = await gate.markDuplicateAtGate(row.id, original.report.id, "reviewer", broken.send);
  assert.equal(first.ok, false);
  assert.equal((await reportById(row.id)).state, "DENIED", "the close committed before the send");
  assert.equal((await gate.readGate(row.id)).duplicateReplySent, false);

  const working = fakeSend();
  assert.deepEqual(await gate.markDuplicateAtGate(row.id, original.report.id, "reviewer", working.send), { ok: true });
  assert.equal(working.calls.length, 1);
  assert.equal(working.calls[0].idempotencyKey, `notice:duplicate:${row.id}`);
});

test("mark duplicate refuses itself, a missing original, and a report no longer at the gate", async () => {
  const { report: row } = await heldReport();
  const mail = fakeSend();

  assert.equal((await gate.markDuplicateAtGate(row.id, row.id, "reviewer", mail.send)).ok, false);
  assert.equal(
    (await gate.markDuplicateAtGate(row.id, "00000000-0000-4000-8000-000000000000", "reviewer", mail.send)).ok,
    false,
  );
  await gate.rejectAtGate(row.id, "reviewer", false, fakeSend().send);
  const other = await heldReport();
  assert.equal((await gate.markDuplicateAtGate(row.id, other.report.id, "reviewer", mail.send)).ok, false);
  assert.equal(mail.calls.length, 0);
});

test("a gated report cannot have a target bound before a decision", async () => {
  const { report: row } = await heldReport();
  const [profile] = await dbm.db
    .insert(dbm.targetProfile)
    .values({ name: `gate-target-${Date.now()}`, imageDigest: `sha256:${"1".repeat(64)}` })
    .returning({ id: dbm.targetProfile.id });

  const result = await bind.bindTarget(row.id, profile.id, "reviewer");

  assert.equal(result.ok, false);
  assert.equal((await reportById(row.id)).targetProfileId, null);
});

test("a notice is never sent to a contact that intake did not verify", async () => {
  await drain();
  const email = await enqueueEmail({ outside: false, from: "owner@bountydesk.test" });
  await worker.runOnce("gate-worker", { analysis: analysisSpy().driver });
  const row = await reportFor(email.messageId);
  const mail = fakeSend();

  const result = await notice.sendNotice(row.id, "acknowledgement", mail.send);

  assert.equal(result.status, "refused");
  assert.equal(mail.calls.length, 0);
});
