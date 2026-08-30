import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before } from "node:test";

/**
 * Real Postgres, like the other security-relevant suites: the artifact table's append-only
 * trigger and its unique (verdict_id, kind) index are database guarantees, and a mock would
 * agree with a wrong implementation. Storage is deliberately left unconfigured (no
 * NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY), which is the state this feature ships
 * in, so every row here is written with a null storage_path.
 */
let schema: import("@/lib/db/testing").DisposableSchema;

type DbModule = typeof import("@/lib/db");
type RecordModule = typeof import("./record");

let dbm: DbModule;
let record: RecordModule;

before(async () => {
  const { createSchema } = await import("@/lib/db/testing");
  schema = await createSchema("artifacts_record");
  dbm = await import("@/lib/db");
  record = await import("./record");
  await dbm.db.execute("select 1");
});

after(async () => {
  await dbm?.client.end({ timeout: 5 });
  await schema?.drop();
});

let seq = 0;

async function seedVerdictWithEvents() {
  seq += 1;
  const n = seq;

  const [r] = await dbm.db
    .insert(dbm.report)
    .values({ channel: "github", sourceRef: `github:9:issue:${n}`, title: `r${n}`, body: "b" })
    .returning({ id: dbm.report.id });

  const [v] = await dbm.db
    .insert(dbm.verdict)
    .values({
      reportId: r.id,
      outcome: "ANALYSIS_ONLY",
      summary: "s",
      payload: `verdict payload ${n}`,
      contentHash: `hash-${n}`,
    })
    .returning({ id: dbm.verdict.id });

  // Two mirrored tool calls, shaped exactly as the poller writes them: a safe argumentsPreview,
  // plus a raw capability field that the poller would never store but which, if the transcript
  // read the whole data blob, would leak.
  await dbm.db.insert(dbm.sessionEvent).values([
    {
      reportId: r.id,
      seq: 1,
      type: "agent.tool_call:http_probe",
      data: { toolName: "http_probe", argumentsPreview: '{"url":"/rest/products"}', capability: "SECRET-CAP-TOKEN" },
    },
    {
      reportId: r.id,
      seq: 2,
      type: "agent.tool_call:publish_verdict",
      data: { toolName: "publish_verdict" },
    },
  ]);

  return { reportId: r.id, verdictId: v.id, payload: `verdict payload ${n}` };
}

test("the transcript carries the tool name and safe preview, never a raw secret", async () => {
  const { reportId, verdictId } = await seedVerdictWithEvents();

  const transcript = await record.buildTranscript(reportId, verdictId);

  assert.match(transcript, /http_probe/);
  assert.match(transcript, /\/rest\/products/);
  assert.match(transcript, /publish_verdict/);
  assert.ok(
    !transcript.includes("SECRET-CAP-TOKEN"),
    "a raw capability token must never reach the transcript",
  );
});

test("recordVerdictArtifacts writes one row per kind, unstored, content-addressed", async () => {
  const { reportId, verdictId, payload } = await seedVerdictWithEvents();

  await record.recordVerdictArtifacts(reportId, verdictId);

  const rows = await dbm.db
    .select()
    .from(dbm.artifact)
    .where(dbm.eq(dbm.artifact.reportId, reportId));

  assert.equal(rows.length, 2);
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
  assert.ok(byKind["investigation-transcript"]);
  assert.ok(byKind["verdict-payload"]);

  for (const row of rows) {
    // Storage is unconfigured in the test env, so nothing was uploaded: the row records the
    // artifact as produced-but-not-stored rather than dropping it.
    assert.equal(row.storagePath, null);
    assert.equal(row.sha256.length, 64);
    assert.ok(row.bytes > 0);
    assert.equal(row.contentType, "text/markdown");
  }

  // The verdict-payload artifact's hash is the hash of the payload bytes: content addressing,
  // so a reviewer who pulls the file can check it is the text that was approved.
  const expected = createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
  assert.equal(byKind["verdict-payload"].sha256, expected);
});

test("a retried draft does not double the artifact rows", async () => {
  const { reportId, verdictId } = await seedVerdictWithEvents();

  await record.recordVerdictArtifacts(reportId, verdictId);
  await record.recordVerdictArtifacts(reportId, verdictId);

  const rows = await dbm.db
    .select()
    .from(dbm.artifact)
    .where(dbm.eq(dbm.artifact.reportId, reportId));
  assert.equal(rows.length, 2, "the unique (verdict_id, kind) index makes the retry a no-op");
});

test("an artifact row cannot be updated or deleted", async () => {
  const { reportId, verdictId } = await seedVerdictWithEvents();
  await record.recordVerdictArtifacts(reportId, verdictId);

  const [row] = await dbm.db
    .select({ id: dbm.artifact.id })
    .from(dbm.artifact)
    .where(dbm.eq(dbm.artifact.reportId, reportId))
    .limit(1);

  // drizzle wraps the Postgres error, so the trigger's "append-only" message is on the cause.
  const isAppendOnly = (err: unknown) =>
    /append-only/.test(`${(err as { message?: string }).message ?? ""} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}`);

  await assert.rejects(
    dbm.db.update(dbm.artifact).set({ storagePath: "sneaky" }).where(dbm.eq(dbm.artifact.id, row.id)),
    isAppendOnly,
  );
  await assert.rejects(
    dbm.db.delete(dbm.artifact).where(dbm.eq(dbm.artifact.id, row.id)),
    isAppendOnly,
  );
});
