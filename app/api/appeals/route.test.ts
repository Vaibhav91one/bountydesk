import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The public appeal route: input bounds and the uniform answers. The eligibility rules are covered
 * against the database in lib/appeals/appeals.test.ts.
 */
delete process.env.RESEND_API_KEY;
process.env.REVIEWER_EMAILS = "owner@bountydesk.test";

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let POST: typeof import("./route").POST;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("appeals_route");
  dbm = await import("@/lib/db");
  ({ POST } = await import("./route"));
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function req(payload: unknown, ip = "203.0.113.9"): Request {
  return new Request("http://localhost/api/appeals", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

test("an oversized body is refused before parsing", async () => {
  assert.equal((await POST(req("x".repeat(16 * 1024 + 1)))).status, 413);
});

test("a non-JSON body and an unknown action are refused", async () => {
  assert.equal((await POST(req("nope"))).status, 400);
  assert.equal((await POST(req({ action: "other" }))).status, 400);
});

test("a code request for a malformed or unknown report answers ok", async () => {
  for (const reportId of ["not-an-id", "11111111-1111-4111-8111-111111111111"]) {
    const response = await POST(req({ action: "request_code", reportId, contact: "a@b.test" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test("a submit without a valid code is a 400 that does not say why", async () => {
  const response = await POST(
    req({ action: "submit", reportId: "11111111-1111-4111-8111-111111111111", contact: "a@b.test", code: "123456", body: "x" }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not valid/);
});
