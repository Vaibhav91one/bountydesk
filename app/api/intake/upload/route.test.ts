import assert from "node:assert/strict";
import test, { after, before } from "node:test";

/**
 * The public upload route against a real Postgres. The point is the order of the checks on untrusted
 * input: content type and size before parsing, field bounds before the database, and an accepted
 * upload held at the gate. RESEND_API_KEY is cleared so the code mail fails closed before any network
 * call; the report still exists and the uploader can ask for another code.
 */
delete process.env.RESEND_API_KEY;

let schema: import("@/lib/db/testing").DisposableSchema;
let dbm: typeof import("@/lib/db");
let POST: typeof import("./route").POST;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("upload_route");
  dbm = await import("@/lib/db");
  ({ POST } = await import("./route"));
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

function upload(fields: Record<string, string | Blob>, headers: Record<string, string> = {}): Request {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return new Request("http://localhost/api/intake/upload", { method: "POST", body: data, headers });
}

const REPORT = { title: "Stored XSS", body: "Post a comment containing a script tag.", contact: "route@outside.test" };

test("a JSON body is refused before it is parsed", async () => {
  const response = await POST(
    new Request("http://localhost/api/intake/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REPORT),
    }),
  );
  assert.equal(response.status, 415);
});

test("an upload over the size cap is refused without being read", async () => {
  const body = new Uint8Array(4 * 1024 * 1024 + 1);
  const headers = { "content-type": "multipart/form-data; boundary=x" };
  // Refused on the declared length, and again on the bytes read when no length is declared.
  const declared = await POST(
    new Request("http://localhost/api/intake/upload", {
      method: "POST",
      body,
      headers: { ...headers, "content-length": String(body.length) },
    }),
  );
  assert.equal(declared.status, 413);
  const streamed = await POST(new Request("http://localhost/api/intake/upload", { method: "POST", body, headers }));
  assert.equal(streamed.status, 413);
});

test("a file that is not a tarball is refused", async () => {
  const response = await POST(upload({ ...REPORT, archive: new Blob(["<html>not a tarball</html>"]) }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /\.tar/);
});

test("a prebuilt image from a registry outside the allowlist is refused", async () => {
  const response = await POST(
    upload({ ...REPORT, imageRef: "registry.attacker.test/x/y:1", imageDigest: `sha256:${"b".repeat(64)}` }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /registry\.attacker\.test are not accepted/);
});

test("an accepted upload is held at the gate on the upload channel", async () => {
  const response = await POST(upload({ ...REPORT, dockerfile: new Blob(["FROM nginx:1.27\n"]) }, { "x-forwarded-for": "198.51.100.7" }));
  assert.equal(response.status, 202);
  const body = (await response.json()) as { reportId: string; codeSent: boolean };
  assert.equal(body.codeSent, false);

  const [row] = await dbm.db.select().from(dbm.report).where(dbm.eq(dbm.report.id, body.reportId));
  assert.equal(row.channel, "upload");
  assert.equal(row.state, "NEEDS_DECISION");
  const [intake] = await dbm.db
    .select()
    .from(dbm.uploadIntake)
    .where(dbm.eq(dbm.uploadIntake.reportId, body.reportId));
  assert.equal(intake.materialKind, "dockerfile");
  assert.equal(intake.clientIp, "198.51.100.7");
  assert.match(intake.sourceArchiveDigest ?? "", /^sha256:[0-9a-f]{64}$/);
});
