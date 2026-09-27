import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The upload contact-verify route against a real Postgres. It guards untrusted input in order: the
 * size cap and JSON parse before anything, then the report-id shape, then the code check or a
 * resend. A report id alone can only act on the address that report already recorded, so knowing an
 * id cannot redirect a verdict.
 *
 * RESEND_API_KEY is cleared so the resend branch fails closed at the mail send rather than reaching
 * the network, which is enough to prove it took the resend path and not the confirm path.
 */
delete process.env.RESEND_API_KEY;

const CONFIG = { perSenderPerDay: 50, perDomainPerDay: 200, maxBytes: 512 * 1024, exemptDomains: [] };

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let POST: typeof import("./route").POST;
let intake: typeof import("@/lib/upload/intake");

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("upload_verify_route");
  dbm = await import("@/lib/db");
  ({ POST } = await import("./route"));
  intake = await import("@/lib/upload/intake");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function body(payload: unknown): Request {
  return new Request("http://localhost/api/intake/upload/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

let seq = 0;

/** Admit a fresh upload and capture the code its contact was mailed, so a confirm can use it. */
async function seedUpload(): Promise<{ reportId: string; contact: string; code: string }> {
  seq += 1;
  const contact = `uploader-${seq}@outside.test`;
  let code = "";
  const admission = await intake.admitUpload(
    { title: `report ${seq}`, body: "steps to reproduce", contact, material: null },
    `198.51.100.${seq % 200}`,
    { config: CONFIG, sendCode: async (_to, c) => void (code = c) },
  );
  assert.ok(admission.accepted);
  if (!admission.accepted) throw new Error("seed upload was not accepted");
  return { reportId: admission.reportId, contact, code };
}

async function reportRow(id: string) {
  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, id));
  return row;
}

test("a body over the size cap is refused before it is parsed", async () => {
  const oversized = "x".repeat(4 * 1024 + 1);
  const response = await POST(body(oversized));
  assert.equal(response.status, 413);
});

test("a non-JSON body is refused", async () => {
  const response = await POST(body("this is not json"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JSON/);
});

test("a report id that is not a report-id shape is a 404", async () => {
  const response = await POST(body({ reportId: "not-a-report-id", code: "123456" }));
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /no such upload/);
});

test("a valid-shaped id for a report that does not exist is refused", async () => {
  const response = await POST(body({ reportId: "11111111-1111-4111-8111-111111111111", code: "123456" }));
  // Shape passes, so it reaches confirmContactCode, which finds no upload report for that id.
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /no such upload/);
});

test("a wrong code is refused without confirming the contact", async () => {
  const { reportId, code } = await seedUpload();
  const wrong = code === "000000" ? "111111" : "000000";
  const response = await POST(body({ reportId, code: wrong }));
  assert.equal(response.status, 400);
  const row = await reportRow(reportId);
  assert.equal(row.verifiedSender, null, "a wrong code never proves the address");
});

test("an expired code is refused", async () => {
  const { reportId, code } = await seedUpload();
  await dbm.db
    .update(dbm.report)
    .set({ contactCodeExpiresAt: new Date(Date.now() - 1000) })
    .where(dbm.eq(dbm.report.id, reportId));
  const response = await POST(body({ reportId, code }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /expired/i);
});

test("a code refused past the attempt cap stays refused", async () => {
  const { reportId, code } = await seedUpload();
  await dbm.db
    .update(dbm.report)
    .set({ contactCodeAttempts: 5 })
    .where(dbm.eq(dbm.report.id, reportId));
  // Even the right code is refused once the cap is spent, so a brute force cannot outrun it.
  const response = await POST(body({ reportId, code }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /too many attempts/i);
});

test("the confirm action proves the contact with the right code", async () => {
  const { reportId, contact, code } = await seedUpload();
  const response = await POST(body({ reportId, code }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const row = await reportRow(reportId);
  assert.equal(row.verifiedSender, contact, "a correct code sets verified_sender to the contact");
});

test("the resend action takes the send path, not the code check", async () => {
  const { reportId } = await seedUpload();
  // No code is given, so the confirm branch would fail on the six-digit check. Instead this reaches
  // sendContactCode, which fails closed at the mail send with RESEND_API_KEY cleared. Either way the
  // reason is distinct from any confirm refusal, which is what proves the switch chose resend.
  const response = await POST(body({ reportId, action: "resend" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /could not be sent/i);
  const row = await reportRow(reportId);
  assert.equal(row.verifiedSender, null);
});
